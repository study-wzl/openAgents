import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FoundationService, {
  type TaskRecord,
} from "#/api/agent-foundation-service";
import ConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";
import EventService from "#/api/event-service/event-service.api";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import { ConversationWebSocketProvider } from "#/contexts/conversation-websocket-context";
import { NavigationProvider } from "#/context/navigation-context";
import { useConversationStore } from "#/stores/conversation-store";
import { useConversationStateStore } from "#/stores/conversation-state-store";
import { useEventStore } from "#/stores/use-event-store";
import { ExecutionStatus } from "#/types/agent-server/core/base/common";
import {
  createPlanningObservationEvent,
  createUserMessageEvent,
  renderWithProviders,
} from "../../../../test-utils";
import { Messages } from "#/components/conversation-events/chat/messages";
import { AgentFoundationChat } from "./agent-foundation-chat";

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];
  readyState = TestWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();
  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }
  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  close() {
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }
}

const conversation: AppConversation = {
  id: "conversation-1",
  created_by_user_id: null,
  selected_repository: null,
  selected_branch: null,
  git_provider: null,
  title: "Research",
  trigger: null,
  pr_number: [],
  llm_model: null,
  metrics: null,
  created_at: "2026-10-05",
  updated_at: "2026-10-05",
  execution_status: ExecutionStatus.IDLE,
  conversation_url: "http://localhost:8000/api/conversations/conversation-1",
  session_api_key: null,
  sandbox_id: null,
  sub_conversation_ids: [],
};
const task: TaskRecord = {
  id: "task-1",
  agent_id: "research/assistant",
  conversation_id: conversation.id,
  parent_task_id: null,
  status: "running",
  task: "Research",
  result: null,
  error: null,
  package_version: "1",
  created_at: "today",
  updated_at: "today",
};

function renderChat() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (conversationId = conversation.id) => (
    <QueryClientProvider client={queryClient}>
      <ActiveBackendProvider>
        <NavigationProvider
          value={{
            currentPath: `/conversations/${conversationId}`,
            conversationId,
            isNavigating: false,
            navigate: vi.fn(),
          }}
        >
          <ConversationWebSocketProvider
            conversationId={conversationId}
            conversationUrl={`http://localhost:8000/api/conversations/${conversationId}`}
          >
            <AgentFoundationChat />
          </ConversationWebSocketProvider>
        </NavigationProvider>
      </ActiveBackendProvider>
    </QueryClientProvider>
  );
  return { ...render(view()), queryClient, view };
}

async function openSocket() {
  await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
  const socket = TestWebSocket.instances[0];
  act(() => socket.open());
  return socket;
}

