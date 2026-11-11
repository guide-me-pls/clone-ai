/**
 * The native Main Agent loop.
 *
 * It streams an OpenAI-compatible chat completion, assembles streamed tool-call
 * fragments, executes the Kernel tools, compacts a long transcript
 * deterministically, and records the turn and its usage. The Pi runtime has
 * been removed; `native` is the only supported runtime, and asking for `pi`
 * fails explicitly instead of silently switching.
 *
 * 原生主 Agent 循环。
 *
 * 它流式调用 OpenAI 兼容端点、组装分片工具调用、执行 Kernel 工具、对长对话做确定性压缩，
 * 并记录回合与用量。Pi 运行时已移除；`native` 是唯一支持的运行时，请求 `pi` 会显式失败，
 * 而不是静默切换。
 */
import { randomUUID } from "node:crypto";

import type { ModelUsage, Run } from "../core/contracts.ts";
import {
  runAgentLoop,
  toProviderToolName,
  type AgentContentPart,
  type AgentLoopResult,
  type AgentMessage,
  type AgentModel,
  type AgentToolSpec,
} from "../agent/loop.ts";
import { createKernelRuntimeSession, kernelToolDefinitions, type PlainKernelTool } from "./tools/kernel-tools.ts";
import { compileMainAgentPrompt } from "./prompt.ts";
import { loadSkills, skillInvocation, skillListing, type SkillDefinition } from "../skills/skill-loader.ts";
import { McpHost, type McpServerConfig } from "../mcp/mcp-host.ts";
import { frameMcpOutput } from "../workers/mcp-client.ts";
import { dispatchTaskTool } from "./tools/dispatch-task.ts";
import { compactTranscript, contextLevels, contextPressure } from "./context-window.ts";
import { recordPromptSnapshot } from "./prompt-snapshot.ts";
import {
  beginMainAgentTurn,
  finishMainAgentTurn,
  readMainAgentTurnRecords,
  recordContextCompaction,
  recordNativeToolCompleted,
  recordNativeToolStarted,
  type MainAgentTurnSource,
} from "./turn-audit.ts";
import { recordUsage, type UsageRecord } from "../observability/usage.ts";
import { parseUsage } from "../workers/openai-compatible-client.ts";
import { redactMemoryPii } from "../memory/memory-hygiene.ts";
import { tokenize } from "../memory/md-memory-store.ts";
import { readMainAgentEffortPreference, readMainAgentModelPreference } from "./model-preferences.ts";

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
  /** Maximum tool calls across the turn. 整个回合的最大工具调用次数。 */
  maxToolCalls?: number;
  /** Maximum wall-clock duration across the turn. 整个回合的最大墙钟时长。 */
  maxDurationMs?: number;
  /** Cancels the turn and every in-flight tool. 取消回合与所有在途工具。 */
  signal?: AbortSignal;
  historyTurns?: number;
  /** Character budget for the verbatim transcript before deterministic compaction. 逐字对话记录在确定性压缩前的字符预算。 */
  historyChars?: number;
  /** The model's context window; defaults to 128,000. Compaction is always token-aware. 模型的上下文窗口，默认 128,000；压缩始终按 token 进行。 */
  contextWindow?: number;
  /** Directories to scan for `<name>/SKILL.md`; omitted disables skills. 扫描 `<name>/SKILL.md` 的目录；缺省禁用技能。 */
  skillRoots?: readonly string[];
  /** MCP servers to connect for this turn. 本回合要连接的 MCP 服务器。 */
  mcpServers?: readonly McpServerConfig[];
  /** Progress for each tool call, for a live timeline. 每次工具调用的进度，用于实时时间线。 */
  onToolEvent?: (event: NativeToolEvent) => void;
  /** Images attached to this turn, sent as OpenAI-style data URLs. 本回合附带的图片，以 OpenAI 风格 data URL 发送。 */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  cwd?: string;
}

