/**
 * A provider client for the native worker, speaking the OpenAI-compatible
 * chat-completions protocol so it works with a local gateway, an OpenAI key, or
 * any endpoint that implements the same shape.
 *
 * It is only a client: the tool boundary (which tools exist, which call is
 * allowed) is decided by NativeAgentWorker before anything reaches this file.
 * The loop here merely relays tool results back to the model.
 *
 * 原生 Worker 的 Provider 客户端，使用 OpenAI 兼容的 chat-completions 协议，因此可对接本地
 * 网关、OpenAI 密钥，或任何实现同样形状的端点。
 *
 * 它只是客户端：工具边界（有哪些工具、哪次调用被允许）在本文件之前已由 NativeAgentWorker
 * 判定。这里的循环只负责把工具结果回传给模型。
 */
import type { ModelUsage } from "../core/contracts.ts";
import type { NativeModelClient, NativeToolCall, NativeToolSpec } from "./native-agent-worker.ts";

export interface OpenAiCompatibleClientOptions {
  /** Base URL without a trailing /v1, e.g. http://127.0.0.1:3425. 不带结尾 /v1 的基础地址。 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxRounds?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export class OpenAiCompatibleClient implements NativeModelClient {
  readonly #options: OpenAiCompatibleClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async run(input: Parameters<NativeModelClient["run"]>[0]): Promise<{ summary: string; usage?: ModelUsage }> {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(input.instructions, input.tools) },
      { role: "user", content: input.instructions },
    ];
    const tools = input.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: "object", properties: {}, additionalProperties: true },
      },
    }));
    const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, modelCalls: 0 };
    let sawUsage = false;
    const finish = (summary: string): { summary: string; usage: ModelUsage } => ({
      summary,
      usage: {
        modelCalls: totals.modelCalls,
        ...(sawUsage
          ? {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            totalTokens: totals.totalTokens,
            ...(totals.cachedInputTokens > 0 ? { cachedInputTokens: totals.cachedInputTokens } : {}),
          }
          : {}),
      },
    });
    const maxRounds = this.#options.maxRounds ?? 12;
    for (let round = 0; round < maxRounds; round += 1) {
      if (input.signal.aborted) throw new Error("Native worker was cancelled.");
      const reply = await this.#complete(messages, tools, input.signal);
      totals.modelCalls += 1;
      if (reply.usage !== undefined) {
        sawUsage = true;
        totals.inputTokens += reply.usage.inputTokens ?? 0;
        totals.outputTokens += reply.usage.outputTokens ?? 0;
        totals.totalTokens += reply.usage.totalTokens ?? 0;
        totals.cachedInputTokens += reply.usage.cachedInputTokens ?? 0;
      }
      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) return finish((reply.content ?? "").trim());
      input.onText?.(reply.content ?? "");
      messages.push({ role: "assistant", content: reply.content, tool_calls: calls });
      for (const call of calls) {
        const parsed = parseArguments(call.function.arguments);
        const outcome = await input.execute({ name: call.function.name, input: parsed } satisfies NativeToolCall);
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.output.slice(0, 8_000) });
      }
    }
    return finish("The worker reached its tool-call round limit without a final answer.");
  }

  async #complete(messages: ChatMessage[], tools: unknown[], signal: AbortSignal): Promise<{ content: string | null; tool_calls?: ChatMessage["tool_calls"]; usage?: ModelUsage }> {
    const response = await this.#fetch(`${this.#options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#options.apiKey === undefined ? {} : { authorization: `Bearer ${this.#options.apiKey}` }),
      },
      body: JSON.stringify({
        model: this.#options.model,
        messages,
        ...(tools.length === 0 ? {} : { tools }),
        stream: false,
      }),
      ...(this.#options.timeoutMs === undefined ? {} : { signal: AbortSignal.any([signal, AbortSignal.timeout(this.#options.timeoutMs)]) }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`The provider answered ${response.status}: ${detail.slice(0, 300)}`);
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ChatMessage["tool_calls"] } }>;
      usage?: unknown;
    };
    const message = body.choices?.[0]?.message;
    if (message === undefined) throw new Error("The provider returned no message.");
    const usage = parseUsage(body.usage);
    return {
      content: message.content ?? null,
      ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

/**
 * Reads the usage block in both the OpenAI shape (`prompt_tokens`) and the
 * Anthropic-style shape (`input_tokens`), including cache counters. Missing
 * numbers stay absent; a provider that reports nothing must not look free.
 * 同时读取 OpenAI 形状（`prompt_tokens`）与 Anthropic 风格（`input_tokens`）的 usage，
 * 包括缓存计数。缺失的数字保持缺省；不报告用量的 Provider 不能被看成免费。
 */
export function parseUsage(value: unknown): ModelUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const details = typeof record.prompt_tokens_details === "object" && record.prompt_tokens_details !== null
    ? record.prompt_tokens_details as Record<string, unknown>
    : {};
  const input = asCount(record.prompt_tokens) ?? asCount(record.input_tokens);
  const output = asCount(record.completion_tokens) ?? asCount(record.output_tokens);
  const total = asCount(record.total_tokens);
  const cached = asCount(details.cached_tokens) ?? asCount(record.cache_read_input_tokens) ?? asCount(record.prompt_cache_hit_tokens);
  const usage: ModelUsage = {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The boundary is restated in the system prompt as well as enforced in code:
 * the model is told not to attempt paths outside the workspace, so a refusal is
 * the exception rather than the normal path.
 * 边界既在代码中强制执行，也在 System Prompt 中重申：模型被告知不要尝试工作区之外的路径，
 * 使拒绝成为例外而非常态。
 */
export function systemPrompt(instructions: string, tools: readonly NativeToolSpec[]): string {
  return [
    "You are a worker inside Clone AI. The Kernel, not you, decides what is allowed.",
    "Call only the tools provided. Paths outside the workspace granted to this step will be refused and the refusal returned to you.",
    "If a required input file is missing, say so and stop; never invent its contents.",
    "When the acceptance criteria are met, answer with a short summary of what you did and stop calling tools.",
    "",
    `Available tools: ${tools.map((tool) => tool.name).join(", ") || "(none)"}.`,
  ].join("\n");
}

export function parseArguments(source: string): Record<string, unknown> {
  if (source.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(source) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
