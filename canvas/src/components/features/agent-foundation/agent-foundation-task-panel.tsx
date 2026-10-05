import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import FoundationService from "#/api/agent-foundation-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { I18nKey } from "#/i18n/declaration";
import { downloadBlob } from "#/utils/utils";
import { AgentFoundationTaskResult } from "./agent-foundation-task-result";
import { TaskCallResolution } from "./task-call-resolution";
import {
  FOUNDATION_POLL_INTERVAL,
  foundationErrorMessage,
  useFoundationScope,
} from "./use-foundation-scope";

const TASKS_QUERY_KEY = "tasks";
const APPROVALS_QUERY_KEY = "approvals";
const ARTIFACTS_QUERY_KEY = "artifacts";
type Task = Awaited<ReturnType<typeof FoundationService.listTasks>>[number];
type Artifact = Awaited<
  ReturnType<typeof FoundationService.listArtifacts>
>[number];
const ACTIVE_STATUSES = new Set<Task["status"]>([
  "queued",
  "running",
  "waiting_for_confirmation",
  "cancelling",
]);
const STATUS_LABELS: Record<Task["status"], I18nKey> = {
  queued: I18nKey.AGENT_FOUNDATION$QUEUED,
  running: I18nKey.AGENT_FOUNDATION$RUNNING,
  waiting_for_confirmation: I18nKey.AGENT_FOUNDATION$WAITING_FOR_CONFIRMATION,
  cancelling: I18nKey.AGENT_FOUNDATION$CANCELLING,
  completed: I18nKey.AGENT_FOUNDATION$COMPLETED,
  failed: I18nKey.AGENT_FOUNDATION$FAILED,
  cancelled: I18nKey.AGENT_FOUNDATION$CANCELLED,
  interrupted: I18nKey.AGENT_FOUNDATION$INTERRUPTED,
};

export function AgentFoundationTaskPanel({
  conversationId,
}: {
  conversationId: string;
}) {
  const { scopeId } = useFoundationScope();
  return (
    <FoundationTaskPanelForConversation
      key={`${scopeId}:${conversationId}`}
      conversationId={conversationId}
    />
  );
}