/** One tool-call progress event for the interface. 面向界面的单次工具调用进度事件。 */
export interface NativeToolEvent {
  phase: "started" | "completed";
  tool: string;
  isError?: boolean;
  denied?: boolean;
  durationMs?: number;
}

export interface NativeMainAgentResult {
  reply: string;
  error?: string;
  newRuns: Array<Pick<Run, "id" | "status" | "planId">>;
}

type NativeContentPart = AgentContentPart;

type NativeMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | NativeContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

interface NativeReply {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: ModelUsage;
}

export type MainAgentRuntime = "native";

/**
 * Which Main Agent runtime this process should use.
 *
 * The built-in native runtime is now the only Main Agent. The legacy value
 * `pi` fails explicitly instead of silently changing the product architecture.
 *
 * 本进程应使用哪个主 Agent 运行时。
 *
 * 内置原生运行时现在是唯一的 Main Agent。旧的 `pi` 值会显式失败，而不是静默改变
 * 产品架构。
 */
export function readMainAgentRuntime(environment: NodeJS.ProcessEnv = process.env): MainAgentRuntime {
  const value = environment.CLONE_AI_MAIN_RUNTIME?.trim().toLowerCase();
  if (value === "pi" || value === "legacy") {
    throw new Error("The Pi Main Agent runtime has been removed. Configure CLONE_AI_NATIVE_MODEL and CLONE_AI_NATIVE_BASE_URL, or set CLONE_AI_MAIN_RUNTIME=native.");
  }
  if (value !== undefined && value !== "" && value !== "native") {
    throw new Error(`Unknown CLONE_AI_MAIN_RUNTIME "${value}". Use "native".`);
  }
  return "native";
}

/** The explicit switch as a boolean, for existing callers. 供现有调用方使用的布尔开关。 */
export function isNativeMainAgentSelected(environment: NodeJS.ProcessEnv = process.env): boolean {
  return readMainAgentRuntime(environment) === "native";
}

/**
 * The native Main Agent's endpoint. It deliberately shares the native worker's
 * variables: one OpenAI-compatible endpoint serves both.
 * 原生主 Agent 的端点。刻意复用原生 Worker 的变量：同一个 OpenAI 兼容端点服务两者。
 */
