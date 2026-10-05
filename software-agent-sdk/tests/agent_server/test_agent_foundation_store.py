"""Durable task/approval boundaries, independent of the execution engine."""

import pytest

from openhands.agent_server.agent_foundation.runtime_models import CreateTaskRequest
from openhands.agent_server.agent_foundation.store import FoundationStore


# @spec GAF-002 — Idempotent task creation and restart reconciliation
def test_task_retry_does_not_duplicate_and_rejects_changed_request(tmp_path):
    store = FoundationStore(tmp_path / "runtime.sqlite3")
    request = CreateTaskRequest(
        agent_id="example/main", task="Report", idempotency_key="one"
    )
    task, created = store.create_task(request, "1.0.0", None)
    again, duplicate = store.create_task(request, "1.0.0", None)
    assert created and not duplicate
    assert again.id == task.id
    with pytest.raises(ValueError, match="idempotency"):
        store.create_task(request.model_copy(update={"task": "Changed"}), "1.0.0", None)
    store.update_task(task.id, status="running")
    store.reconcile()
    assert store.get_task(task.id).status == "interrupted"


# @spec GAF-003 — Approval decisions survive restart and are consumed once
def test_approval_survives_restart_and_rejects_conflicting_decision(tmp_path):
    path = tmp_path / "runtime.sqlite3"
    store = FoundationStore(path)
    task, _ = store.create_task(
        CreateTaskRequest(agent_id="example/main", task="Send", idempotency_key="one"),
        "1",
        None,
    )
    approval = store.ensure_approval(task, "call-1", "send", {"to": "example"})
    store = FoundationStore(path)
    store.reconcile()
    assert store.get_approval(approval.id).status == "pending"
    assert store.decide(approval.id, True).status == "approved"
    assert store.decide(approval.id, True).status == "approved"
    with pytest.raises(ValueError, match="decided"):
        store.decide(approval.id, False)


# @spec GAF-002 — Storage enforces concurrent and recursive delegation limits
def test_delegation_is_one_level_and_at_most_four_active_children(tmp_path):
    store = FoundationStore(tmp_path / "runtime.sqlite3")
    parent, _ = store.create_task(
        CreateTaskRequest(
            agent_id="example/main", task="Coordinate", idempotency_key="parent"
        ),
        "1.0.0",
        None,
    )
    children = []
    for number in range(4):
        child, _ = store.create_task(
            CreateTaskRequest(
                agent_id="example/expert",
                task="Analyze",
                idempotency_key=str(number),
                parent_task_id=parent.id,
            ),
            "1.0.0",
            parent,
        )
        children.append(child)
    with pytest.raises(ValueError, match="four"):
        store.create_task(
            CreateTaskRequest(
                agent_id="example/expert",
                task="Fifth",
                idempotency_key="fifth",
                parent_task_id=parent.id,
            ),
            "1.0.0",
            parent,
        )
    with pytest.raises(ValueError, match="one level"):
        store.create_task(
            CreateTaskRequest(
                agent_id="example/expert",
                task="Nested",
                idempotency_key="nested",
                parent_task_id=children[0].id,
            ),
            "1.0.0",
            children[0],
        )
