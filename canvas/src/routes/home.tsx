import { lazy, Suspense } from "react";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { AgentFoundationHome } from "#/components/features/agent-foundation/agent-foundation-home";

const CodingHome = lazy(() => import("./coding-home"));

// @spec AF-UI-001 — Self-hosted users start business tasks without choosing a repository.
export default function HomeScreen() {
  const { backend } = useActiveBackend();
  if (backend.kind === "cloud")
    return (
      <Suspense fallback={null}>
        <CodingHome />
      </Suspense>
    );
  return <AgentFoundationHome />;
}
