/**
 * Main Agent dispatch contracts.
 *
 * These types are intentionally provider-neutral. The Main Agent selects a
 * logical worker; only the worker registry resolves that selection to a CLI.
 * Main Agent 派发契约保持 Provider 无关：Main 只选择逻辑 Worker，Registry
 * 最后才把它解析成具体 CLI。
 */

export type TaskIntentKind = "coding" | "review" | "research" | "planning" | "operations" | "direct";

export interface TaskIntent {
  kind: TaskIntentKind;
  summary: string;
  requiredCapabilities: readonly string[];
  explicitAgentId?: string;
  excludedAgentIds: readonly string[];
}

export interface MemoryEvidence {
  id: string;
  kind: "project_fact" | "user_preference" | "agent_outcome" | "task_outcome";
  summary: string;
  relevanceScore?: number;
}

/**
 * Only this bounded summary may cross the Worker boundary. Raw long-term
 * memory stays owned by Main Agent.
 * 只有这个受限摘要可以进入 Worker；原始长期记忆始终由 Main Agent 管理。
 */
export interface MemoryContext {
  summary: string;
  sourceMemoryIds: readonly string[];
  evidence: readonly MemoryEvidence[];
}

export type DispatchSource = "explicit" | "rule" | "memory" | "description";

export interface WorkerDescriptor {
  id: string;
  providerId: string;
  description: string;
  roles: readonly TaskIntentKind[];
  capabilities: readonly string[];
  priority: number;
  enabled: boolean;
  installed: boolean;
}

export interface DispatchDecision {
  taskId: string;
  intent: TaskIntent;
  selectedAgentId: string;
  providerId: string;
  source: DispatchSource;
  matchedRuleIds: readonly string[];
  usedMemoryIds: readonly string[];
  alternatives: readonly string[];
  reason: string;
  /** Every black-box worker invocation starts without prior chat history. 每次黑盒 Worker 调用都从无历史的全新上下文开始。 */
  sessionPolicy: "fresh";
  createdAt: string;
}

export type DispatchBlockedCode =
  | "NO_MATCHING_AGENT"
  | "REQUESTED_AGENT_NOT_FOUND"
  | "REQUESTED_AGENT_DISABLED"
  | "REQUESTED_AGENT_UNAVAILABLE"
  | "CAPABILITY_MISMATCH";

export interface DispatchBlocked {
  status: "blocked";
  taskId: string;
  code: DispatchBlockedCode;
  reason: string;
  requestedAgentId?: string;
  consideredAgentIds: readonly string[];
}

export interface DispatchSelected {
  status: "selected";
  decision: DispatchDecision;
}

export type DispatchResult = DispatchSelected | DispatchBlocked;

/**
 * Auditable boundary record written before a process is spawned.
 * 该记录必须在启动子进程前持久化，用来证明真正执行了哪个 Worker。
 */
export interface WorkerInvocation {
  invocationId: string;
  taskId: string;
  selectedAgentId: string;
  providerId: string;
  sessionPolicy: "fresh";
  prompt: string;
  memorySourceIds: readonly string[];
  createdAt: string;
}

