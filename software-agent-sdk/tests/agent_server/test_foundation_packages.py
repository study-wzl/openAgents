"""Business packages compile into canonical SDK profiles and immutable resources."""

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openhands.agent_server.agent_foundation.packages import PackageRegistry
from openhands.agent_server.agent_foundation.packages_router import packages_router
from openhands.sdk.llm import LLM
from openhands.sdk.llm.llm_profile_store import LLMProfileStore


@pytest.fixture
def package_source(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    (source / "prompts").mkdir(parents=True)
    (source / "skills" / "research").mkdir(parents=True)
    (source / "prompts" / "main.md").write_text("You prepare reports.")
    (source / "skills" / "research" / "SKILL.md").write_text(
        "---\nname: research\ndescription: Find facts for a report.\n---\n"
        "Check every fact against its source.\n"
    )
    manifest = {
        "schema_version": 1,
        "id": "reports",
        "version": "1.0.0",
        "name": "Reports",
        "ui_extension_ref": "report-cards",
        "entry_agents": ["assistant"],
        "agents": [
            {
                "id": agent_id,
                "name": agent_id.title(),
                "llm_profile_ref": "business",
                "system_prompt": "prompts/main.md",
                "tools": [],
                "skills": ["skills/research/SKILL.md"],
                "delegates": ["worker"] if agent_id == "assistant" else [],
            }
            for agent_id in ("assistant", "worker")
        ],
    }
    (source / "agent-package.json").write_text(json.dumps(manifest))
    return source


@pytest.fixture
def registry(tmp_path: Path) -> PackageRegistry:
    llm_store = LLMProfileStore(base_dir=tmp_path / "llms")
    llm_store.save("business", LLM(model="openai/gpt-4o", api_key="test"))
    return PackageRegistry(tmp_path / "packages", llm_store=llm_store, mcp_config={})


# @spec GAF-001 — Explicit business configuration without ambient capabilities
def test_import_compiles_entry_and_worker_using_canonical_profile(
    package_source: Path, registry: PackageRegistry
) -> None:
    installed = registry.install(package_source)
    entries = registry.list_agents()
    agent, config = registry.create_agent("reports/assistant")

    assert installed.id == "reports"
    assert installed.ui_extension_ref == "report-cards"
    assert [entry.id for entry in entries] == ["reports/assistant"]
    assert config.allowed_agents == ["reports/worker"]
    assert agent.static_system_message == "You prepare reports."
    assert agent.tools == []
    assert agent.mcp_tool_allowlist == []
    context = agent.agent_context
    assert context is not None
    assert [skill.name for skill in context.skills] == ["research"]
    assert not any(
        (
            context.load_user_skills,
            context.load_public_skills,
            context.load_project_skills,
            context.load_ambient_plugins,
            context.inherit_global_memory,
            context.load_memory,
        )
    )
    worker, _ = registry.create_agent("reports/worker")
    assert worker.static_system_message == agent.static_system_message
    assert worker.agent_context is not None
    assert [skill.name for skill in worker.agent_context.skills] == ["research"]
    assert not worker.agent_context.load_ambient_plugins


# @spec GAF-001 — Installed content is immutable and versions remain addressable
def test_version_import_and_uninstall_preserve_historical_resources(
    package_source: Path, registry: PackageRegistry
) -> None:
    registry.install(package_source)
    (package_source / "prompts" / "main.md").write_text("A changed report agent.")
    with pytest.raises(ValueError, match="already exists with different content"):
        registry.install(package_source)
    assert registry.create_agent("reports/assistant")[0].system_prompt == (
        "You prepare reports."
    )
    manifest_path = package_source / "agent-package.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["version"] = "2.0.0"
    manifest_path.write_text(json.dumps(manifest))
    registry.install(package_source)
    assert registry.create_agent("reports/assistant")[0].system_prompt == (
        "A changed report agent."
    )
    registry.uninstall("reports")
    assert registry.list_agents() == []
    with pytest.raises(ValueError, match="not enabled"):
        registry.get_agent("reports/assistant")
    old = registry.get_agent("reports/assistant", version="1.0.0")
    assert old.profile.system_prompt == "You prepare reports."
    assert old.skills[0].source is not None
    assert Path(old.skills[0].source).is_file()


# @spec GAF-001 — Validation is read-only; invalid imports never activate
@pytest.mark.parametrize(
    "invalid", ["outside", "delegate", "duplicate", "tool", "unmanaged", "reserved"]
)
def test_invalid_package_cannot_replace_installed_version(
    package_source: Path, registry: PackageRegistry, invalid: str
) -> None:
    registry.install(package_source)
    manifest_path = package_source / "agent-package.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["version"] = "2.0.0"
    agent = manifest["agents"][0]
    if invalid == "outside":
        agent["system_prompt"] = "../private.md"
    elif invalid == "delegate":
        agent["delegates"] = ["missing"]
    elif invalid == "duplicate":
        manifest["agents"].append(agent)
    elif invalid == "unmanaged":
        agent["tools"] = [{"name": "task_tool_set"}]
    elif invalid == "reserved":
        agent["tools"] = [
            {"name": "read_artifact"},
            {"name": "publish_artifact"},
            {"name": "read_package_resource"},
        ]
    else:
        agent["tools"] = [{"name": "unregistered_business_tool"}]
    manifest_path.write_text(json.dumps(manifest))

    validation = registry.validate(package_source)
    assert not validation.valid
    if invalid == "reserved":
        assert "provided by the runtime" in validation.errors[0]
    with pytest.raises(ValueError):
        registry.install(package_source)
    assert registry.list_packages()[0].version == "1.0.0"


def test_modified_installed_resources_are_rejected(
    package_source: Path, registry: PackageRegistry
) -> None:
    registry.install(package_source)
    installed = registry.get_agent("reports/assistant")
    (installed.package_root / "prompts" / "main.md").write_text("Changed on disk")

    with pytest.raises(ValueError, match="content has changed"):
        registry.get_agent("reports/assistant")
    with pytest.raises(ValueError, match="content has changed"):
        registry.install(package_source)


def test_enable_toggle_and_reimport_are_durable_and_idempotent(
    tmp_path: Path, package_source: Path, registry: PackageRegistry
) -> None:
    first = registry.install(package_source)
    again = registry.install(package_source)
    assert first.content_hash == again.content_hash
    registry.set_enabled("reports", False)
    reloaded = PackageRegistry(tmp_path / "packages")
    assert not reloaded.list_agents()[0].enabled
    with pytest.raises(ValueError, match="not enabled"):
        reloaded.get_agent("reports/assistant")
    reloaded.set_enabled("reports", True)
    assert reloaded.get_agent("reports/assistant").summary.enabled


def test_package_http_lifecycle(
    package_source: Path, registry: PackageRegistry
) -> None:
    app = FastAPI()
    app.state.package_registry = registry
    app.include_router(packages_router, prefix="/api")
    with TestClient(app) as client:
        prefix = "/api/agent-foundation"
        assert client.post(
            f"{prefix}/packages/validate", json={"source": str(package_source)}
        ).json()["valid"]
        assert client.get(f"{prefix}/packages").json() == {"packages": []}
        installed = client.post(
            f"{prefix}/packages/install", json={"source": str(package_source)}
        )
        assert installed.status_code == 200
        assert client.get(f"{prefix}/agents").json()["agents"][0]["id"] == (
            "reports/assistant"
        )
        disabled = client.patch(f"{prefix}/packages/reports", json={"enabled": False})
        assert not disabled.json()["enabled"]
        config = client.get(f"{prefix}/agents/reports/assistant/config")
        assert config.status_code == 200
        assert config.json()["read_only"]
        assert config.json()["profile"]["system_prompt"] == "You prepare reports."
        assert config.json()["content_hash"] == installed.json()["content_hash"]
        assert config.json()["external_dependencies_pinned"] is False
        assert config.json()["runtime_tools"] == [
            "finish",
            "think",
            "invoke_skill",
            "read_artifact",
            "publish_artifact",
            "read_package_resource",
            "delegate_agent",
        ]
        assert config.json()["child_runtime_tools"] == [
            "finish",
            "think",
            "invoke_skill",
            "read_artifact",
            "publish_artifact",
            "read_package_resource",
        ]
        assert "api_key" not in config.text
        assert client.delete(f"{prefix}/packages/reports").status_code == 204
        assert client.get(f"{prefix}/agents").json() == {"agents": []}
