"""Immutable local package resources compiled through the SDK profile resolver."""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, uuid5

from filelock import FileLock
from pydantic import ValidationError

from openhands.agent_server.agent_foundation.package_models import (
    AgentEffectiveConfig,
    AgentInfo,
    PackageAgent,
    PackageInfo,
    PackageManifest,
    PackageValidation,
    ToolPolicy,
)
from openhands.agent_server.persistence import get_llm_profile_store, get_settings_store
from openhands.sdk.agent import Agent
from openhands.sdk.mcp.config import MCPServer
from openhands.sdk.profiles.agent_profile import OpenHandsAgentProfile
from openhands.sdk.profiles.resolver import (
    DanglingMcpServerRef,
    ProfileNotFound,
    resolve_agent_profile,
)
from openhands.sdk.settings.model import OpenHandsAgentSettings
from openhands.sdk.skills import Skill
from openhands.sdk.tool.builtins import (
    BUILT_IN_TOOL_CLASSES,
    BUILT_IN_TOOLS,
    InvokeSkillTool,
)
from openhands.sdk.tool.registry import list_registered_tools
from openhands.sdk.utils.path import get_user_persistence_dir


if TYPE_CHECKING:
    from openhands.agent_server.config import Config
    from openhands.sdk.llm.llm_profile_store import LLMProfileLoader
    from openhands.sdk.utils.cipher import Cipher


MANIFEST_NAME = "agent-package.json"
UNMANAGED_DELEGATION_TOOLS = {
    "task",
    "task_tool",
    "task_tool_set",
    "TaskTool",
    "TaskToolSet",
    "workflow",
    "workflow_tool",
    "workflow_tool_set",
    "WorkflowTool",
    "WorkflowToolSet",
    "delegate",
    "delegate_agent",
}
FOUNDATION_CONTROL_TOOLS = {
    "read_artifact",
    "publish_artifact",
    "read_package_resource",
}


@dataclass(frozen=True)
class ResolvedPackageAgent:
    summary: AgentInfo
    profile: OpenHandsAgentProfile
    skills: list[Skill]
    package_root: Path
    allowed_agents: list[str]
    tool_policies: dict[str, ToolPolicy]
    content_hash: str = ""

    @property
    def secret_names(self) -> list[str]:
        return list(self.profile.secret_refs or [])


def _resource(root: Path, relative: str) -> Path:
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or "\\" in relative or ":" in relative:
        raise ValueError(f"Package resource must be a relative path: {relative}")
    candidate = (root / path).resolve()
    if not candidate.is_relative_to(root.resolve()) or not candidate.is_file():
        raise ValueError(
            f"Package resource is missing or outside the package: {relative}"
        )
    return candidate


def _snapshot(root: Path) -> tuple[dict[str, bytes], str]:
    if not root.is_dir():
        raise ValueError("Package source must be an existing local directory")
    files: dict[str, bytes] = {}
    total_bytes = 0
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("Package resources cannot contain external links")
        if path.is_file():
            content = path.read_bytes()
            total_bytes += len(content)
            if total_bytes > 64 * 1024 * 1024 or len(files) >= 4096:
                raise ValueError("Package exceeds 64 MiB or 4096 files")
            files[path.relative_to(root).as_posix()] = content
    digest = hashlib.sha256()
    for name, content in files.items():
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(content).digest())
    return files, digest.hexdigest()


