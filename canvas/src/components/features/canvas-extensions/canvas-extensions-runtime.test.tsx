import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CanvasExtensionsService from "#/api/canvas-extensions-service";
import FoundationService, {
  type TaskRecord,
} from "#/api/agent-foundation-service";
import { ConversationClient } from "@openhands/typescript-client/clients";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import type {
  CanvasExtensionHost,
  InstalledCanvasExtensionInfo,
} from "#/types/canvas-extension";
import {
  CanvasExtensionsRuntimeProvider,
  useCanvasExtensionsRuntime,
} from "./canvas-extensions-runtime";

const backend: Backend = {
  id: "extension-backend",
  name: "Extension backend",
  host: "http://127.0.0.1:8000",
  apiKey: "test-key",
  kind: "local",
};

const extension: InstalledCanvasExtensionInfo = {
  name: "demo-extension",
  version: "0.1.0",
  enabled: true,
  source: "github:example/demo",
  resolved_ref: "abc123",
  installed_at: "2026-08-01T00:00:00Z",
  install_path: "/tmp/demo-extension",
  manifest: {
    schema_version: 1,
    name: "demo-extension",
    display_name: "Demo extension",
    version: "0.1.0",
    entrypoint: "dist/extension.js",
    contributes: {
      pages: [
        {
          id: "dashboard",
          title: "Dashboard",
          path: "/dashboard",
          nav_label: "Demo dashboard",
        },
      ],
    },
  },
};

function RuntimeProbe() {
  const runtime = useCanvasExtensionsRuntime();
  return (
    <div>
      <span data-testid="page-count">{runtime.pages.length}</span>
      <span data-testid="renderer-count">{runtime.resultRenderers.length}</span>
      <span data-testid="page-href">{runtime.pages[0]?.href}</span>
      <span data-testid="runtime-error">
        {runtime.errors.get(extension.name)}
      </span>
    </div>
  );
}

