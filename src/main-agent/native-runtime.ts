/**
 * A native Main Agent loop: the same prompt, tools and audit as the Pi path,
 * without the Pi SDK.
 *
 * It is opt-in (`CLONE_AI_MAIN_RUNTIME=native`) and deliberately small: a
 * non-streaming OpenAI-compatible chat loop, the turn ledger as its transcript,
 * no compaction, and the Kernel tools captured from the Pi extension so the two
 * runtimes cannot drift. Pi remains the default and the fallback.
 *
 * 原生主 Agent 循环：与 Pi 路径相同的 Prompt、工具与审计，但不依赖 Pi SDK。
 *
 * 它是显式开启的（`CLONE_AI_MAIN_RUNTIME=native`），刻意保持很小：非流式的 OpenAI 兼容
 * chat 循环、以回合台账作为对话记录、不做压缩、工具从 Pi 扩展中捕获，使两个运行时不会
 * 各自漂移。Pi 仍是默认与回退。
 */
import { randomUUID } from "node:crypto";

import type { ModelUsage, Run } from "../core/contracts.ts";
import { createKernelRuntimeSession, kernelToolDefinitions, type PlainKernelTool } from "./tools/kernel-tools.ts";
import { compileMainAgentPrompt } from "./prompt.ts";
import { recordPromptSnapshot } from "./prompt-snapshot.ts";
import {
  beginMainAgentTurn,
  finishMainAgentTurn,
  readMainAgentTurnRecords,
  recordNativeToolCompleted,
  recordNativeToolStarted,
  type MainAgentTurnSource,
} from "./turn-audit.ts";
import { recordUsage, type UsageRecord } from "../observability/usage.ts";
import { parseUsage } from "../workers/openai-compatible-client.ts";
import { redactMemoryPii } from "../memory/memory-hygiene.ts";
import { tokenize } from "../memory/md-memory-store.ts";
import { isEffortLevel } from "../workers/effort.ts";
import { CloneConfigStore } from "../config/clone-config.ts";
import { resolveClonePaths } from "../config/clone-home.ts";

export interface NativeMainAgentEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface NativeMainAgentOptions {
  dataDirectory: string;
  text: string;
  source: MainAgentTurnSource;
  turnId?: string;
  onDelta?: (delta: string) => void;
  onMetadata?: (metadata: { modelId: string; provider: string; effort?: string }) => void;
  endpoint?: NativeMainAgentEndpoint;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  maxRounds?: number;
  historyTurns?: number;
  /** Character budget for the verbatim transcript before deterministic compaction. 逐字对话记录在确定性压缩前的字符预算。 */
  historyChars?: number;
  cwd?: string;
}

export interface NativeMainAgentResult {
  reply: string;
  error?: string;
  newRuns: Array<Pick<Run, "id" | "status" | "planId">>;
}

type NativeMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

interface NativeReply {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: ModelUsage;
}

/** The explicit switch; anything else keeps Pi. 显式开关；其他值保持 Pi。 */
export function isNativeMainAgentSelected(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CLONE_AI_MAIN_RUNTIME?.trim().toLowerCase() === "native";
}

/**
 * The native Main Agent's endpoint. It deliberately shares the native worker's
 * variables: one OpenAI-compatible endpoint serves both.
 * 原生主 Agent 的端点。刻意复用原生 Worker 的变量：同一个 OpenAI 兼容端点服务两者。
 */
export function readNativeMainAgentEndpoint(environment: NodeJS.ProcessEnv = process.env): {
  endpoint?: NativeMainAgentEndpoint;
  missing: string[];
} {
  const baseUrl = environment.CLONE_AI_NATIVE_BASE_URL?.trim();
  const model = environment.CLONE_AI_NATIVE_MODEL?.trim();
  const missing: string[] = [];
  if (baseUrl === undefined || baseUrl.length === 0) missing.push("CLONE_AI_NATIVE_BASE_URL");
  if (model === undefined || model.length === 0) missing.push("CLONE_AI_NATIVE_MODEL");
  if (missing.length > 0) return { missing };
  const timeout = Number(environment.CLONE_AI_NATIVE_TIMEOUT_MS ?? 120_000);
  return {
    missing,
    endpoint: {
      baseUrl: baseUrl!.replace(/\/$/, ""),
      model: model!,
      ...(environment.CLONE_AI_NATIVE_API_KEY?.trim() ? { apiKey: environment.CLONE_AI_NATIVE_API_KEY.trim() } : {}),
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    },
  };
}

