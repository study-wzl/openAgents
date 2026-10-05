"""Real installed packages run through the native SDK with a scripted provider."""

import asyncio
import json
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from examples.agent_foundation import demo_tools  # noqa: F401
from openhands.agent_server import api as api_module
from openhands.agent_server.agent_foundation.packages import PackageRegistry
from openhands.agent_server.agent_foundation.runtime import AgentFoundationRuntime
from openhands.agent_server.agent_foundation.runtime_models import CreateTaskRequest
from openhands.agent_server.config import Config
from openhands.agent_server.conversation_service import ConversationService
from openhands.agent_server.persistence import get_llm_profile_store
from openhands.sdk.llm import LLM, Message, MessageToolCall
from openhands.sdk.llm.llm_profile_store import LLMProfileStore
from openhands.sdk.testing import TestLLM


EXAMPLES = Path(__file__).resolve().parents[2] / "examples" / "agent_foundation"


def call(name: str, arguments: dict, call_id: str) -> Message:
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


async def eventually(predicate):
    async with asyncio.timeout(20):
        while not (value := predicate()):
            await asyncio.sleep(0.02)
        return value


# @spec GAF-001 — Swapping the package changes business behavior, not the runner
# @spec GAF-002 — Two real child conversations return to the entry coordinator
# @spec GAF-004 — The coordinator publishes a task-local report as an artifact
@pytest.mark.parametrize(
    ("package", "experts", "lookup"),
    [
        ("research", ["evidence", "critic"], "research_lookup"),
        ("operations", ["metrics", "runbook"], "operations_metrics"),
    ],
)
async def test_example_package_runs_delegates_and_publishes_report(
    tmp_path, monkeypatch, package, experts, lookup
):
    llms = LLMProfileStore(base_dir=tmp_path / "llms")
    llms.save("business", LLM(model="openai/gpt-4o"))
    registry = PackageRegistry(tmp_path / "packages", llm_store=llms, mcp_config={})
    registry.install(EXAMPLES / package)
    main_id = f"{package}/coordinator"
    scripts: dict[str, list[Message | Exception]] = {
        f"{package}/{expert}": [
            call(lookup, {"query": expert}, "lookup"),
            call("finish", {"message": f"{expert} verified findings"}, "finish"),
        ]
        for expert in experts
    }
    scripts[main_id] = [
        call(
            "delegate_agent",
            {"agent_id": f"{package}/{expert}", "task": expert},
            expert,
        )
        for expert in experts
    ]
    if package == "operations":
        scripts[main_id].append(
            call(
                "operations_create_ticket",
                {"title": "Check queue trend", "description": "Demo escalation"},
                "ticket",
            )
        )
    report = f"# {package.title()}\n\nDemonstration review with two specialists.\n"
    scripts[main_id].extend(
        [
            call("business_write_report", {"content": report}, "report"),
            call("publish_artifact", {"path": "report.md"}, "publish"),
            call("finish", {"message": "Report published"}, "finish"),
        ]
    )
    create_agent = registry.create_agent

    def scripted_agent(agent_id, version=None):
        agent, resolved = create_agent(agent_id, version)
        return agent.model_copy(
            update={
                "llm": TestLLM(
                    **agent.llm.model_dump(context={"expose_secrets": True}),
                    scripted_responses=scripts[agent_id],
                )
            }
        ), resolved

    monkeypatch.setattr(registry, "create_agent", scripted_agent)
    async with ConversationService(
        conversations_dir=tmp_path / "conversations"
    ) as service:
        start = service.start_conversation

        async def start_with_provider(request):
            result = await start(request)
            event_service = await service.get_event_service(result[0].id)
            assert event_service is not None
            # Disk restore reconstructs the canonical LLM class. Only the provider
            # is replaced; conversations, tools, profiles, and execution are real.
            event_service.get_conversation().switch_llm(request.agent.llm)
            return result

        monkeypatch.setattr(service, "start_conversation", start_with_provider)
        runtime = AgentFoundationRuntime(tmp_path / "runtime", registry, service)
        await runtime.start()
        try:
            parent = await runtime.create_task(
                CreateTaskRequest(
                    agent_id=main_id,
                    task="Prepare a review.",
                    idempotency_key="example",
                )
            )
            if package == "operations":
                approvals = await eventually(
                    lambda: runtime.store.list_approvals(parent.conversation_id)
                )
                assert not (runtime.workspace(parent.id) / "ticket.json").exists()
                await runtime.decide(approvals[0].id, True)
            await eventually(
                lambda: runtime.store.get_task(parent.id).status
                in {"completed", "failed"}
            )
            assert runtime.store.get_task(parent.id).status == "completed"
            tasks = runtime.store.list_tasks(parent.conversation_id)
            children = [task for task in tasks if task.parent_task_id == parent.id]
            assert {child.agent_id for child in children} == {
                f"{package}/{expert}" for expert in experts
            }
            assert len({runtime.workspace(task.id) for task in tasks}) == 3
            artifacts = runtime.store.list_artifacts(parent.conversation_id)
            assert len(artifacts) == 1
            assert (
                json.loads(runtime.read_artifact(parent.id, artifacts[0].id))["text"]
                == report
            )
            conversation = (await runtime._service(parent)).get_conversation()
            history = "\n".join(
                event.model_dump_json() for event in conversation.state.events
            )
            assert all(f"{expert} verified findings" in history for expert in experts)
            assert "terminal" not in conversation.agent.tools_map
            if package == "operations":
                assert (runtime.workspace(parent.id) / "ticket.json").is_file()
        finally:
            await runtime.close()


