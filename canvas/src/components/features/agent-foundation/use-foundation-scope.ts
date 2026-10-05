import { useQueryClient } from "@tanstack/react-query";
import {
  getActiveBackend,
  isNoBackend,
} from "#/api/backend-registry/active-store";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { isSdkHttpStatusError } from "#/api/agent-server-compatibility";

const FOUNDATION_QUERY_KEY = "agent-foundation";
export const FOUNDATION_POLL_INTERVAL = 3000;

/** Backend identity also owns drafts, mutation results, and query caches. */
export function useFoundationScope() {
  const { backend, orgId } = useActiveBackend();
  const queryClient = useQueryClient();
  const connectionRevision = backend.connectionRevision ?? 0;
  const queryKey = [
    FOUNDATION_QUERY_KEY,
    backend.id,
    orgId,
    connectionRevision,
  ] as const;
  const enabled = !isNoBackend(backend) && backend.kind === "local";
  const scopeId = JSON.stringify(queryKey);
  return {
    backend,
    scopeId,
    queryKey,
    enabled,
    queryOptions: {
      retry: false as const,
      meta: { backendId: backend.id, disableToast: true },
    },
    invalidate: () => queryClient.invalidateQueries({ queryKey }),
    isCurrent: () => {
      const current = getActiveBackend();
      return (
        current.backend.id === backend.id &&
        current.orgId === orgId &&
        (current.backend.connectionRevision ?? 0) === connectionRevision
      );
    },
  };
}

export function foundationErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error ? error.message : fallback;
}

export function isFoundationUnsupportedError(error: unknown): boolean {
  return isSdkHttpStatusError(error, 404) || isSdkHttpStatusError(error, 405);
}
