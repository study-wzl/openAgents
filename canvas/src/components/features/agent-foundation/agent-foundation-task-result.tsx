import { useMemo } from "react";
import { CanvasExtensionResultView } from "#/components/features/canvas-extensions/canvas-extension-result-view";
import type { CanvasExtensionResult } from "#/types/canvas-extension";

function parseTaskResult(value: string): CanvasExtensionResult | null {
  try {
    const result: unknown = JSON.parse(value);
    if (!result || typeof result !== "object") return null;
    const candidate = result as Partial<CanvasExtensionResult>;
    if (
      typeof candidate.package_id !== "string" ||
      !candidate.package_id ||
      typeof candidate.tool_name !== "string" ||
      !candidate.tool_name ||
      !Number.isSafeInteger(candidate.schema_version) ||
      candidate.schema_version! < 1 ||
      !("data" in candidate) ||
      (candidate.text != null && typeof candidate.text !== "string") ||
      (candidate.artifacts !== undefined &&
        (!Array.isArray(candidate.artifacts) ||
          candidate.artifacts.some(
            (artifact) =>
              !artifact ||
              typeof artifact !== "object" ||
              typeof artifact.id !== "string" ||
              typeof artifact.name !== "string",
          )))
    )
      return null;
    return candidate as CanvasExtensionResult;
  } catch {
    return null;
  }
}

// @spec GAF-006 — Existing plain-text task results remain readable.
export function AgentFoundationTaskResult({
  result,
  conversationId,
}: {
  result: string;
  conversationId: string;
}) {
  const structured = useMemo(() => parseTaskResult(result), [result]);
  if (structured)
    return (
      <CanvasExtensionResultView
        result={structured}
        conversationId={conversationId}
      />
    );
  return <p className="mt-2 whitespace-pre-wrap text-sm">{result}</p>;
}
