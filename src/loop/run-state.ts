import type { LoopEvent, LoopRunState, ModelContinuation, ToolCall, ToolResult, VerificationOutcome } from "./contracts.ts";

/**
 * Converts append-only events into the next recoverable state. Events remain
 * the source of truth; this projector creates the state a runner needs after
 * restart: call the model, finish a pending tool, verify, or stop.
 *
 * 将仅追加 Event 转化为下一步可恢复状态。Event 仍是事实来源；这个 Projector 创建的是 Runner
 * 在重启后需要的状态：调用 Model、完成待处理 Tool、验证或停止。
 */
export class LoopRunProjector {
  #state: LoopRunState;

  constructor(runId: string, checkpoint?: LoopRunState) {
    this.#state = checkpoint === undefined ? emptyState(runId) : cloneState(checkpoint);
    if (this.#state.runId !== runId) {
      throw new Error(`Checkpoint run ID ${this.#state.runId} does not match ${runId}.`);
    }
  }

  apply(event: LoopEvent): LoopRunState {
    if (event.runId !== this.#state.runId) {
      throw new Error(`Cannot apply event for ${event.runId} to ${this.#state.runId}.`);
    }
    if (event.sequence <= this.#state.lastAppliedSequence) {
      return this.snapshot();
    }

    switch (event.type) {
      case "run.started": {
        requireStatus(this.#state, ["created"], event.type);
        const payload = readObject(event.payload, event.type);
        this.#state.goal = readString(payload.goal, "goal", event.type);
        this.#state.instructions = readString(payload.instructions, "instructions", event.type);
        this.#state.messages = [{ role: "user", content: this.#state.goal }];
        this.#state.budget.startedAt = event.occurredAt;
        this.#state.budget.limits = readBudget(payload.budget, event.type);
        this.#state.status = "waiting_model";
        break;
      }
      case "context.built":
        requireStatus(this.#state, ["waiting_model"], event.type);
        this.#state.turn = readNumber(readObject(event.payload, event.type).turn, "turn", event.type);
        break;
      case "model.started":
        requireStatus(this.#state, ["waiting_model"], event.type);
        this.#state.status = "running_model";
        this.#state.turn = readNumber(readObject(event.payload, event.type).turn, "turn", event.type);
        this.#state.budget.modelCalls += 1;
        break;
      case "model.completed": {
        requireStatus(this.#state, ["running_model"], event.type);
        const payload = readObject(event.payload, event.type);
        this.#state.turn = readNumber(payload.turn, "turn", event.type);
        const kind = readString(payload.kind, "kind", event.type);
        if (kind === "final") {
          this.#state.finalAnswer = readString(payload.answer, "answer", event.type);
          this.#state.pendingToolCalls = [];
          this.#state.status = "verifying";
        } else if (kind === "tool_calls") {
          this.#state.pendingToolCalls = readToolCalls(payload.calls, event.type);
          if (this.#state.pendingToolCalls.length === 0) {
            throw new Error("model.completed tool_calls must contain at least one call.");
          }
          this.#state.status = "waiting_tools";
        } else {
          throw new Error(`Unsupported model.completed kind: ${kind}.`);
        }
        break;
      }
      case "tool.requested": {
        requireStatus(this.#state, ["waiting_tools", "running_tool"], event.type);
        const payload = readObject(event.payload, event.type);
        const call = readToolCall(payload.call, event.type);
        if (!this.#state.pendingToolCalls.some((pending) => pending.id === call.id)) {
          throw new Error(`Tool ${call.id} was not pending.`);
        }
        this.#state.activeToolCallId = call.id;
        this.#state.activeToolOperationId = readOptionalString(payload.operationId, "operationId", event.type);
        this.#state.status = "running_tool";
        break;
      }
      case "tool.completed": {
        requireStatus(this.#state, ["running_tool"], event.type);
        const payload = readObject(event.payload, event.type);
        const callId = readString(payload.callId, "callId", event.type);
        const toolName = readString(payload.toolName, "toolName", event.type);
        const operationId = readOptionalString(payload.operationId, "operationId", event.type);
        const result = readToolResult(payload.result, event.type);
        const pending = this.#state.pendingToolCalls.find((call) => call.id === callId);
        if (pending === undefined || pending.name !== toolName || this.#state.activeToolCallId !== callId) {
          throw new Error(`Tool completion ${callId} does not match the active tool.`);
        }
        if (operationId !== undefined && this.#state.activeToolOperationId !== undefined && operationId !== this.#state.activeToolOperationId) {
          throw new Error(`Tool completion ${callId} does not match the active operation.`);
        }
        this.#state.messages.push({ role: "tool", callId, toolName, result });
        this.#state.pendingToolCalls = this.#state.pendingToolCalls.filter((call) => call.id !== callId);
        this.#state.activeToolCallId = undefined;
        this.#state.activeToolOperationId = undefined;
        this.#state.approvedToolCallIds = this.#state.approvedToolCallIds.filter((id) => id !== callId);
        this.#state.budget.toolCalls += 1;
        this.#state.status = this.#state.pendingToolCalls.length === 0 ? "waiting_model" : "waiting_tools";
        break;
      }
      case "verification.completed": {
        requireStatus(this.#state, ["verifying"], event.type);
        const payload = readObject(event.payload, event.type);
        this.#state.verification = readVerification(payload, event.type);
        break;
      }
      case "run.retrying": {
        requireStatus(this.#state, ["verifying"], event.type);
        const payload = readObject(event.payload, event.type);
        const reason = readString(payload.reason, "reason", event.type);
        if (this.#state.verification?.kind !== "retryable" && this.#state.verification?.kind !== "needs_replan") {
          throw new Error("A run can retry only after retryable verification or a replan request.");
        }
        this.#state.messages.push({ role: "user", content: `Verification feedback: ${reason}\nContinue the task using this evidence.` });
        this.#state.finalAnswer = undefined;
        this.#state.budget.verificationRetries += 1;
        this.#state.status = "waiting_model";
        break;
      }
      case "approval.requested":
        requireStatus(this.#state, ["verifying", "waiting_tools"], event.type);
        if (this.#state.status === "waiting_tools") {
          this.#state.pendingApprovalCallId = readToolCall(readObject(event.payload, event.type).call, event.type).id;
        }
        this.#state.status = "waiting_approval";
        break;
      case "approval.granted":
        requireStatus(this.#state, ["waiting_approval"], event.type);
        if (this.#state.pendingApprovalCallId !== undefined) {
          this.#state.approvedToolCallIds.push(this.#state.pendingApprovalCallId);
          this.#state.pendingApprovalCallId = undefined;
        }
        this.#state.messages.push({ role: "user", content: "Approval granted. Continue the task within the approved scope." });
        this.#state.status = this.#state.pendingToolCalls.length > 0 ? "waiting_tools" : "waiting_model";
        break;
      case "run.cancelled":
        requireNonTerminal(this.#state, event.type);
        this.#state.failureReason = readString(readObject(event.payload, event.type).reason, "reason", event.type);
        this.#state.status = "cancelled";
        break;
      case "run.completed":
        requireStatus(this.#state, ["verifying"], event.type);
        if (this.#state.verification?.kind !== "passed") {
          throw new Error("A run cannot complete without passing verification.");
        }
        this.#state.finalAnswer = readString(readObject(event.payload, event.type).answer, "answer", event.type);
        this.#state.status = "completed";
        break;
      case "run.failed":
        requireNonTerminal(this.#state, event.type);
        this.#state.failureReason = readString(readObject(event.payload, event.type).reason, "reason", event.type);
        this.#state.status = "failed";
        break;
    }

    this.#state.lastAppliedSequence = event.sequence;
    this.#state.updatedAt = event.occurredAt;
    return this.snapshot();
  }

  snapshot(): LoopRunState {
    return cloneState(this.#state);
  }

  /**
   * Save provider continuation immediately after a model response, before its next checkpoint.
   * 模型响应后、写入下一个 Checkpoint 前立刻保存 Provider Continuation。
   */
  setModelContinuation(continuation: ModelContinuation | undefined): void {
    this.#state.modelContinuation = continuation === undefined ? undefined : structuredClone(continuation);
  }
}

export function projectLoopRun(events: LoopEvent[], checkpoint?: LoopRunState): LoopRunState {
  const runId = checkpoint?.runId ?? events[0]?.runId;
  if (runId === undefined) {
    throw new Error("A run needs at least one event or a checkpoint.");
  }
  const projector = new LoopRunProjector(runId, checkpoint);
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    projector.apply(event);
  }
  return projector.snapshot();
}

function emptyState(runId: string): LoopRunState {
  return {
    runId,
    status: "created",
    turn: 0,
    messages: [],
    pendingToolCalls: [],
    approvedToolCallIds: [],
    budget: { modelCalls: 0, toolCalls: 0, verificationRetries: 0, startedAt: "", limits: {} },
    lastAppliedSequence: 0,
  };
}

function cloneState(state: LoopRunState): LoopRunState {
  const clone = structuredClone(state);
  // Older checkpoints may predate new bookkeeping fields. They remain
  // recoverable because events are the source of truth.
  // 旧 Checkpoint 可能早于新的记账字段；由于 Event 才是事实来源，它们仍然可以恢复。
  clone.approvedToolCallIds ??= [];
  clone.budget.verificationRetries ??= 0;
  clone.budget.limits ??= {};
  return clone;
}

function requireStatus(state: LoopRunState, allowed: LoopRunState["status"][], eventType: string): void {
  if (!allowed.includes(state.status)) {
    throw new Error(`${eventType} is invalid while the run is ${state.status}.`);
  }
}

function requireNonTerminal(state: LoopRunState, eventType: string): void {
  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
    throw new Error(`${eventType} is invalid after the run reached ${state.status}.`);
  }
}

function readObject(value: unknown, eventType: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${eventType} must have an object payload.`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string, eventType: string): string {
  if (typeof value !== "string") {
    throw new Error(`${eventType}.${field} must be a string.`);
  }
  return value;
}

function readNumber(value: unknown, field: string, eventType: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${eventType}.${field} must be a finite number.`);
  }
  return value;
}

function readBoolean(value: unknown, field: string, eventType: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${eventType}.${field} must be a boolean.`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string, eventType: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value, field, eventType);
}

function readVerification(payload: Record<string, unknown>, eventType: string): VerificationOutcome {
  const kind = readString(payload.kind, "kind", eventType);
  const summary = readString(payload.summary, "summary", eventType);
  if (kind === "passed" || kind === "retryable" || kind === "needs_replan" || kind === "needs_approval" || kind === "failed") {
    return { kind, summary };
  }
  throw new Error(`${eventType}.kind is unsupported: ${kind}.`);
}

function readBudget(value: unknown, eventType: string): LoopRunState["budget"]["limits"] {
  if (value === undefined) {
    return {};
  }
  const budget = readObject(value, eventType);
  return {
    ...(budget.maxModelCalls === undefined ? {} : { maxModelCalls: readNumber(budget.maxModelCalls, "budget.maxModelCalls", eventType) }),
    ...(budget.maxToolCalls === undefined ? {} : { maxToolCalls: readNumber(budget.maxToolCalls, "budget.maxToolCalls", eventType) }),
    ...(budget.maxVerificationRetries === undefined ? {} : { maxVerificationRetries: readNumber(budget.maxVerificationRetries, "budget.maxVerificationRetries", eventType) }),
    ...(budget.maxDurationMs === undefined ? {} : { maxDurationMs: readNumber(budget.maxDurationMs, "budget.maxDurationMs", eventType) }),
  };
}

function readToolCalls(value: unknown, eventType: string): ToolCall[] {
  if (!Array.isArray(value)) {
    throw new Error(`${eventType}.calls must be an array.`);
  }
  return value.map((call) => readToolCall(call, eventType));
}

function readToolCall(value: unknown, eventType: string): ToolCall {
  const object = readObject(value, eventType);
  const arguments_ = readObject(object.arguments, eventType);
  return { id: readString(object.id, "call.id", eventType), name: readString(object.name, "call.name", eventType), arguments: arguments_ };
}

function readToolResult(value: unknown, eventType: string): ToolResult {
  const object = readObject(value, eventType);
  return {
    ok: readBoolean(object.ok, "result.ok", eventType),
    content: readString(object.content, "result.content", eventType),
    ...(object.data === undefined ? {} : { data: object.data }),
  };
}
