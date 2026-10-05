import { HttpClient } from './http-client';
import type { OpenHandsClientOptions } from './openhands-client';
import type {
  AgentEffectiveConfig,
  ToolCallRecord,
  ResolveToolCall,
  AgentSummary,
  InstalledAgentPackage,
  PackageValidation,
  TaskRecord,
  CreateFoundationTask,
  ApprovalRequest,
  ArtifactRef,
} from '../types/agent-foundation';

const BASE = '/api/agent-foundation';

/** Typed business-agent access; transport and credentials stay server-owned. */
export class AgentFoundationClient {
  private readonly client: HttpClient;

  constructor(options: OpenHandsClientOptions) {
    this.client = new HttpClient({
      baseUrl: options.host,
      apiKey: options.apiKey,
      timeout: options.timeout ?? 60000,
    });
  }

  async listAgents(): Promise<AgentSummary[]> {
    return (await this.client.get<{ agents: AgentSummary[] }>(`${BASE}/agents`)).data.agents;
  }
  async listPackages(): Promise<InstalledAgentPackage[]> {
    return (await this.client.get<{ packages: InstalledAgentPackage[] }>(`${BASE}/packages`)).data
      .packages;
  }
  async validatePackage(source: string): Promise<PackageValidation> {
    return (await this.client.post<PackageValidation>(`${BASE}/packages/validate`, { source }))
      .data;
  }
  async installPackage(source: string): Promise<InstalledAgentPackage> {
    return (await this.client.post<InstalledAgentPackage>(`${BASE}/packages/install`, { source }))
      .data;
  }
  async setPackageEnabled(id: string, enabled: boolean): Promise<InstalledAgentPackage> {
    return (
      await this.client.patch<InstalledAgentPackage>(`${BASE}/packages/${encodeURIComponent(id)}`, {
        enabled,
      })
    ).data;
  }
  async uninstallPackage(id: string): Promise<void> {
    await this.client.delete(`${BASE}/packages/${encodeURIComponent(id)}`);
  }
  async createTask(input: CreateFoundationTask): Promise<TaskRecord> {
    return (await this.client.post<TaskRecord>(`${BASE}/tasks`, input)).data;
  }
  async getAgentConfig(id: string, version?: string): Promise<AgentEffectiveConfig> {
    const [packageId, agentId] = id.split('/');
    if (!packageId || !agentId || id.split('/').length !== 2)
      throw new Error('Expected package/agent identity');
    return (
      await this.client.get<AgentEffectiveConfig>(
        `${BASE}/agents/${encodeURIComponent(packageId)}/${encodeURIComponent(agentId)}/config`,
        { params: { version } }
      )
    ).data;
  }
  async listToolCalls(id: string): Promise<ToolCallRecord[]> {
    return (
      await this.client.get<{ calls: ToolCallRecord[] }>(
        `${BASE}/tasks/${encodeURIComponent(id)}/calls`
      )
    ).data.calls;
  }
  async resolveToolCall(
    id: string,
    callId: string,
    input: ResolveToolCall
  ): Promise<ToolCallRecord> {
    return (
      await this.client.post<ToolCallRecord>(
        `${BASE}/tasks/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/resolve`,
        input
      )
    ).data;
  }
  async getTask(id: string): Promise<TaskRecord> {
    return (await this.client.get<TaskRecord>(`${BASE}/tasks/${encodeURIComponent(id)}`)).data;
  }
  async listTasks(conversationId: string): Promise<TaskRecord[]> {
    return (
      await this.client.get<{ tasks: TaskRecord[] }>(`${BASE}/tasks`, {
        params: { conversation_id: conversationId },
      })
    ).data.tasks;
  }
  async cancelTask(id: string): Promise<TaskRecord> {
    return (await this.client.post<TaskRecord>(`${BASE}/tasks/${encodeURIComponent(id)}/cancel`))
      .data;
  }
  async resumeTask(id: string): Promise<TaskRecord> {
    return (await this.client.post<TaskRecord>(`${BASE}/tasks/${encodeURIComponent(id)}/resume`))
      .data;
  }
  async listApprovals(conversationId: string): Promise<ApprovalRequest[]> {
    return (
      await this.client.get<{ approvals: ApprovalRequest[] }>(`${BASE}/approvals`, {
        params: { conversation_id: conversationId },
      })
    ).data.approvals;
  }
  async decideApproval(id: string, approved: boolean): Promise<ApprovalRequest> {
    return (
      await this.client.post<ApprovalRequest>(
        `${BASE}/approvals/${encodeURIComponent(id)}/decision`,
        { approved }
      )
    ).data;
  }
  async listArtifacts(conversationId: string): Promise<ArtifactRef[]> {
    return (
      await this.client.get<{ artifacts: ArtifactRef[] }>(`${BASE}/artifacts`, {
        params: { conversation_id: conversationId },
      })
    ).data.artifacts;
  }
  async uploadArtifact(conversationId: string, file: File): Promise<ArtifactRef> {
    const body = new FormData();
    body.append('file', file, file.name);
    return (
      await this.client.post<ArtifactRef>(`${BASE}/artifacts`, body, {
        params: { conversation_id: conversationId },
      })
    ).data;
  }
  async downloadArtifact(id: string): Promise<Blob> {
    return (
      await this.client.get<Blob>(`${BASE}/artifacts/${encodeURIComponent(id)}/download`, {
        responseType: 'blob',
      })
    ).data;
  }
  close(): void {
    this.client.close();
  }
}
