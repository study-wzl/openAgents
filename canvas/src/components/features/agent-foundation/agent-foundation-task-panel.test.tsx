import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FoundationService, {
  type ApprovalRequest,
  type ArtifactRef,
  type TaskRecord,
} from "#/api/agent-foundation-service";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import { renderWithProviders } from "../../../../test-utils";
import { AgentFoundationTaskPanel } from "./agent-foundation-task-panel";

const task: TaskRecord = {
  id: "task-1",
  agent_id: "research/assistant",
  conversation_id: "conversation-1",
  parent_task_id: null,
  status: "waiting_for_confirmation",
  task: "Prepare a report",
  result: null,
  error: null,
  package_version: "1.0.0",
  created_at: "2026-10-05T00:00:00Z",
  updated_at: "2026-10-05T00:00:00Z",
};
const approval: ApprovalRequest = {
  id: "approval-1",
  task_id: task.id,
  conversation_id: "conversation-1",
  tool_name: "send_report",
  call_id: "call-1",
  package_version: "1.0.0",
  arguments: { recipient: "reviewer@example.com" },
  status: "pending",
};
const artifact: ArtifactRef = {
  id: "artifact-1",
  conversation_id: "conversation-1",
  task_id: task.id,
  name: "report.pdf",
  mime_type: "application/pdf",
  size: 100,
  version: 1,
};

describe("AgentFoundationTaskPanel", () => {
  beforeEach(() => {
    setRegisteredBackends([
      {
        id: "foundation",
        name: "Foundation",
        host: "http://localhost:8000",
        apiKey: "test",
        kind: "local",
      },
    ]);
    setActiveSelection({ backendId: "foundation" });
    vi.spyOn(FoundationService, "listTasks").mockResolvedValue([task]);
    vi.spyOn(FoundationService, "listApprovals").mockResolvedValue([approval]);
    vi.spyOn(FoundationService, "listArtifacts").mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setActiveSelection(null);
    setRegisteredBackends([]);
  });

  // @spec GAF-003 — A confirmation applies to the exact pending invocation.
  it("shows tool arguments and removes a confirmation once it is decided", async () => {
    const decide = vi
      .spyOn(FoundationService, "decideApproval")
      .mockImplementation(async () => {
        vi.mocked(FoundationService.listApprovals).mockResolvedValue([
          { ...approval, status: "approved" },
        ]);
        return { ...approval, status: "approved" };
      });
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationTaskPanel conversationId="conversation-1" />
      </ActiveBackendProvider>,
    );
    await screen.findByText(/reviewer@example.com/);
    fireEvent.click(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$APPROVE" }),
    );
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        "approval-1",
        true,
        expect.objectContaining({ id: "foundation" }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "AGENT_FOUNDATION$APPROVE" }),
      ).not.toBeInTheDocument(),
    );
  });

  // @spec GAF-004 — Artifact uploads stay bound to their original conversation and backend.
  it("uploads a file and displays the persisted artifact returned by the server", async () => {
    const file = new File(["report"], "report.pdf", {
      type: "application/pdf",
    });
    const upload = vi
      .spyOn(FoundationService, "uploadArtifact")
      .mockImplementation(async () => {
        vi.mocked(FoundationService.listArtifacts).mockResolvedValue([
          artifact,
        ]);
        return artifact;
      });
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationTaskPanel conversationId="conversation-1" />
      </ActiveBackendProvider>,
    );
    await screen.findByText("Prepare a report");
    fireEvent.change(
      screen.getByLabelText("AGENT_FOUNDATION$UPLOAD", { selector: "input" }),
      { target: { files: [file] } },
    );
    await screen.findByRole("button", { name: "AGENT_FOUNDATION$DOWNLOAD" });
    expect(upload).toHaveBeenCalledWith(
      "conversation-1",
      file,
      expect.objectContaining({ id: "foundation" }),
    );
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("keeps legacy conversations free of task-only controls", async () => {
    vi.mocked(FoundationService.listTasks).mockResolvedValue([]);
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationTaskPanel conversationId="legacy-conversation" />
      </ActiveBackendProvider>,
    );
    await waitFor(() =>
      expect(FoundationService.listTasks).toHaveBeenCalledWith(
        "legacy-conversation",
        expect.objectContaining({ id: "foundation" }),
      ),
    );
    expect(
      screen.queryByTestId("agent-foundation-task-panel"),
    ).not.toBeInTheDocument();
    expect(FoundationService.listArtifacts).not.toHaveBeenCalled();
  });

  // @spec GAF-003 — Recording external evidence never automatically replays an uncertain action.
  it("requires evidence and a decision before a separate task resume", async () => {
    vi.mocked(FoundationService.listTasks).mockResolvedValue([
      { ...task, status: "interrupted" },
    ]);
    const call = {
      id: "call-1",
      task_id: task.id,
      status: "unknown",
      read_only: false,
      tool_name: "send_invoice",
      arguments: { invoice_id: "invoice-42" },
      package_version: "1.0.0",
    };
    vi.spyOn(FoundationService, "listToolCalls").mockResolvedValue([call]);
    const resolve = vi
      .spyOn(FoundationService, "resolveToolCall")
      .mockImplementation(async () => {
        vi.mocked(FoundationService.listToolCalls).mockResolvedValue([
          { ...call, status: "succeeded" },
        ]);
        return { ...call, status: "succeeded" };
      });
    const resume = vi
      .spyOn(FoundationService, "resumeTask")
      .mockResolvedValue({ ...task, status: "running" });
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationTaskPanel conversationId="conversation-1" />
      </ActiveBackendProvider>,
    );
    await screen.findByText("call-1");
    expect(screen.getByText("send_invoice")).toBeInTheDocument();
    expect(screen.getByText(/invoice-42/)).toBeInTheDocument();
    const submit = screen.getByRole("button", {
      name: "AGENT_FOUNDATION$CALL_RECORD_DECISION",
    });
    const resumeButton = screen.getByRole("button", {
      name: "AGENT_FOUNDATION$RESUME_TASK",
    });
    expect(submit).toBeDisabled();
    expect(resumeButton).toBeDisabled();
    fireEvent.change(
      screen.getByRole("textbox", { name: "AGENT_FOUNDATION$CALL_EVIDENCE" }),
      { target: { value: "Delivery receipt 42 verified" } },
    );
    expect(submit).toBeDisabled();
    fireEvent.click(
      screen.getByRole("radio", { name: "AGENT_FOUNDATION$CALL_EXECUTED" }),
    );
    fireEvent.click(submit);
    await screen.findByText("AGENT_FOUNDATION$CALL_RECORDED");
    expect(resolve).toHaveBeenCalledWith(
      task.id,
      call.id,
      { outcome: "executed", evidence: "Delivery receipt 42 verified" },
      expect.objectContaining({ id: "foundation" }),
    );
    expect(resume).not.toHaveBeenCalled();
    await waitFor(() => expect(resumeButton).toBeEnabled());
    fireEvent.click(resumeButton);
    await waitFor(() =>
      expect(resume).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ id: "foundation" }),
      ),
    );
  });

  it("keeps resume disabled when tool-call verification cannot be loaded", async () => {
    vi.mocked(FoundationService.listTasks).mockResolvedValue([
      { ...task, status: "cancelled" },
    ]);
    vi.spyOn(FoundationService, "listToolCalls").mockRejectedValue(
      new Error("Cannot verify calls"),
    );
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationTaskPanel conversationId="conversation-1" />
      </ActiveBackendProvider>,
    );
    await screen.findByText("Cannot verify calls");
    expect(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$RESUME_TASK" }),
    ).toBeDisabled();
  });
});
