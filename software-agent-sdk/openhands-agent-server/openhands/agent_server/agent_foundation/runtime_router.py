"""Authenticated Agent Server endpoints for managed task execution."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from openhands.agent_server.agent_foundation.runtime import (
    MAX_ARTIFACT_BYTES,
    AgentFoundationRuntime,
)
from openhands.agent_server.agent_foundation.runtime_models import (
    ApprovalDecision,
    ApprovalList,
    ApprovalRecord,
    ArtifactList,
    ArtifactRecord,
    CreateTaskRequest,
    ResolveToolCallRequest,
    TaskList,
    TaskRecord,
    ToolCallList,
    ToolCallRecord,
)


router = APIRouter(prefix="/agent-foundation", tags=["Agent Foundation"])


def get_runtime(request: Request) -> AgentFoundationRuntime:
    runtime = getattr(request.app.state, "agent_foundation_runtime", None)
    if runtime is None:
        raise HTTPException(503, "Managed task runtime is unavailable")
    return runtime


Runtime = Annotated[AgentFoundationRuntime, Depends(get_runtime)]


def failure(error: Exception) -> HTTPException:
    return HTTPException(404 if isinstance(error, KeyError) else 409, str(error))


# @spec GAF-002 — Task lifecycle uses a stable ID and an idempotent create request
@router.post("/tasks", response_model=TaskRecord)
async def create_task(body: CreateTaskRequest, runtime: Runtime) -> TaskRecord:
    try:
        return await runtime.create_task(body)
    except (ValueError, KeyError) as exc:
        raise failure(exc) from exc


@router.get("/tasks", response_model=TaskList)
async def list_tasks(runtime: Runtime, conversation_id: str | None = None) -> TaskList:
    return TaskList(tasks=runtime.store.list_tasks(conversation_id))


@router.get("/tasks/{task_id}", response_model=TaskRecord)
async def get_task(task_id: str, runtime: Runtime) -> TaskRecord:
    try:
        return runtime.store.get_task(task_id)
    except KeyError as exc:
        raise failure(exc) from exc


@router.post("/tasks/{task_id}/cancel", response_model=TaskRecord)
async def cancel_task(task_id: str, runtime: Runtime) -> TaskRecord:
    try:
        return await runtime.cancel(task_id)
    except (ValueError, KeyError) as exc:
        raise failure(exc) from exc


@router.post("/tasks/{task_id}/resume", response_model=TaskRecord)
async def resume_task(task_id: str, runtime: Runtime) -> TaskRecord:
    try:
        return await runtime.resume(task_id)
    except (ValueError, KeyError) as exc:
        raise failure(exc) from exc


@router.get("/tasks/{task_id}/calls", response_model=ToolCallList)
async def list_calls(task_id: str, runtime: Runtime) -> ToolCallList:
    try:
        return ToolCallList(calls=runtime.store.list_calls(task_id))
    except KeyError as exc:
        raise failure(exc) from exc


# @spec GAF-003 — Unknown writes require a recorded human reconciliation
@router.post("/tasks/{task_id}/calls/{call_id}/resolve", response_model=ToolCallRecord)
async def resolve_call(
    task_id: str, call_id: str, body: ResolveToolCallRequest, runtime: Runtime
) -> ToolCallRecord:
    try:
        return await runtime.resolve_call(task_id, call_id, body)
    except (KeyError, ValueError) as exc:
        raise failure(exc) from exc


# @spec GAF-003 — Nested approvals remain actionable without the parent browser
@router.get("/approvals", response_model=ApprovalList)
async def list_approvals(conversation_id: str, runtime: Runtime) -> ApprovalList:
    return ApprovalList(approvals=runtime.store.list_approvals(conversation_id))


@router.post("/approvals/{approval_id}/decision", response_model=ApprovalRecord)
async def decide_approval(
    approval_id: str, body: ApprovalDecision, runtime: Runtime
) -> ApprovalRecord:
    try:
        return await runtime.decide(approval_id, body.approved)
    except (ValueError, KeyError) as exc:
        raise failure(exc) from exc


# @spec GAF-004 — Upload and download use authenticated, server-issued references
@router.post("/artifacts", response_model=ArtifactRecord)
async def upload_artifact(
    conversation_id: str, file: UploadFile, runtime: Runtime
) -> ArtifactRecord:
    try:
        data = await file.read(MAX_ARTIFACT_BYTES + 1)
        if len(data) > MAX_ARTIFACT_BYTES:
            raise HTTPException(413, "Artifact exceeds 25 MiB")
        return runtime.save_upload(
            conversation_id,
            file.filename or "attachment",
            file.content_type or "application/octet-stream",
            data,
        )
    except (ValueError, KeyError) as exc:
        raise failure(exc) from exc
    finally:
        await file.close()


@router.get("/artifacts", response_model=ArtifactList)
async def list_artifacts(conversation_id: str, runtime: Runtime) -> ArtifactList:
    return ArtifactList(artifacts=runtime.store.list_artifacts(conversation_id))


@router.get("/artifacts/{artifact_id}/download")
async def download_artifact(artifact_id: str, runtime: Runtime) -> FileResponse:
    try:
        record = runtime.store.get_artifact(artifact_id)
        return FileResponse(
            runtime.artifact_path(artifact_id),
            media_type=record.mime_type,
            filename=record.name,
        )
    except KeyError as exc:
        raise failure(exc) from exc
