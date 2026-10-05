"""Exercise the existing SDK engine through managed delegation and approvals."""

import asyncio
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from openhands.agent_server.agent_foundation.execution import FoundationAgent
from openhands.agent_server.agent_foundation.package_models import ToolPolicy
from openhands.agent_server.agent_foundation.runtime import AgentFoundationRuntime
from openhands.agent_server.agent_foundation.runtime_models import (
    CreateTaskRequest,
    ResolveToolCallRequest,
)
from openhands.agent_server.agent_foundation.runtime_tools import PublishArtifactAction
from openhands.agent_server.agent_foundation.store import FoundationStore
from openhands.agent_server.conversation_service import ConversationService
from openhands.sdk import Agent, Tool
from openhands.sdk.context import AgentContext
from openhands.sdk.conversation.state import ConversationExecutionStatus
from openhands.sdk.event import MessageEvent
from openhands.sdk.llm import Message, MessageToolCall, TextContent
from openhands.sdk.mcp.config import coerce_mcp_config
from openhands.sdk.testing import TestLLM
from openhands.sdk.tool import Action, Observation, ToolDefinition, ToolExecutor
from openhands.sdk.tool.registry import register_tool


class ProbeAction(Action):
    text: str
    delay: float = 0
    fail_after_write: bool = False


class ProbeObservation(Observation):
    pass


class ProbeExecutor(ToolExecutor):
    def __init__(self):
        self.stopped = threading.Event()

    def __call__(self, action, conversation=None):
        assert conversation is not None
        if action.delay and self.stopped.wait(action.delay):
            return ProbeObservation.from_text("Stopped before writing")
        path = Path(conversation.state.workspace.working_dir) / "result.txt"
        path.write_text(action.text, encoding="utf-8")
        if action.fail_after_write:
            raise ValueError("Write receipt was lost")
        return ProbeObservation.from_text("Wrote result.txt")

    def interrupt(self):
        self.stopped.set()


class FoundationProbeTool(ToolDefinition[ProbeAction, ProbeObservation]):
    @classmethod
    def create(cls, conv_state=None, **params):
        return [
            cls(
                description="Write a test result",
                action_type=ProbeAction,
                observation_type=ProbeObservation,
                executor=ProbeExecutor(),
            )
        ]


register_tool(FoundationProbeTool.name, FoundationProbeTool)


def tool_message(name, arguments, call_id="call-1"):
    return Message(
        role="assistant",
        content=[],
        tool_calls=[
            MessageToolCall(
                id=call_id,
                name=name,
                arguments=json.dumps(arguments),
                origin="completion",
            )
        ],
    )


def scripted_registry(scripts, policy=None) -> Any:
    def resolve(agent_id, version=None):
        if agent_id not in scripts:
            raise KeyError(agent_id)
        return SimpleNamespace(
            summary=SimpleNamespace(package_version="1.0.0", enabled=True),
            secret_names=[],
            allowed_agents=["example/expert"] if agent_id == "example/main" else [],
            tool_policies={FoundationProbeTool.name: policy or ToolPolicy()},
        )

    def create(agent_id, version=None):
        return Agent(
            llm=TestLLM.from_messages(scripts[agent_id]),
            tools=[Tool(name=FoundationProbeTool.name)],
            system_prompt=f"ONLY {agent_id} INSTRUCTIONS",
            agent_context=AgentContext(
                load_ambient_plugins=False, inherit_global_memory=False
            ),
        ), resolve(agent_id, version)

    return SimpleNamespace(get_agent=resolve, create_agent=create, resolve_agent=create)


async def eventually(predicate):
    async with asyncio.timeout(15):
        while not (value := predicate()):
            await asyncio.sleep(0.02)
        return value


def install_scripted_llms(service, monkeypatch):
    original = service.start_conversation

    async def start(request):
        result = await original(request)
        events = await service.get_event_service(result[0].id)
        events.get_conversation().switch_llm(request.agent.llm)
        return result

    monkeypatch.setattr(service, "start_conversation", start)


