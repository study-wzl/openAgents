"""SDK tools for bounded delegation and conversation-scoped artifact references."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import TYPE_CHECKING, Self

from pydantic import Field

from openhands.agent_server.agent_foundation.execution import get_runtime
from openhands.sdk.tool import Action, Observation, ToolDefinition, ToolExecutor
from openhands.sdk.tool.registry import register_tool
from openhands.sdk.tool.tool import DeclaredResources, ToolAnnotations


if TYPE_CHECKING:
    from openhands.sdk.conversation import LocalConversation


class DelegateAgentAction(Action):
    agent_id: str = Field(description="An allowed agent's full package/agent ID")
    task: str = Field(min_length=1, max_length=100_000)
    artifact_ids: list[str] = Field(default_factory=list)


class FoundationObservation(Observation):
    pass


class DelegateExecutor(ToolExecutor):
    def __init__(self, root: str, task_id: str) -> None:
        self.root, self.task_id = root, task_id

    def __call__(
        self,
        action: DelegateAgentAction,
        conversation: LocalConversation | None = None,  # noqa: ARG002
    ) -> FoundationObservation:
        runtime = get_runtime(self.root)
        action_id = runtime.current_action_id()
        future = asyncio.run_coroutine_threadsafe(
            runtime.delegate(self.task_id, action_id, action), runtime.loop
        )
        return FoundationObservation.from_text(future.result())


# @spec GAF-002 — Parent receives the child SDK conversation's actual result
class DelegateAgentTool(ToolDefinition[DelegateAgentAction, FoundationObservation]):
    @classmethod
    def create(cls, conv_state=None, **params) -> Sequence[Self]:  # noqa: ARG003
        return [
            cls(
                description=(
                    "Delegate one task to an allowed specialist and wait for its "
                    "actual result. At most four specialists run concurrently. "
                    f"Allowed agents: {', '.join(params['allowed_agents'])}."
                ),
                action_type=DelegateAgentAction,
                observation_type=FoundationObservation,
                executor=DelegateExecutor(params["root"], params["task_id"]),
                annotations=ToolAnnotations(destructiveHint=False),
            )
        ]

    def declared_resources(self, action: Action) -> DeclaredResources:  # noqa: ARG002
        return DeclaredResources(keys=(), declared=True)


class PublishArtifactAction(Action):
    path: str = Field(description="Relative file path inside this task's workspace")
    name: str | None = None
    mime_type: str | None = None


class ReadArtifactAction(Action):
    artifact_id: str


class ReadPackageResourceAction(Action):
    path: str = Field(
        description="Relative POSIX path inside the installed agent package"
    )


class PackageResourceExecutor(ToolExecutor):
    def __init__(self, root: str, task_id: str) -> None:
        self.root, self.task_id = root, task_id

    def __call__(self, action, conversation=None) -> FoundationObservation:  # noqa: ARG002
        return FoundationObservation.from_text(
            get_runtime(self.root).read_package_resource(self.task_id, action.path)
        )


class ReadPackageResourceTool(
    ToolDefinition[ReadPackageResourceAction, FoundationObservation]
):
    @classmethod
    def create(cls, conv_state=None, **params) -> Sequence[Self]:  # noqa: ARG003
        return [
            cls(
                description=(
                    "Read a UTF-8 skill resource from this agent's installed "
                    "package (at most 256 KiB)."
                ),
                action_type=ReadPackageResourceAction,
                observation_type=FoundationObservation,
                executor=PackageResourceExecutor(params["root"], params["task_id"]),
                annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False),
            )
        ]


class ArtifactExecutor(ToolExecutor):
    def __init__(self, root: str, task_id: str, publish: bool) -> None:
        self.root, self.task_id, self.publish = root, task_id, publish

    def __call__(self, action, conversation=None) -> FoundationObservation:  # noqa: ARG002
        runtime = get_runtime(self.root)
        if self.publish:
            record = runtime.publish_artifact(self.task_id, action)
            return FoundationObservation.from_text(record.model_dump_json())
        return FoundationObservation.from_text(
            runtime.read_artifact(self.task_id, action.artifact_id)
        )


# @spec GAF-004 — Tools exchange immutable IDs, not untrusted host paths
class PublishArtifactTool(ToolDefinition[PublishArtifactAction, FoundationObservation]):
    @classmethod
    def create(cls, conv_state=None, **params) -> Sequence[Self]:  # noqa: ARG003
        return [
            cls(
                description="Publish a task workspace file as a managed artifact.",
                action_type=PublishArtifactAction,
                observation_type=FoundationObservation,
                executor=ArtifactExecutor(params["root"], params["task_id"], True),
                annotations=ToolAnnotations(destructiveHint=False, openWorldHint=False),
            )
        ]


class ReadArtifactTool(ToolDefinition[ReadArtifactAction, FoundationObservation]):
    @classmethod
    def create(cls, conv_state=None, **params) -> Sequence[Self]:  # noqa: ARG003
        return [
            cls(
                description="Read an artifact explicitly attached to this task.",
                action_type=ReadArtifactAction,
                observation_type=FoundationObservation,
                executor=ArtifactExecutor(params["root"], params["task_id"], False),
                annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False),
            )
        ]


for _tool in (
    DelegateAgentTool,
    PublishArtifactTool,
    ReadArtifactTool,
    ReadPackageResourceTool,
):
    register_tool(_tool.name, _tool)