export function readNativeMainAgentEndpoint(
  environment: NodeJS.ProcessEnv = process.env,
  modelFallback?: string,
): {
  endpoint?: NativeMainAgentEndpoint;
  missing: string[];
} {
  const baseUrl = environment.CLONE_AI_NATIVE_BASE_URL?.trim();
  const model = environment.CLONE_AI_NATIVE_MODEL?.trim()
    ?? (modelFallback === undefined || modelFallback.trim().length === 0 ? undefined : modelFallback.trim());
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
  // The settings page writes a model id to config.json; when the endpoint is
  // configured only through the environment's base URL, use that choice.
  // 设置页把模型 id 写入 config.json；当端点只通过环境变量给出基础地址时，沿用该选择。
  const effective = options.endpoint === undefined && resolved.endpoint === undefined
    ? readNativeMainAgentEndpoint(environment, await readMainAgentModelPreference(options.dataDirectory, environment))
    : resolved;
  if (effective.endpoint === undefined) {
    throw new Error(`The native Main Agent needs ${effective.missing.join(" and ")}.`);
  }
  const endpoint = effective.endpoint;
  const effort = await readMainAgentEffortPreference(options.dataDirectory, environment);
  const compiled = await compileMainAgentPrompt({
    dataDirectory: options.dataDirectory,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    query: options.text,
  });
  const tools = nativeTools(options.dataDirectory, options.signal);
  // Skills and MCP are opt-in per turn: without roots or servers the tool table
  // and prompt are exactly what they were before.
  // 技能与 MCP 是按回合显式开启的：没有根目录或服务器时，工具表与 Prompt 与之前完全相同。
  const skillLibrary = options.skillRoots === undefined || options.skillRoots.length === 0
    ? { skills: [], rejected: [] }
    : await loadSkills(options.skillRoots);
  const mcpHost = options.mcpServers === undefined || options.mcpServers.length === 0
    ? undefined
    : new McpHost(options.mcpServers);
  if (mcpHost !== undefined) await mcpHost.connectAll();
  const extraTools = agentExtraTools(skillLibrary.skills, mcpHost);
  const listing = skillListing(skillLibrary.skills);
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
  const images = options.images ?? [];
  const currentText = options.text.length > 0
    ? options.text
    : images.length > 0 ? "(see attached image)" : "(empty message)";
  const userMessage: AgentMessage = images.length === 0
    ? { role: "user", content: currentText }
    : {
      role: "user",
      content: [
        { type: "text", text: currentText },
        ...images.map((image) => ({
          type: "image_url" as const,
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        })),
      ],
    };
  const systemPrompt = listing.length === 0 ? compiled.systemPrompt : `${compiled.systemPrompt}

${listing}`;
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    userMessage,
  ];
  const startedAt = Date.now();
  const maxRounds = Math.max(1, options.maxRounds ?? 8);
  const windowPolicy = contextLevels({ contextWindow: options.contextWindow ?? 128_000 });
  let agentResult: AgentLoopResult;
  try {
    agentResult = await runAgentLoop({
      model: nativeChatModel(endpoint, options.fetchImpl ?? fetch),
      tools: [...nativeAgentTools(tools), ...extraTools],
      messages,
      maxRounds,
      // Token-aware compaction is always on: the default window applies when a
      // caller does not name one, so no production surface can silently fall
      // back to the character budget and truncate without an audit record.
      // 按 token 的压缩始终启用：调用方不指定窗口时使用默认窗口，因此任何产品入口都不会
      // 悄悄退回字符预算、在没有审计记录的情况下截断。
      compactThresholdTokens: windowPolicy.compactAt,
      compact: async (current, context) => {
        const pressure = contextPressure(context.estimatedTokens, windowPolicy);
        if (pressure === "blocked") {
          throw new Error(`Context is at its ${windowPolicy.blockedAt}-token blocked level.`);
        }
        const outcome = compactTranscript(current, { estimatedTokens: context.estimatedTokens });
        await recordContextCompaction(turn, {
          estimatedTokens: context.estimatedTokens,
          compactAt: windowPolicy.compactAt,
          droppedMessages: outcome.droppedMessages,
          keptMessages: outcome.keptMessages,
          summary: outcome.summary,
        });
        return outcome.messages;
      },
      ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
      ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
      toolResultBudget: { perResultChars: 8_000, totalChars: 32_000 },
      onEvent: async (event) => {
        if (event.type === "tool_started") {
          const inputSummary = summarizeArguments(event.arguments);
          options.onToolEvent?.({ phase: "started", tool: event.tool });
          await recordNativeToolStarted(turn, {
            toolCallId: event.toolCallId,
            tool: event.tool,
            ...(inputSummary.length === 0 ? {} : { inputSummary }),
          });
        } else if (event.type === "tool_completed") {
          options.onToolEvent?.({
            phase: "completed",
            tool: event.tool,
            isError: event.isError,
            ...(event.denied === true ? { denied: true } : {}),
            durationMs: event.durationMs,
          });
          await recordNativeToolCompleted(turn, {
            toolCallId: event.toolCallId,
            tool: event.tool,
            isError: event.isError,
            durationMs: event.durationMs,
          });
        }
      },
    });
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const blocked = /blocked level/.test(message);
    agentResult = {
      reply: "",
      terminalReason: blocked ? "budget_exhausted" : "model_error",
      error: message,
      messages,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 },
      toolCalls: 0,
      rounds: 0,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  } finally {
    // The MCP processes must not outlive the turn, whatever path it took.
    // 无论回合走哪条路径，MCP 进程都不能活过它。
    await mcpHost?.close().catch(() => undefined);
  }
  const reply = agentResult.reply;
  const error = agentResult.terminalReason === "completed"
    ? undefined
    : agentResult.terminalReason === "empty_response"
      ? "The native Main Agent returned no visible reply."
      : agentResult.error ?? `The native Main Agent stopped: ${agentResult.terminalReason}.`;
  const usage = agentResult.usage;
  const sawUsage = usage.inputTokens > 0 || usage.outputTokens > 0 || usage.totalTokens > 0;

  const usageRecord: UsageRecord = {
    source: "main-agent",
    turnId,
    modelId: endpoint.model,
    provider: "native",
    durationMs: agentResult.durationMs,
    modelCalls: usage.modelCalls,
    ...(sawUsage
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
      : {}),
  };
  await recordUsage(options.dataDirectory, usageRecord).catch(() => undefined);
  const newRuns = (await currentRuns(options.dataDirectory).catch(() => []))
    .filter((run) => !before.has(run.id))
    .map((run) => ({ id: run.id, status: run.status, planId: run.planId }));
  const turnStatus = error === undefined
    ? "completed"
    : agentResult.terminalReason === "aborted" ? "interrupted" : "failed";
  await finishMainAgentTurn(turn, {
    status: turnStatus,
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

/**
 * Kernel tools that only read state may run together; a proposal or approval
 * mutates state and stays serial.
 * 只读 Kernel 工具可以并发；提案或审批会改动状态，保持串行。
 */
const PARALLEL_SAFE_KERNEL_TOOLS = new Set([
  "get_authority",
  "get_run_status",
  "get_situation",
  "read_memory",
  "recall_memory",
  "search_history",
]);

/** Adapt the Kernel tool table to the shared loop's tool contract. 把 Kernel 工具表适配到共享循环的工具契约。 */
function nativeAgentTools(tools: readonly PlainKernelTool[]): AgentToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters as Record<string, unknown> }),
    parallelSafe: PARALLEL_SAFE_KERNEL_TOOLS.has(tool.name),
    run: async (args, context) => ({
      content: toolText(await tool.execute(context.toolCallId, args)),
    }),
  }));
}

