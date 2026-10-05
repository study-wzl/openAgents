"""Durable orchestration around ConversationService and its native SDK engine."""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import shutil
import threading
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlsplit
from uuid import UUID, uuid4

from pydantic import SecretStr

from openhands.agent_server.agent_foundation.execution import (
    FoundationAgent,
    bind_runtime,
)
from openhands.agent_server.agent_foundation.package_models import ToolPolicy
from openhands.agent_server.agent_foundation.runtime_models import (
    ArtifactRecord,
    CreateTaskRequest,
    ResolveToolCallRequest,
    TaskRecord,
    ToolCallRecord,
)
from openhands.agent_server.agent_foundation.runtime_tools import (
    DelegateAgentAction,
    DelegateAgentTool,
    FoundationObservation,
    PublishArtifactAction,
    PublishArtifactTool,
    ReadArtifactTool,
    ReadPackageResourceTool,
)
from openhands.agent_server.agent_foundation.store import ACTIVE, FoundationStore
from openhands.agent_server.persistence import get_secrets_store
from openhands.sdk.conversation.request import StartConversationRequest
from openhands.sdk.conversation.state import ConversationExecutionStatus
from openhands.sdk.event import (
    ActionEvent,
    AgentErrorEvent,
    Event,
    ObservationEvent,
    UserRejectObservation,
)
from openhands.sdk.llm import Message, TextContent
from openhands.sdk.mcp.definition import MCPToolObservation
from openhands.sdk.secret import StaticSecret
from openhands.sdk.tool import Tool
from openhands.sdk.workspace import LocalWorkspace


if TYPE_CHECKING:
    from openhands.agent_server.agent_foundation.packages import PackageRegistry
    from openhands.agent_server.conversation_service import ConversationService
    from openhands.sdk.conversation import LocalConversation


MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
_CONTROL_TOOLS = {
    "finish",
    "think",
    "invoke_skill",
    "delegate_agent",
    "read_artifact",
    "read_package_resource",
    "publish_artifact",
}


