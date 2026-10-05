"""Policy at the existing SDK dispatch boundary, without a second agent loop."""

from __future__ import annotations

from typing import TYPE_CHECKING
from weakref import WeakValueDictionary

from pydantic import Field

from openhands.agent_server.agent_foundation.package_models import ToolPolicy
from openhands.sdk import Agent


if TYPE_CHECKING:
    from openhands.agent_server.agent_foundation.runtime import AgentFoundationRuntime
    from openhands.sdk.conversation import LocalConversation
    from openhands.sdk.event import ActionEvent, Event


_runtimes: WeakValueDictionary[str, AgentFoundationRuntime] = WeakValueDictionary()


def bind_runtime(runtime: AgentFoundationRuntime) -> None:
    _runtimes[str(runtime.root)] = runtime


def get_runtime(root: str) -> AgentFoundationRuntime:
    runtime = _runtimes.get(root)
    if runtime is None:
        raise RuntimeError("Managed task runtime is unavailable; execution is blocked")
    return runtime


# @spec GAF-003 — Python and MCP calls share one durable approval boundary
class FoundationAgent(Agent):
    foundation_root: str
    foundation_task_id: str
    foundation_tool_policies: dict[str, ToolPolicy] = Field(default_factory=dict)

    async def astep(self, conversation, on_event, on_token=None) -> None:
        runtime = get_runtime(self.foundation_root)
        runtime.before_step(self.foundation_task_id, self, conversation)
        try:
            await super().astep(conversation, on_event, on_token)
        finally:
            runtime.schedule_status_refresh(self.foundation_task_id, conversation)

    def step(self, conversation, on_event, on_token=None) -> None:
        runtime = get_runtime(self.foundation_root)
        runtime.before_step(self.foundation_task_id, self, conversation)
        try:
            super().step(conversation, on_event, on_token)
        finally:
            runtime.loop.call_soon_threadsafe(
                runtime.schedule_status_refresh, self.foundation_task_id, conversation
            )

    def _execute_action_event(
        self, conversation: LocalConversation, action_event: ActionEvent
    ) -> list[Event]:
        execute = super()._execute_action_event
        return get_runtime(self.foundation_root).execute_tool(
            self,
            conversation,
            action_event,
            lambda: execute(conversation, action_event),
        )
