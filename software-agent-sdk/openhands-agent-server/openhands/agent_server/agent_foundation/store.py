"""SQLite is the single writer for task ownership and tool-call decisions."""

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

from openhands.agent_server.agent_foundation.runtime_models import (
    ApprovalRecord,
    ArtifactRecord,
    CreateTaskRequest,
    TaskRecord,
    ToolCallRecord,
    utc_now,
)


ACTIVE = ("queued", "running", "waiting_for_confirmation", "cancelling")


class FoundationStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, conversation_id TEXT UNIQUE NOT NULL,
                    root_conversation_id TEXT NOT NULL, parent_id TEXT,
                    request_key TEXT UNIQUE NOT NULL, request_json TEXT NOT NULL,
                    status TEXT NOT NULL, record TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS approvals (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
                    action_id TEXT NOT NULL, status TEXT NOT NULL,
                    record TEXT NOT NULL, UNIQUE(task_id, action_id)
                );
                CREATE TABLE IF NOT EXISTS calls (
                    task_id TEXT NOT NULL, action_id TEXT NOT NULL,
                    state TEXT NOT NULL, readonly INTEGER NOT NULL,
                    result TEXT, PRIMARY KEY(task_id, action_id)
                );
                CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
                    task_id TEXT, record TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS artifact_grants (
                    task_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
                    PRIMARY KEY(task_id, artifact_id)
                );
                CREATE TABLE IF NOT EXISTS call_resolutions (
                    task_id TEXT NOT NULL, action_id TEXT NOT NULL,
                    outcome TEXT NOT NULL, evidence TEXT NOT NULL,
                    resolved_at TEXT NOT NULL, PRIMARY KEY(task_id, action_id)
                );
                CREATE TABLE IF NOT EXISTS call_details (
                    task_id TEXT NOT NULL, action_id TEXT NOT NULL,
                    record TEXT NOT NULL, PRIMARY KEY(task_id, action_id)
                );
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    # @spec GAF-002 — Atomic idempotency and bounded one-level delegation
    def find_request(self, request: CreateTaskRequest) -> TaskRecord | None:
        key = json.dumps([request.parent_task_id, request.idempotency_key])
        with self.connection() as db:
            row = db.execute(
                "SELECT request_json,record FROM tasks WHERE request_key=?", (key,)
            ).fetchone()
            if row is None:
                return None
            if row[0] != request.model_dump_json():
                raise ValueError("idempotency_key reused with different task input")
            return TaskRecord.model_validate_json(row[1])

    def create_task(
        self,
        request: CreateTaskRequest,
        package_version: str,
        parent: TaskRecord | None,
    ) -> tuple[TaskRecord, bool]:
        request_json = request.model_dump_json()
        key = json.dumps([request.parent_task_id, request.idempotency_key])
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM tasks WHERE request_key=?", (key,)
            ).fetchone()
            if row:
                if row["request_json"] != request_json:
                    raise ValueError("idempotency_key reused with different task input")
                return TaskRecord.model_validate_json(row["record"]), False
            if parent:
                current = self._task(db, parent.id)
                if current.parent_task_id:
                    raise ValueError("Only one level of delegation is supported")
                if current.status not in (
                    "queued",
                    "running",
                    "waiting_for_confirmation",
                ):
                    raise ValueError("Parent task is not active")
                active = db.execute(
                    "SELECT COUNT(*) FROM tasks WHERE parent_id=? "
                    "AND status IN ('queued','running',"
                    "'waiting_for_confirmation','cancelling')",
                    (parent.id,),
                ).fetchone()[0]
                if active >= 4:
                    raise ValueError("At most four child tasks may run concurrently")
            task_id = str(uuid4())
            record = TaskRecord(
                id=task_id,
                conversation_id=task_id,
                agent_id=request.agent_id,
                task=request.task,
                parent_task_id=request.parent_task_id,
                package_version=package_version,
            )
            root = parent.conversation_id if parent else task_id
            db.execute(
                "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)",
                (
                    task_id,
                    task_id,
                    root,
                    request.parent_task_id,
                    key,
                    request_json,
                    record.status,
                    record.model_dump_json(),
                ),
            )
            for artifact_id in set(request.artifact_ids):
                db.execute(
                    "INSERT INTO artifact_grants VALUES (?,?)", (task_id, artifact_id)
                )
            return record, True

    def _task(self, db: sqlite3.Connection, task_id: str) -> TaskRecord:
        row = db.execute("SELECT record FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise KeyError("Task not found")
        return TaskRecord.model_validate_json(row[0])

    def get_task(self, task_id: str) -> TaskRecord:
        with self.connection() as db:
            return self._task(db, task_id)

    def task_for_conversation(self, conversation_id: str) -> TaskRecord:
        with self.connection() as db:
            row = db.execute(
                "SELECT record FROM tasks WHERE conversation_id=?", (conversation_id,)
            ).fetchone()
            if row is None:
                raise KeyError("Managed conversation not found")
            return TaskRecord.model_validate_json(row[0])

    def update_task(self, task_id: str, **changes: Any) -> TaskRecord:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            record = self._task(db, task_id)
            payload = record.model_dump() | changes | {"updated_at": utc_now()}
            record = TaskRecord.model_validate(payload)
            db.execute(
                "UPDATE tasks SET status=?,record=? WHERE id=?",
                (record.status, record.model_dump_json(), task_id),
            )
            return record

    def list_tasks(self, conversation_id: str | None = None) -> list[TaskRecord]:
        with self.connection() as db:
            if conversation_id:
                row = db.execute(
                    "SELECT root_conversation_id FROM tasks WHERE conversation_id=?",
                    (conversation_id,),
                ).fetchone()
                rows = db.execute(
                    "SELECT record FROM tasks WHERE root_conversation_id=? "
                    "ORDER BY rowid",
                    (row[0] if row else conversation_id,),
                ).fetchall()
            else:
                rows = db.execute(
                    "SELECT record FROM tasks ORDER BY rowid DESC"
                ).fetchall()
            return [TaskRecord.model_validate_json(row[0]) for row in rows]

    def request_for(self, task_id: str) -> CreateTaskRequest:
        with self.connection() as db:
            row = db.execute(
                "SELECT request_json FROM tasks WHERE id=?", (task_id,)
            ).fetchone()
            if row is None:
                raise KeyError("Task not found")
            return CreateTaskRequest.model_validate_json(row[0])

    # @spec GAF-003 — Exact-call approvals persist independently of a browser
    def ensure_approval(
        self, task: TaskRecord, action_id: str, name: str, arguments: dict[str, Any]
    ) -> ApprovalRecord:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT record FROM approvals WHERE task_id=? AND action_id=?",
                (task.id, action_id),
            ).fetchone()
            if row:
                return ApprovalRecord.model_validate_json(row[0])
            approval = ApprovalRecord(
                id=str(uuid4()),
                task_id=task.id,
                conversation_id=task.conversation_id,
                call_id=action_id,
                package_version=task.package_version,
                tool_name=name,
                arguments=arguments,
            )
            db.execute(
                "INSERT INTO approvals VALUES (?,?,?,?,?)",
                (
                    approval.id,
                    task.id,
                    action_id,
                    approval.status,
                    approval.model_dump_json(),
                ),
            )
            return approval

    def get_approval(self, approval_id: str) -> ApprovalRecord:
        with self.connection() as db:
            row = db.execute(
                "SELECT record FROM approvals WHERE id=?", (approval_id,)
            ).fetchone()
            if row is None:
                raise KeyError("Approval not found")
            return ApprovalRecord.model_validate_json(row[0])

    def decide(self, approval_id: str, approved: bool) -> ApprovalRecord:
        target = "approved" if approved else "rejected"
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT record FROM approvals WHERE id=?", (approval_id,)
            ).fetchone()
            if row is None:
                raise KeyError("Approval not found")
            record = ApprovalRecord.model_validate_json(row[0])
            if record.status not in ("pending", target):
                raise ValueError("Approval has already been decided")
            record.status = target
            db.execute(
                "UPDATE approvals SET status=?,record=? WHERE id=?",
                (
                    target,
                    record.model_dump_json(),
                    approval_id,
                ),
            )
            return record

    def list_approvals(self, conversation_id: str) -> list[ApprovalRecord]:
        ids = {task.id for task in self.list_tasks(conversation_id)}
        with self.connection() as db:
            return [
                record
                for row in db.execute("SELECT record FROM approvals ORDER BY rowid")
                if (record := ApprovalRecord.model_validate_json(row[0])).task_id in ids
            ]

    def cancel_approvals(self, task_id: str) -> None:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT id,record FROM approvals WHERE task_id=? AND status='pending'",
                (task_id,),
            ).fetchall()
            for row in rows:
                record = ApprovalRecord.model_validate_json(row[1])
                record.status = "cancelled"
                db.execute(
                    "UPDATE approvals SET status='cancelled',record=? WHERE id=?",
                    (record.model_dump_json(), row[0]),
                )

    def call(self, task_id: str, action_id: str) -> tuple[str, str | None] | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT state,result FROM calls WHERE task_id=? AND action_id=?",
                (task_id, action_id),
            ).fetchone()
            return (row[0], row[1]) if row else None

    def save_call(
        self,
        task_id: str,
        action_id: str,
        state: str,
        readonly: bool,
        result: str | None = None,
        details: ToolCallRecord | None = None,
    ) -> None:
        with self.connection() as db:
            db.execute(
                "INSERT INTO calls VALUES (?,?,?,?,?) "
                "ON CONFLICT(task_id,action_id) DO UPDATE SET "
                "state=excluded.state,result=excluded.result",
                (task_id, action_id, state, int(readonly), result),
            )
            if details is not None:
                db.execute(
                    "INSERT OR IGNORE INTO call_details VALUES (?,?,?)",
                    (task_id, action_id, details.model_dump_json()),
                )

    def has_unknown_writes(self, task_id: str) -> bool:
        return bool(self.unknown_write_tasks(task_id))

    def unknown_write_tasks(
        self, task_id: str, *, include_running: bool = True
    ) -> list[str]:
        """Include direct children so delegation cannot evade write reconciliation."""
        with self.connection() as db:
            return [
                row[0]
                for row in db.execute(
                    "SELECT DISTINCT calls.task_id FROM calls JOIN tasks "
                    "ON calls.task_id=tasks.id "
                    "WHERE (calls.task_id=? OR tasks.parent_id=?) "
                    "AND state IN ('unknown',?) AND readonly=0",
                    (task_id, task_id, "running" if include_running else "unknown"),
                )
            ]

    def completed_results(self, task_id: str) -> list[dict[str, Any]]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT result FROM calls WHERE task_id=? AND state='completed' "
                "ORDER BY rowid",
                (task_id,),
            ).fetchall()
            return [event for row in rows if row[0] for event in json.loads(row[0])]

    def list_calls(self, task_id: str) -> list[ToolCallRecord]:
        self.get_task(task_id)
        with self.connection() as db:
            return [
                ToolCallRecord(
                    **(
                        (json.loads(row[3]) if row[3] else {})
                        | {
                            "id": row[0],
                            "task_id": task_id,
                            "status": row[1],
                            "read_only": bool(row[2]),
                        }
                    )
                )
                for row in db.execute(
                    "SELECT calls.action_id,state,readonly,call_details.record "
                    "FROM calls LEFT JOIN call_details "
                    "ON calls.task_id=call_details.task_id "
                    "AND calls.action_id=call_details.action_id WHERE calls.task_id=?",
                    (task_id,),
                )
            ]

    def resolve_call(
        self,
        task_id: str,
        action_id: str,
        outcome: str,
        evidence: str,
        result: str | None,
    ) -> bool:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT state FROM calls WHERE task_id=? AND action_id=?",
                (task_id, action_id),
            ).fetchone()
            if row is None:
                raise KeyError("Tool call not found")
            prior = db.execute(
                "SELECT outcome,evidence FROM call_resolutions "
                "WHERE task_id=? AND action_id=?",
                (task_id, action_id),
            ).fetchone()
            if prior and tuple(prior) == (outcome, evidence):
                return False
            if prior or row[0] != "unknown":
                raise ValueError(
                    "Only unresolved calls with an unknown outcome can be resolved"
                )
            db.execute(
                "INSERT INTO call_resolutions VALUES (?,?,?,?,?)",
                (task_id, action_id, outcome, evidence, utc_now()),
            )
            db.execute(
                "UPDATE calls SET state=?,result=? WHERE task_id=? AND action_id=?",
                (
                    "completed" if outcome == "executed" else "verified_not_executed",
                    result,
                    task_id,
                    action_id,
                ),
            )
            return True

    def reconcile(self) -> None:
        with self.connection() as db:
            db.execute("UPDATE calls SET state='unknown' WHERE state='running'")
        for task in self.list_tasks():
            if task.status in ACTIVE:
                self.update_task(
                    task.id,
                    status="interrupted",
                    error="Server stopped during execution; review before resuming.",
                )

    # @spec GAF-004 — Persist only IDs, never client-supplied filesystem paths
    def save_artifact(self, record: ArtifactRecord) -> None:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = [
                ArtifactRecord.model_validate_json(row[0])
                for row in db.execute(
                    "SELECT record FROM artifacts WHERE conversation_id=?",
                    (record.conversation_id,),
                )
            ]
            record.version = (
                max(
                    (item.version for item in previous if item.name == record.name),
                    default=0,
                )
                + 1
            )
            db.execute(
                "INSERT INTO artifacts VALUES (?,?,?,?)",
                (
                    record.id,
                    record.conversation_id,
                    record.task_id,
                    record.model_dump_json(),
                ),
            )
            if record.task_id:
                db.execute(
                    "INSERT OR IGNORE INTO artifact_grants VALUES (?,?)",
                    (record.task_id, record.id),
                )

    def get_artifact(self, artifact_id: str) -> ArtifactRecord:
        with self.connection() as db:
            row = db.execute(
                "SELECT record FROM artifacts WHERE id=?", (artifact_id,)
            ).fetchone()
            if row is None:
                raise KeyError("Artifact not found")
            return ArtifactRecord.model_validate_json(row[0])

    def allowed_artifact(self, task_id: str, artifact_id: str) -> bool:
        with self.connection() as db:
            return (
                db.execute(
                    "SELECT 1 FROM artifact_grants WHERE task_id=? AND artifact_id=?",
                    (task_id, artifact_id),
                ).fetchone()
                is not None
            )

    def grant_artifact(self, task_id: str, artifact_id: str) -> None:
        with self.connection() as db:
            db.execute(
                "INSERT OR IGNORE INTO artifact_grants VALUES (?,?)",
                (task_id, artifact_id),
            )

    def list_artifacts(self, conversation_id: str) -> list[ArtifactRecord]:
        ids = {task.conversation_id for task in self.list_tasks(conversation_id)}
        with self.connection() as db:
            return [
                record
                for row in db.execute("SELECT record FROM artifacts ORDER BY rowid")
                if (
                    record := ArtifactRecord.model_validate_json(row[0])
                ).conversation_id
                in ids
            ]
