import { randomUUID } from "node:crypto";

import type {
  ContinuationCapableModel,
  LoopCheckpointStore,
  LoopEvent,
  LoopJournal,
  LoopModel,
  LoopModelFactory,
  LoopRunState,
  RunBudget,
  ResponseVerifier,
} from "./contracts.ts";
import { restoreLoopRun } from "./recovery.ts";
import { LoopRunProjector } from "./run-state.ts";
import type { ToolRegistry } from "./tools.ts";
import { ToolRuntime } from "./tool-runtime.ts";

export class NonEmptyResponseVerifier implements ResponseVerifier {
  async verify(input: { goal: string; answer: string }): Promise<import("./contracts.ts").VerificationOutcome> {
    if (input.answer.trim().length === 0) {
      return { kind: "failed", summary: "The model returned an empty final answer." };
    }
    return { kind: "passed", summary: "The loop received a non-empty final answer." };
  }
}

export class AgentLoop {
  readonly #model: LoopModel;
  readonly #tools: ToolRegistry;
  readonly #journal: LoopJournal;
  readonly #verifier: ResponseVerifier;
  readonly #instructions: string;
  readonly #checkpoints?: LoopCheckpointStore;
  readonly #modelFactory?: LoopModelFactory;
  readonly #toolRuntime: ToolRuntime;
  readonly #budget: RunBudget;

