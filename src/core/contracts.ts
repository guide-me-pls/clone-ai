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
  /** Work orders supervised by this step. They may run in dependency-aware waves. */
  subagents?: SubagentWorkOrder[];
}

/**
 * A work order is deliberately smaller than a task. It has no authority over
 * personal state, policy, or the final outcome; it only authorizes one agent
 * to produce evidence for one plan step.
 */
export interface SubagentWorkOrder {
  id: string;
  agentId: string;
  role: "researcher" | "maker" | "reviewer" | "custom";
  title: string;
  objective: string;
  acceptanceCriteria: string[];
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

export type SubagentStatus = "running" | "completed" | "failed";

export interface SubagentRun {
  id: string;
  runId: string;
  stepId: string;
  workOrderId: string;
  agentId: string;
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
  | "subagent.progress"
  | "subagent.completed"
  | "subagent.failed"
  | "subagent.verified"
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
  /** Defined only for a child agent. The parent Runtime remains the supervisor. */
  workOrder?: SubagentWorkOrder;
  workspacePath?: string;
}

export type ExecutionEvent =
  | { type: "progress"; message: string }
  | { type: "evidence"; evidence: Omit<Evidence, "id" | "runId" | "stepId" | "createdAt"> }
  | { type: "completed"; summary: string }
  | { type: "failed"; message: string };

export interface RuntimeCapabilities {
  resume: boolean;
  cancellation: boolean;
  approvalCallback: boolean;
  parallelAssignments: boolean;
}

export interface RuntimeAdapter {
  readonly id: string;

  capabilities(): Promise<RuntimeCapabilities>;

  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent>;

  cancel?(runtimeRunId: string): Promise<void>;
}

/** Maps a work order to a replaceable agent adapter. */
export interface AgentRegistry {
  get(agentId: string): RuntimeAdapter | undefined;
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