// @spec GAF-003 — Task controls and approvals operate on durable server records.
function FoundationTaskPanelForConversation({
  conversationId,
}: {
  conversationId: string;
}) {
  const { t } = useTranslation("openhands");
  const scope = useFoundationScope();
  const uploadInput = useRef<HTMLInputElement>(null);
  // Backend identity/revision are in scope.queryKey; credentials must stay out of cache keys.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const tasks = useQuery({
    queryKey: [...scope.queryKey, TASKS_QUERY_KEY, conversationId],
    queryFn: () => FoundationService.listTasks(conversationId, scope.backend),
    enabled: scope.enabled && !!conversationId,
    refetchInterval: (query) =>
      query.state.data?.some((task) => ACTIVE_STATUSES.has(task.status))
        ? FOUNDATION_POLL_INTERVAL
        : false,
    ...scope.queryOptions,
  });
  const hasTasks = (tasks.data?.length ?? 0) > 0;
  const hasActiveTasks =
    tasks.data?.some((task) => ACTIVE_STATUSES.has(task.status)) ?? false;
  const refreshInterval = hasActiveTasks ? FOUNDATION_POLL_INTERVAL : false;
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- Backend is represented by its scoped identity/revision.
  const approvals = useQuery({
    queryKey: [...scope.queryKey, APPROVALS_QUERY_KEY, conversationId],
    queryFn: () =>
      FoundationService.listApprovals(conversationId, scope.backend),
    enabled: scope.enabled && hasTasks,
    refetchInterval: refreshInterval,
    ...scope.queryOptions,
  });
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- Backend is represented by its scoped identity/revision.
  const artifacts = useQuery({
    queryKey: [...scope.queryKey, ARTIFACTS_QUERY_KEY, conversationId],
    queryFn: () =>
      FoundationService.listArtifacts(conversationId, scope.backend),
    enabled: scope.enabled && hasTasks,
    refetchInterval: refreshInterval,
    ...scope.queryOptions,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => FoundationService.cancelTask(id, scope.backend),
    onSuccess: () => void scope.invalidate(),
  });
  const decide = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) =>
      FoundationService.decideApproval(id, approved, scope.backend),
    onSuccess: () => void scope.invalidate(),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files)
        await FoundationService.uploadArtifact(
          conversationId,
          file,
          scope.backend,
        );
    },
    onSettled: () => void scope.invalidate(),
  });
  const download = useMutation({
    mutationFn: async (artifact: Artifact) => {
      const blob = await FoundationService.downloadArtifact(
        artifact.id,
        scope.backend,
      );
      if (scope.isCurrent()) downloadBlob(blob, artifact.name);
    },
  });
  const taskState = tasks.data
    ?.map((task) => `${task.id}:${task.status}`)
    .join(",");
  const refetchArtifacts = artifacts.refetch;
  const refetchApprovals = approvals.refetch;
  useEffect(() => {
    if (!hasTasks) return;
    void refetchArtifacts();
    void refetchApprovals();
  }, [taskState, hasTasks, refetchArtifacts, refetchApprovals]);

  if (!scope.enabled || (!hasTasks && !tasks.error)) return null;
  const error =
    tasks.error ??
    approvals.error ??
    artifacts.error ??
    cancel.error ??
    decide.error ??
    upload.error ??
    download.error;
  const pendingApprovals =
    approvals.data?.filter((approval) => approval.status === "pending") ?? [];
  const busy = cancel.isPending;

  return (
    <aside
      className="flex flex-col gap-4 rounded-xl border border-border bg-base-secondary p-4"
      aria-label={t(I18nKey.AGENT_FOUNDATION$TASK_PROGRESS)}
      data-testid="agent-foundation-task-panel"
    >
      <h2 className="font-semibold">
        {t(I18nKey.AGENT_FOUNDATION$TASK_PROGRESS)}
      </h2>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {foundationErrorMessage(
            error,
            t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED),
          )}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {tasks.data?.map((task) => (
          <li
            key={task.id}
            className={`rounded-lg border border-border p-3 ${task.parent_task_id ? "ml-4" : ""}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{task.agent_id}</span>
              <span role="status" className="text-xs text-muted">
                {t(STATUS_LABELS[task.status])}
              </span>
            </div>
            {task.parent_task_id && (
              <p className="mt-1 text-xs text-muted">
                {t(I18nKey.AGENT_FOUNDATION$SUBTASK)}
              </p>
            )}
            <p className="mt-2 whitespace-pre-wrap text-sm">{task.task}</p>
            {task.error && (
              <p className="mt-2 text-sm text-red-500">{task.error}</p>
            )}
            {task.result && (
              <AgentFoundationTaskResult
                result={task.result}
                conversationId={conversationId}
              />
            )}
            <div className="mt-2 flex gap-2">
              {ACTIVE_STATUSES.has(task.status) &&
                task.status !== "cancelling" && (
                  <BrandButton
                    type="button"
                    variant="secondary"
                    isDisabled={busy}
                    onClick={() => cancel.mutate(task.id)}
                  >
                    {t(I18nKey.AGENT_FOUNDATION$STOP_TASK)}
                  </BrandButton>
                )}
            </div>
            <TaskCallResolution task={task} />
          </li>
        ))}
      </ul>
      {pendingApprovals.length > 0 && (
        <section
          aria-label={t(I18nKey.AGENT_FOUNDATION$APPROVALS)}
          className="flex flex-col gap-3"
        >
          <h3 className="font-medium">
            {t(I18nKey.AGENT_FOUNDATION$APPROVALS)}
          </h3>
          {pendingApprovals.map((approval) => (
            <div
              key={approval.id}
              className="rounded-lg border border-border p-3"
            >
              <p className="font-medium">{approval.tool_name}</p>
              <pre className="my-3 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(approval.arguments, null, 2)}
              </pre>
              <div className="flex gap-2">
                <BrandButton
                  type="button"
                  variant="primary"
                  isDisabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({ id: approval.id, approved: true })
                  }
                >
                  {t(I18nKey.AGENT_FOUNDATION$APPROVE)}
                </BrandButton>
                <BrandButton
                  type="button"
                  variant="secondary"
                  isDisabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({ id: approval.id, approved: false })
                  }
                >
                  {t(I18nKey.AGENT_FOUNDATION$REJECT)}
                </BrandButton>
              </div>
            </div>
          ))}
        </section>
      )}
      {hasTasks && (
        <section
          aria-label={t(I18nKey.AGENT_FOUNDATION$ARTIFACTS)}
          className="flex flex-col gap-3 border-t border-border pt-3"
        >
          <h3 className="font-medium">
            {t(I18nKey.AGENT_FOUNDATION$ARTIFACTS)}
          </h3>
          {artifacts.data?.length === 0 && (
            <p className="text-sm text-muted">
              {t(I18nKey.AGENT_FOUNDATION$NO_ARTIFACTS)}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {artifacts.data?.map((artifact) => (
              <li key={artifact.id}>
                <BrandButton
                  type="button"
                  variant="secondary"
                  isDisabled={download.isPending}
                  onClick={() => download.mutate(artifact)}
                  ariaLabel={t(I18nKey.AGENT_FOUNDATION$DOWNLOAD, {
                    name: artifact.name,
                  })}
                >
                  {artifact.name}
                </BrandButton>
              </li>
            ))}
          </ul>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            aria-label={t(I18nKey.AGENT_FOUNDATION$UPLOAD)}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (uploadInput.current) uploadInput.current.value = "";
              if (files.length) upload.mutate(files);
            }}
          />
          <BrandButton
            type="button"
            variant="secondary"
            isDisabled={upload.isPending}
            aria-busy={upload.isPending}
            className="self-start"
            onClick={() => uploadInput.current?.click()}
          >
            {t(I18nKey.AGENT_FOUNDATION$UPLOAD)}
          </BrandButton>
        </section>
      )}
    </aside>
  );
}
