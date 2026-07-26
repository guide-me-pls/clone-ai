import type { JsonObject, LoopMessage, LoopModel, ModelTurn, ToolSchema } from "./contracts.ts";

interface OpenAIResponsesModelOptions {
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
}

/**
 * A dependency-free Responses API adapter. The full transcript remains in this
 * process and each request uses `store: false`; no response ID is retained.
 */
export class OpenAIResponsesModel implements LoopModel {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;
  #history: unknown[] = [];
  #syncedMessageCount = 0;

  constructor(options: OpenAIResponsesModelOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("OPENAI_API_KEY is required to run the real LLM loop.");
    }
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetcher ?? fetch;
  }

  async respond(input: { instructions: string; messages: LoopMessage[]; tools: ToolSchema[] }): Promise<ModelTurn> {
    this.syncMessages(input.messages);

    const response = await this.#fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        instructions: input.instructions,
        input: this.#history,
        tools: input.tools,
        store: false,
      }),
    });

    const body = (await response.json()) as OpenAIResponse | OpenAIErrorResponse;
    if (!response.ok) {
      throw new Error(`OpenAI Responses API error (${response.status}): ${readApiError(body)}`);
    }

    const completed = body as OpenAIResponse;
    this.#history.push(...completed.output);
    const calls = completed.output
      .filter(isFunctionCall)
      .map((call) => ({ id: call.call_id, name: call.name, arguments: parseArguments(call.arguments) }));
    if (calls.length > 0) {
      return { kind: "tool_calls", calls };
    }

    const text = completed.output_text ?? readMessageText(completed.output);
    if (text.trim().length === 0) {
      throw new Error("The Responses API returned neither a function call nor final text.");
    }
    return { kind: "final", text };
  }

  private syncMessages(messages: LoopMessage[]): void {
    if (messages.length < this.#syncedMessageCount) {
      this.#history = [];
      this.#syncedMessageCount = 0;
    }

    for (const message of messages.slice(this.#syncedMessageCount)) {
      if (message.role === "user") {
        this.#history.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
      } else {
        this.#history.push({
          type: "function_call_output",
          call_id: message.callId,
          output: JSON.stringify(message.result),
        });
      }
    }
    this.#syncedMessageCount = messages.length;
  }
}

interface OpenAIResponse {
  output: unknown[];
  output_text?: string;
}

interface OpenAIErrorResponse {
  error?: { message?: string };
}

interface FunctionCallOutput {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

function isFunctionCall(value: unknown): value is FunctionCallOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "function_call" &&
    "call_id" in value &&
    typeof value.call_id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "arguments" in value &&
    typeof value.arguments === "string"
  );
}

function parseArguments(source: string): JsonObject {
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("must decode to an object");
    }
    return value as JsonObject;
  } catch (error: unknown) {
    throw new Error(`The model returned invalid function arguments: ${formatError(error)}`);
  }
}

function readMessageText(output: unknown[]): string {
  const text: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null || !("content" in item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (typeof content === "object" && content !== null && "text" in content && typeof content.text === "string") {
        text.push(content.text);
      }
    }
  }
  return text.join("\n");
}

function readApiError(body: OpenAIResponse | OpenAIErrorResponse): string {
  if ("error" in body && typeof body.error?.message === "string") {
    return body.error.message;
  }
  return "Unknown API error";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
