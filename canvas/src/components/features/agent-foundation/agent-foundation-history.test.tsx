import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import { renderWithProviders } from "../../../../test-utils";
import { AgentFoundationHistory } from "./agent-foundation-history";

const conversation: AppConversation = {
  id: "legacy/one",
  created_by_user_id: null,
  selected_repository: "old/repository",
  selected_branch: "main",
  git_provider: null,
  title: "Legacy research",
  trigger: null,
  pr_number: [],
  llm_model: null,
  metrics: null,
  created_at: "2026-10-05",
  updated_at: "2026-10-05",
  execution_status: null,
  conversation_url: null,
  session_api_key: null,
  sandbox_id: null,
  sub_conversation_ids: [],
};

describe("AgentFoundationHistory", () => {
  beforeEach(() => {
    setRegisteredBackends([
      {
        id: "foundation",
        name: "Foundation",
        host: "http://localhost:8000",
        apiKey: "",
        kind: "local",
      },
    ]);
    setActiveSelection({ backendId: "foundation" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setActiveSelection(null);
    setRegisteredBackends([]);
  });

  // @spec GAF-005 — Legacy records remain linked to their owning backend across pagination.
  it("keeps historical conversations and fetches the next page with its cursor", async () => {
    const search = vi
      .spyOn(ConversationService, "searchConversations")
      .mockResolvedValueOnce({ items: [conversation], next_page_id: "page-2" })
      .mockResolvedValueOnce({
        items: [{ ...conversation, id: "new-two", title: "Current research" }],
        next_page_id: null,
      });
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationHistory />
      </ActiveBackendProvider>,
    );
    const link = await screen.findByRole("link", { name: "Legacy research" });
    expect(link).toHaveAttribute(
      "href",
      "/conversations/legacy%2Fone?backend=foundation",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "CHAT_INTERFACE$FETCHING_OLDER_MESSAGES",
      }),
    );
    await screen.findByRole("link", { name: "Current research" });
    expect(search).toHaveBeenLastCalledWith(20, "page-2");
    expect(
      screen.getByRole("link", { name: "Legacy research" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "CHAT_INTERFACE$FETCHING_OLDER_MESSAGES",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("old/repository")).not.toBeInTheDocument();
  });

  it("recovers a failed history request through an explicit retry", async () => {
    const search = vi
      .spyOn(ConversationService, "searchConversations")
      .mockRejectedValueOnce(new Error("History offline"))
      .mockResolvedValueOnce({ items: [conversation], next_page_id: null });
    renderWithProviders(
      <ActiveBackendProvider>
        <AgentFoundationHistory />
      </ActiveBackendProvider>,
    );
    await screen.findByRole("alert");
    fireEvent.click(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$RETRY" }),
    );
    await screen.findByRole("link", { name: "Legacy research" });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });
});
