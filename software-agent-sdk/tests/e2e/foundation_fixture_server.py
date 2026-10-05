"""Browser fixture: real Agent Server and tools, deterministic model responses only.

Run as a script with --state-dir and --port. FOUNDATION_E2E_SESSION_API_KEY must
contain a test-only key. The launcher owns the temporary state directory.
"""

import argparse
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=19300)
    args = parser.parse_args()
    state = args.state_dir.resolve()
    key = os.environ["FOUNDATION_E2E_SESSION_API_KEY"]
    state.mkdir(parents=True, exist_ok=True)
    os.environ.update(
        {
            "OH_PERSISTENCE_DIR": str(state),
            "OH_CONVERSATIONS_PATH": str(state / "conversations"),
            "OH_WORKSPACE_PATH": str(state / "workspace"),
            "OH_BASH_EVENTS_DIR": str(state / "bash-events"),
            "OH_CONVERSATION_WORKTREE_ROOT": str(state / "worktrees"),
            "OH_SESSION_API_KEYS_0": key,
            "OH_SECRET_KEY": key,
            "OH_ENABLE_VSCODE": "false",
            "OH_PRELOAD_TOOLS": "false",
            "DO_NOT_TRACK": "1",
        }
    )
    # Environment isolation must precede imports that initialise server stores.
    import uvicorn
    from pydantic import SecretStr

    from examples.agent_foundation import demo_tools  # noqa: F401
    from openhands.agent_server import api as api_module
    from openhands.agent_server.config import Config
    from openhands.agent_server.conversation_service import ConversationService
    from openhands.agent_server.persistence import get_llm_profile_store
    from openhands.sdk.llm import LLM, Message, MessageToolCall
    from openhands.sdk.testing import TestLLM

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

    def trajectory(tool_names: set[str]) -> list[Message | Exception]:
        if "business_write_report" not in tool_names:
            tool = (
                "operations_metrics"
                if "operations_metrics" in tool_names
                else "research_lookup"
            )
            return [
                call(
                    tool,
                    {"query": "Review the supplied demonstration evidence"},
                    "lookup",
                ),
                call(
                    "finish",
                    {"message": "Expert verified the demonstration evidence."},
                    "finish",
                ),
            ]
        operations = "operations_create_ticket" in tool_names
        package = "operations" if operations else "research"
        experts = ("metrics", "runbook") if operations else ("evidence", "critic")
        messages: list[Message | Exception] = [
            call(
                "delegate_agent",
                {"agent_id": f"{package}/{expert}", "task": f"Review {expert}."},
                expert,
            )
            for expert in experts
        ]
        if operations:
            messages.append(
                call(
                    "operations_create_ticket",
                    {
                        "title": "Review queue trend",
                        "description": "Demonstration escalation proposal",
                    },
                    "ticket",
                )
            )
        messages.extend(
            [
                call(
                    "business_write_report",
                    {
                        "content": (
                            f"# {package.title()} report\n\n"
                            "Two specialists reviewed demonstration evidence.\n"
                            "See the confirmation record for the ticket decision.\n"
                        )
                    },
                    "report",
                ),
                call("publish_artifact", {"path": "report.md"}, "publish"),
                call(
                    "finish",
                    {"message": "Review completed. The report is ready to download."},
                    "finish",
                ),
            ]
        )
        return messages

    class FixtureConversationService(ConversationService):
        async def start_conversation(self, request):
            result = await super().start_conversation(request)
            events = await self.get_event_service(result[0].id)
            assert events is not None
            # StoredConversation copies the Agent; replace only the provider on
            # the actual SDK conversation before the runtime starts its loop.
            events.get_conversation().switch_llm(
                TestLLM(
                    **request.agent.llm.model_dump(context={"expose_secrets": True}),
                    scripted_responses=trajectory(
                        {tool.name for tool in request.agent.tools}
                    ),
                )
            )
            return result

    config = Config(
        conversations_path=state / "conversations",
        workspace_path=state / "workspace",
        bash_events_dir=state / "bash-events",
        session_api_keys=[key],
        secret_key=SecretStr(key),
        static_files_path=None,
        enable_vscode=False,
        preload_tools=False,
    )
    service = FixtureConversationService(conversations_dir=config.conversations_path)
    api_module.get_default_conversation_service = lambda: service
    api_module.get_vscode_service = lambda: None
    api_module.get_tool_preload_service = lambda: None
    app = api_module.create_app(config)
    lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def fixture_lifespan(application):
        async with lifespan(application):
            get_llm_profile_store().save(
                "business",
                LLM(model="openai/gpt-4o", api_key="foundation-e2e-not-a-real-key"),
            )
            registry = application.state.package_registry
            for package in ("operations", "research"):
                registry.install(REPO_ROOT / "examples" / "agent_foundation" / package)
            yield

    app.router.lifespan_context = fixture_lifespan
    uvicorn.run(
        app, host="127.0.0.1", port=args.port, log_level="warning", ws="wsproto"
    )


if __name__ == "__main__":
    main()
