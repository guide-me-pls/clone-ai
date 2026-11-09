/**
 * A provider client for the native worker, speaking the OpenAI-compatible
 * chat-completions protocol so it works with a local gateway, an OpenAI key, or
 * any endpoint that implements the same shape.
 *
 * It is a single model call, not a loop: the shared agent kernel owns the
 * rounds, budgets, abort, and tool scheduling. The tool boundary (which tools
 * exist, which call is allowed) is decided by NativeAgentWorker before a call
 * reaches this file.
 *
 * 原生 Worker 的 Provider 客户端，使用 OpenAI 兼容的 chat-completions 协议，因此可对接本地
 * 网关、OpenAI 密钥，或任何实现同样形状的端点。
 *
 * 它只做一次模型调用，不拥有循环：回合、预算、abort 与工具调度都由共享 Agent 内核负责。
 * 工具边界（有哪些工具、哪次调用被允许）在本文件之前已由 NativeAgentWorker 判定。
 */
import type {
  AgentContentPart,
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
} from "../agent/loop.ts";
import type { ModelUsage } from "../core/contracts.ts";

export interface OpenAiCompatibleClientOptions {
  /** Base URL without a trailing /v1, e.g. http://127.0.0.1:3425. 不带结尾 /v1 的基础地址。 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** One completion's output cap; the shared loop owns the rounds. 单次补全的输出上限；回合由共享内核拥有。 */
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AgentContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export class OpenAiCompatibleClient implements AgentModel {
  readonly #options: OpenAiCompatibleClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async complete(input: AgentModelRequest): Promise<AgentModelResponse> {
    if (input.signal.aborted) throw new Error("Native worker was cancelled.");
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 120_000);
    const signal = AbortSignal.any([input.signal, timeout]);
    const response = await this.#fetch(`${this.#options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#options.apiKey === undefined ? {} : { authorization: `Bearer ${this.#options.apiKey}` }),
      },
      body: JSON.stringify({
        model: this.#options.model,
        messages: toChatMessages(input.messages),
        ...(input.tools.length === 0
          ? {}
          : {
            tools: input.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters ?? { type: "object", properties: {}, additionalProperties: true },
              },
            })),
          }),
        ...(this.#options.maxTokens === undefined ? {} : { max_tokens: this.#options.maxTokens }),
        stream: false,
      }),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(
        new Error(`The provider answered ${response.status}: ${detail.slice(0, 300)}`),
        { status: response.status },
      );
    }
    const body = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: unknown;
    };
    const message = body.choices?.[0]?.message;
    if (message === undefined) throw new Error("The provider returned no message.");
    const content = message.content ?? null;
    if (typeof content === "string" && content.length > 0) input.onDelta?.(content);
    const toolCalls = (message.tool_calls ?? []).map((call, index) => ({
      id: typeof call.id === "string" && call.id.length > 0 ? call.id : `call-${index + 1}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }));
    const usage = parseUsage(body.usage);
    return {
      content,
      toolCalls,
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

/** Convert provider-neutral messages into the OpenAI chat shape. 把 Provider 无关的消息转成 OpenAI chat 形状。 */
function toChatMessages(messages: readonly AgentMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: typeof message.content === "string" ? message.content : "",
      };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: typeof message.content === "string" ? message.content : null,
        ...(message.toolCalls === undefined
          ? {}
          : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }),
      };
    }
    if (message.role === "user") {
      return {
        role: "user",
        content: Array.isArray(message.content)
          ? message.content.map((part) => part.type === "text"
            ? { type: "text" as const, text: part.text }
            : { type: "image_url" as const, image_url: part.image_url })
          : message.content ?? "",
      };
    }
    return { role: "system", content: typeof message.content === "string" ? message.content : "" };
  });
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

/** Re-exported for callers that build the worker prompt directly. 重新导出，供直接构建 Worker Prompt 的调用方使用。 */
export { systemPrompt } from "./native-worker-prompt.ts";

/** Parse the model's tool arguments; prose or a non-object becomes {}. 解析模型的工具参数；散文或非对象变为 {}。 */
export function parseArguments(source: string): Record<string, unknown> {
  if (source.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(source) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
