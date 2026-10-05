import { AgentFoundationChat } from "./agent-foundation-chat";
import { ConversationName } from "#/components/features/conversation/conversation-name";
import { SidebarMobileMenuToggle } from "#/components/features/sidebar/sidebar-mobile-menu-toggle";
import { useConversationId } from "#/hooks/use-conversation-id";
import { AgentFoundationTaskPanel } from "./agent-foundation-task-panel";

// @spec GAF-005 — Local application conversations use tasks and artifacts
export function AgentFoundationConversation() {
  const { conversationId } = useConversationId();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden lg:flex-row">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 px-3">
          <SidebarMobileMenuToggle />
          <ConversationName />
        </div>
        <div className="mx-auto flex min-h-0 w-full max-w-200 flex-1 flex-col">
          <AgentFoundationChat />
        </div>
      </section>
      <aside className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border lg:max-h-none lg:w-96 lg:border-t-0 lg:border-l">
        <AgentFoundationTaskPanel conversationId={conversationId} />
      </aside>
    </div>
  );
}