# @spec GAF-001 — Installation and execution work through the canonical HTTP API
# @spec GAF-003 — The HTTP decision releases only the approved operation
async def test_operations_package_full_http_lifecycle(tmp_path, monkeypatch):
    get_llm_profile_store().save("business", LLM(model="openai/gpt-4o"))
    service = ConversationService(conversations_dir=tmp_path / "conversations")
    monkeypatch.setattr(api_module, "get_default_conversation_service", lambda: service)
    monkeypatch.setattr(api_module, "get_vscode_service", lambda: None)
    monkeypatch.setattr(api_module, "get_tool_preload_service", lambda: None)
    monkeypatch.setattr(api_module, "_cleanup_stale_tmux_sessions", lambda: None)
    config = Config(
        conversations_path=tmp_path / "conversations",
        workspace_path=tmp_path / "workspace",
        bash_events_dir=tmp_path / "bash-events",
        static_files_path=None,
        enable_vscode=False,
        preload_tools=False,
        session_api_keys=["example-key"],
        secret_key=None,
    )
    app = api_module.create_app(config)
    report = "# Operations HTTP report\n\nDemo observations and approved escalation.\n"
    script: list[Message | Exception] = [
        call(
            "delegate_agent",
            {"agent_id": f"operations/{expert}", "task": expert},
            expert,
        )
        for expert in ("metrics", "runbook")
    ]
    script.extend(
        [
            call(
                "operations_create_ticket",
                {"title": "Demo", "description": "Check trend"},
                "ticket",
            ),
            call("business_write_report", {"content": report}, "report"),
            call("publish_artifact", {"path": "report.md"}, "publish"),
            call("finish", {"message": "Report published"}, "finish"),
        ]
    )
    original_start = service.start_conversation

    async def start_scripted(request):
        result = await original_start(request)
        events = await service.get_event_service(result[0].id)
        assert events is not None
        messages: list[Message | Exception] = (
            script
            if "operations_create_ticket" in {tool.name for tool in request.agent.tools}
            else [
                call("operations_metrics", {"query": "Review operations"}, "metrics"),
                call("finish", {"message": "Expert verified demo facts"}, "finish"),
            ]
        )
        events.get_conversation().switch_llm(
            TestLLM(
                **request.agent.llm.model_dump(context={"expose_secrets": True}),
                scripted_responses=messages,
            )
        )
        return result

    monkeypatch.setattr(service, "start_conversation", start_scripted)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app), base_url="http://test"
        ) as client:
            prefix = "/api/agent-foundation"
            assert (await client.get(f"{prefix}/agents")).status_code == 401
            client.headers["X-Session-API-Key"] = "example-key"
            installed = await client.post(
                f"{prefix}/packages/install",
                json={"source": str(EXAMPLES / "operations")},
            )
            assert installed.status_code == 200, installed.text
            response = await client.post(
                f"{prefix}/tasks",
                json={
                    "agent_id": "operations/coordinator",
                    "task": "Review operations",
                    "idempotency_key": "http-example",
                },
            )
            assert response.status_code == 200, response.text
            parent = response.json()
            query = {"conversation_id": parent["conversation_id"]}
            async with asyncio.timeout(20):
                while not (
                    approvals := (
                        await client.get(f"{prefix}/approvals", params=query)
                    ).json()["approvals"]
                ):
                    await asyncio.sleep(0.02)
            runtime = app.state.agent_foundation_runtime
            assert not (runtime.workspace(parent["id"]) / "ticket.json").exists()
            decision = await client.post(
                f"{prefix}/approvals/{approvals[0]['id']}/decision",
                json={"approved": True},
            )
            assert decision.status_code == 200
            async with asyncio.timeout(20):
                while True:
                    task = (await client.get(f"{prefix}/tasks/{parent['id']}")).json()
                    if task["status"] in {"completed", "failed"}:
                        break
                    await asyncio.sleep(0.02)
            assert task["status"] == "completed", task
            tasks = (await client.get(f"{prefix}/tasks", params=query)).json()["tasks"]
            assert len(tasks) == 3
            artifacts = (await client.get(f"{prefix}/artifacts", params=query)).json()[
                "artifacts"
            ]
            assert len(artifacts) == 1
            download = await client.get(
                f"{prefix}/artifacts/{artifacts[0]['id']}/download"
            )
            assert download.status_code == 200
            assert download.text == report