/**
 * The extra tools a turn offers: `Skill` for each loaded skill, and every MCP
 * tool under its `mcp__server__tool` name. Skill bodies and MCP tool output are
 * data, not instructions; the Kernel gate still decides what may run.
 * 本回合提供的额外工具：每个已加载技能对应一个 `Skill`，以及每件 MCP 工具以其
 * `mcp__server__tool` 名称暴露。技能正文与 MCP 工具输出是数据而非指令；真正的闸门仍由
 * Kernel 决定。
 */
function agentExtraTools(
  skills: readonly SkillDefinition[],
  mcp: McpHost | undefined,
): AgentToolSpec[] {
  const tools: AgentToolSpec[] = skills.filter((skill) => !skill.disableModelInvocation).map((skill) => ({
    name: `Skill(${skill.name})`,
    description: `Load the "${skill.name}" skill: ${skill.description}`,
    parallelSafe: true,
    run: async () => ({ content: skillInvocation(skill) }),
  }));
  for (const tool of mcp?.tools() ?? []) {
    tools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // An MCP tool's risk is the server's, not ours; keep it serial.
      // MCP 工具的风险由服务器决定，不归我们；保持串行。
      parallelSafe: false,
      run: async (args) => {
        const result = await mcp!.call(tool.name, args);
        // The same framing the worker's MCP path uses: a server can return
        // "ignore your rules", and the wrapper makes clear it is a quoted
        // observation rather than an instruction.
        // 与 Worker 的 MCP 路径相同的包裹：服务器可能返回"忽略你的规则"，包裹会明确它是引用
        // 观察而不是指令。
        return {
          content: frameMcpOutput(tool.server, tool.tool, result.content.map((part) => part.text ?? "").filter(Boolean).join("\n")),
          isError: result.isError,
        };
      },
    });
  }
  return tools;
}