# @spec GAF-002 — Real SDK delegation isolates workspaces and returns the result
# @spec GAF-003 — A child write pauses until its durable decision is approved
async def test_native_sdk_delegate_waits_for_child_approval_and_returns_result(
    tmp_path, monkeypatch
):
    registry = scripted_registry(
        {
            "example/main": [
                tool_message(
                    "delegate_agent", {"agent_id": "example/expert", "task": "Write"}
                ),
                tool_message("finish", {"message": "parent done"}, "parent-finish"),
            ],
            "example/expert": [
                tool_message(FoundationProbeTool.name, {"text": "child wrote"}),
                tool_message("finish", {"message": "expert result"}, "child-finish"),
            ],
        }
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            request = CreateTaskRequest(
                agent_id="example/main", task="Analyze", idempotency_key="run"
            )
            parent = await runtime.create_task(request)
            approvals = await eventually(
                lambda: runtime.store.list_approvals(parent.conversation_id)
            )
            child = runtime.store.get_task(approvals[0].task_id)
            assert child.parent_task_id == parent.id
            assert not (runtime.workspace(child.id) / "result.txt").exists()
            await runtime.decide(approvals[0].id, True)
            await eventually(
                lambda: runtime.store.get_task(parent.id).status == "completed"
            )
            result = runtime.store.get_task(child.id).result
            assert result is not None
            assert json.loads(result)["text"] == "expert result"
            assert (
                runtime.workspace(child.id) / "result.txt"
            ).read_text() == "child wrote"
            assert not (runtime.workspace(parent.id) / "result.txt").exists()
            assert (await runtime.create_task(request)).id == parent.id
            conversation = (await runtime._service(child)).get_conversation()
            assert isinstance(conversation.agent, FoundationAgent)
            assert (
                conversation.agent.system_prompt == "ONLY example/expert INSTRUCTIONS"
            )
            events = (await runtime._service(parent)).get_conversation().state.events
            assert any("expert result" in event.model_dump_json() for event in events)
        finally:
            await runtime.close()


# @spec GAF-003 — Cancel a pending write without dispatching it
async def test_cancel_approval_and_artifact_scope(tmp_path, monkeypatch):
    registry = scripted_registry(
        {
            "example/main": [
                tool_message(FoundationProbeTool.name, {"text": "must not write"})
            ]
        }
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            task = await runtime.create_task(
                CreateTaskRequest(
                    agent_id="example/main", task="Write", idempotency_key="write"
                )
            )
            await eventually(lambda: runtime.store.list_approvals(task.conversation_id))
            await runtime.cancel(task.id)
            await eventually(
                lambda: runtime.store.get_task(task.id).status == "cancelled"
            )
            assert not (runtime.workspace(task.id) / "result.txt").exists()
            artifact = runtime.save_upload(
                task.conversation_id, "../input.txt", "text/plain", b"source"
            )
            assert artifact.name == "input.txt"
            assert (
                json.loads(runtime.read_artifact(task.id, artifact.id))["text"]
                == "source"
            )
            with pytest.raises(ValueError, match="inside"):
                runtime.publish_artifact(
                    task.id, PublishArtifactAction(path="../outside")
                )
            with pytest.raises(ValueError, match="granted"):
                runtime.read_artifact("unrelated", artifact.id)
            package = tmp_path / "package"
            package.mkdir()
            (package / "checklist.md").write_text(
                "Use verified sources", encoding="utf-8"
            )
            original_resolve = registry.get_agent

            def resolve_with_resources(agent_id, version=None):
                resolved = original_resolve(agent_id, version)
                resolved.package_root = package
                return resolved

            registry.get_agent = resolve_with_resources
            assert (
                runtime.read_package_resource(task.id, "checklist.md")
                == "Use verified sources"
            )
            with pytest.raises(ValueError, match="relative"):
                runtime.read_package_resource(task.id, "../outside")
        finally:
            await runtime.close()


# @spec GAF-002 — Normal conversation follow-ups keep their managed agent after restore
async def test_restore_and_native_followup_keep_policy(tmp_path, monkeypatch):
    registry = scripted_registry(
        {"example/main": [tool_message("finish", {"message": "first"})]}
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        task = await runtime.create_task(
            CreateTaskRequest(
                agent_id="example/main", task="First", idempotency_key="first"
            )
        )
        await eventually(lambda: runtime.store.get_task(task.id).status == "completed")
        await runtime.close()
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            events = await runtime._service(task)
            assert isinstance(events.get_conversation().agent, FoundationAgent)
            events.get_conversation().switch_llm(
                TestLLM.from_messages(
                    [
                        tool_message(
                            FoundationProbeTool.name,
                            {"text": "followup"},
                            "followup-write",
                        ),
                        tool_message(
                            "finish", {"message": "second"}, "followup-finish"
                        ),
                    ]
                )
            )
            await events.send_message(
                Message(role="user", content=[TextContent(text="Followup")]), run=True
            )
            approvals = await eventually(
                lambda: runtime.store.list_approvals(task.conversation_id)
            )
            assert not (runtime.workspace(task.id) / "result.txt").exists()
            await runtime.decide(approvals[0].id, True)
            await eventually(
                lambda: runtime.store.get_task(task.id).status == "completed"
            )
            result = runtime.store.get_task(task.id).result
            assert result is not None
            assert json.loads(result)["text"] == "second"
        finally:
            await runtime.close()


# @spec GAF-002 — Rejected native follow-ups do not retain a completed task status
async def test_native_followup_configuration_failure_updates_task(
    tmp_path, monkeypatch
):
    registry = scripted_registry(
        {"example/main": [tool_message("finish", {"message": "first"})]}
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            task = await runtime.create_task(
                CreateTaskRequest(
                    agent_id="example/main", task="First", idempotency_key="first"
                )
            )
            await eventually(
                lambda: runtime.store.get_task(task.id).status == "completed"
            )

            def unavailable_profile(agent_id, version=None):
                raise ValueError("The referenced profile was revoked")

            registry.resolve_agent = unavailable_profile
            events = await runtime._service(task)
            await events.send_message(
                Message(role="user", content=[TextContent(text="Followup")]), run=True
            )
            assert (
                await events.wait_for_run_completion()
                == ConversationExecutionStatus.ERROR
            )
            assert runtime.store.get_task(task.id).status == "failed"
        finally:
            await runtime.close()


# @spec GAF-003 — A deadline interrupts underlying cooperative work
async def test_tool_deadline_stops_underlying_write(tmp_path, monkeypatch):
    registry = scripted_registry(
        {
            "example/main": [
                tool_message(FoundationProbeTool.name, {"text": "late", "delay": 5})
            ]
        },
        policy=ToolPolicy(
            requires_confirmation=False, timeout_seconds=0.05, cancellable=True
        ),
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            task = await runtime.create_task(
                CreateTaskRequest(
                    agent_id="example/main", task="Write slowly", idempotency_key="slow"
                )
            )
            await eventually(
                lambda: runtime.store.get_task(task.id).status == "cancelled"
            )
            assert runtime._inflight[task.id] == 0
            assert not (runtime.workspace(task.id) / "result.txt").exists()
        finally:
            await runtime.close()


# @spec GAF-003 — A write with no reliable receipt requires recorded human evidence
async def test_unknown_write_requires_reconciliation_before_resume(
    tmp_path, monkeypatch
):
    registry = scripted_registry(
        {
            "example/main": [
                tool_message(
                    FoundationProbeTool.name,
                    {"text": "written once", "fail_after_write": True},
                )
            ]
        },
        policy=ToolPolicy(requires_confirmation=False),
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            task = await runtime.create_task(
                CreateTaskRequest(
                    agent_id="example/main", task="Write", idempotency_key="uncertain"
                )
            )
            await eventually(lambda: runtime.store.get_task(task.id).status == "failed")
            runtime.store.update_task(task.id, status="interrupted")
            with pytest.raises(ValueError, match="unknown"):
                await runtime.resume(task.id)
            call = runtime.store.list_calls(task.id)[0]
            assert call.status == "unknown"
            await runtime.resolve_call(
                task.id,
                call.id,
                ResolveToolCallRequest(
                    outcome="executed",
                    evidence="Checked the output; the write completed",
                ),
            )
            events = await runtime._service(task)
            events.get_conversation().switch_llm(
                TestLLM.from_messages(
                    [
                        tool_message(
                            "finish", {"message": "verified"}, "verified-finish"
                        )
                    ],
                    usage_id="verified-llm",
                )
            )
            await runtime.resume(task.id)
            await eventually(
                lambda: runtime.store.get_task(task.id).status == "completed"
            )
            assert (
                runtime.workspace(task.id) / "result.txt"
            ).read_text() == "written once"
        finally:
            await runtime.close()


# @spec GAF-003 — A child with an unknown write cannot be retried via a new delegate
async def test_child_unknown_write_blocks_parent_retry(tmp_path, monkeypatch):
    registry = scripted_registry(
        {
            "example/main": [
                tool_message(
                    "delegate_agent",
                    {"agent_id": "example/expert", "task": "Write once"},
                    call_id,
                )
                for call_id in ("first-delegate", "automatic-retry")
            ]
            + [tool_message("finish", {"message": "done"}, "parent-finish")],
            "example/expert": [
                tool_message(
                    FoundationProbeTool.name,
                    {"text": "written once", "fail_after_write": True},
                )
            ],
        },
        policy=ToolPolicy(requires_confirmation=False),
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            task = await runtime.create_task(
                CreateTaskRequest(
                    agent_id="example/main", task="Write", idempotency_key="uncertain"
                )
            )
            await eventually(
                lambda: runtime.store.get_task(task.id).status
                in ("failed", "completed")
            )
            children = [
                item
                for item in runtime.store.list_tasks(task.conversation_id)
                if item.parent_task_id == task.id
            ]
            assert len(children) == 1
            assert runtime.store.get_task(task.id).status == "failed"
            error = runtime.store.get_task(task.id).error
            assert error is not None and children[0].id in error
            with pytest.raises(ValueError, match="unknown"):
                await runtime.resume(task.id)
            call = runtime.store.list_calls(children[0].id)[0]
            await runtime.resolve_call(
                children[0].id,
                call.id,
                ResolveToolCallRequest(outcome="executed", evidence="Receipt found"),
            )
            parent_events = await runtime._service(task)
            messages = [
                event.llm_message
                for event in parent_events.get_conversation().state.events
                if isinstance(event, MessageEvent)
            ]
            assert any(
                isinstance(content, TextContent)
                and "Receipt found" in content.text
                and children[0].id in content.text
                for message in messages
                for content in message.content
            )
            assert not runtime.store.has_unknown_writes(task.id)
        finally:
            await runtime.close()


# @spec GAF-003 — Shutdown preserves a pending approval for explicit resume
@pytest.mark.parametrize("hard_restart", [False, True])
async def test_pending_approval_survives_shutdown_and_resume(
    tmp_path, monkeypatch, hard_restart
):
    registry = scripted_registry(
        {
            "example/main": [
                tool_message(
                    "delegate_agent", {"agent_id": "example/expert", "task": "Write"}
                )
            ],
            "example/expert": [
                tool_message(
                    FoundationProbeTool.name, {"text": "approved after restart"}
                )
            ],
        }
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        task = await runtime.create_task(
            CreateTaskRequest(
                agent_id="example/main", task="Write", idempotency_key="pending"
            )
        )
        approvals = await eventually(
            lambda: runtime.store.list_approvals(task.conversation_id)
        )
        child = runtime.store.get_task(approvals[0].task_id)
        await runtime.close()
        assert runtime.store.get_task(task.id).status == "interrupted"
        assert runtime.store.get_approval(approvals[0].id).status == "pending"
        if hard_restart:
            # Recreate the persisted status seen after a process crash, where
            # no orderly run teardown updated RUNNING on the SDK conversations.
            for pending in (task, child):
                pending_events = await runtime._service(pending)
                pending_events.get_conversation().state.execution_status = (
                    ConversationExecutionStatus.RUNNING
                )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            events = await runtime._service(task)
            events.get_conversation().switch_llm(
                TestLLM.from_messages(
                    [tool_message("finish", {"message": "resumed"}, "resumed-finish")],
                    usage_id="resumed-llm",
                )
            )
            child_events = await runtime._service(child)
            child_events.get_conversation().switch_llm(
                TestLLM.from_messages(
                    [
                        tool_message(
                            "finish", {"message": "child resumed"}, "child-resumed"
                        )
                    ],
                    usage_id="child-resumed-llm",
                )
            )
            original_resolve = registry.resolve_agent

            def changed_config(agent_id, version=None):
                agent, resolved = original_resolve(agent_id, version)
                return agent.model_copy(
                    update={
                        "llm": agent.llm.model_copy(update={"model": "changed-model"})
                    }
                ), resolved

            registry.resolve_agent = changed_config
            with pytest.raises(ValueError, match="configuration changed"):
                await runtime.resume(task.id)
            registry.resolve_agent = original_resolve
            await runtime.resume(task.id)
            await eventually(
                lambda: runtime.store.get_task(child.id).status
                == "waiting_for_confirmation"
            )
            assert not (runtime.workspace(child.id) / "result.txt").exists()
            assert len(runtime.store.list_approvals(task.conversation_id)) == 1
            await runtime.decide(approvals[0].id, True)
            await eventually(
                lambda: runtime.store.get_task(task.id).status == "completed"
            )
            assert (
                runtime.workspace(child.id) / "result.txt"
            ).read_text() == "approved after restart"
        finally:
            await runtime.close()


# @spec GAF-004 — A real MCP transport returns structured data and managed file bytes
async def test_real_mcp_embedded_resource_becomes_artifact(tmp_path, monkeypatch):
    registry = scripted_registry(
        {
            "example/main": [
                tool_message("report", {}),
                tool_message("finish", {"message": "MCP done"}, "finish"),
            ]
        }
    )
    original = registry.create_agent

    def create(agent_id, version=None):
        agent, resolved = original(agent_id, version)
        config = coerce_mcp_config(
            {
                "reports": {
                    "command": sys.executable,
                    "args": [str(Path(__file__).with_name("foundation_mcp_server.py"))],
                }
            }
        )
        return agent.model_copy(
            update={"mcp_config": config, "mcp_tool_allowlist": ["report"]}
        ), resolved

    registry.create_agent = create
    registry.resolve_agent = create
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            task = await runtime.create_task(
                CreateTaskRequest(
                    agent_id="example/main", task="Report", idempotency_key="mcp"
                )
            )
            approvals = await eventually(
                lambda: runtime.store.list_approvals(task.conversation_id)
            )
            assert approvals[0].tool_name == "report"
            await runtime.decide(approvals[0].id, True)
            await eventually(
                lambda: runtime.store.get_task(task.id).status == "completed"
            )
            artifact = runtime.store.list_artifacts(task.conversation_id)[0]
            assert (
                runtime.artifact_path(artifact.id).read_bytes()
                == b"metric,value\norders,7\n"
            )
            envelope = runtime.store.get_task(task.id).result
            assert envelope is not None
            result = json.loads(envelope)
            assert any(
                event.get("observation", {}).get("structured_content") == {"orders": 7}
                for event in result["data"]["tool_results"]
            )
        finally:
            await runtime.close()


# @spec GAF-002 — Native SDK parallel dispatch supports four live specialist tasks
# @spec GAF-003 — A parent sees concurrent approvals with independent decisions
async def test_parallel_native_delegates_have_independent_durable_approvals(
    tmp_path, monkeypatch
):
    delegates = [
        MessageToolCall(
            id=f"delegate-{index}",
            name="delegate_agent",
            origin="completion",
            arguments=json.dumps(
                {"agent_id": "example/expert", "task": f"Task {index}"}
            ),
        )
        for index in range(2)
    ]
    registry = scripted_registry(
        {
            "example/main": [
                Message(role="assistant", content=[], tool_calls=delegates),
                tool_message("finish", {"message": "joined"}, "parent-finish"),
            ],
            "example/expert": [
                tool_message(FoundationProbeTool.name, {"text": "written once"}),
                tool_message("finish", {"message": "expert done"}, "expert-finish"),
            ],
        }
    )
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        install_scripted_llms(service, monkeypatch)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            parent = await runtime.create_task(
                CreateTaskRequest(
                    agent_id="example/main", task="Parallel", idempotency_key="parallel"
                )
            )
            await eventually(
                lambda: len(runtime.store.list_approvals(parent.conversation_id)) == 2
            )
            approvals = runtime.store.list_approvals(parent.conversation_id)
            await eventually(
                lambda: all(
                    runtime.store.get_task(item.task_id).status
                    == "waiting_for_confirmation"
                    for item in approvals
                )
            )
            extras = [
                await runtime.create_task(
                    CreateTaskRequest(
                        agent_id="example/expert",
                        task=f"Additional {index}",
                        idempotency_key=f"extra-{index}",
                        parent_task_id=parent.id,
                    )
                )
                for index in range(2)
            ]
            await eventually(
                lambda: len(runtime.store.list_approvals(parent.conversation_id)) == 4
            )
            with pytest.raises(ValueError, match="four"):
                await runtime.create_task(
                    CreateTaskRequest(
                        agent_id="example/expert",
                        task="Fifth",
                        idempotency_key="fifth",
                        parent_task_id=parent.id,
                    )
                )
            for extra in extras:
                await runtime.cancel(extra.id)
            await runtime.decide(approvals[0].id, True)
            await runtime.decide(approvals[0].id, True)
            await runtime.decide(approvals[1].id, False)
            await eventually(
                lambda: runtime.store.get_task(parent.id).status == "completed"
            )
            granted = runtime.workspace(approvals[0].task_id) / "result.txt"
            assert granted.read_text() == "written once"
            assert not (runtime.workspace(approvals[1].task_id) / "result.txt").exists()
            refreshed = FoundationStore(runtime.store.path)
            assert len(refreshed.list_calls(approvals[0].task_id)) == 2
            assert [
                item.status for item in refreshed.list_approvals(parent.conversation_id)
            ][:2] == ["approved", "rejected"]
            with pytest.raises(ValueError, match="decided"):
                await runtime.decide(approvals[0].id, False)
        finally:
            await runtime.close()