/**
 * One turn through the native loop. Failures are recorded on the turn and
 * returned; a configuration error throws before any model call.
 * 通过原生循环完成一个回合。失败会记入回合并返回；配置错误在任何模型调用之前抛出。
 */
export async function runNativeMainAgentTurn(options: NativeMainAgentOptions): Promise<NativeMainAgentResult> {
  const environment = options.environment ?? process.env;
  const resolved = options.endpoint === undefined
    ? readNativeMainAgentEndpoint(environment)
    : { endpoint: options.endpoint, missing: [] as string[] };
  if (resolved.endpoint === undefined) {
    throw new Error(`The native Main Agent needs ${resolved.missing.join(" and ")}.`);
  }
  const endpoint = resolved.endpoint;
  const effort = await readMainAgentEffort(options.dataDirectory, environment);
  const compiled = await compileMainAgentPrompt({
    dataDirectory: options.dataDirectory,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    query: options.text,
  });
  const tools = nativeTools(options.dataDirectory);
  const turnId = options.turnId ?? randomUUID();
  const snapshot = await recordPromptSnapshot(options.dataDirectory, {
    charter: compiled.charter,
    charterVersion: compiled.charterVersion,
    ...(compiled.briefing === undefined ? {} : { briefing: compiled.briefing }),
    ...(compiled.briefingError === undefined ? {} : { briefingError: compiled.briefingError }),
    systemPrompt: compiled.systemPrompt,
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
    })),
    modelId: endpoint.model,
    provider: "native",
    ...(effort === undefined ? {} : { effort }),
  }, { turnId });
  const turn = await beginMainAgentTurn({
    dataDirectory: options.dataDirectory,
    text: options.text,
    source: options.source,
    turnId,
    modelId: endpoint.model,
    provider: "native",
    ...(effort === undefined ? {} : { effort }),
    ...(snapshot === undefined ? {} : { promptMaterialHash: snapshot.materialHash }),
  });
  options.onMetadata?.({
    modelId: endpoint.model,
    provider: "native",
    ...(effort === undefined ? {} : { effort }),
  });

  const before = new Set((await currentRuns(options.dataDirectory)).map((run) => run.id));
  const history = await buildHistory(options.dataDirectory, turnId, {
    turns: options.historyTurns ?? 24,
    chars: options.historyChars ?? 12_000,
  });
  const messages: NativeMessage[] = [
    { role: "system", content: compiled.systemPrompt },
    ...history,
    { role: "user", content: options.text.length === 0 ? "(empty message)" : options.text },
  ];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 };
  let sawUsage = false;
  let reply = "";
  let error: string | undefined;
  const startedAt = Date.now();
  const maxRounds = Math.max(1, options.maxRounds ?? 8);
  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const response = await chat(endpoint, messages, tools, options.fetchImpl ?? fetch, options.onDelta);
      usage.modelCalls += 1;
      if (response.usage !== undefined) {
        sawUsage = true;
        usage.inputTokens += response.usage.inputTokens ?? 0;
        usage.outputTokens += response.usage.outputTokens ?? 0;
        usage.totalTokens += response.usage.totalTokens ?? 0;
      }
      if (response.content !== null && response.content.length > 0) {
        reply += response.content;
      }
      if (response.toolCalls.length === 0) break;
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of response.toolCalls) {
        const toolCallId = call.id.length > 0 ? call.id : randomUUID();
        const tool = tools.find((item) => item.name === call.name);
        const inputSummary = summarizeArguments(call.arguments);
        await recordNativeToolStarted(turn, { toolCallId, tool: call.name, ...(inputSummary.length === 0 ? {} : { inputSummary }) });
        const toolStartedAt = Date.now();
        try {
          if (tool === undefined) throw new Error(`No tool named ${call.name} is available.`);
          const result = await tool.execute(toolCallId, parseArguments(call.arguments));
          messages.push({ role: "tool", tool_call_id: toolCallId, content: toolText(result).slice(0, 8_000) });
          await recordNativeToolCompleted(turn, { toolCallId, tool: call.name, isError: false, durationMs: Date.now() - toolStartedAt });
        } catch (toolError: unknown) {
          const message = toolError instanceof Error ? toolError.message : String(toolError);
          messages.push({ role: "tool", tool_call_id: toolCallId, content: `Tool ${call.name} failed: ${message}`.slice(0, 8_000) });
          await recordNativeToolCompleted(turn, { toolCallId, tool: call.name, isError: true, durationMs: Date.now() - toolStartedAt });
        }
      }
      if (round === maxRounds - 1) {
        error = `The native Main Agent reached its ${maxRounds}-round limit without a final answer.`;
      }
    }
    if (error === undefined && reply.trim().length === 0) {
      error = "The native Main Agent returned no visible reply.";
    }
  } catch (caught: unknown) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const usageRecord: UsageRecord = {
    source: "main-agent",
    turnId,
    modelId: endpoint.model,
    provider: "native",
    durationMs: Math.max(0, Date.now() - startedAt),
    modelCalls: usage.modelCalls,
    ...(sawUsage
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
      : {}),
  };
  await recordUsage(options.dataDirectory, usageRecord).catch(() => undefined);
  const newRuns = (await currentRuns(options.dataDirectory).catch(() => []))
    .filter((run) => !before.has(run.id))
    .map((run) => ({ id: run.id, status: run.status, planId: run.planId }));
  await finishMainAgentTurn(turn, {
    status: error === undefined ? "completed" : "failed",
    reply,
    ...(error === undefined ? {} : { error }),
    usage: usageRecord,
    ...(newRuns.length === 0 ? {} : { spawnedRunIds: newRuns.map((run) => run.id) }),
  });
  return {
    reply: reply.trim(),
    ...(error === undefined ? {} : { error }),
    newRuns,
  };
}

