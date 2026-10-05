import React from "react";
import { useNavigate } from "react-router";
import CanvasExtensionsService from "#/api/canvas-extensions-service";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { loadCanvasExtensionModule } from "#/extensions/canvas-extension-module-loader";
import { createCanvasExtensionFoundationHost } from "#/extensions/canvas-extension-foundation-host";
import { useCanvasExtensions } from "#/hooks/query/use-canvas-extensions";
import {
  CANVAS_EXTENSION_HOST_API_VERSION,
  type CanvasExtensionDispose,
  type CanvasExtensionHost,
  type CanvasExtensionModule,
  type CanvasExtensionPageContribution,
  type CanvasExtensionPageMount,
  type CanvasExtensionResultRendererContribution,
  type CanvasExtensionResultMount,
  type InstalledCanvasExtensionInfo,
} from "#/types/canvas-extension";

export interface RegisteredCanvasExtensionPage {
  extension: InstalledCanvasExtensionInfo;
  contribution: CanvasExtensionPageContribution;
  mount: CanvasExtensionPageMount;
  href: string;
}

export interface RegisteredCanvasExtensionResultRenderer {
  extension: InstalledCanvasExtensionInfo;
  contribution: CanvasExtensionResultRendererContribution;
  mount: CanvasExtensionResultMount;
  activationSignature: string;
}

export function canvasExtensionResultScope(
  scope: Pick<
    CanvasExtensionResultRendererContribution,
    "package_id" | "tool_name" | "schema_version"
  >,
): string {
  return JSON.stringify([
    scope.package_id,
    scope.tool_name,
    scope.schema_version,
  ]);
}

interface CanvasExtensionsRuntimeValue {
  pages: RegisteredCanvasExtensionPage[];
  resultRenderers: RegisteredCanvasExtensionResultRenderer[];
  activating: boolean;
  errors: ReadonlyMap<string, string>;
}

const EMPTY_RUNTIME: CanvasExtensionsRuntimeValue = {
  pages: [],
  resultRenderers: [],
  activating: false,
  errors: new Map(),
};

const CanvasExtensionsRuntimeContext =
  React.createContext<CanvasExtensionsRuntimeValue>(EMPTY_RUNTIME);

export function useCanvasExtensionsRuntime(): CanvasExtensionsRuntimeValue {
  return React.useContext(CanvasExtensionsRuntimeContext);
}

