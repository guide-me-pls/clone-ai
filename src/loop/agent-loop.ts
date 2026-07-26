import { randomUUID } from "node:crypto";

import type {
  LoopCheckpointStore,
  LoopEvent,
  LoopJournal,
  LoopMessage,
  LoopModel,
  ResponseVerifier,
} from "./contracts.ts";
import { LoopRunProjector } from "./run-state.ts";
import type { ToolRegistry } from "./tools.ts";

export class NonEmptyResponseVerifier implements ResponseVerifier {
  async verify(input: { goal: string; answer: string }): Promise<{ passed: boolean; summary: string }> {
    if (input.answer.trim().length === 0) {
      return { passed: false, summary: "The model returned an empty final answer." };
    }
    return { passed: true, summary: "The loop received a non-empty final answer." };
  }
}

export class AgentLoop {
  readonly #model: LoopModel;
  readonly #tools: ToolRegistry;
  readonly #journal: LoopJournal;
  readonly #verifier: ResponseVerifier;
  readonly #instructions: string;
  readonly #maxTurns?: number;
  readonly #checkpoints?: LoopCheckpointStore;

  constructor(input: {
    model: LoopModel;
    tools: ToolRegistry;
    journal: LoopJournal;
    verifier?: ResponseVerifier;
    instructions?: string;
    /** Optional emergency guard; durable budgets replace a fixed default later. */
    maxTurns?: number;
    checkpoints?: LoopCheckpointStore;
  }) {
    this.#model = input.model;
    this.#tools = input.tools;
    this.#journal = input.journal;
    this.#verifier = input.verifier ?? new NonEmptyResponseVerifier();
    this.#instructions = input.instructions ?? DEFAULT_INSTRUCTIONS;
    this.#maxTurns = input.maxTurns;
    this.#checkpoints = input.checkpoints;
  }

  async *run(goal: string, runId = randomUUID()): AsyncGenerator<LoopEvent> {
    const messages: LoopMessage[] = [{ role: "user", content: goal }];
    const projector = new LoopRunProjector(runId);
    const record = async (type: LoopEvent["type"], payload: unknown): Promise<LoopEvent> => {
      const event = await this.#journal.append({ runId, type, payload });
      const state = projector.apply(event);
      await this.#checkpoints?.save(state);
      return event;
    };

    yield await record("run.started", { goal, instructions: this.#instructions, maxTurns: this.#maxTurns });

    for (let turn = 1; this.#maxTurns === undefined || turn <= this.#maxTurns; turn += 1) {
      yield await record("context.built", { turn, messageCount: messages.length, toolCount: this.#tools.schemas().length });
      yield await record("model.started", { turn });

      let response;
      try {
        response = await this.#model.respond({
          instructions: this.#instructions,
          messages: [...messages],
          tools: this.#tools.schemas(),
        });
      } catch (error: unknown) {
        yield await record("run.failed", { turn, reason: formatError(error) });
        return;
      }

      if (response.kind === "final") {
        yield await record("model.completed", { turn, kind: "final", answer: response.text });
        const verification = await this.#verifier.verify({ goal, answer: response.text });
        yield await record("verification.completed", verification);
        if (verification.passed) {
          yield await record("run.completed", { turn, answer: response.text });
        } else {
          yield await record("run.failed", { turn, reason: verification.summary });
        }
        return;
      }

      yield await record("model.completed", {
        turn,
        kind: "tool_calls",
        calls: response.calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      });

      for (const call of response.calls) {
        yield await record("tool.requested", { turn, call });
        const result = await this.#tools.execute(call);
        messages.push({ role: "tool", callId: call.id, toolName: call.name, result });
        yield await record("tool.completed", { turn, callId: call.id, toolName: call.name, result });
      }
    }

    yield await record("run.failed", {
      reason: `The loop reached its configured ${this.#maxTurns}-turn emergency limit without a final answer.`,
    });
  }
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
