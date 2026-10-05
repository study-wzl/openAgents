import { useTranslation } from "react-i18next";
import { usePaginatedConversations } from "#/hooks/query/use-paginated-conversations";
import { NavigationLink } from "#/components/shared/navigation-link";
import { useBackendScopedPath } from "#/hooks/use-backend-scoped-path";
import { I18nKey } from "#/i18n/declaration";

// @spec GAF-005 — History keeps old records without repository UI
export function AgentFoundationHistory() {
  const { t } = useTranslation("openhands");
  const conversations = usePaginatedConversations();
  const scopedPath = useBackendScopedPath();
  const items = conversations.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
      <NavigationLink
        to={scopedPath("/conversations")}
        className="rounded-md border border-border px-3 py-2"
      >
        {t(I18nKey.AGENT_FOUNDATION$CHOOSE_AGENT)}
      </NavigationLink>
      {items.map((conversation) => (
        <NavigationLink
          key={conversation.id}
          to={scopedPath(
            `/conversations/${encodeURIComponent(conversation.id)}`,
          )}
          className="truncate rounded-md px-3 py-2 hover:bg-surface"
        >
          {conversation.title || t(I18nKey.AGENT_FOUNDATION$TASK_PROGRESS)}
        </NavigationLink>
      ))}
      {conversations.isError && (
        <div role="alert">
          <p>{t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED)}</p>
          <button type="button" onClick={() => void conversations.refetch()}>
            {t(I18nKey.AGENT_FOUNDATION$RETRY)}
          </button>
        </div>
      )}
      {conversations.hasNextPage && (
        <button
          type="button"
          disabled={conversations.isFetchingNextPage}
          onClick={() => void conversations.fetchNextPage()}
        >
          {t(I18nKey.CHAT_INTERFACE$FETCHING_OLDER_MESSAGES)}
        </button>
      )}
    </nav>
  );
}