function renderRuntime(
  moduleLoader: (source: string) => Promise<{
    activate: (host: CanvasExtensionHost) => void | (() => void);
  }>,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <ActiveBackendProvider>
        <MemoryRouter>
          <CanvasExtensionsRuntimeProvider moduleLoader={moduleLoader}>
            <RuntimeProbe />
          </CanvasExtensionsRuntimeProvider>
        </MemoryRouter>
      </ActiveBackendProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

describe("CanvasExtensionsRuntimeProvider", () => {
  beforeEach(() => {
    setRegisteredBackends([backend]);
    setActiveSelection({ backendId: backend.id });
    vi.spyOn(CanvasExtensionsService, "listInstalled").mockResolvedValue([
      extension,
    ]);
    vi.spyOn(CanvasExtensionsService, "fetchBundle").mockResolvedValue(
      "fixture source",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setActiveSelection(null);
    setRegisteredBackends([]);
  });

  it("activates enabled extensions and admits declared page registrations", async () => {
    const disposeActivation = vi.fn();
    const moduleLoader = vi.fn().mockResolvedValue({
      activate: (host: CanvasExtensionHost) => {
        host.registerPage("dashboard", () => undefined);
        return disposeActivation;
      },
    });

    const rendered = renderRuntime(moduleLoader);

    await waitFor(() =>
      expect(screen.getByTestId("page-count")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("page-href")).toHaveTextContent(
      "/extensions/demo-extension/dashboard",
    );
    expect(CanvasExtensionsService.fetchBundle).toHaveBeenCalledWith(
      extension.name,
      expect.objectContaining({ id: backend.id }),
    );

    rendered.unmount();
    expect(disposeActivation).toHaveBeenCalledTimes(1);
  });

  it("re-activates an extension refreshed without a version change", async () => {
    const disposeActivation = vi.fn();
    const moduleLoader = vi.fn().mockResolvedValue({
      activate: () => disposeActivation,
    });

    const { queryClient } = renderRuntime(moduleLoader);
    await waitFor(() => expect(moduleLoader).toHaveBeenCalledTimes(1));

    vi.mocked(CanvasExtensionsService.listInstalled).mockResolvedValue([
      { ...extension, installed_at: "2026-08-02T00:00:00Z" },
    ]);
    await queryClient.invalidateQueries();

    await waitFor(() => expect(moduleLoader).toHaveBeenCalledTimes(2));
    expect(disposeActivation).toHaveBeenCalledTimes(1);
  });

  it("rejects registrations that were not declared in the manifest", async () => {
    const moduleLoader = vi.fn().mockResolvedValue({
      activate: (host: CanvasExtensionHost) => {
        host.registerPage("surprise", () => undefined);
      },
    });

    renderRuntime(moduleLoader);

    await waitFor(() =>
      expect(screen.getByTestId("runtime-error")).toHaveTextContent(
        'registered undeclared page "surprise"',
      ),
    );
    expect(screen.getByTestId("page-count")).toHaveTextContent("0");
  });

  it("degrades gracefully when the backend response has no manifest", async () => {
    vi.mocked(CanvasExtensionsService.listInstalled).mockResolvedValue([
      { ...extension, manifest: null },
    ]);
    const moduleLoader = vi.fn().mockResolvedValue({
      activate: (host: CanvasExtensionHost) => {
        host.registerPage("dashboard", () => undefined);
      },
    });

    renderRuntime(moduleLoader);

    await waitFor(() =>
      expect(screen.getByTestId("runtime-error")).toHaveTextContent(
        'registered undeclared page "dashboard"',
      ),
    );
    expect(screen.getByTestId("page-count")).toHaveTextContent("0");
  });

  // @spec GAF-006 — Result renderers use declared, unambiguous scopes.
  it("registers a declared renderer and removes it when the extension is disabled", async () => {
    const resultExtension = {
      ...extension,
      manifest: {
        ...extension.manifest!,
        contributes: {
          result_renderers: [
            {
              id: "report",
              package_id: "research",
              tool_name: "create_report",
              schema_version: 1,
            },
          ],
        },
      },
    };
    vi.mocked(CanvasExtensionsService.listInstalled).mockResolvedValue([
      resultExtension,
    ]);
    const moduleLoader = vi.fn().mockResolvedValue({
      activate: (host: CanvasExtensionHost) =>
        host.registerResultRenderer!("report", () => undefined),
    });
    const { queryClient } = renderRuntime(moduleLoader);
    await waitFor(() =>
      expect(screen.getByTestId("renderer-count")).toHaveTextContent("1"),
    );
    vi.mocked(CanvasExtensionsService.listInstalled).mockResolvedValue([
      { ...resultExtension, enabled: false },
    ]);
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(screen.getByTestId("renderer-count")).toHaveTextContent("0"),
    );
  });

  it("rejects duplicate renderer registrations instead of choosing a winner", async () => {
    vi.mocked(CanvasExtensionsService.listInstalled).mockResolvedValue([
      {
        ...extension,
        manifest: {
          ...extension.manifest!,
          contributes: {
            result_renderers: [
              {
                id: "report",
                package_id: "research",
                tool_name: "create_report",
                schema_version: 1,
              },
            ],
          },
        },
      },
    ]);
    renderRuntime(async () => ({
      activate: (host: CanvasExtensionHost) => {
        host.registerResultRenderer!("report", () => undefined);
        host.registerResultRenderer!("report", () => undefined);
      },
    }));
    await waitFor(() =>
      expect(screen.getByTestId("runtime-error")).toHaveTextContent(
        "more than once",
      ),
    );
    expect(screen.getByTestId("renderer-count")).toHaveTextContent("0");
  });

  it("rejects conflicting scopes from two installed extensions", async () => {
    const resultExtension = {
      ...extension,
      manifest: {
        ...extension.manifest!,
        contributes: {
          result_renderers: [
            {
              id: "report",
              package_id: "research",
              tool_name: "create_report",
              schema_version: 1,
            },
          ],
        },
      },
    };
    vi.mocked(CanvasExtensionsService.listInstalled).mockResolvedValue([
      resultExtension,
      { ...resultExtension, name: "other-extension" },
    ]);
    renderRuntime(async () => ({
      activate: (host) => {
        host.registerResultRenderer!("report", () => undefined);
      },
    }));
    await waitFor(() =>
      expect(screen.getByTestId("runtime-error")).toHaveTextContent("scope"),
    );
    expect(screen.getByTestId("renderer-count")).toHaveTextContent("0");
  });

  it("binds form actions to the backend and rejects old actions after a backend switch", async () => {
    const task: TaskRecord = {
      id: "task",
      agent_id: "research/assistant",
      conversation_id: "conversation",
      parent_task_id: null,
      status: "running",
      task: "Research",
      result: null,
      error: null,
      package_version: "1",
      created_at: "today",
      updated_at: "today",
    };
    const create = vi
      .spyOn(FoundationService, "createTask")
      .mockResolvedValue(task);
    const get = vi.spyOn(FoundationService, "getTask").mockResolvedValue(task);
    const upload = vi
      .spyOn(FoundationService, "uploadArtifact")
      .mockResolvedValue({
        id: "artifact",
        conversation_id: "conversation",
        task_id: "task",
        name: "notes.txt",
        mime_type: "text/plain",
        size: 4,
        version: 1,
      });
    const send = vi
      .spyOn(ConversationClient.prototype, "sendEvent")
      .mockResolvedValue();
    let host!: CanvasExtensionHost;
    const activate = vi.fn((value: CanvasExtensionHost) => {
      host = value;
    });
    const rendered = renderRuntime(async () => ({ activate }));
    await waitFor(() => expect(activate).toHaveBeenCalled());
    const input = {
      agent_id: "research/assistant",
      task: "Research",
      idempotency_key: "request-1",
    };
    const file = new File(["test"], "notes.txt");
    await host.foundation!.createTask(input);
    await host.foundation!.getTask("task");
    await host.foundation!.uploadArtifact("conversation", file);
    await host.foundation!.sendInput("conversation", "Continue");
    expect(create).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ id: backend.id }),
    );
    expect(get).toHaveBeenCalledWith(
      "task",
      expect.objectContaining({ id: backend.id }),
    );
    expect(upload).toHaveBeenCalledWith(
      "conversation",
      file,
      expect.objectContaining({ id: backend.id }),
    );
    expect(send).toHaveBeenCalledWith(
      "conversation",
      { role: "user", content: [{ type: "text", text: "Continue" }] },
      { run: true },
    );
    expect(host.apiVersion).toBe("1");
    expect(host.backend).not.toHaveProperty("apiKey");
    const oldHost = host;
    act(() => {
      setRegisteredBackends([
        backend,
        { ...backend, id: "other-backend", host: "http://localhost:9000" },
      ]);
      setActiveSelection({ backendId: "other-backend" });
    });
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    await expect(oldHost.foundation!.getTask("task")).rejects.toThrow(
      "no longer active",
    );
    expect(get).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });
});
