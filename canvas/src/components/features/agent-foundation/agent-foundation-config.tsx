import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import FoundationService from "#/api/agent-foundation-service";
import { I18nKey } from "#/i18n/declaration";
import { BrandButton } from "#/components/features/settings/brand-button";
import {
  foundationErrorMessage,
  useFoundationScope,
} from "./use-foundation-scope";

const CONFIG_QUERY_KEY = "effective-config";

// @spec GAF-005 — The displayed configuration is the server's resolved package version.
export function AgentFoundationConfig({
  agentId,
  version,
}: {
  agentId: string;
  version: string;
}) {
  const { t } = useTranslation("openhands");
  const scope = useFoundationScope();
  const [expanded, setExpanded] = useState(false);
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- Backend is represented by its scoped identity/revision.
  const config = useQuery({
    queryKey: [...scope.queryKey, CONFIG_QUERY_KEY, agentId, version],
    queryFn: () =>
      FoundationService.getAgentConfig(agentId, version, scope.backend),
    enabled: scope.enabled && expanded,
    ...scope.queryOptions,
  });
  return (
    <details
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="rounded-lg border border-border p-3 text-sm"
    >
      <summary className="cursor-pointer font-medium">
        {t(I18nKey.AGENT_FOUNDATION$EFFECTIVE_CONFIG)}
      </summary>
      {expanded && config.isPending && (
        <p role="status">{t(I18nKey.AGENT_FOUNDATION$LOADING)}</p>
      )}
      {expanded && config.error && (
        <div role="alert">
          <p>
            {foundationErrorMessage(
              config.error,
              t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED),
            )}
          </p>
          <BrandButton
            type="button"
            variant="secondary"
            onClick={() => void config.refetch()}
          >
            {t(I18nKey.AGENT_FOUNDATION$RETRY)}
          </BrandButton>
        </div>
      )}
      {expanded && config.data && (
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words">
          {JSON.stringify(config.data, null, 2)}
        </pre>
      )}
    </details>
  );
}