  constructor(input: {
    model: LoopModel;
    tools: ToolRegistry;
    journal: LoopJournal;
    verifier?: ResponseVerifier;
    instructions?: string;
    /**
     * Optional emergency guard; durable budgets replace a fixed default later.
     * 可选的紧急保护；以后由持久化 Budget 取代固定默认值。
     */
    maxTurns?: number;
    budget?: RunBudget;
    checkpoints?: LoopCheckpointStore;
    /**
     * Creates a fresh provider adapter from a persisted continuation after restart.
     * 重启后根据持久化的 Continuation 创建新的 Provider Adapter。
     */
    modelFactory?: LoopModelFactory;
    toolRuntime?: ToolRuntime;
  }) {
    this.#model = input.model;
    this.#tools = input.tools;
    this.#journal = input.journal;
    this.#verifier = input.verifier ?? new NonEmptyResponseVerifier();
    this.#instructions = input.instructions ?? DEFAULT_INSTRUCTIONS;
    this.#budget = {
      ...input.budget,
      ...(input.maxTurns === undefined ? {} : { maxModelCalls: input.maxTurns }),
    };
    this.#checkpoints = input.checkpoints;
    this.#modelFactory = input.modelFactory;
    this.#toolRuntime = input.toolRuntime ?? new ToolRuntime(input.tools);
  }

  async *run(goal: string, runId = randomUUID()): AsyncGenerator<LoopEvent> {
    const projector = new LoopRunProjector(runId);
    const record = this.createRecorder(runId, projector);
    yield await record("run.started", { goal, instructions: this.#instructions, budget: this.#budget });
    yield* this.drive(projector, record, this.#model);
  }

  /**
   * Continue a crashed run from its latest checkpoint. Read-only tools can be
   * re-executed safely; a model turn needs the provider continuation captured
   * after its previous response.
   *
   * 从最新 Checkpoint 恢复崩溃的 Run。只读 Tool 可安全重执行；Model Turn 则需要其上次响应后保存的
   * Provider Continuation。
   */
  async *resume(runId: string): AsyncGenerator<LoopEvent> {
    if (this.#checkpoints === undefined) {
      throw new Error("A checkpoint store is required to resume a run.");
    }
    const recovered = await restoreLoopRun({ runId, journal: this.#journal, checkpoints: this.#checkpoints });
    const projector = new LoopRunProjector(runId, recovered);
    const record = this.createRecorder(runId, projector);
    const state = projector.snapshot();

    if (state.turn > 0 && this.#modelFactory === undefined) {
      yield await record("run.failed", { reason: "A model factory is required to resume a prior provider session." });
      return;
    }
    if (state.status === "waiting_model" && state.turn > 0 && state.modelContinuation === undefined) {
      yield await record("run.failed", { reason: "Cannot resume a model turn because its provider continuation was not checkpointed." });
      return;
    }

    const model = this.#modelFactory?.(state.modelContinuation) ?? this.#model;
    yield* this.drive(projector, record, model);
  }

  async grantApproval(runId: string): Promise<LoopEvent> {
    const { projector, record } = await this.recoverRecorder(runId);
    if (projector.snapshot().status !== "waiting_approval") {
      throw new Error(`Run ${runId} is not waiting for approval.`);
    }
    return record("approval.granted", { reason: "Approved by the local owner." });
  }

  async cancel(runId: string, reason = "Cancelled by the local owner."): Promise<LoopEvent> {
    const { projector, record } = await this.recoverRecorder(runId);
    const state = projector.snapshot();
    if (state.activeToolOperationId !== undefined) {
      await this.#toolRuntime.cancel(state.activeToolOperationId);
    }
    return record("run.cancelled", { reason });
  }

  private async *drive(
    projector: LoopRunProjector,
    record: (type: LoopEvent["type"], payload: unknown) => Promise<LoopEvent>,
    model: LoopModel,
  ): AsyncGenerator<LoopEvent> {
    for (;;) {
      const state = projector.snapshot();
      if (state.status === "waiting_tools") {
        for (const call of state.pendingToolCalls) {
          const budgetReason = exceededBudget(state, "tool");
          if (budgetReason !== undefined) {
            yield await record("run.failed", { reason: budgetReason });
            return;
          }
          const operationId = this.#toolRuntime.createOperationId();
          const execution = { runId: state.runId, call, operationId };
          const authorization = state.approvedToolCallIds.includes(call.id)
            ? { outcome: "allowed" as const }
            : this.#toolRuntime.authorize(execution);
          if (authorization.outcome === "approval_required") {
            yield await record("approval.requested", { reason: authorization.reason, call });
            return;
          }
          if (authorization.outcome === "denied") {
            yield await record("run.failed", { reason: authorization.reason });
            return;
          }
          yield await record("tool.requested", { turn: state.turn, call, operationId });
          const outcome = await this.#toolRuntime.execute(execution);
          yield await record("tool.completed", {
            turn: state.turn,
            callId: call.id,
            toolName: call.name,
            operationId,
            result: outcome.result,
            receipt: outcome.receipt,
          });
        }
        continue;
      }

      if (state.status === "running_tool") {
        const call = state.pendingToolCalls.find((pending) => pending.id === state.activeToolCallId);
        const operationId = state.activeToolOperationId;
        if (call === undefined || operationId === undefined) {
          yield await record("run.failed", { reason: "Interrupted tool execution is missing its call or operation ID." });
          return;
        }
        const execution = { runId: state.runId, call, operationId };
        const reconciliation = await this.#toolRuntime.reconcile(execution);
        if (reconciliation.status === "completed") {
          yield await record("tool.completed", {
            turn: state.turn,
            callId: call.id,
            toolName: call.name,
            operationId,
            result: reconciliation.result,
            receipt: reconciliation.receipt,
          });
          continue;
        }
        if (reconciliation.status === "not_started") {
          const outcome = await this.#toolRuntime.execute(execution);
          yield await record("tool.completed", {
            turn: state.turn,
            callId: call.id,
            toolName: call.name,
            operationId,
            result: outcome.result,
            receipt: outcome.receipt,
          });
          continue;
        }
        yield await record("run.failed", { reason: `Tool recovery needs human reconciliation: ${reconciliation.reason}` });
        return;
      }

      if (state.status === "waiting_model") {
        const budgetReason = exceededBudget(state, "model");
        if (budgetReason !== undefined) {
          yield await record("run.failed", { reason: budgetReason });
          return;
        }
        const turn = state.turn + 1;
        yield await record("context.built", { turn, messageCount: state.messages.length, toolCount: this.#tools.schemas().length });
        yield await record("model.started", { turn });

        let response;
        try {
          response = await model.respond({
            instructions: state.instructions ?? this.#instructions,
            messages: state.messages,
            tools: this.#tools.schemas(),
          });
        } catch (error: unknown) {
          yield await record("run.failed", { turn, reason: formatError(error) });
          return;
        }

        projector.setModelContinuation(snapshotContinuation(model));
        if (response.kind === "final") {
          yield await record("model.completed", { turn, kind: "final", answer: response.text });
        } else {
          yield await record("model.completed", { turn, kind: "tool_calls", calls: response.calls });
        }
        continue;
      }

      if (state.status === "verifying") {
        const verification = await this.#verifier.verify({
          goal: state.goal ?? "",
          answer: state.finalAnswer ?? "",
        });
        yield await record("verification.completed", verification);
        if (verification.kind === "passed") {
          yield await record("run.completed", { turn: state.turn, answer: state.finalAnswer });
          return;
        }
        if (verification.kind === "retryable" || verification.kind === "needs_replan") {
          const budgetReason = exceededBudget(projector.snapshot(), "verification");
          if (budgetReason !== undefined) {
            yield await record("run.failed", { reason: budgetReason });
            return;
          }
          yield await record("run.retrying", { reason: verification.summary, replan: verification.kind === "needs_replan" });
          continue;
        }
        if (verification.kind === "needs_approval") {
          yield await record("approval.requested", { reason: verification.summary });
          return;
        }
        yield await record("run.failed", { reason: verification.summary });
        return;
      }

      if (state.status === "waiting_approval" || state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
        return;
      }

      // A process died between recording intent and recording its result. Tool
      // reconciliation for side effects is added in the Tool Runtime milestone.
      // 进程在记录意图与记录结果之间崩溃；有副作用 Tool 的对账会在 Tool Runtime 阶段加入。
      yield await record("run.failed", { reason: `Cannot automatically resume from ${state.status}.` });
      return;
    }
  }

  private createRecorder(runId: string, projector: LoopRunProjector) {
    return async (type: LoopEvent["type"], payload: unknown): Promise<LoopEvent> => {
      const event = await this.#journal.append({ runId, type, payload });
      const state = projector.apply(event);
      await this.#checkpoints?.save(state);
      return event;
    };
  }

  private async recoverRecorder(runId: string) {
    if (this.#checkpoints === undefined) {
      throw new Error("A checkpoint store is required to recover a run.");
    }
    const recovered = await restoreLoopRun({ runId, journal: this.#journal, checkpoints: this.#checkpoints });
    const projector = new LoopRunProjector(runId, recovered);
    return { projector, record: this.createRecorder(runId, projector) };
  }
}

function exceededBudget(state: LoopRunState, kind: "model" | "tool" | "verification"): string | undefined {
  const { limits } = state.budget;
  if (limits.maxDurationMs !== undefined && Date.now() - Date.parse(state.budget.startedAt) >= limits.maxDurationMs) {
    return `Run exceeded its ${limits.maxDurationMs}ms duration budget.`;
  }
  if (kind === "model" && limits.maxModelCalls !== undefined && state.budget.modelCalls >= limits.maxModelCalls) {
    return `Run reached its ${limits.maxModelCalls} model-call budget.`;
  }
  if (kind === "tool" && limits.maxToolCalls !== undefined && state.budget.toolCalls >= limits.maxToolCalls) {
    return `Run reached its ${limits.maxToolCalls} tool-call budget.`;
  }
  if (kind === "verification" && limits.maxVerificationRetries !== undefined && state.budget.verificationRetries >= limits.maxVerificationRetries) {
    return `Run reached its ${limits.maxVerificationRetries} verification-retry budget.`;
  }
  return undefined;
}

function snapshotContinuation(model: LoopModel): import("./contracts.ts").ModelContinuation | undefined {
  return "snapshotContinuation" in model && typeof model.snapshotContinuation === "function"
    ? (model as ContinuationCapableModel).snapshotContinuation()
    : undefined;
}

const DEFAULT_INSTRUCTIONS = [
  "You are the first local Clone AI learning-loop agent.",
  "Use the supplied tools when local workspace facts are needed.",
  "Never claim that a mocked write changed a file.",
  "Once you have enough evidence, return a concise final answer to the user.",
].join(" ");

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
