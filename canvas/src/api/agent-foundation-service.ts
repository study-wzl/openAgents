import { AgentFoundationClient } from "@openhands/typescript-client/clients";
import type {
  CreateFoundationTask,
  ResolveToolCall,
} from "@openhands/typescript-client";
import { getAgentServerClientOptions } from "./agent-server-client-options";
import type { Backend } from "./backend-registry/types";

export type {
  AgentSummary,
  InstalledAgentPackage,
  PackageValidation,
  TaskRecord,
  FoundationTaskStatus,
  CreateFoundationTask,
  ApprovalRequest,
  ArtifactRef,
  AgentEffectiveConfig,
  ToolCallRecord,
  ResolveToolCall,
} from "@openhands/typescript-client";

function client(backend?: Backend) {
  return new AgentFoundationClient(
    getAgentServerClientOptions(
      backend ? { host: backend.host, apiKey: backend.apiKey } : {},
    ),
  );
}

// @spec GAF-005 — Canvas uses the canonical client for all foundation state
const AgentFoundationService = {
  listAgents: (backend?: Backend) => client(backend).listAgents(),
  getAgentConfig: (id: string, version?: string, backend?: Backend) =>
    client(backend).getAgentConfig(id, version),
  listPackages: (backend?: Backend) => client(backend).listPackages(),
  validatePackage: (source: string, backend?: Backend) =>
    client(backend).validatePackage(source),
  installPackage: (source: string, backend?: Backend) =>
    client(backend).installPackage(source),
  setPackageEnabled: (id: string, enabled: boolean, backend?: Backend) =>
    client(backend).setPackageEnabled(id, enabled),
  uninstallPackage: (id: string, backend?: Backend) =>
    client(backend).uninstallPackage(id),
  createTask: (input: CreateFoundationTask, backend?: Backend) =>
    client(backend).createTask(input),
  getTask: (id: string, backend?: Backend) => client(backend).getTask(id),
  listToolCalls: (id: string, backend?: Backend) =>
    client(backend).listToolCalls(id),
  resolveToolCall: (
    id: string,
    callId: string,
    input: ResolveToolCall,
    backend?: Backend,
  ) => client(backend).resolveToolCall(id, callId, input),
  listTasks: (conversationId: string, backend?: Backend) =>
    client(backend).listTasks(conversationId),
  cancelTask: (id: string, backend?: Backend) => client(backend).cancelTask(id),
  resumeTask: (id: string, backend?: Backend) => client(backend).resumeTask(id),
  listApprovals: (conversationId: string, backend?: Backend) =>
    client(backend).listApprovals(conversationId),
  decideApproval: (id: string, approved: boolean, backend?: Backend) =>
    client(backend).decideApproval(id, approved),
  listArtifacts: (conversationId: string, backend?: Backend) =>
    client(backend).listArtifacts(conversationId),
  uploadArtifact: (conversationId: string, file: File, backend?: Backend) =>
    client(backend).uploadArtifact(conversationId, file),
  downloadArtifact: (id: string, backend?: Backend) =>
    client(backend).downloadArtifact(id),
};

export default AgentFoundationService;
