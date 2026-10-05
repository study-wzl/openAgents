"""Deployment-installed sample tools; business packages contain no Python code.

These tools use fixture data and task-local files. Replace their implementations
with business services when deploying an application.
"""

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Self

from pydantic import Field

from openhands.sdk.tool import (
    Action,
    Observation,
    ToolAnnotations,
    ToolDefinition,
    ToolExecutor,
    register_tool,
)


class QueryAction(Action):
    query: str = Field(min_length=1, max_length=1000)


class DemoObservation(Observation):
    pass


class FixtureExecutor(ToolExecutor):
    def __init__(self, domain: str) -> None:
        self.domain = domain

    def __call__(self, action: QueryAction, conversation=None) -> DemoObservation:  # noqa: ARG002
        records = {
            "research": [
                {"source": "demo://survey", "fact": "30 of 50 users prefer option A."},
                {"source": "demo://costs", "fact": "Option A costs 20% more than B."},
            ],
            "operations": [
                {
                    "source": "demo://metrics",
                    "fact": "Queue depth is 120; target is 40.",
                },
                {
                    "source": "demo://runbook",
                    "fact": "Escalate sustained queue growth.",
                },
            ],
        }
        return DemoObservation.from_text(
            json.dumps({"query": action.query, "demo_data": records[self.domain]})
        )


class ResearchLookupTool(ToolDefinition[QueryAction, DemoObservation]):
    @classmethod
    def create(cls, conv_state=None, **_params) -> Sequence[Self]:  # noqa: ARG003
        return [
            cls(
                description="Read the research demo dataset; cite demo sources.",
                action_type=QueryAction,
                observation_type=DemoObservation,
                executor=FixtureExecutor("research"),
                annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False),
            )
        ]


class OperationsMetricsTool(ToolDefinition[QueryAction, DemoObservation]):
    @classmethod
    def create(cls, conv_state=None, **_params) -> Sequence[Self]:  # noqa: ARG003
        return [
            cls(
                description="Read demonstration operations metrics and runbook facts.",
                action_type=QueryAction,
                observation_type=DemoObservation,
                executor=FixtureExecutor("operations"),
                annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False),
            )
        ]


class WriteReportAction(Action):
    content: str = Field(min_length=1, max_length=100_000)


class WriteReportExecutor(ToolExecutor):
    def __init__(self, workspace: str) -> None:
        self.path = Path(workspace) / "report.md"

    def __call__(self, action: WriteReportAction, conversation=None) -> DemoObservation:  # noqa: ARG002
        self.path.write_text(action.content, encoding="utf-8", newline="\n")
        return DemoObservation.from_text("Saved report.md; publish it as an artifact.")


class BusinessWriteReportTool(ToolDefinition[WriteReportAction, DemoObservation]):
    @classmethod
    def create(cls, conv_state=None, **_params) -> Sequence[Self]:
        if conv_state is None:
            raise ValueError("A task workspace is required")
        return [
            cls(
                description="Write report.md inside this task's isolated workspace.",
                action_type=WriteReportAction,
                observation_type=DemoObservation,
                executor=WriteReportExecutor(conv_state.workspace.working_dir),
                annotations=ToolAnnotations(destructiveHint=False, openWorldHint=False),
            )
        ]


class CreateTicketAction(Action):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=5000)


class CreateTicketExecutor(ToolExecutor):
    def __init__(self, workspace: str) -> None:
        self.path = Path(workspace) / "ticket.json"

    def __call__(
        self,
        action: CreateTicketAction,
        conversation=None,  # noqa: ARG002
    ) -> DemoObservation:
        ticket = {"id": "demo-ticket-1", **action.model_dump()}
        self.path.write_text(json.dumps(ticket), encoding="utf-8")
        return DemoObservation.from_text(json.dumps(ticket))


class OperationsCreateTicketTool(ToolDefinition[CreateTicketAction, DemoObservation]):
    @classmethod
    def create(cls, conv_state=None, **_params) -> Sequence[Self]:
        if conv_state is None:
            raise ValueError("A task workspace is required")
        return [
            cls(
                description=(
                    "Create a demonstration escalation ticket after approval. "
                    "This sample writes ticket.json and calls no external service."
                ),
                action_type=CreateTicketAction,
                observation_type=DemoObservation,
                executor=CreateTicketExecutor(conv_state.workspace.working_dir),
                annotations=ToolAnnotations(destructiveHint=False, openWorldHint=False),
            )
        ]


for _tool in (
    ResearchLookupTool,
    OperationsMetricsTool,
    BusinessWriteReportTool,
    OperationsCreateTicketTool,
):
    register_tool(_tool.name, _tool)
