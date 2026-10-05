import type {
  ArtifactRef,
  CreateFoundationTask,
  TaskRecord,
} from "@openhands/typescript-client";

export const CANVAS_EXTENSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CANVAS_EXTENSION_HOST_API_VERSION = "1" as const;

export interface CanvasExtensionPageContribution {
  id: string;
  title: string;
  path: string;
  nav_label?: string | null;
  description?: string | null;
}

export interface CanvasExtensionContributions {
  pages?: CanvasExtensionPageContribution[] | null;
  result_renderers?: CanvasExtensionResultRendererContribution[] | null;
}

/** A renderer matches this exact tuple; there are no wildcard scopes. */
export interface CanvasExtensionResultRendererContribution {
  id: string;
  package_id: string;
  tool_name: string;
  schema_version: number;
}

export interface CanvasExtensionResult {
  package_id: string;
  tool_name: string;
  schema_version: number;
  data: unknown;
  text?: string | null;
  artifacts?: ArtifactRef[];
}

export interface CanvasExtensionResultMountContext {
  container: HTMLElement;
  result: Readonly<CanvasExtensionResult>;
  conversationId: string | null;
}

export type CanvasExtensionResultMount = (
  context: CanvasExtensionResultMountContext,
) => void | CanvasExtensionDispose | Promise<void | CanvasExtensionDispose>;

/** Optional v1 capability for business forms on a local Agent Server. */
export interface CanvasExtensionFoundationHost {
  createTask: (input: CreateFoundationTask) => Promise<TaskRecord>;
  sendInput: (conversationId: string, text: string) => Promise<void>;
  uploadArtifact: (conversationId: string, file: File) => Promise<ArtifactRef>;
  getTask: (taskId: string) => Promise<TaskRecord>;
}

/** Parsed contents of `canvas-extension.json`. */
export interface CanvasExtensionManifest {
  schema_version: typeof CANVAS_EXTENSION_MANIFEST_SCHEMA_VERSION;
  name: string;
  display_name?: string | null;
  version: string;
  description?: string | null;
  entrypoint: string;
  contributes?: CanvasExtensionContributions | null;
}

export interface InstalledCanvasExtensionInfo {
  name: string;
  version: string;
  description?: string | null;
  enabled: boolean;
  source: string;
  requested_ref?: string | null;
  resolved_ref?: string | null;
  repo_path?: string | null;
  installed_at: string;
  install_path: string;
  /** Absent until the backend exposes page contributions (OSS-10048). */
  manifest?: CanvasExtensionManifest | null;
}

export interface InstallCanvasExtensionRequest {
  source: string;
  ref?: string | null;
  repo_path?: string | null;
  force?: boolean;
}

export type CanvasExtensionDispose = () => void;

export interface CanvasExtensionPageMountContext {
  container: HTMLElement;
  /** Remainder of the route below the page contribution's declared path. */
  path: string;
  navigate: (path: string) => void;
}

export type CanvasExtensionPageMount = (
  context: CanvasExtensionPageMountContext,
) => void | CanvasExtensionDispose | Promise<void | CanvasExtensionDispose>;

export interface CanvasExtensionAgentServerRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CanvasExtensionHost {
  readonly apiVersion: typeof CANVAS_EXTENSION_HOST_API_VERSION;
  readonly extension: Readonly<{
    name: string;
    version: string;
    resolvedRef: string | null;
  }>;
  readonly backend: Readonly<{
    id: string;
    kind: "local" | "cloud";
    orgId: string | null;
  }>;
  registerPage: (
    contributionId: string,
    mount: CanvasExtensionPageMount,
  ) => CanvasExtensionDispose;
  registerResultRenderer?: (
    contributionId: string,
    mount: CanvasExtensionResultMount,
  ) => CanvasExtensionDispose;
  foundation?: CanvasExtensionFoundationHost;
  navigate: (path: string) => void;
  agentServer: {
    request: <T = unknown>(
      request: CanvasExtensionAgentServerRequest,
    ) => Promise<T>;
  };
}

export interface CanvasExtensionModule {
  activate: (
    host: CanvasExtensionHost,
  ) => void | CanvasExtensionDispose | Promise<void | CanvasExtensionDispose>;
}