/** Adapt the streaming chat function to the shared loop's model contract. 把流式 chat 适配到共享循环的模型契约。 */
function nativeChatModel(endpoint: NativeMainAgentEndpoint, fetchImpl: typeof fetch): AgentModel {
  return {
    async complete(request) {
      const reply = await chat(
        endpoint,
        toNativeMessages(request.messages),
        request.tools,
        fetchImpl,
        request.onDelta,
        request.signal,
      );
      // The provider saw derived names; the loop resolves real tools by name.
      // Provider 看到的是派生名；循环按真实名字解析工具。
      const byProviderName = new Map(request.tools.map((tool) => [toProviderToolName(tool.name), tool.name]));
      return {
        content: reply.content,
        toolCalls: reply.toolCalls.map((call) => ({ ...call, name: byProviderName.get(call.name) ?? call.name })),
        ...(reply.usage === undefined ? {} : { usage: reply.usage }),
      };
    },
  };
}

/** Convert provider-neutral messages into the OpenAI-compatible chat shape. 把 Provider 无关的消息转成 OpenAI 兼容 chat 形状。 */
function toNativeMessages(messages: readonly AgentMessage[]): NativeMessage[] {
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
        ...(message.toolCalls === undefined ? {} : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }),
      };
    }
    if (message.role === "user") {
      if (Array.isArray(message.content)) return { role: "user", content: message.content };
      return { role: "user", content: message.content ?? "" };
    }
    return { role: "system", content: typeof message.content === "string" ? message.content : "" };
  });
}

async function chat(
  endpoint: NativeMainAgentEndpoint,
  messages: NativeMessage[],
  tools: readonly AgentToolSpec[],
  fetchImpl: typeof fetch,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal,
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
              // A provider rejects `Skill(name)` and `server.tool`; the name it
              // sees is derived, and `nativeChatModel` maps a call back.
              // Provider 会拒绝 `Skill(name)` 与 `server.tool`；它看到的是派生名，
              // `nativeChatModel` 会把调用映射回来。
              name: toProviderToolName(tool.name),
              description: tool.description,
              parameters: tool.parameters ?? { type: "object", properties: {} },
            },
          })),
          tool_choice: "auto",
        }),
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: signal === undefined
      ? AbortSignal.timeout(endpoint.timeoutMs ?? 120_000)
      : AbortSignal.any([signal, AbortSignal.timeout(endpoint.timeoutMs ?? 120_000)]),
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
  let finishReason: string | undefined;
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
        finish_reason?: string | null;
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
    const finish = chunk.choices?.[0]?.finish_reason;
    if (typeof finish === "string" && finish.length > 0) finishReason = finish;
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
    ...(finishReason === undefined ? {} : { finishReason }),
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
 * The legacy search_history read Pi session files; the native transcript is the
 * turn ledger, so this runtime swaps that one tool for a ledger search.
 * 旧版 search_history 读 Pi 会话文件；原生对话记录是回合台账，因此本运行时只替换
 * 这一个工具为台账检索。
 */
function nativeTools(dataDirectory: string, signal?: AbortSignal): PlainKernelTool[] {
  return [...kernelToolDefinitions({ dataDirectory }), dispatchTaskTool({ dataDirectory, ...(signal === undefined ? {} : { signal }) })].map((tool) => tool.name === "search_history"
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
): Promise<AgentMessage[]> {
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
  const messages: AgentMessage[] = [];
  if (summary.length > 0) {
    messages.push({
      role: "system",
      content: `Earlier conversation (compacted deterministically; background only, full text is in the turn ledger and search_history):\n${summary}`,
    });
  }
  messages.push(...flattenPairs(keep));
  return messages;
}

function flattenPairs(pairs: ReadonlyArray<{ user: string; assistant: string }>): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const pair of pairs) {
    messages.push({ role: "user", content: pair.user });
    messages.push({ role: "assistant", content: pair.assistant });
  }
  return messages;
}

function trim(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
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
