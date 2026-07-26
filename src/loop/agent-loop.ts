import { randomUUID } from "node:crypto";

import type {
  LoopEvent,
  LoopJournal,
  LoopMessage,
  LoopModel,
  ResponseVerifier,
} from "./contracts.ts";
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
  readonly #maxTurns: number;

  constructor(input: {
    model: LoopModel;
    tools: ToolRegistry;
    journal: LoopJournal;
    verifier?: ResponseVerifier;
    instructions?: string;
    maxTurns?: number;
  }) {
    this.#model = input.model;
    this.#tools = input.tools;
    this.#journal = input.journal;
    this.#verifier = input.verifier ?? new NonEmptyResponseVerifier();
    this.#instructions = input.instructions ?? DEFAULT_INSTRUCTIONS;
    this.#maxTurns = input.maxTurns ?? 8;
  }

  async *run(goal: string, runId = randomUUID()): AsyncGenerator<LoopEvent> {
    const messages: LoopMessage[] = [{ role: "user", content: goal }];
    yield await this.record(runId, "run.started", { goal, maxTurns: this.#maxTurns });

    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      yield await this.record(runId, "context.built", { turn, messageCount: messages.length, toolCount: this.#tools.schemas().length });
      yield await this.record(runId, "model.started", { turn });

      let response;
      try {
        response = await this.#model.respond({
          instructions: this.#instructions,
          messages: [...messages],
          tools: this.#tools.schemas(),
        });
      } catch (error: unknown) {
        yield await this.record(runId, "run.failed", { turn, reason: formatError(error) });
        return;
      }

      if (response.kind === "final") {
        yield await this.record(runId, "model.completed", { turn, kind: "final", answer: response.text });
        const verification = await this.#verifier.verify({ goal, answer: response.text });
        yield await this.record(runId, "verification.completed", verification);
        if (verification.passed) {
          yield await this.record(runId, "run.completed", { turn, answer: response.text });
        } else {
          yield await this.record(runId, "run.failed", { turn, reason: verification.summary });
        }
        return;
      }

      yield await this.record(runId, "model.completed", {
        turn,
        kind: "tool_calls",
        calls: response.calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      });

      for (const call of response.calls) {
        yield await this.record(runId, "tool.requested", { turn, call });
        const result = await this.#tools.execute(call);
        messages.push({ role: "tool", callId: call.id, toolName: call.name, result });
        yield await this.record(runId, "tool.completed", { turn, callId: call.id, toolName: call.name, result });
      }
    }

    yield await this.record(runId, "run.failed", {
      reason: `The loop reached its ${this.#maxTurns}-turn limit without a final answer.`,
    });
  }

  private record(runId: string, type: LoopEvent["type"], payload: unknown): Promise<LoopEvent> {
    return this.#journal.append({ runId, type, payload });
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
