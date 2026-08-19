import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ExecutionAssignment } from "../core/contracts.ts";
import {
  SupervisedWorkerAdapter,
  isRecord,
  type NormalizedWorkerEvent,
  type ProviderTranslator,
  type WorkerTransport,
} from "./supervised-worker.ts";

export interface ClaudeAgentSdkAdapterOptions {
  id: string;
  model?: string;
  workCapabilities: string[];
  /** Injected for tests; defaults to the real SDK query. 供测试注入；默认使用真实 SDK query。 */
  queryFn?: typeof query;
}

/**
 * Claude Code behind its official SDK instead of parsed stdout. This class is
 * now only the SDK message translator; budgets, deadlines, completion
 * authority, and evidence policy live once in SupervisedWorkerAdapter.
 *
 * Claude Code 走官方 SDK 而不是解析 stdout。本类现在只是 SDK 消息翻译器；预算、截止、
 * 完成判定权与证据策略都只在 SupervisedWorkerAdapter 存在一份。
 */
export class ClaudeAgentSdkAdapter extends SupervisedWorkerAdapter {
  constructor(options: ClaudeAgentSdkAdapterOptions) {
    super({
      id: options.id,
      providerId: "claude-agent-sdk",
      translator: new ClaudeSdkTranslator(options),
      workCapabilities: options.workCapabilities,
      // Same rule as every worker-backed boundary: a receipt attests that an
      // external action really happened and can never be self-reported.
      // 与所有 Worker 型边界同一规则：Receipt 证明外部动作确实发生，永不允许自报。
      evidenceKinds: ["artifact", "observation"],
      defaultBudget: { maxDurationMs: 20 * 60_000 },
    });
  }
}

class ClaudeSdkTranslator implements ProviderTranslator {
  readonly evidencePolicy = "worker-claim" as const;
  readonly #options: ClaudeAgentSdkAdapterOptions;

  constructor(options: ClaudeAgentSdkAdapterOptions) {
    this.#options = options;
  }

  async start(input: {
    assignment: ExecutionAssignment;
    sessionId: string | undefined;
    resuming: boolean;
    prompt: string;
  }): Promise<WorkerTransport> {
    const abort = new AbortController();
    const budget = input.assignment.workOrder?.budget;
    const options: Options = {
      cwd: input.assignment.workspacePath ?? process.cwd(),
      abortController: abort,
      includePartialMessages: true,
      // Write access follows the step's declared risk, not the worker's wish.
      // 写权限跟随步骤声明的风险，而不是 Worker 的意愿。
      permissionMode: input.assignment.step.risk === "reversible_write" ? "acceptEdits" : "plan",
      ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
      ...(budget?.maxModelCalls === undefined ? {} : { maxTurns: budget.maxModelCalls }),
      ...(input.resuming && input.sessionId !== undefined ? { resume: input.sessionId } : {}),
    };
    const queryFn = this.#options.queryFn ?? query;
    const stream = queryFn({ prompt: input.prompt, options }) as AsyncIterable<SDKMessage>;
    return {
      events: translateSdkMessages(stream),
      abort: () => abort.abort(),
      terminate: async () => abort.abort(),
    };
  }
}

async function* translateSdkMessages(stream: AsyncIterable<SDKMessage>): AsyncGenerator<NormalizedWorkerEvent> {
  for await (const message of stream) {
    const record = message as unknown as Record<string, unknown>;
    if (typeof record.session_id === "string") {
      yield { kind: "session", id: record.session_id };
    }

    if (message.type === "stream_event") {
      const event = record.event;
      if (isRecord(event) && event.type === "content_block_delta") {
        const delta = event.delta;
        if (isRecord(delta) && typeof delta.text === "string") {
          yield { kind: "text", delta: delta.text };
        }
      }
      continue;
    }

    if (message.type === "assistant") {
      yield { kind: "turn" };
      for (const block of contentBlocks(record)) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          const id = typeof block.id === "string" ? block.id : block.name;
          yield { kind: "tool_start", id, name: block.name, input: block.input };
        }
      }
      continue;
    }

    if (message.type === "user") {
      for (const block of contentBlocks(record)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          yield { kind: "tool_end", id: block.tool_use_id, isError: block.is_error === true };
        }
      }
      continue;
    }

    if (message.type === "result") {
      // The typed result is the provider's explicit settled signal.
      // 有类型的 result 就是 Provider 显式的 settled 信号。
      yield {
        kind: "settled",
        ok: record.is_error !== true && record.subtype === "success",
        text: typeof record.result === "string" ? record.result : "",
      };
      return;
    }
  }
}

function contentBlocks(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const inner = record.message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return [];
  return inner.content.filter(isRecord);
}
