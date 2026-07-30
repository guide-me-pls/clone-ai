export type JsonObject = Record<string, unknown>;

export interface ToolSchema {
  type: "function";
  name: string;
  description: string;
  parameters: JsonObject;
  strict: true;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

export type ToolRisk = "read_only" | "reversible_write" | "external_side_effect" | "irreversible";

export interface ToolExecution {
  runId: string;
  call: ToolCall;
  /**
   * Stable across recovery; never generate a second ID for the same real-world action.
   * 跨恢复保持稳定；同一个现实动作绝不能生成第二个 ID。
   */
  operationId: string;
}

export interface ToolExecutionContext {
  operationId: string;
  signal: AbortSignal;
}

export interface ToolReceipt {
  operationId: string;
  status: "completed" | "failed";
  evidence: Array<{
    kind: "artifact" | "receipt" | "observation";
    summary: string;
    locator?: string;
  }>;
}

export type ToolReconcileResult =
  | { status: "completed"; result: ToolResult; receipt: ToolReceipt }
  | { status: "not_started" }
  | { status: "unknown"; reason: string };

export type ToolAuthorization =
  | { outcome: "allowed" }
  | { outcome: "approval_required"; reason: string }
  | { outcome: "denied"; reason: string };

export type LoopMessage =
  | { role: "user"; content: string }
  | { role: "tool"; callId: string; toolName: string; result: ToolResult };

export type ModelTurn =
  | { kind: "tool_calls"; calls: ToolCall[] }
  | { kind: "final"; text: string };

/**
 * Provider-specific, JSON-serializable protocol state. This is distinct from
 * LoopMessage: it lets an API continue a function-call conversation after a
 * process restart without storing credentials or HTTP headers.
 *
 * Provider 特有且可 JSON 序列化的协议状态。它不同于 LoopMessage：它让 API 可以在进程重启后
 * 继续 Function Call 对话，同时不保存凭据或 HTTP Header。
 */
export interface ModelContinuation {
  provider: string;
  state: unknown;
}

export interface LoopModel {
  respond(input: { instructions: string; messages: LoopMessage[]; tools: ToolSchema[] }): Promise<ModelTurn>;
}

export interface ContinuationCapableModel extends LoopModel {
  snapshotContinuation(): ModelContinuation;
}

export type LoopModelFactory = (continuation?: ModelContinuation) => LoopModel;

export interface ToolDefinition {
  schema: ToolSchema;
  risk?: ToolRisk;
  execute(arguments_: JsonObject, context?: ToolExecutionContext): Promise<ToolResult>;
  /**
   * Required for safe automatic recovery of a side-effecting tool.
   * 有副作用 Tool 的安全自动恢复所必需。
   */
  reconcile?(execution: ToolExecution): Promise<ToolReconcileResult>;
}

export interface ToolPolicy {
  authorize(input: { execution: ToolExecution; definition: ToolDefinition }): ToolAuthorization;
}

export type LoopEventType =
  | "run.started"
  | "context.built"
  | "model.started"
  | "model.completed"
  | "tool.requested"
  | "tool.completed"
  | "verification.completed"
  | "run.retrying"
  | "approval.requested"
  | "approval.granted"
  | "run.cancelled"
  | "run.completed"
  | "run.failed";

export interface LoopEvent {
  id: string;
  sequence: number;
  runId: string;
  type: LoopEventType;
  occurredAt: string;
  payload: unknown;
}

export interface NewLoopEvent {
  runId: string;
  type: LoopEventType;
  payload: unknown;
}

export interface LoopJournal {
  append(event: NewLoopEvent): Promise<LoopEvent>;
  list(runId?: string): Promise<LoopEvent[]>;
}

/**
 * The next recoverable action for a durable single-agent run.
 * 持久化单 Agent Run 的下一步可恢复动作。
 */
export type LoopRunStatus =
  | "created"
  | "waiting_model"
  | "running_model"
  | "waiting_tools"
  | "running_tool"
  | "verifying"
  | "waiting_approval"
  | "cancelled"
  | "completed"
  | "failed";

export interface LoopRunState {
  runId: string;
  status: LoopRunStatus;
  goal?: string;
  instructions?: string;
  turn: number;
  messages: LoopMessage[];
  pendingToolCalls: ToolCall[];
  activeToolCallId?: string;
  activeToolOperationId?: string;
  pendingApprovalCallId?: string;
  approvedToolCallIds: string[];
  budget: {
    modelCalls: number;
    toolCalls: number;
    verificationRetries: number;
    startedAt: string;
    limits: RunBudget;
  };
  modelContinuation?: ModelContinuation;
  verification?: VerificationOutcome;
  finalAnswer?: string;
  failureReason?: string;
  lastAppliedSequence: number;
  updatedAt?: string;
}

/**
 * A materialized view used to start recovery without replaying an entire journal.
 * 用于启动恢复的物化视图，避免每次重放完整 Journal。
 */
export interface LoopCheckpointStore {
  save(state: LoopRunState): Promise<void>;
  load(runId: string): Promise<LoopRunState | undefined>;
}

export interface RunBudget {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxVerificationRetries?: number;
  maxDurationMs?: number;
}

export type VerificationOutcome =
  | { kind: "passed"; summary: string }
  | { kind: "retryable"; summary: string }
  | { kind: "needs_replan"; summary: string }
  | { kind: "needs_approval"; summary: string }
  | { kind: "failed"; summary: string };

export interface ResponseVerifier {
  verify(input: { goal: string; answer: string }): Promise<VerificationOutcome>;
}
