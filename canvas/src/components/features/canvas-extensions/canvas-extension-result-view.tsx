import React from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import FoundationService from "#/api/agent-foundation-service";
import { getActiveBackend } from "#/api/backend-registry/active-store";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { I18nKey } from "#/i18n/declaration";
import type { CanvasExtensionResult } from "#/types/canvas-extension";
import { downloadBlob } from "#/utils/utils";
import {
  canvasExtensionResultScope,
  useCanvasExtensionsRuntime,
  type RegisteredCanvasExtensionResultRenderer,
} from "./canvas-extensions-runtime";

function DefaultResult({ result }: { result: CanvasExtensionResult }) {
  const { t } = useTranslation("openhands");
  const { backend, orgId } = useActiveBackend();
  const download = useMutation({
    mutationFn: async (
      artifact: NonNullable<CanvasExtensionResult["artifacts"]>[number],
    ) => {
      const blob = await FoundationService.downloadArtifact(
        artifact.id,
        backend,
      );
      const active = getActiveBackend();
      if (
        active.backend.id === backend.id &&
        active.orgId === orgId &&
        active.backend.connectionRevision === backend.connectionRevision
      ) {
        downloadBlob(blob, artifact.name);
      }
    },
  });
  const data =
    typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data, null, 2);
  return (
    <div className="space-y-2">
      {result.text && (
        <p className="whitespace-pre-wrap break-words">{result.text}</p>
      )}
      {data && data !== result.text && (
        <pre className="overflow-auto whitespace-pre-wrap break-words text-sm">
          {data}
        </pre>
      )}
      {result.artifacts?.map((artifact) => (
        <button
          key={artifact.id}
          type="button"
          disabled={download.isPending}
          onClick={() => download.mutate(artifact)}
          className="block text-sm underline"
        >
          {t(I18nKey.AGENT_FOUNDATION$DOWNLOAD, { name: artifact.name })}
        </button>
      ))}
      {download.error && (
        <p role="alert">{t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED)}</p>
      )}
    </div>
  );
}

export interface CanvasExtensionResultViewProps {
  result: CanvasExtensionResult;
  conversationId?: string | null;
  /** Preserve the surrounding event's existing presentation when no renderer works. */
  fallback?: React.ReactNode;
}

// @spec GAF-006 — Optional renderers never make the underlying result unavailable.
export function CanvasExtensionResultView({
  result,
  conversationId = null,
  fallback,
}: CanvasExtensionResultViewProps) {
  const { resultRenderers } = useCanvasExtensionsRuntime();
  const { backend, orgId } = useActiveBackend();
  const scope = canvasExtensionResultScope(result);
  const renderer = resultRenderers.find(
    (entry) => canvasExtensionResultScope(entry.contribution) === scope,
  );
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [failedMount, setFailedMount] = React.useState<{
    renderer: RegisteredCanvasExtensionResultRenderer;
    result: CanvasExtensionResult;
  } | null>(null);
  const failed =
    failedMount?.renderer === renderer && failedMount?.result === result;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!renderer || !container) return undefined;
    let disposed = false;
    let disposeMount: (() => void) | undefined;
    const cleanup = () => {
      try {
        disposeMount?.();
      } catch (error) {
        console.error("Canvas Extension result cleanup failed", error);
      }
      disposeMount = undefined;
      container.replaceChildren();
    };
    Promise.resolve()
      .then(() =>
        disposed
          ? undefined
          : renderer.mount({ container, result, conversationId }),
      )
      .then((dispose) => {
        if (typeof dispose === "function") {
          disposeMount = dispose;
          if (disposed) cleanup();
        }
      })
      .catch(() => {
        if (!disposed) {
          cleanup();
          setFailedMount({ renderer, result });
        }
      });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [renderer, result, conversationId]);

  if (!renderer || failed) {
    return fallback !== undefined ? (
      fallback
    ) : (
      <DefaultResult
        key={`${backend.id}:${orgId}:${backend.connectionRevision ?? 0}`}
        result={result}
      />
    );
  }
  return <div ref={containerRef} className="min-w-0" />;
}
