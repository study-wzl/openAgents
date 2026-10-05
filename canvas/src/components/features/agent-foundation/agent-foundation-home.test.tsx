import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FoundationService, {
  type TaskRecord,
} from "#/api/agent-foundation-service";
import {
  setActiveSelection,
  setRegisteredBackends,
  getActiveBackend,
} from "#/api/backend-registry/active-store";
import { renderWithProviders } from "../../../../test-utils";
import { AgentFoundationHome } from "./agent-foundation-home";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";

const agent = {
  id: "research/assistant",
  name: "Research assistant",
  description: "Research and summarize",
  profile_id: "research",
  package_id: "research",
  package_version: "1.0.0",
  enabled: true,
};
const installedPackage = {
  id: "research",
  name: "Research",
  version: "1.0.0",
  description: "Research tools",
  enabled: true,
  content_hash: "research-content-hash",
  ui_extension_ref: "business-foundation-ui",
};

describe("AgentFoundationHome", () => {
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
    vi.spyOn(FoundationService, "listAgents").mockResolvedValue([agent]);
    vi.spyOn(FoundationService, "listPackages").mockResolvedValue([
      installedPackage,
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setActiveSelection(null);
    setRegisteredBackends([]);
  });

  // @spec GAF-005 — Business tasks launch with the selected agent.
  it("reuses the same request identity on retry and opens the created conversation", async () => {
    const navigate = vi.fn();
    const createTask = vi
      .spyOn(FoundationService, "createTask")
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({
        id: "task-1",
        agent_id: agent.id,
        conversation_id: "conversation-1",
        parent_task_id: null,
        status: "running",
        task: "Summarize the market",
        result: null,
        error: null,
        package_version: "1.0.0",
        created_at: "2026-10-05T00:00:00Z",
        updated_at: "2026-10-05T00:00:00Z",
      });
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationHome />
      </ActiveBackendProvider>,
      { navigation: { navigate } },
    );
    await screen.findByRole("button", { name: /Research assistant/ });
    fireEvent.change(
      screen.getByRole("textbox", { name: "AGENT_FOUNDATION$TASK_LABEL" }),
      { target: { value: "Summarize the market" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$START_TASK" }),
    );
    await screen.findByText("Connection lost");
    fireEvent.click(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$START_TASK" }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/conversations/conversation-1"),
    );
    expect(createTask.mock.calls[0][0]).toEqual(createTask.mock.calls[1][0]);
    expect(createTask.mock.calls[0][0]).toMatchObject({
      agent_id: agent.id,
      task: "Summarize the market",
    });
  });

  // @spec GAF-005 — Package installation uses the validated source.
  it("invalidates validation when the package source changes", async () => {
    const validate = vi
      .spyOn(FoundationService, "validatePackage")
      .mockResolvedValue({ valid: true, errors: [] });
    const install = vi
      .spyOn(FoundationService, "installPackage")
      .mockResolvedValue(installedPackage);
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationHome />
      </ActiveBackendProvider>,
    );
    await screen.findByText("Research");
    const source = screen.getByRole("textbox", {
      name: "AGENT_FOUNDATION$SOURCE_LABEL",
    });
    fireEvent.change(source, { target: { value: "/packages/research" } });
    fireEvent.click(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$VALIDATE" }),
    );
    await screen.findByText("AGENT_FOUNDATION$VALID");
    expect(screen.getByText("business-foundation-ui")).toBeInTheDocument();
    expect(validate).toHaveBeenCalledWith(
      "/packages/research",
      expect.objectContaining({ kind: "local" }),
    );
    fireEvent.change(source, { target: { value: "/packages/other" } });
    expect(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$INSTALL" }),
    ).toBeDisabled();
    expect(install).not.toHaveBeenCalled();
  });

  it("loads the selected package version's effective configuration only when expanded", async () => {
    const getConfig = vi
      .spyOn(FoundationService, "getAgentConfig")
      .mockResolvedValue({
        agent,
        content_hash: "content-hash",
        resolved_model: "configured-model",
        resolved_skills: [],
        runtime_tools: ["business_write_report", "delegate_task"],
        child_runtime_tools: ["business_write_report"],
        delegation_note: "Delegated agents cannot delegate again.",
        allowed_agents: [],
        tool_policies: {},
        managed_by_package: true,
        read_only: true,
        external_dependencies_pinned: false,
        profile: {
          id: "profile",
          name: "Research",
          revision: 1,
          agent_kind: "openhands",
          llm_profile_ref: "default",
          agent: "Agent",
          mcp_server_refs: [],
          skills: [],
          system_message_suffix: null,
          condenser: null,
          enable_sub_agents: false,
          tool_concurrency_limit: 1,
          verification: {
            critic_enabled: false,
            critic_mode: "default",
            enable_iterative_refinement: false,
            critic_threshold: 0.5,
            max_refinement_iterations: 1,
            critic_server_url: null,
            critic_model_name: null,
          },
        },
      });
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationHome />
      </ActiveBackendProvider>,
    );
    await screen.findByText("Research assistant");
    expect(getConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("AGENT_FOUNDATION$EFFECTIVE_CONFIG"));
    await screen.findByText(/configured-model/);
    expect(
      screen.getByText(/Delegated agents cannot delegate again/),
    ).toBeInTheDocument();
    expect(screen.getByText(/child_runtime_tools/)).toBeInTheDocument();
    expect(getConfig).toHaveBeenCalledWith(
      agent.id,
      agent.package_version,
      expect.objectContaining({ id: "foundation" }),
    );
  });

  it("drops the old draft on a backend switch and ignores a late task creation response", async () => {
    const originalBackend = getActiveBackend().backend;
    setRegisteredBackends([
      originalBackend,
      {
        ...originalBackend,
        id: "other",
        name: "Other",
        host: "http://localhost:9000",
      },
    ]);
    vi.mocked(FoundationService.listAgents).mockImplementation(async () =>
      getActiveBackend().backend.id === "other"
        ? [{ ...agent, id: "support/assistant", name: "Support assistant" }]
        : [agent],
    );
    let resolveTask: (record: TaskRecord) => void = () => {};
    vi.spyOn(FoundationService, "createTask").mockReturnValue(
      new Promise((resolve) => {
        resolveTask = resolve;
      }),
    );
    const navigate = vi.fn();
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationHome />
      </ActiveBackendProvider>,
      { navigation: { navigate } },
    );
    await screen.findByRole("button", { name: /Research assistant/ });
    fireEvent.change(
      screen.getByRole("textbox", { name: "AGENT_FOUNDATION$TASK_LABEL" }),
      { target: { value: "Private research task" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$START_TASK" }),
    );
    await waitFor(() =>
      expect(FoundationService.createTask).toHaveBeenCalled(),
    );
    act(() => setActiveSelection({ backendId: "other" }));
    await screen.findByRole("button", { name: /Support assistant/ });
    expect(
      screen.getByRole("textbox", { name: "AGENT_FOUNDATION$TASK_LABEL" }),
    ).toHaveValue("");
    await act(async () =>
      resolveTask({
        id: "old-task",
        agent_id: agent.id,
        conversation_id: "old-conversation",
        parent_task_id: null,
        status: "running",
        task: "Private research task",
        result: null,
        error: null,
        package_version: "1.0.0",
        created_at: "2026-10-05T00:00:00Z",
        updated_at: "2026-10-05T00:00:00Z",
      }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
