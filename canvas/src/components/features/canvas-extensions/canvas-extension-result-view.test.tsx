import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CanvasExtensionsService from "#/api/canvas-extensions-service";
import FoundationService from "#/api/agent-foundation-service";
import * as downloadUtils from "#/utils/utils";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import type {
  CanvasExtensionResult,
  CanvasExtensionResultMount,
  InstalledCanvasExtensionInfo,
} from "#/types/canvas-extension";
import { AgentFoundationTaskResult } from "../agent-foundation/agent-foundation-task-result";
import { CanvasExtensionsRuntimeProvider } from "./canvas-extensions-runtime";
import { CanvasExtensionResultView } from "./canvas-extension-result-view";

const result: CanvasExtensionResult = {
  package_id: "research",
  tool_name: "task_result",
  schema_version: 1,
  data: { count: 3 },
  text: "Report ready",
};
const extension: InstalledCanvasExtensionInfo = {
  name: "report-ui",
  version: "1.0.0",
  enabled: true,
  source: "/report-ui",
  installed_at: "2026-10-05",
  install_path: "/report-ui",
  manifest: {
    schema_version: 1,
    name: "report-ui",
    version: "1.0.0",
    entrypoint: "index.js",
    contributes: {
      result_renderers: [
        {
          id: "report",
          package_id: result.package_id,
          tool_name: result.tool_name,
          schema_version: result.schema_version,
        },
      ],
    },
  },
};

function renderResult(mount: CanvasExtensionResultMount, value = result) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const activate = vi.fn(
    (host: import("#/types/canvas-extension").CanvasExtensionHost) => {
      host.registerResultRenderer!("report", mount);
    },
  );
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <ActiveBackendProvider>
        <MemoryRouter>
          <CanvasExtensionsRuntimeProvider
            moduleLoader={async () => ({ activate })}
          >
            <CanvasExtensionResultView
              result={value}
              conversationId="conversation-1"
            />
          </CanvasExtensionsRuntimeProvider>
        </MemoryRouter>
      </ActiveBackendProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient, activate };
}

describe("CanvasExtensionResultView", () => {
  beforeEach(() => {
    setRegisteredBackends([
      {
        id: "local",
        name: "Local",
        host: "http://localhost:8000",
        apiKey: "",
        kind: "local",
      },
    ]);
    setActiveSelection({ backendId: "local" });
    vi.spyOn(CanvasExtensionsService, "listInstalled").mockResolvedValue([
      extension,
    ]);
    vi.spyOn(CanvasExtensionsService, "fetchBundle").mockResolvedValue(
      "fixture",
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setActiveSelection(null);
    setRegisteredBackends([]);
  });

  // @spec GAF-006 — Disabled renderers release their UI and preserve result data.
  it("mounts a matching renderer and restores text/JSON when it is disabled", async () => {
    const dispose = vi.fn();
    const mount = vi.fn<CanvasExtensionResultMount>(({ container }) => {
      container.replaceChildren(document.createTextNode("Report card"));
      return dispose;
    });
    const { queryClient } = renderResult(mount);
    await screen.findByText("Report card");
    expect(mount).toHaveBeenCalledWith(
      expect.objectContaining({ result, conversationId: "conversation-1" }),
    );
    vi.mocked(CanvasExtensionsService.listInstalled).mockResolvedValue([
      { ...extension, enabled: false },
    ]);
    await queryClient.invalidateQueries();
    await screen.findByText("Report ready");
    expect(screen.getByText(/"count": 3/)).toBeInTheDocument();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    { package_id: "other" },
    { tool_name: "other" },
    { schema_version: 2 },
  ])("requires the full exact scope: %j", async (difference) => {
    const mount = vi.fn();
    const { activate } = renderResult(mount, { ...result, ...difference });
    await waitFor(() => expect(activate).toHaveBeenCalled());
    expect(screen.getByText("Report ready")).toBeInTheDocument();
    expect(mount).not.toHaveBeenCalled();
  });

  it("falls back when a renderer rejects after adding partial content", async () => {
    const mount = vi.fn<CanvasExtensionResultMount>(async ({ container }) => {
      container.replaceChildren(document.createTextNode("Partial card"));
      throw new Error("broken renderer");
    });
    renderResult(mount);
    await waitFor(() => expect(mount).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText("Partial card")).not.toBeInTheDocument(),
    );
    await screen.findByText("Report ready");
    expect(screen.getByText(/"count": 3/)).toBeInTheDocument();
  });

  it("disposes a mount that resolves after its view is removed", async () => {
    const dispose = vi.fn();
    let resolveMount!: (dispose: () => void) => void;
    const mount = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveMount = resolve;
        }),
    );
    const rendered = renderResult(mount);
    await waitFor(() => expect(mount).toHaveBeenCalled());
    rendered.unmount();
    resolveMount(dispose);
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it("downloads fallback artifacts through the scoped server client", async () => {
    const blob = new Blob(["report"]);
    const download = vi
      .spyOn(FoundationService, "downloadArtifact")
      .mockResolvedValue(blob);
    const save = vi
      .spyOn(downloadUtils, "downloadBlob")
      .mockImplementation(() => undefined);
    renderResult(vi.fn(), {
      ...result,
      schema_version: 2,
      artifacts: [
        {
          id: "artifact-1",
          conversation_id: "conversation-1",
          task_id: "task-1",
          name: "report.txt",
          mime_type: "text/plain",
          size: 6,
          version: 1,
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "AGENT_FOUNDATION$DOWNLOAD" }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledWith(blob, "report.txt"));
    expect(download).toHaveBeenCalledWith(
      "artifact-1",
      expect.objectContaining({ id: "local" }),
    );
  });

  it("keeps legacy and malformed task results readable", () => {
    render(
      <>
        <AgentFoundationTaskResult
          result="Legacy report"
          conversationId="legacy"
        />
        <AgentFoundationTaskResult
          result={'{"data":"partial"}'}
          conversationId="legacy"
        />
      </>,
    );
    expect(screen.getByText("Legacy report")).toBeInTheDocument();
    expect(screen.getByText('{"data":"partial"}')).toBeInTheDocument();
  });
});