# @spec GAF-001 — One package registry owns installation and active versions
class PackageRegistry:
    def __init__(
        self,
        base_dir: Path | None = None,
        *,
        llm_store: LLMProfileLoader | None = None,
        mcp_config: dict[str, MCPServer] | None = None,
        cipher: Cipher | None = None,
        config: Config | None = None,
    ) -> None:
        self.base_dir = (
            base_dir or get_user_persistence_dir() / "agent-foundation/packages"
        )
        self.llm_store = llm_store
        self.mcp_config = mcp_config
        self.config = config
        self.cipher = (
            cipher if cipher is not None else (config.cipher if config else None)
        )

    def _catalog(self) -> dict[str, Any]:
        path = self.base_dir / "catalog.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def _write_catalog(self, catalog: dict[str, Any]) -> None:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.base_dir, delete=False
        ) as file:
            json.dump(catalog, file, sort_keys=True)
            temporary = Path(file.name)
        try:
            temporary.replace(self.base_dir / "catalog.json")
        finally:
            temporary.unlink(missing_ok=True)

    def _dependencies(self) -> tuple[LLMProfileLoader, dict[str, MCPServer]]:
        llm_store = self.llm_store or get_llm_profile_store()
        if self.mcp_config is not None:
            return llm_store, self.mcp_config
        settings = get_settings_store(self.config).load()
        return llm_store, settings.agent_settings.mcp_config if settings else {}

    def _compile(
        self, manifest: PackageManifest, spec: PackageAgent, root: Path, enabled: bool
    ) -> ResolvedPackageAgent:
        logical_id = f"{manifest.id}/{spec.id}"
        identity = uuid5(NAMESPACE_URL, f"openhands:agent-foundation:{logical_id}")
        prompt = _resource(root, spec.system_prompt).read_text(encoding="utf-8")
        if not prompt.strip():
            raise ValueError(f"System prompt is empty for {logical_id}")
        skills = [
            Skill.load(_resource(root, name), skip_mcp=True) for name in spec.skills
        ]
        if len({skill.name for skill in skills}) != len(skills):
            raise ValueError(f"Duplicate skill names for {logical_id}")
        unmanaged = {tool.name for tool in spec.tools} & UNMANAGED_DELEGATION_TOOLS
        if unmanaged:
            raise ValueError(
                "Use declared delegates instead of unmanaged delegation tools: "
                f"{sorted(unmanaged)}"
            )
        if reserved := {tool.name for tool in spec.tools} & FOUNDATION_CONTROL_TOOLS:
            raise ValueError(
                "Foundation control tools are provided by the runtime: "
                f"{sorted(reserved)}"
            )
        known_tools = set(list_registered_tools()) | set(BUILT_IN_TOOL_CLASSES)
        unknown = {tool.name for tool in spec.tools} - known_tools
        if unknown:
            raise ValueError(f"Unregistered tools for {logical_id}: {sorted(unknown)}")
        profile = OpenHandsAgentProfile(
            id=identity,
            name=f"gaf-{identity.hex}",
            llm_profile_ref=spec.llm_profile_ref,
            system_prompt=prompt,
            skill_sources="explicit",
            tools=spec.tools,
            mcp_server_refs=spec.mcp_server_refs,
            mcp_tool_allowlist=spec.mcp_tools,
            secret_refs=spec.secret_refs,
            enable_sub_agents=False,
            enable_switch_llm_tool=False,
        )
        return ResolvedPackageAgent(
            summary=AgentInfo(
                id=logical_id,
                name=spec.name,
                description=spec.description,
                profile_id=str(identity),
                package_id=manifest.id,
                package_version=manifest.version,
                enabled=enabled,
            ),
            profile=profile,
            skills=skills,
            package_root=root,
            allowed_agents=[f"{manifest.id}/{name}" for name in spec.delegates],
            tool_policies=spec.tool_policies,
        )

    def _inspect(self, source: Path) -> tuple[PackageManifest, dict[str, bytes], str]:
        source = source.resolve()
        files, digest = _snapshot(source)
        if MANIFEST_NAME not in files:
            raise ValueError(f"Package is missing {MANIFEST_NAME}")
        manifest = PackageManifest.model_validate_json(files[MANIFEST_NAME])
        llm_store, mcp_config = self._dependencies()
        for spec in manifest.agents:
            resolved = self._compile(manifest, spec, source, enabled=True)
            resolve_agent_profile(
                resolved.profile,
                llm_store=llm_store,
                mcp_config=mcp_config,
                available_skills=resolved.skills,
                cipher=self.cipher,
            )
        return manifest, files, digest

    def validate(self, source: Path | str) -> PackageValidation:
        try:
            manifest, _, digest = self._inspect(Path(source))
            return PackageValidation(
                valid=True,
                package=self._info(manifest, digest, enabled=True),
            )
        except ValidationError as exc:
            errors = [
                f"{'.'.join(map(str, error['loc']))}: {error['msg']}"
                for error in exc.errors(include_input=False)
            ]
            return PackageValidation(valid=False, errors=errors)
        except (
            ValueError,
            OSError,
            KeyError,
            ProfileNotFound,
            DanglingMcpServerRef,
        ) as exc:
            return PackageValidation(valid=False, errors=[str(exc)])

    @staticmethod
    def _info(manifest: PackageManifest, digest: str, enabled: bool) -> PackageInfo:
        return PackageInfo(
            id=manifest.id,
            version=manifest.version,
            name=manifest.name,
            description=manifest.description,
            enabled=enabled,
            content_hash=digest,
            ui_extension_ref=manifest.ui_extension_ref,
        )

    def install(self, source: Path | str) -> PackageInfo:
        manifest, files, digest = self._inspect(Path(source))
        self.base_dir.mkdir(parents=True, exist_ok=True)
        with FileLock(self.base_dir / ".packages.lock"):
            catalog = self._catalog()
            versions = self.base_dir / manifest.id
            destination = versions / manifest.version
            if destination.exists():
                _, _, existing_hash = self._load_version(manifest.id, manifest.version)
                if existing_hash != digest:
                    raise ValueError(
                        "Package version already exists with different content"
                    )
            else:
                versions.mkdir(parents=True, exist_ok=True)
                temporary = Path(tempfile.mkdtemp(prefix=".import-", dir=versions))
                try:
                    content_root = temporary / "content"
                    for name, data in files.items():
                        target = content_root / PurePosixPath(name)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(data)
                    # Validate the copied snapshot before making it visible.
                    self._inspect(content_root)
                    (temporary / "digest").write_text(digest, encoding="utf-8")
                    temporary.replace(destination)
                finally:
                    if temporary.exists():
                        shutil.rmtree(temporary)
            catalog[manifest.id] = {
                "version": manifest.version,
                "enabled": True,
                "installed": True,
            }
            self._write_catalog(catalog)
        return self._info(manifest, digest, enabled=True)

    def _load_version(
        self, package_id: str, version: str
    ) -> tuple[PackageManifest, Path, str]:
        # Paths originate in the catalog or validated manifest, but callers may
        # request a historical version directly; enforce containment at the boundary.
        version_root = (self.base_dir / package_id / version).resolve()
        if not version_root.is_relative_to(self.base_dir.resolve()):
            raise ValueError("Invalid package identity")
        content_root = version_root / "content"
        files, actual = _snapshot(content_root)
        expected = (version_root / "digest").read_text(encoding="utf-8")
        if actual != expected:
            raise ValueError("Installed package content has changed")
        manifest = PackageManifest.model_validate_json(files[MANIFEST_NAME])
        if (manifest.id, manifest.version) != (package_id, version):
            raise ValueError("Package identity does not match installed content")
        return manifest, content_root, actual

    def list_packages(self) -> list[PackageInfo]:
        packages = []
        for package_id, record in self._catalog().items():
            if not record["installed"]:
                continue
            manifest, _, digest = self._load_version(package_id, record["version"])
            packages.append(self._info(manifest, digest, record["enabled"]))
        return sorted(packages, key=lambda package: package.id)

    def list_agents(self) -> list[AgentInfo]:
        agents = []
        for package in self.list_packages():
            manifest, root, _ = self._load_version(package.id, package.version)
            agents.extend(
                self._compile(manifest, spec, root, package.enabled).summary
                for spec in manifest.agents
                if spec.id in manifest.entry_agents
            )
        return agents

    def _update_status(
        self, package_id: str, *, enabled: bool, installed: bool
    ) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        with FileLock(self.base_dir / ".packages.lock"):
            catalog = self._catalog()
            if package_id not in catalog or not catalog[package_id]["installed"]:
                raise KeyError(f"Package not found: {package_id}")
            catalog[package_id].update(enabled=enabled, installed=installed)
            self._write_catalog(catalog)

    def set_enabled(self, package_id: str, enabled: bool) -> PackageInfo:
        self._update_status(package_id, enabled=enabled, installed=True)
        return next(
            package for package in self.list_packages() if package.id == package_id
        )

    def uninstall(self, package_id: str) -> None:
        # Retain immutable versions for existing conversation provenance and resume.
        self._update_status(package_id, enabled=False, installed=False)

    def get_agent(
        self, logical_id: str, version: str | None = None
    ) -> ResolvedPackageAgent:
        package_id, separator, agent_id = logical_id.partition("/")
        catalog = self._catalog()
        if not separator or package_id not in catalog:
            raise KeyError(f"Agent not found: {logical_id}")
        record = catalog[package_id]
        enabled = bool(record["installed"] and record["enabled"])
        if version is None and not enabled:
            raise ValueError(f"Package is not enabled: {package_id}")
        manifest, root, content_hash = self._load_version(
            package_id, version or record["version"]
        )
        for spec in manifest.agents:
            if spec.id == agent_id:
                resolved = self._compile(manifest, spec, root, enabled)
                return ResolvedPackageAgent(
                    summary=resolved.summary,
                    profile=resolved.profile,
                    skills=resolved.skills,
                    package_root=resolved.package_root,
                    allowed_agents=resolved.allowed_agents,
                    tool_policies=resolved.tool_policies,
                    content_hash=content_hash,
                )
        raise KeyError(f"Agent not found: {logical_id}")

    def effective_config(
        self, logical_id: str, version: str | None = None
    ) -> AgentEffectiveConfig:
        """Inspect disabled packages too, without activating a mutable profile."""
        package_id = logical_id.partition("/")[0]
        if version is None:
            record = self._catalog().get(package_id)
            if not record or not record["installed"]:
                raise KeyError(f"Package not found: {package_id}")
            version = record["version"]
        settings, resolved = self.resolve_agent(logical_id, version)
        # These are the SDK defaults and the foundation service's controlled
        # helpers. Business tool declarations remain in the canonical profile.
        control_tools = [tool.name for tool in BUILT_IN_TOOLS]
        if any(
            skill.is_agentskills_format and not skill.disable_model_invocation
            for skill in resolved.skills
        ):
            control_tools.append(InvokeSkillTool.name)
        control_tools.extend(
            ["read_artifact", "publish_artifact", "read_package_resource"]
        )
        return AgentEffectiveConfig(
            agent=resolved.summary,
            profile=resolved.profile,
            content_hash=resolved.content_hash,
            resolved_model=settings.llm.model,
            resolved_skills=[skill.name for skill in resolved.skills],
            allowed_agents=resolved.allowed_agents,
            tool_policies=resolved.tool_policies,
            runtime_tools=control_tools
            + (["delegate_agent"] if resolved.allowed_agents else []),
            child_runtime_tools=control_tools,
            delegation_note=(
                "Only a root task with declared delegates receives delegate_agent."
            ),
        )

    def resolve_agent(
        self, logical_id: str, version: str | None = None
    ) -> tuple[OpenHandsAgentSettings, ResolvedPackageAgent]:
        resolved = self.get_agent(logical_id, version)
        llm_store, mcp_config = self._dependencies()
        settings = resolve_agent_profile(
            resolved.profile,
            llm_store=llm_store,
            mcp_config=mcp_config,
            available_skills=resolved.skills,
            cipher=self.cipher,
        )
        if not isinstance(settings, OpenHandsAgentSettings):
            raise ValueError("Business packages require an OpenHands agent")
        return settings, resolved

    def create_agent(
        self, logical_id: str, version: str | None = None
    ) -> tuple[Agent, ResolvedPackageAgent]:
        settings, resolved = self.resolve_agent(logical_id, version)
        return settings.create_agent(), resolved
