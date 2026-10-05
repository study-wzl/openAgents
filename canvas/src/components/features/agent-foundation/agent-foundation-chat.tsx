import { useQuery } from "@tanstack/react-query";
import FoundationService from "#/api/agent-foundation-service";
import { useFoundationScope } from "./use-foundation-scope";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Messages } from "#/components/conversation-events/chat/messages";
import { useFilteredEvents } from "#/hooks/use-filtered-events";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useLoadOlderEvents } from "#/hooks/use-load-older-events";
import { useSendMessage } from "#/hooks/use-send-message";
import { useConversationWebSocket } from "#/contexts/conversation-websocket-context";
import { I18nKey } from "#/i18n/declaration";

// @spec GAF-005 — Generic chat retains native events without coding controls
export function AgentFoundationChat() {
  const { scopeId } = useFoundationScope();
  const { conversationId } = useConversationId();
  return <FoundationChatForConversation key={`${scopeId}:${conversationId}`} />;
}

function FoundationChatForConversation() {
  const { t } = useTranslation("openhands");
  const scope = useFoundationScope();
  const { conversationId } = useConversationId();
  const { renderableEvents, allConversationEvents } = useFilteredEvents();
  const older = useLoadOlderEvents(conversationId);
  const socket = useConversationWebSocket();
  const { send } = useSendMessage();
  // Scope already includes backend ID and revision; credentials stay out of cache keys.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const tasks = useQuery({
    queryKey: [...scope.queryKey, "tasks", conversationId],
    queryFn: () => FoundationService.listTasks(conversationId, scope.backend),
    enabled: scope.enabled,
    ...scope.queryOptions,
  });
  const main = tasks.data?.find(
    (task) => task.conversation_id === conversationId,
  );
  const canSend =
    scope.enabled &&
    !tasks.isError &&
    !!main &&
    ["running", "completed"].includes(main.status) &&
    socket?.connectionState === "OPEN";
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {older.hasMore && (
          <button
            type="button"
            disabled={older.isLoading}
            onClick={() => void older.loadOlder().catch(() => setError(true))}
          >
            {t(I18nKey.CHAT_INTERFACE$FETCHING_OLDER_MESSAGES)}
          </button>
        )}
        <Messages
          messages={renderableEvents}
          allEvents={allConversationEvents}
          readOnly
        />
      </div>
      <form
        className="flex flex-col gap-2 p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!draft.trim() || sending || !canSend) return;
          setSending(true);
          setError(false);
          try {
            await send({ action: "message", args: { content: draft } });
            setDraft("");
          } catch {
            setError(true);
          } finally {
            setSending(false);
          }
        }}
      >
        {!main && tasks.isSuccess && (
          <p role="status">{t(I18nKey.AGENT_FOUNDATION$LEGACY_READ_ONLY)}</p>
        )}
        {(error || tasks.isError) && (
          <p role="alert">{t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED)}</p>
        )}
        {tasks.isError && (
          <button type="button" onClick={() => void tasks.refetch()}>
            {t(I18nKey.AGENT_FOUNDATION$RETRY)}
          </button>
        )}
        <textarea
          className="rounded-lg border border-border bg-surface p-3"
          aria-label={t(I18nKey.AGENT_FOUNDATION$TASK_LABEL)}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t(I18nKey.AGENT_FOUNDATION$TASK_PLACEHOLDER)}
          rows={3}
          disabled={!canSend || sending}
        />
        <button
          type="submit"
          className="self-end rounded-lg bg-primary px-4 py-2"
          disabled={!draft.trim() || sending || !canSend}
        >
          {t(I18nKey.CHAT_INTERFACE$INPUT_SEND_MESSAGE_BUTTON_CONTENT)}
        </button>
      </form>
    </>
  );
}
