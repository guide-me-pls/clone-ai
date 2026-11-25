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
import { composeAttachedDocuments, type DocumentAttachment } from "./attachments.ts";
import { TokenCalibrator } from "../agent/token-estimate.ts";
import { recordPromptSnapshot } from "./prompt-snapshot.ts";
import {
  beginMainAgentTurn,
  finishMainAgentTurn,
  readMainAgentTurnRecords,
  recordContextCompaction,
  recordNativeHistorySearch,
  recordNativeToolCompleted,
  recordNativeToolStarted,
  type MainAgentTurnContext,
  type MainAgentTurnSource,
} from "./turn-audit.ts";
import { recordUsage, type UsageRecord } from "../observability/usage.ts";
import { parseUsage } from "../workers/openai-compatible-client.ts";
import { createJournalStore } from "../core/sqlite-journal.ts";
import { mainAgentRunConversations } from "./run-triggers.ts";
import { formatHistorySearch, searchOwnerHistory, type HistorySearchScope } from "./history-search.ts";
import { redactMemoryPii } from "../memory/memory-hygiene.ts";
import { readMainAgentEffortPreference } from "./model-preferences.ts";
import { CloneConfigStore } from "../config/clone-config.ts";
import { resolveClonePaths } from "../config/clone-home.ts";
import { conversationIdOf, MAIN_AGENT_DEFAULT_CONVERSATION_ID } from "./conversation.ts";

export interface NativeMainAgentEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * How many completed turns the model's history carries by default. The desktop
 * log shows this number beside the context assembly, so both sides name the
 * same window.
 * 模型历史默认携带多少个已完成回合。桌面日志在上下文组装旁显示这个数字，使两边指向同一个
 * 窗口。
 */
export const MAIN_AGENT_HISTORY_TURNS = 24;

export interface NativeMainAgentOptions {
  dataDirectory: string;
  text: string;
  source: MainAgentTurnSource;
  /**
   * The task this turn belongs to. The model sees only this conversation's
   * history; omitted means the owner's main conversation.
   * 本回合所属的任务。模型只看到这个对话的历史；缺省表示所有者的主对话。
   */
  conversationId?: string;
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
  /** Text documents attached to this turn; their bodies reach the model once. 本回合附带的文本文档；正文只交给模型一次。 */
  documents?: DocumentAttachment[];
  /** What the turn ledger records when it differs from the model text, such as an attachment manifest. 当写入台账的文本不同于模型文本时使用，例如附件清单。 */
  ledgerText?: string;
  cwd?: string;
  /**
   * The model the owner picked for this turn. It overrides the persisted and
   * environment value for this turn only; omitted keeps the Settings default,
   * which is what surfaces without a composer (WhatsApp, schedules) rely on.
   * 所有者为本回合选择的模型。仅覆盖本回合的持久化与环境值；缺省沿用设置默认值，
   * 没有输入框的入口（WhatsApp、定时）依赖这一行为。
   */
  model?: string;
  /**
   * The reasoning effort the owner picked for this turn. Omitted keeps the
   * persisted or environment default. 所有者为本回合选择的推理强度；缺省沿用
   * 持久化或环境默认值。
   */
  effort?: string;
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
  fallback: { model?: string; baseUrl?: string; apiKey?: string } = {},
): {
  endpoint?: NativeMainAgentEndpoint;
  missing: string[];
} {
  // The environment wins for a one-off run; the persisted config is the
  // fallback so an app launched from Finder — with an empty environment — still
  // has an endpoint. The key never appears in a missing-paths message.
  // 一次性运行以环境变量为准；持久配置作为兜底，使从 Finder 启动、环境为空的 App 仍有
  // 端点。密钥绝不出现在"缺什么"的提示里。
  const baseUrl = nonEmpty(environment.CLONE_AI_NATIVE_BASE_URL) ?? nonEmpty(fallback.baseUrl);
  const model = nonEmpty(environment.CLONE_AI_NATIVE_MODEL) ?? nonEmpty(fallback.model);
  const apiKey = nonEmpty(environment.CLONE_AI_NATIVE_API_KEY) ?? nonEmpty(fallback.apiKey);
  const missing: string[] = [];
  if (baseUrl === undefined) missing.push("CLONE_AI_NATIVE_BASE_URL");
  if (model === undefined) missing.push("CLONE_AI_NATIVE_MODEL");
  if (missing.length > 0) return { missing };
  const timeout = Number(environment.CLONE_AI_NATIVE_TIMEOUT_MS ?? 120_000);
  return {
    missing,
    endpoint: {
      baseUrl: baseUrl!.replace(/\/$/, ""),
      model: model!,
      ...(apiKey === undefined ? {} : { apiKey }),
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    },
  };
}

