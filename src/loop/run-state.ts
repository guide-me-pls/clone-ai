import type { LoopEvent, LoopRunState, ToolCall, ToolResult } from "./contracts.ts";

/**
 * Converts append-only events into the next recoverable state. Events remain
 * the source of truth; this projector creates the state a runner needs after
 * restart: call the model, finish a pending tool, verify, or stop.
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
        this.#state.status = "running_tool";
        break;
      }
      case "tool.completed": {
        requireStatus(this.#state, ["running_tool"], event.type);
        const payload = readObject(event.payload, event.type);
        const callId = readString(payload.callId, "callId", event.type);
        const toolName = readString(payload.toolName, "toolName", event.type);
        const result = readToolResult(payload.result, event.type);
        const pending = this.#state.pendingToolCalls.find((call) => call.id === callId);
        if (pending === undefined || pending.name !== toolName || this.#state.activeToolCallId !== callId) {
          throw new Error(`Tool completion ${callId} does not match the active tool.`);
        }
        this.#state.messages.push({ role: "tool", callId, toolName, result });
        this.#state.pendingToolCalls = this.#state.pendingToolCalls.filter((call) => call.id !== callId);
        this.#state.activeToolCallId = undefined;
        this.#state.budget.toolCalls += 1;
        this.#state.status = this.#state.pendingToolCalls.length === 0 ? "waiting_model" : "waiting_tools";
        break;
      }
      case "verification.completed": {
        requireStatus(this.#state, ["verifying"], event.type);
        const payload = readObject(event.payload, event.type);
        this.#state.verification = {
          passed: readBoolean(payload.passed, "passed", event.type),
          summary: readString(payload.summary, "summary", event.type),
        };
        break;
      }
      case "run.completed":
        requireStatus(this.#state, ["verifying"], event.type);
        if (this.#state.verification?.passed !== true) {
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
    budget: { modelCalls: 0, toolCalls: 0 },
    lastAppliedSequence: 0,
  };
}

function cloneState(state: LoopRunState): LoopRunState {
  return structuredClone(state);
}

function requireStatus(state: LoopRunState, allowed: LoopRunState["status"][], eventType: string): void {
  if (!allowed.includes(state.status)) {
    throw new Error(`${eventType} is invalid while the run is ${state.status}.`);
  }
}

function requireNonTerminal(state: LoopRunState, eventType: string): void {
  if (state.status === "completed" || state.status === "failed") {
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
