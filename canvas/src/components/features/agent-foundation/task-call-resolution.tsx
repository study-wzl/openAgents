import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import FoundationService, {
  type ResolveToolCall,
  type TaskRecord,
  type ToolCallRecord,
} from "#/api/agent-foundation-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { I18nKey } from "#/i18n/declaration";
import {
  foundationErrorMessage,
  useFoundationScope,
} from "./use-foundation-scope";

const CALLS_QUERY_KEY = "tool-calls";
const RECOVERABLE_STATUSES = new Set<TaskRecord["status"]>([
  "interrupted",
  "cancelled",
  "failed",
]);

function UnknownCallForm({
  call,
  onRecorded,
}: {
  call: ToolCallRecord;
  onRecorded: () => void;
}) {
  const { t } = useTranslation("openhands");
  const scope = useFoundationScope();
  const [evidence, setEvidence] = useState("");
  const [outcome, setOutcome] = useState<ResolveToolCall["outcome"] | "">("");
  const resolve = useMutation({
    mutationFn: (input: ResolveToolCall) =>
      FoundationService.resolveToolCall(
        call.task_id,
        call.id,
        input,
        scope.backend,
      ),
    onSuccess: () => {
      onRecorded();
      void scope.invalidate();
    },
  });
  return (
    <form
      className="mt-3 flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (outcome && evidence.trim() && !resolve.isPending)
          resolve.mutate({ outcome, evidence: evidence.trim() });
      }}
    >
      <code className="break-all text-xs">{call.id}</code>
      <p className="font-medium">{call.tool_name}</p>
      <code className="text-xs">{call.package_version}</code>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
        {JSON.stringify(call.arguments, null, 2)}
      </pre>
      <label className="flex flex-col gap-2">
        {t(I18nKey.AGENT_FOUNDATION$CALL_EVIDENCE)}
        <textarea
          required
          value={evidence}
          disabled={resolve.isPending}
          onChange={(event) => setEvidence(event.target.value)}
          className="rounded border border-border bg-base-secondary p-2"
        />
      </label>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={call.id}
            checked={outcome === "executed"}
            disabled={resolve.isPending}
            onChange={() => setOutcome("executed")}
          />
          {t(I18nKey.AGENT_FOUNDATION$CALL_EXECUTED)}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={call.id}
            checked={outcome === "not_executed"}
            disabled={resolve.isPending}
            onChange={() => setOutcome("not_executed")}
          />
          {t(I18nKey.AGENT_FOUNDATION$CALL_NOT_EXECUTED)}
        </label>
      </div>
      {resolve.error && (
        <p role="alert">
          {foundationErrorMessage(
            resolve.error,
            t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED),
          )}
        </p>
      )}
      <BrandButton
        type="submit"
        variant="secondary"
        isDisabled={!outcome || !evidence.trim() || resolve.isPending}
      >
        {t(I18nKey.AGENT_FOUNDATION$CALL_RECORD_DECISION)}
      </BrandButton>
    </form>
  );
}

function RecoverableTaskControls({ task }: { task: TaskRecord }) {
  const { t } = useTranslation("openhands");
  const scope = useFoundationScope();
  const [recorded, setRecorded] = useState(false);
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- Backend is represented by its scoped identity/revision.
  const calls = useQuery({
    queryKey: [...scope.queryKey, CALLS_QUERY_KEY, task.id],
    queryFn: () => FoundationService.listToolCalls(task.id, scope.backend),
    enabled: scope.enabled,
    ...scope.queryOptions,
  });
  const resume = useMutation({
    mutationFn: () => FoundationService.resumeTask(task.id, scope.backend),
    onSuccess: () => void scope.invalidate(),
  });
  const unknownCalls =
    calls.data?.filter((call) => call.status === "unknown") ?? [];
  const error = calls.error ?? resume.error;
  return (
    <div className="mt-3 text-sm">
      {unknownCalls.length > 0 && (
        <section aria-label={t(I18nKey.AGENT_FOUNDATION$CALL_RESOLUTION)}>
          <h3 className="font-medium">
            {t(I18nKey.AGENT_FOUNDATION$CALL_RESOLUTION)}
          </h3>
          <p className="mt-2 text-muted">
            {t(I18nKey.AGENT_FOUNDATION$CALL_RESOLUTION_HELP)}
          </p>
          {unknownCalls.map((call) => (
            <UnknownCallForm
              key={call.id}
              call={call}
              onRecorded={() => setRecorded(true)}
            />
          ))}
        </section>
      )}
      {recorded && (
        <p role="status" className="mt-2">
          {t(I18nKey.AGENT_FOUNDATION$CALL_RECORDED)}
        </p>
      )}
      {error && (
        <div role="alert">
          <p>
            {foundationErrorMessage(
              error,
              t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED),
            )}
          </p>
          {calls.error && (
            <BrandButton
              type="button"
              variant="secondary"
              onClick={() => void calls.refetch()}
            >
              {t(I18nKey.AGENT_FOUNDATION$RETRY)}
            </BrandButton>
          )}
        </div>
      )}
      <BrandButton
        type="button"
        variant="secondary"
        className="mt-2"
        isDisabled={
          calls.isPending ||
          calls.isFetching ||
          calls.isError ||
          unknownCalls.length > 0 ||
          resume.isPending
        }
        onClick={() => resume.mutate()}
      >
        {t(I18nKey.AGENT_FOUNDATION$RESUME_TASK)}
      </BrandButton>
    </div>
  );
}

// @spec GAF-003 — Uncertain calls need evidence and an explicit decision before a separate resume.
export function TaskCallResolution({ task }: { task: TaskRecord }) {
  const scope = useFoundationScope();
  if (!RECOVERABLE_STATUSES.has(task.status)) return null;
  return (
    <RecoverableTaskControls
      key={`${scope.scopeId}:${task.id}:${task.status}`}
      task={task}
    />
  );
}