/** A trimmed non-empty string, or undefined. 去空白后的非空字符串，否则 undefined。 */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The endpoint the owner saved in `config.json`. A missing or unreadable config
 * degrades to "nothing persisted" rather than failing before the environment
 * is even consulted.
 * 所有者在 `config.json` 中保存的端点。配置缺失或不可读时退化为"没有持久值"，而不是在
 * 读环境变量之前就失败。
 */
export async function readPersistedMainAgentEndpoint(dataDirectory: string): Promise<{ model?: string; baseUrl?: string; apiKey?: string }> {
  try {
    const config = await new CloneConfigStore(resolveClonePaths({ dataDirectory })).get();
    return {
      ...(config.mainAgentModel === undefined ? {} : { model: config.mainAgentModel }),
      ...(config.mainAgentBaseUrl === undefined ? {} : { baseUrl: config.mainAgentBaseUrl }),
      ...(config.mainAgentApiKey === undefined ? {} : { apiKey: config.mainAgentApiKey }),
    };
  } catch {
    return {};
  }
}

/**
 * One turn through the native loop. Failures are recorded on the turn and
 * returned; a configuration error throws before any model call.
 * 通过原生循环完成一个回合。失败会记入回合并返回；配置错误在任何模型调用之前抛出。
 */
export async function runNativeMainAgentTurn(options: NativeMainAgentOptions): Promise<NativeMainAgentResult> {
  const environment = options.environment ?? process.env;
  // Read the persisted endpoint once: it is the fallback for every field the
  // environment does not set, so a Finder-launched app and a terminal run reach
  // the same endpoint.
  // 读取一次持久化端点：环境变量未设置的每个字段都用它兜底，使 Finder 启动的 App 与
  // 终端运行到达同一个端点。
  const persisted = await readPersistedMainAgentEndpoint(options.dataDirectory);
  const resolved = options.endpoint === undefined
    ? readNativeMainAgentEndpoint(environment, persisted)
    : { endpoint: options.endpoint, missing: [] as string[] };
  if (resolved.endpoint === undefined) {
    throw new Error(`The native Main Agent needs ${resolved.missing.join(" and ")}. Set them in Settings or in the environment.`);
  }
  const endpoint = options.model === undefined ? resolved.endpoint : { ...resolved.endpoint, model: options.model };
  // A turn carries the owner's explicit composer choice when there is one. It
  // overrides the Settings default for this turn only; without it, WhatsApp and
  // scheduled turns keep using the persisted/environment value.
  // 回合携带所有者在输入框中的显式选择（如果有）。它只覆盖本回合的设置默认值；没有选择时，
  // WhatsApp 与定时回合继续使用持久化/环境值。
  const effort = options.effort ?? await readMainAgentEffortPreference(options.dataDirectory, environment);
  const conversationId = conversationIdOf(options.conversationId);
  const compiled = await compileMainAgentPrompt({
    dataDirectory: options.dataDirectory,
    conversationId,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    query: options.text,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  // The tool is created before the turn exists; the callback writes the search
  // provenance into the turn once the loop starts.
  // 工具在回合存在之前创建；循环开始时回调把检索来源写入该回合。
  let searchTurn: MainAgentTurnContext | undefined;
  const tools = nativeTools(options.dataDirectory, conversationId, options.cwd, options.signal, (info) => {
    if (searchTurn !== undefined) void recordNativeHistorySearch(searchTurn, info);
  }, options.text);
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
    ...(compiled.instructions === undefined ? {} : { instructions: compiled.instructions.text }),
    ...(compiled.instructions === undefined ? {} : { instructionSources: compiled.instructions.sources }),
    ...(compiled.instructions === undefined || compiled.instructions.warnings.length === 0
      ? {}
      : { instructionWarnings: compiled.instructions.warnings }),
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
  }, { turnId, conversationId });
  const history = await buildHistory(options.dataDirectory, turnId, {
    turns: options.historyTurns ?? MAIN_AGENT_HISTORY_TURNS,
    conversationId,
    // Token-aware compaction owns the budget. A character cap here would drop
    // history before the loop could measure it, which is why production never
    // crossed the token threshold; `historyChars` remains an explicit override.
    // 预算归 token 感知压缩所有。在这里设字符上限会在循环测量之前丢掉历史，这正是生产路径
    // 从未越过 token 阈值的原因；`historyChars` 仍是显式覆盖。
    chars: options.historyChars ?? 0,
  });
  const turn = await beginMainAgentTurn({
    dataDirectory: options.dataDirectory,
    text: options.ledgerText ?? options.text,
    source: options.source,
    conversationId,
    turnId,
    modelId: endpoint.model,
    provider: "native",
    ...(effort === undefined ? {} : { effort }),
    ...(snapshot === undefined ? {} : { promptMaterialHash: snapshot.materialHash }),
    // The audit shows the window this turn actually saw, not the configured
    // maximum. 审计显示本回合实际看到的窗口，而不是配置的上限。
    historyMessages: history.messages.length,
    historyTurns: history.historyTurns,
  });
  searchTurn = turn;
  options.onMetadata?.({
    modelId: endpoint.model,
    provider: "native",
    ...(effort === undefined ? {} : { effort }),
  });

  const before = new Set((await currentRuns(options.dataDirectory)).map((run) => run.id));
  const images = options.images ?? [];
  const documents = options.documents ?? [];
  const currentText = documents.length > 0
    ? composeAttachedDocuments(options.text, documents)
    : options.text.length > 0
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
    ...history.messages,
    userMessage,
  ];
  const startedAt = Date.now();
  // No default round cap: the model decides when to stop. Callers that need a
  // bound pass `maxRounds` explicitly.
  // 没有默认轮次上限：由模型决定何时停下。需要上界的调用方显式传入 `maxRounds`。
  const maxRounds = options.maxRounds === undefined ? undefined : Math.max(1, options.maxRounds);
  const windowPolicy = contextLevels({ contextWindow: options.contextWindow ?? 128_000 });
  // One calibrator per turn: the provider's own usage reports teach it the real
  // characters-per-token, so the compaction threshold is measured rather than
  // guessed from a character ratio that differs by model and script.
  // 每个回合一个标定器：Provider 自己的用量报告教会它真实的每 token 字符数，使压缩阈值来自
  // 测量，而不是来自因模型与书写系统而异的字符比例。
  const calibrator = new TokenCalibrator();
  let agentResult: AgentLoopResult;
  try {
    agentResult = await runAgentLoop({
      model: nativeChatModel(endpoint, options.fetchImpl ?? fetch, effort),
      tools: [...nativeAgentTools(tools), ...extraTools],
      messages,
      maxRounds,
      // Token-aware compaction is always on: the default window applies when a
      // caller does not name one, so no production surface can silently fall
      // back to the character budget and truncate without an audit record.
      // 按 token 的压缩始终启用：调用方不指定窗口时使用默认窗口，因此任何产品入口都不会
      // 悄悄退回字符预算、在没有审计记录的情况下截断。
      compactThresholdTokens: windowPolicy.compactAt,
      calibrator,
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
  // Only runs whose trigger names this conversation are this turn's spawn. A
  // before/after diff alone attributes a concurrent conversation's dispatch to
  // whichever turn happens to finish second.
  // 只有 Trigger 点名本对话的 Run 才是本回合派发的。仅按前后差集会把它并发对话的派发归给
  // 恰好后结束的那个回合。
  const spawned = await conversationRunIds(options.dataDirectory, conversationId).catch(() => undefined);
  const newRuns = (await currentRuns(options.dataDirectory).catch(() => []))
    .filter((run) => !before.has(run.id) && spawned !== undefined && spawned.has(run.id))
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
  "read_file",
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
function nativeChatModel(endpoint: NativeMainAgentEndpoint, fetchImpl: typeof fetch, effort?: string): AgentModel {
  return {
    async complete(request) {
      const reply = await chat(
        endpoint,
        toNativeMessages(request.messages),
        request.tools,
        fetchImpl,
        request.onDelta,
        request.signal,
        effort,
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
            // Provider-safe names, same as the tool table above. 与上面的工具表一样使用 Provider 安全名。
            function: { name: toProviderToolName(call.name), arguments: call.arguments },
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
  effort?: string,
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
      // The effort the owner chose (or the Settings default) must reach the
      // provider; recording it in the turn ledger without sending it made the
      // setting decorative. 所有者选择（或设置默认）的强度必须送达 Provider；
      // 只写进回合台账而不发送，会让这个设置变成摆设。
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
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
function nativeTools(
  dataDirectory: string,
  conversationId: string,
  workspacePath?: string,
  signal?: AbortSignal,
  onSearch?: (info: { query: string; scope: HistorySearchScope; limit: number; hitCount: number; hits: Array<{ conversationId: string; at: string; score: number; excerpt?: string; source?: string }> }) => void,
  ownerText?: string,
): PlainKernelTool[] {
  return [
    ...kernelToolDefinitions({
      dataDirectory,
      conversationId,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(ownerText === undefined ? {} : { query: ownerText }),
    }),
    dispatchTaskTool({
      dataDirectory,
      conversationId,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(signal === undefined ? {} : { signal }),
    }),
  ].map((tool) => tool.name === "search_history"
    ? {
      ...tool,
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const query = String(params.query ?? "");
        const scope: HistorySearchScope = params.scope === "conversation" ? "conversation" : "all";
        const requested = Number(params.limit ?? 6);
        const limit = Math.max(1, Math.min(20, Number.isFinite(requested) ? Math.trunc(requested) : 6));
        const result = await searchOwnerHistory(dataDirectory, query, { limit, scope, conversationId });
        onSearch?.({
          query,
          scope,
          limit,
          hitCount: result.hits.length,
          hits: result.hits.map((hit) => ({
            conversationId: hit.conversationId,
            at: hit.at,
            score: hit.score,
            excerpt: hit.excerpt,
            source: hit.source,
          })),
        });
        return {
          content: [{ type: "text", text: formatHistorySearch(result, conversationId) }],
          details: { matches: result.hits.length },
        };
      },
    }
    : tool);
}

async function buildHistory(
  dataDirectory: string,
  excludeTurnId: string,
  options: { turns: number; chars: number; conversationId: string },
): Promise<{ messages: AgentMessage[]; historyTurns: number }> {
  const records = (await readMainAgentTurnRecords(dataDirectory))
    .filter((record) => record.id !== excludeTurnId && record.status === "completed" && (record.reply ?? "").trim().length > 0)
    // A task's model context is its own conversation. Rows written before the
    // ledger carried a conversation id belong to the main conversation, so an
    // upgraded clone home keeps its history.
    // 任务的模型上下文就是它自己的对话。台账携带对话 id 之前写入的行属于主对话，因此升级后的
    // clone home 仍保有其历史。
    .filter((record) => conversationIdOf(record.conversationId) === options.conversationId)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    .slice(-Math.max(1, options.turns));
  // No per-record cap here either: a 15k-character turn truncated to 4k made
  // the loop's token estimate four times too small, so a transcript that
  // really exceeded the window never reached the compact threshold.
  // 这里也不做逐条截断：把 15k 字符的回合截到 4k，会让循环的 token 估算小四倍，真正超过
  // 窗口的转录因此永远到不了压缩阈值。
  const pairs = records.map((record) => ({
    user: record.text,
    assistant: record.reply ?? "",
  }));
  const budget = Math.max(1, options.chars);
  const total = pairs.reduce((sum, pair) => sum + pair.user.length + pair.assistant.length, 0);
  // A caller that compacts by tokens must see the whole history: this
  // character budget used to truncate first, so the loop's token threshold
  // could never be crossed and compaction never ran in production.
  // 按 token 压缩的调用方必须看到完整历史：这个字符预算过去先截断，使循环的 token 阈值永远
  // 无法触发，压缩在生产路径上从不执行。
  if (options.chars === 0 || total <= budget) return { messages: flattenPairs(pairs), historyTurns: records.length };

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
  return { messages, historyTurns: records.length };
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

/** Run ids whose trigger names this conversation. 其 Trigger 点名本对话的 Run id。 */
async function conversationRunIds(dataDirectory: string, conversationId: string): Promise<Set<string>> {
  const journal = createJournalStore(dataDirectory);
  try {
    const events = await journal.list();
    return new Set(
      [...mainAgentRunConversations(events)]
        .filter(([, owner]) => owner === conversationId)
        .map(([runId]) => runId),
    );
  } finally {
    (journal as { close?: () => void }).close?.();
  }
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