# @spec GAF-002 — A managed task owns a real, separately persisted SDK conversation
class AgentFoundationRuntime:
    def __init__(
        self, root: Path, registry: PackageRegistry, conversations: ConversationService
    ):
        self.root = root.resolve()
        self.registry = registry
        self.conversations = conversations
        self.store = FoundationStore(self.root / "runtime.sqlite3")
        self._runs: dict[str, asyncio.Task] = {}
        self._refreshes: set[asyncio.Task] = set()
        self._cancel: dict[str, threading.Event] = {}
        self._inflight: dict[str, int] = {}
        self._lock = threading.RLock()
        self._current = threading.local()
        self.loop: asyncio.AbstractEventLoop
        self._closing = False

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.store.reconcile()
        bind_runtime(self)

    async def close(self) -> None:
        self._closing = True
        active = [task for task in self.store.list_tasks() if task.status in ACTIVE]
        # Let approval waits drain without SDK cancellation observations. Their
        # unmatched ActionEvents are then replayable through the native loop.
        for task in active:
            self._cancel.setdefault(task.id, threading.Event()).set()
        if self._runs:
            await asyncio.wait(list(self._runs.values()), timeout=5)
        for task in active:
            if self.store.get_task(task.id).status in ACTIVE:
                await self.cancel(task.id)
        if self._refreshes:
            await asyncio.wait(list(self._refreshes), timeout=5)

    def workspace(self, task_id: str) -> Path:
        self.store.get_task(task_id)
        return self.root / "workspaces" / task_id

    def current_action_id(self) -> str:
        return self._current.action_id

    async def create_task(self, request: CreateTaskRequest) -> TaskRecord:
        if self._closing:
            raise ValueError("Runtime is shutting down")
        previous = self.store.find_request(request)
        if previous is not None:
            return previous
        parent = (
            self.store.get_task(request.parent_task_id)
            if request.parent_task_id
            else None
        )
        version = parent.package_version if parent else None
        if parent:
            parent_agent = self.registry.get_agent(parent.agent_id, version=version)
            if request.agent_id not in parent_agent.allowed_agents:
                raise ValueError("Agent is not an allowed delegate of this parent")
        for artifact_id in request.artifact_ids:
            self.store.get_artifact(artifact_id)
            if parent and not self.store.allowed_artifact(parent.id, artifact_id):
                raise ValueError("Artifact was not granted to the parent task")
        resolved = self.registry.get_agent(request.agent_id, version=version)
        task, created = self.store.create_task(
            request, resolved.summary.package_version, parent
        )
        if not created:
            return task
        try:
            agent, resolved = self.registry.create_agent(
                request.agent_id, version=task.package_version
            )
            workspace = self.workspace(task.id)
            workspace.mkdir(parents=True, exist_ok=True)
            params = {"root": str(self.root), "task_id": task.id}
            tools = [
                *agent.tools,
                Tool(name=ReadArtifactTool.name, params=params),
                Tool(name=ReadPackageResourceTool.name, params=params),
                Tool(name=PublishArtifactTool.name, params=params),
            ]
            if not parent and resolved.allowed_agents:
                tools.append(
                    Tool(
                        name=DelegateAgentTool.name,
                        params=params | {"allowed_agents": resolved.allowed_agents},
                    )
                )
            managed = FoundationAgent(
                **(
                    agent.model_dump(
                        mode="python",
                        exclude={"kind", "llm", "tools", "tool_concurrency_limit"},
                        context={"expose_secrets": True},
                    )
                ),
                llm=agent.llm,
                tools=tools,
                tool_concurrency_limit=4
                if not parent
                else agent.tool_concurrency_limit,
                foundation_root=str(self.root),
                foundation_task_id=task.id,
                foundation_tool_policies=resolved.tool_policies,
            )
            secrets = {}
            secret_store = self.conversations.secrets_store or get_secrets_store()
            for name in resolved.secret_names:
                value = secret_store.get_secret(name)
                if value is None:
                    raise ValueError(f"Required secret is unavailable: {name}")
                secrets[name] = StaticSecret(value=SecretStr(value))
            await self.conversations.start_conversation(
                StartConversationRequest(
                    conversation_id=UUID(task.conversation_id),
                    agent=managed,
                    workspace=LocalWorkspace(working_dir=str(workspace)),
                    worktree=False,
                    autotitle=False,
                    max_iterations=100,
                    secrets=secrets,
                    tags={"foundationtask": task.id},
                )
            )
            service = await self._service(task)
            text = request.task
            if request.artifact_ids:
                text += "\n\nAttached artifact IDs: " + ", ".join(request.artifact_ids)
            await service.send_message(
                Message(role="user", content=[TextContent(text=text)]), run=False
            )
            self._schedule(task.id)
        except Exception as exc:
            self.store.update_task(task.id, status="failed", error=str(exc))
            raise
        return self.store.get_task(task.id)

    async def _service(self, task: TaskRecord):
        service = await self.conversations.get_event_service(UUID(task.conversation_id))
        if service is None:
            raise ValueError("Task conversation is missing")
        if not isinstance(service.get_conversation().agent, FoundationAgent):
            raise ValueError("Task conversation has lost its managed execution policy")
        return service

    def _schedule(self, task_id: str) -> None:
        existing = self._runs.get(task_id)
        if existing and not existing.done():
            raise ValueError("Task is already running")
        self._cancel[task_id] = threading.Event()
        self.store.update_task(task_id, status="running", error=None)
        self._runs[task_id] = asyncio.create_task(self._drive(task_id))

    async def _drive(self, task_id: str) -> None:
        try:
            service = await self._service(self.store.get_task(task_id))
            await service.run()
            status = await service.wait_for_run_completion()
            while self._inflight.get(task_id, 0):
                await asyncio.sleep(0.05)
            if self._cancel[task_id].is_set():
                self.store.update_task(task_id, status=self.stopped_status())
            elif status == ConversationExecutionStatus.FINISHED:
                self.store.update_task(
                    task_id,
                    status="completed",
                    result=self.result_envelope(
                        task_id, await service.get_agent_final_response()
                    ),
                )
            elif status in (
                ConversationExecutionStatus.ERROR,
                ConversationExecutionStatus.STUCK,
            ):
                self.store.update_task(
                    task_id,
                    status="failed",
                    error=self.store.get_task(task_id).error
                    or f"SDK execution ended: {status.value}",
                )
            else:
                self.store.update_task(task_id, status="interrupted")
        except Exception as exc:
            self.store.update_task(task_id, status="failed", error=str(exc))

    def before_step(
        self, task_id: str, agent: FoundationAgent, conversation: LocalConversation
    ) -> None:
        task = self.store.get_task(task_id)
        if self._closing or task.status in ("interrupted", "cancelled", "cancelling"):
            raise ValueError("Managed task requires explicit resume before execution")
        try:
            self._check_unknown_writes(task_id)
            self.validate_resume_configuration(task, agent, conversation)
        except Exception as exc:
            # Native conversation follow-ups have no _drive owner to mirror an
            # early guard failure. Do not leave their previous result completed.
            self.store.update_task(task_id, status="failed", error=str(exc))
            raise
        if task.status in ("completed", "queued", "failed"):
            self._cancel[task_id] = threading.Event()
            self.store.update_task(task_id, status="running", error=None)

    async def after_step(self, task_id: str, conversation: LocalConversation) -> None:
        def status_snapshot():
            with conversation._state:
                return conversation._state.execution_status

        status = await asyncio.to_thread(status_snapshot)
        managed_run = self._runs.get(task_id)
        if managed_run is not None and not managed_run.done():
            return
        if status == ConversationExecutionStatus.FINISHED:
            service = await self._service(self.store.get_task(task_id))
            self.store.update_task(
                task_id,
                status="completed",
                result=self.result_envelope(
                    task_id, await service.get_agent_final_response()
                ),
            )
        elif status in (
            ConversationExecutionStatus.ERROR,
            ConversationExecutionStatus.STUCK,
        ):
            self.store.update_task(
                task_id,
                status="failed",
                error=self.store.get_task(task_id).error
                or f"SDK execution ended: {status.value}",
            )
        elif status == ConversationExecutionStatus.PAUSED:
            if self.store.get_task(task_id).status in ACTIVE:
                await self.cancel(task_id)

    def schedule_status_refresh(
        self, task_id: str, conversation: LocalConversation
    ) -> None:
        task = asyncio.create_task(self.after_step(task_id, conversation))
        self._refreshes.add(task)
        task.add_done_callback(self._refreshes.discard)

    def result_envelope(self, task_id: str, text: str) -> str:
        task = self.store.get_task(task_id)
        return json.dumps(
            {
                "package_id": task.agent_id.partition("/")[0],
                "tool_name": "task_result",
                "schema_version": 1,
                "text": text,
                "data": {"tool_results": self.store.completed_results(task_id)},
                "artifacts": [
                    artifact.model_dump()
                    for artifact in self.store.list_artifacts(task.conversation_id)
                    if artifact.task_id == task.id
                ],
            }
        )

    async def cancel(self, task_id: str) -> TaskRecord:
        task = self.store.get_task(task_id)
        if task.status not in ACTIVE:
            return task
        self._cancel.setdefault(task_id, threading.Event()).set()
        if not self._closing:
            self.store.cancel_approvals(task_id)
        self.store.update_task(task_id, status="cancelling")
        for child in self.store.list_tasks(task.conversation_id):
            if child.parent_task_id == task.id:
                await self.cancel(child.id)
        await self.conversations.interrupt_conversation(UUID(task.conversation_id))
        if not self._inflight.get(task_id, 0):
            self.store.update_task(task_id, status=self.stopped_status())
        return self.store.get_task(task_id)

    def stopped_status(self):
        return "interrupted" if self._closing else "cancelled"

    def _check_unknown_writes(self, task_id: str, *, include_running: bool = True):
        affected = self.store.unknown_write_tasks(
            task_id, include_running=include_running
        )
        if affected:
            raise ValueError(
                "A write has an unknown outcome in task(s): "
                + ", ".join(affected)
                + ". Verify these operations before resuming or retrying."
            )

    async def resume(self, task_id: str) -> TaskRecord:
        task = self.store.get_task(task_id)
        if task.status not in ("interrupted", "cancelled", "failed"):
            raise ValueError("Only stopped tasks can be resumed")
        if self._inflight.get(task_id, 0):
            raise ValueError("A write has an unknown outcome; retry is blocked")
        self._check_unknown_writes(task_id)
        service = await self._service(task)
        conversation = service.get_conversation()
        agent = conversation.agent
        if not isinstance(agent, FoundationAgent):
            raise ValueError("Managed execution policy is missing")
        self.validate_resume_configuration(task, agent, conversation)
        self._schedule(task_id)
        return self.store.get_task(task_id)

    async def decide(self, approval_id: str, approved: bool):
        return self.store.decide(approval_id, approved)

    def validate_resume_configuration(
        self, task: TaskRecord, agent: FoundationAgent, conversation: LocalConversation
    ) -> None:
        current, resolved = self.registry.resolve_agent(
            task.agent_id, version=task.package_version
        )
        if not resolved.summary.enabled:
            raise ValueError("The package is disabled; execution is blocked")
        original_llm = agent.llm.model_dump(
            mode="json", exclude={"usage_id"}, context={"expose_secrets": True}
        )
        current_llm = current.llm.model_dump(
            mode="json", exclude={"usage_id"}, context={"expose_secrets": True}
        )
        if original_llm != current_llm or agent.mcp_config != current.mcp_config:
            raise ValueError("LLM or MCP configuration changed; start a new task")
        secrets = self.conversations.secrets_store or get_secrets_store()
        if any(secrets.get_secret(name) is None for name in resolved.secret_names):
            raise ValueError("A required credential was revoked; execution is blocked")
        if any(
            secrets.get_secret(name)
            != conversation.state.secret_registry.get_secret_value(name)
            for name in resolved.secret_names
        ):
            raise ValueError("A credential changed; start a new task")

    async def resolve_call(
        self, task_id: str, call_id: str, request: ResolveToolCallRequest
    ):
        task = self.store.get_task(task_id)
        if task.status not in (
            "interrupted",
            "cancelled",
            "failed",
        ) or self._inflight.get(task_id, 0):
            raise ValueError("Stop the task and wait for all tools before reconciling")
        service = await self._service(task)

        def action_snapshot():
            conversation = service.get_conversation()
            with conversation._state:
                return next(
                    (
                        event
                        for event in conversation._state.events
                        if isinstance(event, ActionEvent) and event.id == call_id
                    ),
                    None,
                )

        action = await asyncio.to_thread(action_snapshot)
        if action is None:
            raise KeyError("SDK action not found")
        result = None
        if request.outcome == "executed":
            observation = ObservationEvent(
                action_id=action.id,
                tool_name=action.tool_name,
                tool_call_id=action.tool_call_id,
                observation=FoundationObservation.from_text(
                    "A human verified this operation executed. Evidence: "
                    + request.evidence
                ),
            )
            result = json.dumps([observation.model_dump(mode="json")])
        changed = self.store.resolve_call(
            task_id, call_id, request.outcome, request.evidence, result
        )
        if changed:
            verification = Message(
                role="user",
                content=[
                    TextContent(
                        text=(
                            f"Human verification for {action.tool_name}, "
                            f"task {task_id}, action {call_id}: "
                            f"outcome={request.outcome}. Evidence: {request.evidence}. "
                            "Do not repeat an operation verified as executed."
                        )
                    )
                ],
            )
            await service.send_message(verification, run=False)
            if task.parent_task_id:
                parent = await self._service(self.store.get_task(task.parent_task_id))
                await parent.send_message(verification, run=False)
        self.store.update_task(task_id, status="interrupted", error=None)
        return next(
            call for call in self.store.list_calls(task_id) if call.id == call_id
        )

    async def delegate(
        self, parent_id: str, action_id: str, action: DelegateAgentAction
    ) -> str:
        child = await self.create_task(
            CreateTaskRequest(
                agent_id=action.agent_id,
                task=action.task,
                artifact_ids=action.artifact_ids,
                parent_task_id=parent_id,
                idempotency_key=action_id,
            )
        )
        if child.status == "interrupted" and not self._closing:
            child = await self.resume(child.id)
        while child.status in ACTIVE:
            if (
                not self._closing
                and self._cancel.get(parent_id, threading.Event()).is_set()
            ):
                await self.cancel(child.id)
            await asyncio.sleep(0.05)
            child = self.store.get_task(child.id)
        if child.status == "completed":
            artifacts = self.store.list_artifacts(child.conversation_id)
            for artifact in artifacts:
                if artifact.task_id == child.id:
                    self.store.grant_artifact(parent_id, artifact.id)
            return json.dumps(
                {
                    "task_id": child.id,
                    "result": child.result,
                    "artifact_ids": [a.id for a in artifacts if a.task_id == child.id],
                }
            )
        return json.dumps(
            {"task_id": child.id, "status": child.status, "error": child.error}
        )

    # @spec GAF-003 — Decisions are durable and tied to one SDK action ID
    def execute_tool(
        self,
        agent: FoundationAgent,
        conversation: LocalConversation,
        action: ActionEvent,
        execute: Callable[[], list[Event]],
    ) -> list[Event]:
        task_id = agent.foundation_task_id
        task = self.store.get_task(task_id)
        if action.action is None:
            raise ValueError("Cannot execute an invalid SDK action")
        masked = conversation.state.secret_registry.mask_secrets_in_model(action.action)
        arguments = masked.model_dump(mode="json")
        cancelled = self._cancel.setdefault(task_id, threading.Event())
        token = conversation.cancel_token
        tool = agent.tools_map.get(action.tool_name)
        readonly = bool(tool and tool.annotations and tool.annotations.readOnlyHint)
        # Delegation is itself idempotent, keyed by the parent's SDK action ID.
        readonly = readonly or action.tool_name == "delegate_agent"
        previous = self.store.call(task_id, action.id)
        if previous and previous[0] == "completed" and previous[1]:
            return [Event.model_validate(value) for value in json.loads(previous[1])]
        if previous and previous[0] in ("running", "unknown") and not readonly:
            raise ValueError("Previous write outcome is unknown; refusing to retry")
        self._check_unknown_writes(task_id, include_running=False)
        policy = agent.foundation_tool_policies.get(action.tool_name, ToolPolicy())
        with self._lock:
            self._inflight[task_id] = self._inflight.get(task_id, 0) + 1
        timer = None
        try:
            if policy.requires_confirmation and action.tool_name not in _CONTROL_TOOLS:
                approval = self.store.ensure_approval(
                    task, action.id, action.tool_name, arguments
                )
                while approval.status == "pending" and not cancelled.is_set():
                    if token and token.is_cancelled:
                        cancelled.set()
                        break
                    self.store.update_task(task_id, status="waiting_for_confirmation")
                    cancelled.wait(0.1)
                    approval = self.store.get_approval(approval.id)
                if approval.status != "approved" or cancelled.is_set():
                    if self._closing:
                        return []
                    return [
                        UserRejectObservation(
                            action_id=action.id,
                            tool_name=action.tool_name,
                            tool_call_id=action.tool_call_id,
                            rejection_reason="Tool execution was rejected or cancelled",
                        )
                    ]
            if cancelled.is_set():
                if self._closing:
                    return []
                raise ValueError("Task was cancelled before tool dispatch")
            self.validate_resume_configuration(task, agent, conversation)
            self._check_unknown_writes(task_id, include_running=False)
            self.store.update_task(task_id, status="running")
            self.store.save_call(
                task_id,
                action.id,
                "running",
                readonly,
                details=ToolCallRecord(
                    id=action.id,
                    task_id=task_id,
                    status="running",
                    read_only=readonly,
                    tool_name=action.tool_name,
                    arguments=arguments,
                    package_version=task.package_version,
                ),
            )

            def timeout():
                self.store.update_task(
                    task_id, error=f"Tool timed out: {action.tool_name}"
                )
                asyncio.run_coroutine_threadsafe(self.cancel(task_id), self.loop)
                if policy.cancellable and tool and tool.executor:
                    tool.executor.interrupt()

            if action.tool_name != "delegate_agent":
                timer = threading.Timer(policy.timeout_seconds, timeout)
                timer.daemon = True
                timer.start()
            self._current.action_id = action.id
            result = [
                conversation.state.secret_registry.mask_secrets_in_model(event)
                for event in execute()
            ]
            if self._closing and action.tool_name == "delegate_agent":
                return []
            for index, event in enumerate(result):
                if isinstance(event, ObservationEvent) and isinstance(
                    event.observation, MCPToolObservation
                ):
                    artifacts = self.import_mcp_resources(task, event.observation)
                    if artifacts:
                        observation = event.observation.model_copy(
                            update={
                                "content": [
                                    *event.observation.content,
                                    TextContent(
                                        text="Managed artifacts: "
                                        + json.dumps(
                                            [a.model_dump() for a in artifacts]
                                        )
                                    ),
                                ]
                            }
                        )
                        result[index] = event.model_copy(
                            update={"observation": observation}
                        )
            uncertain = not readonly and any(
                isinstance(event, AgentErrorEvent)
                or (isinstance(event, ObservationEvent) and event.observation.is_error)
                for event in result
            )
            self.store.save_call(
                task_id,
                action.id,
                "unknown" if uncertain else "completed",
                readonly,
                json.dumps([event.model_dump(mode="json") for event in result]),
            )
            return result
        except BaseException:
            if self.store.call(task_id, action.id):
                self.store.save_call(task_id, action.id, "unknown", readonly)
            raise
        finally:
            if timer:
                timer.cancel()
            with self._lock:
                self._inflight[task_id] -= 1
            if cancelled.is_set() and not self._inflight[task_id]:
                self.store.update_task(task_id, status=self.stopped_status())

    def import_mcp_resources(
        self, task: TaskRecord, observation: MCPToolObservation
    ) -> list[ArtifactRecord]:
        records = []
        for resource in observation.resource_contents:
            if "text" in resource:
                data = resource["text"].encode("utf-8")
            elif "blob" in resource:
                encoded = resource["blob"]
                if len(encoded) > (MAX_ARTIFACT_BYTES + 2) // 3 * 4:
                    raise ValueError("MCP resource exceeds 25 MiB")
                data = base64.b64decode(encoded, validate=True)
            else:
                continue
            name = unquote(urlsplit(str(resource.get("uri", ""))).path).rsplit("/", 1)[
                -1
            ]
            records.append(
                self.save_upload(
                    task.conversation_id,
                    name or "mcp-resource",
                    resource.get("mimeType") or "application/octet-stream",
                    data,
                )
            )
        return records

    # @spec GAF-004 — The server owns file storage, scope and immutable versions
    def save_upload(
        self, conversation_id: str, name: str, mime_type: str, data: bytes
    ) -> ArtifactRecord:
        task = self.store.task_for_conversation(conversation_id)
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError("Artifact exceeds 25 MiB")
        name = name.replace("\\", "/").rsplit("/", 1)[-1]
        if not name or name in (".", ".."):
            raise ValueError("Artifact needs a filename")
        record = ArtifactRecord(
            id=str(uuid4()),
            conversation_id=conversation_id,
            task_id=task.id,
            name=name,
            mime_type=mime_type,
            size=len(data),
        )
        directory = self.root / "artifacts"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / record.id
        path.write_bytes(data)
        try:
            self.store.save_artifact(record)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return record

    def artifact_path(self, artifact_id: str) -> Path:
        record = self.store.get_artifact(artifact_id)
        return self.root / "artifacts" / record.id

    def publish_artifact(
        self, task_id: str, action: PublishArtifactAction
    ) -> ArtifactRecord:
        workspace = self.workspace(task_id).resolve()
        path = (workspace / action.path).resolve()
        if Path(action.path).is_absolute() or not path.is_relative_to(workspace):
            raise ValueError("Artifact path must remain inside this task's workspace")
        if not path.is_file() or path.stat().st_size > MAX_ARTIFACT_BYTES:
            raise ValueError("Artifact must be a file of at most 25 MiB")
        return self.save_upload(
            self.store.get_task(task_id).conversation_id,
            action.name or path.name,
            action.mime_type
            or mimetypes.guess_type(path.name)[0]
            or "application/octet-stream",
            path.read_bytes(),
        )

    def read_artifact(self, task_id: str, artifact_id: str) -> str:
        if not self.store.allowed_artifact(task_id, artifact_id):
            raise ValueError("Artifact was not granted to this task")
        record = self.store.get_artifact(artifact_id)
        path = self.artifact_path(artifact_id)
        workspace = self.workspace(task_id)
        destination = workspace / "attachments" / record.id
        if not destination.resolve().is_relative_to(workspace.resolve()):
            raise ValueError("Artifact staging path escapes this task's workspace")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        output = record.model_dump() | {"workspace_path": f"attachments/{record.id}"}
        if record.size <= 256 * 1024:
            try:
                output["text"] = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                pass
        return json.dumps(output)

    def read_package_resource(self, task_id: str, relative: str) -> str:
        task = self.store.get_task(task_id)
        resolved = self.registry.get_agent(task.agent_id, version=task.package_version)
        root = resolved.package_root.resolve()
        relative_path = PurePosixPath(relative)
        if (
            relative_path.is_absolute()
            or ".." in relative_path.parts
            or "\\" in relative
            or ":" in relative
        ):
            raise ValueError("Package resource must be a relative POSIX path")
        path = (root / relative_path).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("Package resource is missing or outside the package")
        if path.stat().st_size > 256 * 1024:
            raise ValueError("Package text resource exceeds 256 KiB")
        try:
            return path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("Package resource must be UTF-8 text") from exc
