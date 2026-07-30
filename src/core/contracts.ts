/**
 * A Run may start from an owner query or from a governed non-query source.
 * A signal can request planning; it never grants execution authority itself.
 *
 * Run 既可以由用户 Query 发起，也可以由受治理的非 Query 来源发起。Signal 只能请求规划，
 * 绝不会自行授予执行权限。
 */
export type TriggerKind = "query" | "schedule" | "signal" | "manual";

export type RunStatus =
  | "created"
  | "planning"
  | "queued"
  | "running"
  | "waiting_approval"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type RiskClass =
  | "read_only"
  | "reversible_write"
  | "external_side_effect"
  | "irreversible";

export interface Trigger {
  id: string;
  kind: TriggerKind;
  occurredAt: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface Task {
  id: string;
  triggerId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  createdAt: string;
}

export interface PlanStep {
  id: string;
  title: string;
  instructions: string;
  risk: RiskClass;
  acceptanceCriteria: string[];
  /** A single bounded executor for this step. Mutually exclusive with subagents. */
  agentId?: string;
  /** Required when agentId is present; the Runtime checks it before execution. */
  requiredCapabilities?: string[];
  /** Work orders supervised by this step. They may run in dependency-aware waves. */
  subagents?: SubagentWorkOrder[];
}

export interface WorkOrderInput {
  /** Stable name used when building the bounded agent prompt. */
  name: string;
  description: string;
  /** When present, the Runtime injects evidence produced by this dependency. */
  sourceWorkOrderId?: string;
  required: boolean;
}

export interface ArtifactContract {
  id: string;
  kind: Evidence["kind"];
  description: string;
  required: boolean;
  /** Receipts and files generally need a durable location, not only prose. */
  locatorRequired?: boolean;
}

export interface WorkOrderBudget {
  maxDurationMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxAttempts: number;
}

/**
 * A work order is deliberately smaller than a task. It has no authority over
 * personal state, policy, or the final outcome. It is an executable contract:
 * an agent receives bounded inputs and authority, then returns named artifacts
 * and evidence that the supervisor verifies.
 *
 * WorkOrder 被刻意设计得比 Task 更小。它无权修改个人状态、Policy 或最终结果；它是一份
 * 可执行合同：Agent 只获得有边界的输入与权限，返回具名的 Artifact 和 Evidence，再由
 * Supervisor 验收。
 */
export interface SubagentWorkOrder {
  id: string;
  /** Optional routing preference. The dispatcher still checks capabilities. */
  agentId?: string;
  role: "researcher" | "maker" | "reviewer" | "custom";
  title: string;
  objective: string;
  inputs: WorkOrderInput[];
  requiredCapabilities: string[];
  expectedArtifacts: ArtifactContract[];
  acceptanceCriteria: string[];
  risk: RiskClass;
  budget: WorkOrderBudget;
  dependsOn?: string[];
}

export interface WorkPlan {
  id: string;
  runId: string;
  summary: string;
  steps: PlanStep[];
  createdAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  planId?: string;
  activeStepId?: string;
}

export interface ApprovalGrant {
  id: string;
  runId: string;
  stepId: string;
  grantedAt: string;
  grantedBy: "user" | "standing_policy";
  note?: string;
}

export interface Evidence {
  id: string;
  runId: string;
  stepId: string;
  /** Present when the evidence came from a child-agent work order. */
  workOrderId?: string;
  producedBy?: string;
  kind: "artifact" | "tool_result" | "receipt" | "test" | "observation";
  summary: string;
  locator?: string;
  createdAt: string;
}

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentRun {
  id: string;
  runId: string;
  stepId: string;
  workOrderId: string;
  agentId: string;
  /** Concrete provider pinned when the work order first starts. */
  providerId?: string;
  sessionId?: string;
  attempt: number;
  role: SubagentWorkOrder["role"];
  title: string;
  status: SubagentStatus;
  startedAt: string;
  updatedAt: string;
  summary?: string;
}

export interface SubagentVerificationResult {
  id: string;
  runId: string;
  stepId: string;
  workOrderId: string;
  passed: boolean;
  summary: string;
  checkedEvidenceIds: string[];
  createdAt: string;
}

export interface VerificationResult {
  runId: string;
  passed: boolean;
  summary: string;
  checkedEvidenceIds: string[];
  createdAt: string;
}

export interface MemoryCandidate {
  id: string;
  runId: string;
  sourceEvidenceIds: string[];
  summary: string;
  confidence: "low" | "medium" | "high";
  status: "proposed" | "committed" | "rejected";
  createdAt: string;
}

export type JournalEventType =
  | "trigger.received"
  | "task.created"
  | "run.created"
  | "run.status_changed"
  | "plan.created"
  | "policy.decided"
  | "approval.granted"
  | "execution.started"
  | "execution.progress"
  | "subagent.dispatched"
  | "subagent.resumed"
  | "subagent.session_started"
  | "subagent.progress"
  | "subagent.completed"
  | "subagent.failed"
  | "subagent.cancelled"
  | "subagent.verified"
  | "agent.message_delta"
  | "agent.tool_started"
  | "agent.tool_completed"
  | "evidence.recorded"
  | "verification.completed"
  | "memory.candidate.requested"
  | "memory.candidate.proposed"
  | "memory.recalled";

export interface JournalEvent {
  id: string;
  sequence: number;
  type: JournalEventType;
  occurredAt: string;
  taskId?: string;
  runId?: string;
  payload: unknown;
}

export interface NewJournalEvent {
  type: JournalEventType;
  taskId?: string;
  runId?: string;
  payload: unknown;
}

export interface ExecutionAssignment {
  run: Run;
  task: Task;
  step: PlanStep;
  /** The concrete adapter selected by the Runtime, not merely a planning hint. */
  executor: {
    agentId: string;
    providerId: string;
  };
  /** Defined only for a child agent. The parent Runtime remains the supervisor. */
  workOrder?: SubagentWorkOrder;
  /** Evidence from completed dependencies, curated by the supervisor. */
  dependencyEvidence?: Evidence[];
  workspacePath?: string;
}

export type ExecutionEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "message_delta"; text: string }
  | { type: "tool_started"; toolCallId: string; tool: string; inputSummary?: string }
  | { type: "tool_completed"; toolCallId: string; tool: string; isError: boolean }
  | { type: "progress"; message: string }
  | { type: "evidence"; evidence: Omit<Evidence, "id" | "runId" | "stepId" | "createdAt"> }
  | { type: "completed"; summary: string }
  | { type: "failed"; message: string };

export interface RuntimeCapabilities {
  resume: boolean;
  cancellation: boolean;
  approvalCallback: boolean;
  parallelAssignments: boolean;
  /** Domain abilities used by the dispatcher; tool access remains adapter-owned. */
  work: string[];
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly providerId: string;

  capabilities(): Promise<RuntimeCapabilities>;

  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent>;

  resume?(sessionId: string, input: ExecutionAssignment): AsyncIterable<ExecutionEvent>;

  cancel?(sessionId: string): Promise<void>;
}

/**
 * Maps a work order to a replaceable agent adapter.
 * 将 WorkOrder 映射到可替换的 Agent Adapter；Adapter 不拥有 Run 状态。
 */
export interface AgentRegistry {
  get(agentId: string): RuntimeAdapter | undefined;
  list(): RuntimeAdapter[];
}

export interface PolicyDecision {
  outcome: "allowed" | "approval_required" | "denied";
  reason: string;
}

export interface PolicyEngine {
  evaluate(input: { run: Run; task: Task; step: PlanStep; approved: boolean }): PolicyDecision;
}

export interface Verifier {
  verify(input: { run: Run; plan: WorkPlan; evidence: Evidence[] }): Promise<VerificationResult>;
}
