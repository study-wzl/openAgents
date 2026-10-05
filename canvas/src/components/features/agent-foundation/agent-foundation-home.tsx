import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import FoundationService, {
  type CreateFoundationTask,
} from "#/api/agent-foundation-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { useNavigation } from "#/context/navigation-context";
import { I18nKey } from "#/i18n/declaration";
import { AgentFoundationPackages } from "./agent-foundation-packages";
import { AgentFoundationConfig } from "./agent-foundation-config";
import {
  foundationErrorMessage,
  isFoundationUnsupportedError,
  useFoundationScope,
} from "./use-foundation-scope";

const AGENTS_QUERY_KEY = "agents";

export function AgentFoundationHome() {
  const { scopeId } = useFoundationScope();
  return <FoundationHomeForBackend key={scopeId} />;
}

// @spec GAF-005 — Business tasks launch with an explicit agent and stable request identity.
function FoundationHomeForBackend() {
  const { t } = useTranslation("openhands");
  const { navigate } = useNavigation();
  const scope = useFoundationScope();
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [task, setTask] = useState("");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const requestRef = useRef<{
    agent_id: string;
    task: string;
    idempotency_key: string;
  } | null>(null);
  // Backend identity/revision are in scope.queryKey; credentials must stay out of cache keys.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const agents = useQuery({
    queryKey: [...scope.queryKey, AGENTS_QUERY_KEY],
    queryFn: () => FoundationService.listAgents(scope.backend),
    enabled: scope.enabled,
    ...scope.queryOptions,
  });
  const availableAgents = (agents.data ?? []).filter((agent) => agent.enabled);
  const selectedAgent = selectedAgentId
    ? availableAgents.find((agent) => agent.id === selectedAgentId)
    : availableAgents[0];
  const start = useMutation({
    mutationFn: (input: CreateFoundationTask) =>
      FoundationService.createTask(input, scope.backend),
    onSuccess: (created) => {
      if (!scope.isCurrent()) return;
      if (!created.conversation_id) {
        setLaunchError(t(I18nKey.AGENT_FOUNDATION$NO_CONVERSATION));
        return;
      }
      requestRef.current = null;
      navigate(`/conversations/${encodeURIComponent(created.conversation_id)}`);
    },
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedAgent || !task.trim() || start.isPending || agents.isError)
      return;
    setLaunchError(null);
    const previous = requestRef.current;
    if (
      previous?.agent_id !== selectedAgent.id ||
      previous.task !== task.trim()
    ) {
      requestRef.current = {
        agent_id: selectedAgent.id,
        task: task.trim(),
        idempotency_key: crypto.randomUUID(),
      };
    }
    start.mutate(requestRef.current!);
  };

  return (
    <main
      className="h-full overflow-y-auto px-5 py-8 md:px-10"
      data-testid="agent-foundation-home"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        <header>
          <h1 className="text-3xl font-semibold text-foreground">
            {t(I18nKey.AGENT_FOUNDATION$TITLE)}
          </h1>
          <p className="mt-3 text-muted">
            {t(I18nKey.AGENT_FOUNDATION$WELCOME)}
          </p>
        </header>
        {!scope.enabled ? (
          <p role="status">{t(I18nKey.AGENT_FOUNDATION$NO_BACKEND)}</p>
        ) : (
          <>
            {agents.isPending && (
              <p role="status">{t(I18nKey.AGENT_FOUNDATION$LOADING)}</p>
            )}
            {agents.isError && (
              <div role="alert" className="flex flex-col items-start gap-3">
                <p>
                  {isFoundationUnsupportedError(agents.error)
                    ? t(I18nKey.AGENT_FOUNDATION$UNSUPPORTED)
                    : foundationErrorMessage(
                        agents.error,
                        t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED),
                      )}
                </p>
                <BrandButton
                  type="button"
                  variant="secondary"
                  onClick={() => void agents.refetch()}
                >
                  {t(I18nKey.AGENT_FOUNDATION$RETRY)}
                </BrandButton>
              </div>
            )}
            {!agents.isPending &&
              !agents.isError &&
              availableAgents.length === 0 && (
                <p role="status">{t(I18nKey.AGENT_FOUNDATION$NO_AGENTS)}</p>
              )}
            {availableAgents.length > 0 && (
              <form onSubmit={submit} className="flex flex-col gap-5">
                <div
                  role="group"
                  aria-label={t(I18nKey.AGENT_FOUNDATION$CHOOSE_AGENT)}
                  className="grid gap-3 sm:grid-cols-2"
                >
                  {availableAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      aria-pressed={selectedAgent?.id === agent.id}
                      disabled={start.isPending}
                      onClick={() => setSelectedAgentId(agent.id)}
                      className={`rounded-xl border p-5 text-left transition-colors ${selectedAgent?.id === agent.id ? "border-primary bg-primary/10" : "border-border bg-base-secondary hover:bg-surface-raised"}`}
                    >
                      <span className="block font-medium">{agent.name}</span>
                      {agent.description && (
                        <span className="mt-2 block text-sm text-muted">
                          {agent.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {selectedAgent && (
                  <AgentFoundationConfig
                    key={`${selectedAgent.id}:${selectedAgent.package_version}`}
                    agentId={selectedAgent.id}
                    version={selectedAgent.package_version}
                  />
                )}
                <label className="flex flex-col gap-2 font-medium">
                  {t(I18nKey.AGENT_FOUNDATION$TASK_LABEL)}
                  <textarea
                    value={task}
                    onChange={(event) => {
                      setTask(event.target.value);
                      if (!selectedAgentId && selectedAgent)
                        setSelectedAgentId(selectedAgent.id);
                    }}
                    disabled={start.isPending}
                    rows={5}
                    required
                    placeholder={t(I18nKey.AGENT_FOUNDATION$TASK_PLACEHOLDER)}
                    className="w-full resize-y rounded-xl border border-border bg-base-secondary p-4 font-normal outline-none focus:border-primary"
                  />
                </label>
                {(start.error || launchError) && (
                  <p role="alert" className="text-red-500">
                    {launchError ??
                      foundationErrorMessage(
                        start.error,
                        t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED),
                      )}
                  </p>
                )}
                <BrandButton
                  type="submit"
                  variant="primary"
                  isDisabled={
                    !selectedAgent ||
                    !task.trim() ||
                    start.isPending ||
                    agents.isError
                  }
                  aria-busy={start.isPending}
                  className="self-end"
                >
                  {t(
                    start.isPending
                      ? I18nKey.AGENT_FOUNDATION$STARTING
                      : I18nKey.AGENT_FOUNDATION$START_TASK,
                  )}
                </BrandButton>
              </form>
            )}
            <AgentFoundationPackages />
          </>
        )}
      </div>
    </main>
  );
}
