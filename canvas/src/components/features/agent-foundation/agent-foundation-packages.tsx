import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import FoundationService from "#/api/agent-foundation-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { SettingsInput } from "#/components/features/settings/settings-input";
import { I18nKey } from "#/i18n/declaration";
import {
  foundationErrorMessage,
  isFoundationUnsupportedError,
  useFoundationScope,
} from "./use-foundation-scope";

const PACKAGES_QUERY_KEY = "packages";
type InstalledPackage = Awaited<
  ReturnType<typeof FoundationService.listPackages>
>[number];

export function AgentFoundationPackages() {
  const { t } = useTranslation("openhands");
  const scope = useFoundationScope();
  const [source, setSource] = useState("");
  const [uninstallTarget, setUninstallTarget] =
    useState<InstalledPackage | null>(null);
  // Backend identity/revision are in scope.queryKey; credentials must stay out of cache keys.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const packages = useQuery({
    queryKey: [...scope.queryKey, PACKAGES_QUERY_KEY],
    queryFn: () => FoundationService.listPackages(scope.backend),
    enabled: scope.enabled,
    ...scope.queryOptions,
  });
  const validate = useMutation({
    mutationFn: (packageSource: string) =>
      FoundationService.validatePackage(packageSource, scope.backend),
  });
  const install = useMutation({
    mutationFn: (packageSource: string) =>
      FoundationService.installPackage(packageSource, scope.backend),
    onSuccess: () => {
      setSource("");
      validate.reset();
      void scope.invalidate();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      FoundationService.setPackageEnabled(id, enabled, scope.backend),
    onSuccess: () => void scope.invalidate(),
  });
  const uninstall = useMutation({
    mutationFn: (id: string) =>
      FoundationService.uninstallPackage(id, scope.backend),
    onSuccess: () => {
      setUninstallTarget(null);
      void scope.invalidate();
    },
  });
  const trimmedSource = source.trim();
  const validatedCurrentSource =
    validate.variables === trimmedSource && validate.data?.valid === true;
  const busy =
    packages.isPending ||
    packages.isError ||
    install.isPending ||
    toggle.isPending ||
    uninstall.isPending;
  const error =
    packages.error ??
    validate.error ??
    install.error ??
    toggle.error ??
    uninstall.error;

  // @spec GAF-005 — Validation cannot authorize installation of a different source.
  return (
    <section
      className="flex flex-col gap-4 border-t border-border pt-6"
      aria-label={t(I18nKey.AGENT_FOUNDATION$PACKAGES)}
    >
      <header>
        <h2 className="text-lg font-semibold">
          {t(I18nKey.AGENT_FOUNDATION$PACKAGES)}
        </h2>
        <p className="mt-2 text-sm text-muted">
          {t(I18nKey.AGENT_FOUNDATION$PACKAGES_DESCRIPTION)}
        </p>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedSource && !validate.isPending && !busy)
            validate.mutate(trimmedSource);
        }}
        className="flex flex-col gap-3 rounded-xl border border-border bg-base-secondary p-4"
      >
        <SettingsInput
          type="text"
          label={t(I18nKey.AGENT_FOUNDATION$SOURCE_LABEL)}
          value={source}
          onChange={(value) => {
            setSource(value);
            validate.reset();
          }}
          isDisabled={busy || validate.isPending}
        />
        {validate.data && validate.variables === trimmedSource && (
          <div role={validate.data.valid ? "status" : "alert"}>
            {validate.data.valid ? (
              t(I18nKey.AGENT_FOUNDATION$VALID)
            ) : (
              <ul className="list-inside list-disc text-red-500">
                {validate.data.errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <BrandButton
            type="submit"
            variant="secondary"
            isDisabled={!trimmedSource || busy || validate.isPending}
            aria-busy={validate.isPending}
          >
            {t(I18nKey.AGENT_FOUNDATION$VALIDATE)}
          </BrandButton>
          <BrandButton
            type="button"
            variant="primary"
            isDisabled={!validatedCurrentSource || busy || validate.isPending}
            aria-busy={install.isPending}
            onClick={() => install.mutate(trimmedSource)}
          >
            {t(I18nKey.AGENT_FOUNDATION$INSTALL)}
          </BrandButton>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-red-500">
          {isFoundationUnsupportedError(error)
            ? t(I18nKey.AGENT_FOUNDATION$UNSUPPORTED)
            : foundationErrorMessage(
                error,
                t(I18nKey.AGENT_FOUNDATION$REQUEST_FAILED),
              )}
        </p>
      )}
      {packages.isPending && (
        <p role="status">{t(I18nKey.AGENT_FOUNDATION$LOADING)}</p>
      )}
      {packages.isError && (
        <BrandButton
          type="button"
          variant="secondary"
          onClick={() => void packages.refetch()}
        >
          {t(I18nKey.AGENT_FOUNDATION$RETRY)}
        </BrandButton>
      )}
      {packages.data?.length === 0 && (
        <p className="text-sm text-muted">
          {t(I18nKey.AGENT_FOUNDATION$NO_PACKAGES)}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {packages.data?.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4"
          >
            <div>
              <h3 className="font-medium">
                {item.name}{" "}
                <span className="font-normal text-muted">{item.version}</span>
              </h3>
              <p className="mt-1 text-sm text-muted">{item.description}</p>
              {item.ui_extension_ref && (
                <p className="mt-1 text-xs text-muted">
                  {t(I18nKey.AGENT_FOUNDATION$UI_EXTENSION_REFERENCE)}:{" "}
                  <code>{item.ui_extension_ref}</code>
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                {t(
                  item.enabled
                    ? I18nKey.AGENT_FOUNDATION$ENABLED
                    : I18nKey.AGENT_FOUNDATION$DISABLED,
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <BrandButton
                type="button"
                variant="secondary"
                isDisabled={busy}
                onClick={() =>
                  toggle.mutate({ id: item.id, enabled: !item.enabled })
                }
              >
                {t(
                  item.enabled
                    ? I18nKey.AGENT_FOUNDATION$DISABLE
                    : I18nKey.AGENT_FOUNDATION$ENABLE,
                )}
              </BrandButton>
              <BrandButton
                type="button"
                variant="ghost-danger"
                isDisabled={busy}
                onClick={() => setUninstallTarget(item)}
              >
                {t(I18nKey.AGENT_FOUNDATION$UNINSTALL)}
              </BrandButton>
            </div>
          </li>
        ))}
      </ul>
      {uninstallTarget && (
        <div
          role="alertdialog"
          aria-modal="false"
          aria-label={t(I18nKey.AGENT_FOUNDATION$UNINSTALL)}
          className="rounded-xl border border-border bg-base-secondary p-4"
        >
          <p>
            {t(I18nKey.AGENT_FOUNDATION$UNINSTALL_CONFIRM, {
              name: uninstallTarget.name,
            })}
          </p>
          <div className="mt-3 flex gap-2">
            <BrandButton
              type="button"
              variant="secondary"
              isDisabled={uninstall.isPending}
              onClick={() => setUninstallTarget(null)}
            >
              {t(I18nKey.AGENT_FOUNDATION$KEEP_PACKAGE)}
            </BrandButton>
            <BrandButton
              type="button"
              variant="danger"
              isDisabled={uninstall.isPending}
              onClick={() => uninstall.mutate(uninstallTarget.id)}
            >
              {t(I18nKey.AGENT_FOUNDATION$UNINSTALL)}
            </BrandButton>
          </div>
        </div>
      )}
    </section>
  );
}
