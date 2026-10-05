"""Public contracts for managed business-agent executions."""

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


TaskStatus = Literal[
    "queued",
    "running",
    "waiting_for_confirmation",
    "cancelling",
    "cancelled",
    "completed",
    "failed",
    "interrupted",
]
ApprovalStatus = Literal["pending", "approved", "rejected", "cancelled"]


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


# @spec GAF-002 — Managed task contract
class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent_id: str = Field(min_length=1, max_length=256)
    task: str = Field(min_length=1, max_length=100_000)
    idempotency_key: str = Field(min_length=1, max_length=256)
    artifact_ids: list[str] = Field(default_factory=list, max_length=100)
    parent_task_id: str | None = None


class TaskRecord(BaseModel):
    id: str
    agent_id: str
    conversation_id: str
    parent_task_id: str | None = None
    status: TaskStatus = "queued"
    task: str
    result: str | None = None
    error: str | None = None
    package_version: str
    created_at: str = Field(default_factory=utc_now)
    updated_at: str = Field(default_factory=utc_now)


class TaskList(BaseModel):
    tasks: list[TaskRecord]


class ToolCallRecord(BaseModel):
    id: str
    task_id: str
    status: str
    read_only: bool
    tool_name: str = "unknown"
    arguments: dict[str, Any] = Field(default_factory=dict)
    package_version: str = "unknown"


class ToolCallList(BaseModel):
    calls: list[ToolCallRecord]


class ResolveToolCallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["not_executed", "executed"]
    evidence: str = Field(min_length=1, max_length=20_000)


# @spec GAF-003 — Server-owned approval decisions
class ApprovalRecord(BaseModel):
    id: str
    task_id: str
    conversation_id: str
    call_id: str
    package_version: str
    tool_name: str
    arguments: dict[str, Any]
    status: ApprovalStatus = "pending"


class ApprovalDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approved: bool


class ApprovalList(BaseModel):
    approvals: list[ApprovalRecord]


# @spec GAF-004 — Immutable managed file references
class ArtifactRecord(BaseModel):
    id: str
    conversation_id: str
    task_id: str | None = None
    name: str
    mime_type: str
    size: int
    version: int = 1


class ArtifactList(BaseModel):
    artifacts: list[ArtifactRecord]