async function chat(
  endpoint: NativeMainAgentEndpoint,
  messages: NativeMessage[],
  tools: readonly PlainKernelTool[],
  fetchImpl: typeof fetch,
  onDelta?: (delta: string) => void,
): Promise<NativeReply> {
  const response = await fetchImpl(`${endpoint.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` }),
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      ...(tools.length === 0
        ? {}
        : {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters ?? { type: "object", properties: {} },
            },
          })),
          tool_choice: "auto",
        }),
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: AbortSignal.timeout(endpoint.timeoutMs ?? 120_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`The Main Agent endpoint answered ${response.status}: ${detail.slice(0, 300)}`);
  }
  if (response.body === null) throw new Error("The Main Agent endpoint returned no stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: ModelUsage | undefined;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  const handleLine = (raw: string): void => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") return;
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: unknown;
    };
    try {
      chunk = JSON.parse(data) as typeof chunk;
    } catch {
      return;
    }
    if (chunk.usage !== undefined) {
      const parsed = parseUsage(chunk.usage);
      if (parsed !== undefined) usage = parsed;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (delta === undefined) return;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      try {
        onDelta?.(delta.content);
      } catch {
        // A broken sink must not lose the reply. 断开的下游不能丢回复。
      }
    }
    for (const fragment of delta.tool_calls ?? []) {
      const index = typeof fragment.index === "number" ? fragment.index : 0;
      const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof fragment.id === "string" && fragment.id.length > 0) current.id = fragment.id;
      if (typeof fragment.function?.name === "string" && fragment.function.name.length > 0) current.name += fragment.function.name;
      if (typeof fragment.function?.arguments === "string") current.arguments += fragment.function.arguments;
      toolCalls.set(index, current);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) handleLine(buffer);

  return {
    content: content.length > 0 ? content : null,
    toolCalls: [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id.length > 0 ? call.id : randomUUID(),
        name: call.name,
        arguments: call.arguments.length > 0 ? call.arguments : "{}",
      })),
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * The Pi-backed search_history reads Pi session files; the native transcript is
 * the turn ledger, so this runtime swaps that one tool for a ledger search.
 * Pi 版 search_history 读 Pi 会话文件；原生对话记录是回合台账，因此本运行时只替换
 * 这一个工具为台账检索。
 */
function nativeTools(dataDirectory: string): PlainKernelTool[] {
  return kernelToolDefinitions({ dataDirectory }).map((tool) => tool.name === "search_history"
    ? {
      ...tool,
      execute: async (_toolCallId: string, params: Record<string, unknown>) => ({
        content: [{
          type: "text",
          text: await searchLedger(dataDirectory, String(params.query ?? ""), Number(params.limit ?? 6)),
        }],
        details: {},
      }),
    }
    : tool);
}