describe("AgentFoundationChat", () => {
  beforeEach(() => {
    TestWebSocket.instances = [];
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
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
    useConversationStore.getState().setConversationMode("code");
    useConversationStore.getState().setPlanContent(null);
    useConversationStateStore.getState().reset();
    useEventStore.getState().clearEventsForConversation(conversation.id);
    vi.spyOn(ConversationService, "batchGetAppConversations").mockResolvedValue(
      [conversation],
    );
    vi.spyOn(EventService, "getEventCount").mockResolvedValue(1);
    vi.spyOn(EventService, "searchEvents").mockResolvedValue({
      items: [createUserMessageEvent("message-1")],
      next_page_id: null,
    });
    vi.spyOn(FoundationService, "listTasks").mockResolvedValue([task]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setActiveSelection(null);
    setRegisteredBackends([]);
    useConversationStore.getState().setPlanContent(null);
    useConversationStateStore.getState().reset();
  });

  // @spec GAF-005 — Legacy history stays readable and cannot send new input.
  it("shows legacy messages in a read-only conversation", async () => {
    vi.mocked(FoundationService.listTasks).mockResolvedValue([]);
    renderChat();
    const socket = await openSocket();
    await screen.findByText("User message");
    await screen.findByText("AGENT_FOUNDATION$LEGACY_READ_ONLY");
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "CHAT_INTERFACE$INPUT_SEND_MESSAGE_BUTTON_CONTENT",
      }),
    ).toBeDisabled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  // @spec GAF-005 — Old planning history retains text without coding actions.
  it("shows historical plan text without planning controls in legacy chat", async () => {
    const plan = createPlanningObservationEvent("old-plan");
    plan.observation.new_content = "Historical research plan";
    vi.mocked(FoundationService.listTasks).mockResolvedValue([]);
    vi.mocked(EventService.searchEvents).mockResolvedValue({
      items: [createUserMessageEvent("message-1"), plan],
      next_page_id: null,
    });
    vi.mocked(EventService.getEventCount).mockResolvedValue(2);
    useConversationStore.getState().setPlanContent("Unrelated current plan");
    renderChat();
    await openSocket();
    await screen.findByText("Historical research plan");
    expect(
      screen.queryByText("Unrelated current plan"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("plan-preview-build-button"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("plan-preview-view-button"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("sends managed input only for a runnable task with an open socket", async () => {
    const { queryClient } = renderChat();
    await screen.findByText("User message");
    expect(screen.getByRole("textbox")).toBeDisabled();
    const socket = await openSocket();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Continue research" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "CHAT_INTERFACE$INPUT_SEND_MESSAGE_BUTTON_CONTENT",
      }),
    );
    await waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "Continue research" }],
          run: true,
        }),
      ),
    );
    expect(input).toHaveValue("");
    vi.mocked(FoundationService.listTasks).mockResolvedValue([
      { ...task, status: "waiting_for_confirmation" },
    ]);
    await queryClient.invalidateQueries({ queryKey: ["agent-foundation"] });
    await waitFor(() => expect(input).toBeDisabled());
    vi.mocked(FoundationService.listTasks).mockResolvedValue([
      { ...task, status: "completed" },
    ]);
    await queryClient.invalidateQueries({ queryKey: ["agent-foundation"] });
    await waitFor(() => expect(input).toBeEnabled());
    act(() => socket.close());
    expect(input).toBeDisabled();
  });

  it("blocks sending after a task refresh fails without mislabeling the conversation as legacy", async () => {
    const { queryClient } = renderChat();
    await openSocket();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    vi.mocked(FoundationService.listTasks).mockRejectedValue(
      new Error("Task service offline"),
    );
    await queryClient.invalidateQueries({ queryKey: ["agent-foundation"] });
    await screen.findByRole("alert");
    expect(input).toBeDisabled();
    expect(input).toHaveValue("Keep this draft");
    expect(
      screen.queryByText("AGENT_FOUNDATION$LEGACY_READ_ONLY"),
    ).not.toBeInTheDocument();
  });

  it("clears the draft when the active conversation changes", async () => {
    const { rerender, view } = renderChat();
    await openSocket();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "First conversation draft" },
    });
    vi.mocked(FoundationService.listTasks).mockResolvedValue([
      { ...task, id: "task-2", conversation_id: "conversation-2" },
    ]);
    vi.mocked(ConversationService.batchGetAppConversations).mockResolvedValue([
      { ...conversation, id: "conversation-2" },
    ]);
    rerender(view("conversation-2"));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it.each([true, false])(
    "never mounts native confirmation controls for generic chat (managed=%s)",
    async (managed) => {
      vi.mocked(FoundationService.listTasks).mockResolvedValue(
        managed ? [{ ...task, status: "waiting_for_confirmation" }] : [],
      );
      renderChat();
      await openSocket();
      act(() => {
        const eventStore = useEventStore.getState();
        eventStore.addEvent({
          ...createUserMessageEvent("awaiting-1"),
          source: "agent",
          llm_message: {
            role: "assistant",
            content: [{ type: "text", text: "Waiting for approval" }],
          },
        });
        useConversationStateStore
          .getState()
          .setExecutionStatus(
            conversation.id,
            ExecutionStatus.WAITING_FOR_CONFIRMATION,
          );
      });
      await screen.findByText("Waiting for approval");
      expect(
        screen.queryByText("CHAT_INTERFACE$USER_ASK_CONFIRMATION"),
      ).not.toBeInTheDocument();
    },
  );

  it("preserves native confirmation controls for existing Messages consumers", async () => {
    const event = {
      ...createUserMessageEvent("awaiting-1"),
      source: "agent" as const,
    };
    useEventStore.getState().addEvent(event);
    useConversationStateStore
      .getState()
      .setExecutionStatus(
        conversation.id,
        ExecutionStatus.WAITING_FOR_CONFIRMATION,
      );
    const messages: [] = [];
    const { rerender } = renderWithProviders(
      <Messages messages={messages} allEvents={messages} />,
      { navigation: { conversationId: conversation.id } },
    );
    await screen.findByText("CHAT_INTERFACE$USER_ASK_CONFIRMATION");
    rerender(<Messages messages={messages} allEvents={messages} readOnly />);
    expect(
      screen.queryByText("CHAT_INTERFACE$USER_ASK_CONFIRMATION"),
    ).not.toBeInTheDocument();
  });
});
