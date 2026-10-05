import type { OpenHandsAgentProfile } from '../models/agent-profile';
/** Canonical Agent Server business-agent contracts. @spec GAF-001 */
export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  profile_id: string;
  package_id: string;
  package_version: string;
  enabled: boolean;
}

export interface InstalledAgentPackage {
  id: string;
  name: string;
  version: string;
  description: string | null;
  enabled: boolean;
  content_hash: string;
  ui_extension_ref?: string | null;
}

export interface PackageValidation {
  valid: boolean;
  errors: string[];
}

export type FoundationTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_confirmation'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** @spec GAF-002 — Persisted orchestration state. */
export interface TaskRecord {
  id: string;
  agent_id: string;
  conversation_id: string;
  parent_task_id: string | null;
  status: FoundationTaskStatus;
  task: string;
  result: string | null;
  error: string | null;
  package_version: string;
  created_at: string;
  updated_at: string;
}

export interface CreateFoundationTask {
  agent_id: string;
  task: string;
  idempotency_key: string;
  artifact_ids?: string[];
  parent_task_id?: string | null;
}

/** @spec GAF-003 — Approval is scoped to an exact tool invocation. */
export interface ApprovalRequest {
  id: string;
  task_id: string;
  conversation_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  call_id: string;
  package_version: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
}

/** @spec GAF-004 — Artifacts outlive execution workspaces. */
export interface ArtifactRef {
  id: string;
  conversation_id: string;
  task_id: string | null;
  name: string;
  mime_type: string;
  size: number;
  version: number;
}

export interface FoundationToolPolicy {
  requires_confirmation: boolean;
  timeout_seconds: number;
  cancellable: boolean;
}
export interface AgentEffectiveConfig {
  agent: AgentSummary;
  profile: OpenHandsAgentProfile;
  content_hash: string;
  resolved_model: string;
  resolved_skills: string[];
  runtime_tools: string[];
  child_runtime_tools: string[];
  delegation_note: string;
  allowed_agents: string[];
  tool_policies: Record<string, FoundationToolPolicy>;
  managed_by_package: true;
  read_only: true;
  external_dependencies_pinned: false;
}
export interface ToolCallRecord {
  id: string;
  task_id: string;
  status: string;
  read_only: boolean;
  tool_name: string;
  arguments: Record<string, unknown>;
  package_version: string;
}
export interface ResolveToolCall {
  outcome: 'not_executed' | 'executed';
  evidence: string;
}