async function searchLedger(dataDirectory: string, query: string, limit: number): Promise<string> {
  const terms = tokenize(query);
  if (terms.length === 0) return "No search terms were provided.";
  const records = (await readMainAgentTurnRecords(dataDirectory))
    .filter((record) => record.status === "completed");
  const scored: Array<{ at: string; score: number; excerpt: string }> = [];
  for (const record of records) {
    const haystack = `${record.text}\n${record.reply ?? ""}`.toLocaleLowerCase();
    const matched = terms.filter((term) => haystack.includes(term.toLocaleLowerCase()));
    if (matched.length === 0) continue;
    scored.push({
      at: record.startedAt,
      score: matched.length / terms.length,
      excerpt: `${record.text}\n— ${record.reply ?? ""}`.slice(0, 600),
    });
  }
  scored.sort((left, right) => right.score - left.score);
  if (scored.length === 0) return "No matching past turns were found in the native transcript.";
  const take = Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.trunc(limit) : 6));
  return scored.slice(0, take).map((item) => `[${item.at}] ${item.excerpt}`).join("\n\n");
}

async function buildHistory(
  dataDirectory: string,
  excludeTurnId: string,
  options: { turns: number; chars: number },
): Promise<NativeMessage[]> {
  const records = (await readMainAgentTurnRecords(dataDirectory))
    .filter((record) => record.id !== excludeTurnId && record.status === "completed" && (record.reply ?? "").trim().length > 0)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    .slice(-Math.max(1, options.turns));
  const pairs = records.map((record) => ({
    user: record.text.slice(0, 4_000),
    assistant: (record.reply ?? "").slice(0, 4_000),
  }));
  const budget = Math.max(1, options.chars);
  const total = pairs.reduce((sum, pair) => sum + pair.user.length + pair.assistant.length, 0);
  if (total <= budget) return flattenPairs(pairs);

  // Keep the newest pairs verbatim within two thirds of the budget; summarise
  // the rest into a bounded system note. The full text stays in the ledger.
  // 在预算的三分之二内保留最新若干轮的原文；其余压成一段有界系统说明。全文仍在台账里。
  const keepBudget = Math.floor(budget * 0.66);
  const keep: typeof pairs = [];
  let kept = 0;
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const pair = pairs[index]!;
    const size = pair.user.length + pair.assistant.length;
    if (keep.length > 0 && kept + size > keepBudget) break;
    keep.unshift(pair);
    kept += size;
  }
  const older = pairs.slice(0, pairs.length - keep.length);
  const summary = older
    .map((pair) => `${trim(pair.user, 160)} → ${trim(pair.assistant, 160)}`)
    .join("\n")
    .slice(0, 2_000);
  const messages: NativeMessage[] = [];
  if (summary.length > 0) {
    messages.push({
      role: "system",
      content: `Earlier conversation (compacted deterministically; background only, full text is in the turn ledger and search_history):\n${summary}`,
    });
  }
  messages.push(...flattenPairs(keep));
  return messages;
}

function flattenPairs(pairs: ReadonlyArray<{ user: string; assistant: string }>): NativeMessage[] {
  const messages: NativeMessage[] = [];
  for (const pair of pairs) {
    messages.push({ role: "user", content: pair.user });
    messages.push({ role: "assistant", content: pair.assistant });
  }
  return messages;
}

function trim(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function readMainAgentEffort(dataDirectory: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const fromEnv = environment.CLONE_AI_MAIN_EFFORT?.trim();
  if (isEffortLevel(fromEnv)) return fromEnv;
  const paths = resolveClonePaths({ dataDirectory });
  const config = await new CloneConfigStore(paths).get();
  return config.mainAgentEffort;
}

async function currentRuns(dataDirectory: string): Promise<Run[]> {
  const { runtime, close } = await createKernelRuntimeSession(dataDirectory);
  try { return runtime.listRuns(); } finally { close(); }
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.map((item) => item.text ?? "").filter((item) => item.length > 0).join("\n");
  return text.length === 0 ? "(no output)" : text;
}

function parseArguments(source: string): Record<string, unknown> {
  if (source.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(source) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function summarizeArguments(source: string): string {
  try {
    return redactMemoryPii(JSON.stringify(JSON.parse(source))).text.slice(0, 2_000);
  } catch {
    return redactMemoryPii(source).text.slice(0, 2_000);
  }
}
