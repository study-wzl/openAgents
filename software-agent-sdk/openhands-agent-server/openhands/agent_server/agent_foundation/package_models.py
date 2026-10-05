"""The thin, reference-only business package installation contract."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from openhands.sdk.profiles.agent_profile import OpenHandsAgentProfile
from openhands.sdk.tool import Tool


PackageIdentifier = Annotated[
    str, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$", max_length=64)
]
PackageVersion = Annotated[
    str,
    Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9][a-z0-9.-]*)?$", max_length=64),
]


class ToolPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requires_confirmation: bool = True
    timeout_seconds: float = Field(default=120, gt=0, le=3600)
    cancellable: bool = False


class PackageAgent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: PackageIdentifier
    name: str = Field(min_length=1, max_length=128)
    description: str = ""
    llm_profile_ref: str = Field(min_length=1)
    system_prompt: str = Field(min_length=1)
    tools: list[Tool] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    mcp_server_refs: list[str] = Field(default_factory=list)
    mcp_tools: list[str] = Field(default_factory=list)
    secret_refs: list[str] = Field(default_factory=list)
    delegates: list[PackageIdentifier] = Field(default_factory=list)
    tool_policies: dict[str, ToolPolicy] = Field(default_factory=dict)


# @spec GAF-001 — Business packages reference canonical SDK configuration
class PackageManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    id: PackageIdentifier
    version: PackageVersion
    name: str = Field(min_length=1, max_length=128)
    description: str = ""
    ui_extension_ref: str | None = Field(default=None, min_length=1, max_length=128)
    entry_agents: list[PackageIdentifier] = Field(min_length=1)
    agents: list[PackageAgent] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_agent_references(self) -> "PackageManifest":
        ids = [agent.id for agent in self.agents]
        if len(set(ids)) != len(ids):
            raise ValueError("Agent IDs must be unique within a package")
        if len(set(self.entry_agents)) != len(self.entry_agents):
            raise ValueError("Entry agent IDs must be unique")
        if missing := set(self.entry_agents) - set(ids):
            raise ValueError(f"Unknown entry agents: {sorted(missing)}")
        for agent in self.agents:
            if missing := set(agent.delegates) - set(ids):
                raise ValueError(f"Unknown delegates for {agent.id}: {sorted(missing)}")
            if agent.id in agent.delegates:
                raise ValueError(f"Agent {agent.id} cannot delegate to itself")
            names = [tool.name for tool in agent.tools]
            if len(set(names)) != len(names):
                raise ValueError(f"Duplicate tools for {agent.id}")
        return self


class PackageInfo(BaseModel):
    id: str
    version: str
    name: str
    description: str
    enabled: bool
    content_hash: str
    ui_extension_ref: str | None = None


class AgentInfo(BaseModel):
    id: str
    name: str
    description: str
    profile_id: str
    package_id: str
    package_version: str
    enabled: bool


class PackageValidation(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    package: PackageInfo | None = None


class PackageListResponse(BaseModel):
    packages: list[PackageInfo]


class AgentListResponse(BaseModel):
    agents: list[AgentInfo]


class AgentEffectiveConfig(BaseModel):
    """Readable package configuration without resolved credential values."""

    agent: AgentInfo
    profile: OpenHandsAgentProfile
    content_hash: str
    resolved_model: str
    resolved_skills: list[str]
    allowed_agents: list[str]
    tool_policies: dict[str, ToolPolicy]
    runtime_tools: list[str]
    child_runtime_tools: list[str]
    delegation_note: str
    managed_by_package: Literal[True] = True
    read_only: Literal[True] = True
    external_dependencies_pinned: Literal[False] = False


class PackageSourceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(min_length=1)


class PackageEnabledRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