function isValidSegment(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function buildCanvasExtensionPageHref(
  extensionName: string,
  contributionPath: string,
): string {
  return `/extensions/${encodeURIComponent(extensionName)}/${contributionPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function getDeclaredPage(
  extension: InstalledCanvasExtensionInfo,
  contributionId: string,
): CanvasExtensionPageContribution {
  const contribution = extension.manifest?.contributes?.pages?.find(
    (page) => page.id === contributionId,
  );
  if (!contribution) {
    throw new Error(
      `Extension ${extension.name} registered undeclared page "${contributionId}".`,
    );
  }
  // The backend declares page paths as absolute routes (e.g. "/dashboard");
  // normalize to the relative form used for hrefs and route matching.
  const normalizedPath = contribution.path.replace(/^\/+/, "");
  if (
    !isValidSegment(extension.name) ||
    !isValidSegment(contribution.id) ||
    !normalizedPath.split("/").every(isValidSegment)
  ) {
    throw new Error(
      `Extension ${extension.name} has an invalid page name, id, or path.`,
    );
  }
  return { ...contribution, path: normalizedPath };
}

type CanvasExtensionModuleLoader = (
  source: string,
) => Promise<CanvasExtensionModule>;

interface CanvasExtensionsRuntimeProviderProps {
  children: React.ReactNode;
  /** Test seam for environments that cannot import browser Blob URLs. */
  moduleLoader?: CanvasExtensionModuleLoader;
}

export function CanvasExtensionsRuntimeProvider({
  children,
  moduleLoader = loadCanvasExtensionModule,
}: CanvasExtensionsRuntimeProviderProps) {
  const active = useActiveBackend();
  const navigate = useNavigate();
  const query = useCanvasExtensions();
  const [pages, setPages] = React.useState<RegisteredCanvasExtensionPage[]>([]);
  const [resultRenderers, setResultRenderers] = React.useState<
    RegisteredCanvasExtensionResultRenderer[]
  >([]);
  const [errors, setErrors] = React.useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [activating, setActivating] = React.useState(false);

  const enabledExtensions = React.useMemo(
    () => (query.data ?? []).filter((extension) => extension.enabled),
    [query.data],
  );

  // `useActiveBackend` can synthesize a fresh `backend` object on every render
  // (e.g. when mounted without an <ActiveBackendProvider>), and refetches
  // produce new extension arrays with identical content. The activation effect
  // therefore keys on this value signature — backend identity plus the enabled
  // inventory, whose `installedAt` catches a same-version refresh — and reads
  // the current objects from refs, so referential churn never tears down and
  // re-activates extensions.
  const activationSignature = React.useMemo(
    () =>
      JSON.stringify({
        backendId: active.backend.id,
        backendKind: active.backend.kind,
        connectionRevision: active.backend.connectionRevision ?? 0,
        orgId: active.orgId,
        extensions: enabledExtensions.map((extension) => ({
          name: extension.name,
          version: extension.version,
          resolvedRef: extension.resolved_ref ?? null,
          installedAt: extension.installed_at,
          pages: extension.manifest?.contributes?.pages ?? [],
          resultRenderers:
            extension.manifest?.contributes?.result_renderers ?? [],
        })),
      }),
    [
      active.backend.id,
      active.backend.kind,
      active.backend.connectionRevision,
      active.orgId,
      enabledExtensions,
    ],
  );
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const enabledExtensionsRef = React.useRef(enabledExtensions);
  enabledExtensionsRef.current = enabledExtensions;

  React.useEffect(() => {
    let cancelled = false;
    const disposers: CanvasExtensionDispose[] = [];
    const { backend, orgId } = activeRef.current;
    const extensionsToActivate = enabledExtensionsRef.current;
    const scopeCounts = new Map<string, number>();
    for (const extension of extensionsToActivate) {
      for (const contribution of extension.manifest?.contributes
        ?.result_renderers ?? []) {
        const scope = canvasExtensionResultScope(contribution);
        scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
      }
    }
    setPages([]);
    setResultRenderers([]);
    setErrors(new Map());
    setActivating(extensionsToActivate.length > 0);

    const activateExtension = async (
      extension: InstalledCanvasExtensionInfo,
    ) => {
      const registeredPages = new Map<string, RegisteredCanvasExtensionPage>();
      const registeredRenderers = new Map<
        string,
        RegisteredCanvasExtensionResultRenderer
      >();
      const seenRendererIds = new Set<string>();
      const registrationDisposers: CanvasExtensionDispose[] = [];
      let activationFailed = false;
      let acceptingRegistrations = true;
      const assertActive = () => {
        if (cancelled || activationFailed)
          throw new Error("Extension activation is no longer active.");
      };
      try {
        const source = await CanvasExtensionsService.fetchBundle(
          extension.name,
          backend,
        );
        if (cancelled) return;
        const extensionModule = await moduleLoader(source);
        if (cancelled) return;

        const host: CanvasExtensionHost = {
          apiVersion: CANVAS_EXTENSION_HOST_API_VERSION,
          extension: Object.freeze({
            name: extension.name,
            version: extension.version,
            resolvedRef: extension.resolved_ref ?? null,
          }),
          backend: Object.freeze({
            id: backend.id,
            kind: backend.kind,
            orgId,
          }),
          registerPage: (contributionId, mount) => {
            assertActive();
            if (registeredPages.has(contributionId)) {
              throw new Error(
                `Extension ${extension.name} registered page "${contributionId}" more than once.`,
              );
            }
            const contribution = getDeclaredPage(extension, contributionId);
            const page: RegisteredCanvasExtensionPage = {
              extension,
              contribution,
              mount,
              href: buildCanvasExtensionPageHref(
                extension.name,
                contribution.path,
              ),
            };
            registeredPages.set(contributionId, page);
            const unregister = () => registeredPages.delete(contributionId);
            registrationDisposers.push(unregister);
            return unregister;
          },
          // @spec GAF-006 — Only declared, unique exact result scopes may mount.
          registerResultRenderer: (contributionId, mount) => {
            assertActive();
            if (!acceptingRegistrations)
              throw new Error(
                "Result renderers must register during activation.",
              );
            if (seenRendererIds.has(contributionId)) {
              throw new Error(
                `Extension ${extension.name} registered result renderer "${contributionId}" more than once.`,
              );
            }
            const contribution =
              extension.manifest?.contributes?.result_renderers?.find(
                (entry) => entry.id === contributionId,
              );
            if (!contribution)
              throw new Error(
                `Extension ${extension.name} registered undeclared result renderer "${contributionId}".`,
              );
            if (
              !isValidSegment(contribution.id) ||
              !contribution.package_id?.trim() ||
              !contribution.tool_name?.trim() ||
              !Number.isSafeInteger(contribution.schema_version) ||
              contribution.schema_version < 1
            ) {
              throw new Error(
                `Extension ${extension.name} has an invalid result renderer scope.`,
              );
            }
            const scope = canvasExtensionResultScope(contribution);
            if (scopeCounts.get(scope) !== 1)
              throw new Error(
                `Result renderer scope ${scope} is declared more than once.`,
              );
            seenRendererIds.add(contributionId);
            const renderer = {
              extension,
              contribution,
              mount,
              activationSignature,
            };
            registeredRenderers.set(contributionId, renderer);
            const unregister = () => {
              registeredRenderers.delete(contributionId);
              if (!cancelled)
                setResultRenderers((current) =>
                  current.filter((entry) => entry !== renderer),
                );
            };
            registrationDisposers.push(unregister);
            return unregister;
          },
          ...(backend.kind === "local"
            ? {
                foundation: createCanvasExtensionFoundationHost(
                  backend,
                  assertActive,
                ),
              }
            : {}),
          navigate: (path) => navigate(path),
          agentServer: {
            request: (request) =>
              CanvasExtensionsService.requestAgentServer(request, backend),
          },
        };

        const disposeActivation = await extensionModule.activate(host);
        acceptingRegistrations = false;
        if (cancelled) {
          if (typeof disposeActivation === "function") disposeActivation();
          return;
        }
        if (typeof disposeActivation === "function") {
          disposers.push(disposeActivation);
        }
        disposers.push(...registrationDisposers);
        setPages((current) => [
          ...current.filter((page) => page.extension.name !== extension.name),
          ...registeredPages.values(),
        ]);
        setResultRenderers((current) => [
          ...current.filter(
            (renderer) => renderer.extension.name !== extension.name,
          ),
          ...registeredRenderers.values(),
        ]);
      } catch (error) {
        activationFailed = true;
        acceptingRegistrations = false;
        registrationDisposers.forEach((dispose) => dispose());
        if (cancelled) return;
        const message =
          error instanceof Error
            ? error.message
            : "Extension activation failed.";
        setErrors((current) => {
          const next = new Map(current);
          next.set(extension.name, message);
          return next;
        });
      }
    };

    void Promise.all(extensionsToActivate.map(activateExtension)).finally(
      () => {
        if (!cancelled) setActivating(false);
      },
    );

    return () => {
      cancelled = true;
      setPages([]);
      setResultRenderers([]);
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          console.error("Canvas Extension cleanup failed", error);
        }
      }
    };
  }, [activationSignature, moduleLoader, navigate]);

  const value = React.useMemo(
    () => ({
      pages,
      resultRenderers: resultRenderers.filter(
        (renderer) => renderer.activationSignature === activationSignature,
      ),
      activating,
      errors,
    }),
    [pages, resultRenderers, activationSignature, activating, errors],
  );

  return (
    <CanvasExtensionsRuntimeContext.Provider value={value}>
      {children}
    </CanvasExtensionsRuntimeContext.Provider>
  );
}
