/**
 * Turn audit: the Main Agent's inputs, replies, tool calls and model usage,
 * projected from the journal.
 *
 * Runs answer "what work was done"; turns answer "what was asked, what did the
 * agent say it was doing, and which tools did it call". They are paired by
 * turnId: `main_agent.turn_started` opens a record and
 * `main_agent.turn_completed` closes it. A started record with no completion
 * stays `started` — visible, not invented.
 *
 * 回合审计：主 Agent 的输入、回复、工具调用与模型用量，从 Journal 投影得出。
 *
 * Run 回答"做了什么工作"；回合回答"问了什么、Agent 说自己在做什么、调用了哪些工具"。
 * 两者按 turnId 配对：`main_agent.turn_started` 开启记录，`main_agent.turn_completed`
 * 关闭它。只有开始没有完成的记录保持 `started`——可见，但不编造。
 */
import type { JournalEvent } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";
import { conversationIdOf } from "../main-agent/conversation.ts";
import type { UsageRecord } from "../observability/usage.ts";

export interface MainAgentTurnToolCall {
  toolCallId: string;
  name: string;
  inputSummary?: string;
  isError?: boolean;
  durationMs?: number;
}

/** One deterministic context compaction, as recorded during the turn. 回合中记录的一次确定性上下文压缩。 */
export interface MainAgentTurnCompaction {
  at: string;
  estimatedTokens: number;
  compactAt: number;
  droppedMessages: number;
  keptMessages: number;
  summary: string;
}

/**
 * What the turn's prompt was built from: hashes, the tool table and a locator
 * for the content-addressed material. The full system prompt stays in the
 * snapshot file; the log shows what changed without pasting it.
 * 本回合提示词的来源：哈希、工具表，以及内容寻址材料的定位符。完整系统提示词留在快照文件里，
 * 日志只显示变了什么，不粘贴全文。
 */
export interface MainAgentTurnPromptSnapshot {
  schemaVersion: number;
  charterVersion: number;
  charterHash: string;
  briefingHash: string;
  promptHash: string;
  toolsHash: string;
  materialHash: string;
  toolNames: string[];
  /** Project instructions read into the prompt, when recorded. 写入 Prompt 的项目指令来源，记录时存在。 */
  instructionSources: string[];
  /** Warnings the instruction loader produced, when recorded. 指令加载器产生的警告，记录时存在。 */
  instructionWarnings: string[];
  /** Whether a situation briefing was part of the materials. 情境简报是否属于材料的一部分。 */
  hasBriefing: boolean;
  modelId?: string;
  provider?: string;
  effort?: string;
  locator: string;
  capturedAt: string;
}

/** One run a Main Agent turn dispatched, as the audit can reconstruct it from run events. Main Agent 回合派发的一个 Run，由 Run 事件重建。 */
export interface MainAgentTurnRun {
  id: string;
  title?: string;
  status?: string;
  /** The plan's step titles, when a plan was attached. 计划步骤标题（附加计划时存在）。 */
  steps?: string[];
}

/** Why a new request went to a new Main Agent or an existing conversation. 新请求为何去往新的 Main Agent 或已有对话。 */
export interface MainAgentTurnRouting {
  decision: "new" | "continue";
  conversationId: string;
  candidateConversationId?: string;
  reason: string;
  source: string;
  model?: string;
}

export interface MainAgentTurnAudit {
  turnId: string;
  source: string;
  status: "started" | "completed" | "failed" | "interrupted";
  /**
   * The conversation (task) this turn belongs to. Rows written before scoping
   * belong to the main conversation.
   * 本回合所属的对话（任务）。划分之前写入的行属于主对话。
   */
  conversationId: string;
  input: string;
  inputTruncated?: boolean;
  reply?: string;
  replyTruncated?: boolean;
  error?: string;
  modelId?: string;
  provider?: string;
  effort?: string;
  promptMaterialHash?: string;
  sessionFile?: string;
  usage?: UsageRecord;
  toolCalls: MainAgentTurnToolCall[];
  /** Context compactions during this turn, in occurrence order. 本回合发生的上下文压缩，按发生顺序。 */
  compactions: MainAgentTurnCompaction[];
  /** Completed turns and messages this turn's model context was rebuilt from. 本回合重建模型上下文所用的已完成回合与消息数。 */
  historyTurns?: number;
  historyMessages?: number;
  /** The runs this turn dispatched, with their titles, steps and last known status. 本回合派发的 Run 及其标题、步骤与最后已知状态。 */
  runs: MainAgentTurnRun[];
  /** Which Main Agent handled the request, and why. 哪个 Main Agent 处理了请求，以及原因。 */
  routing?: MainAgentTurnRouting;
  /** The prompt materials the model was given, when capture succeeded. 模型拿到的提示词材料，捕获成功时存在。 */
  snapshot?: MainAgentTurnPromptSnapshot;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  spawnedRunIds?: string[];
}

type Payload = Record<string, unknown>;

/**
 * A turn id is only unique inside one conversation: callers choose the id and
 * the ledger deliberately keeps a reused id in two conversations as two rows.
 * The projection must key the same way or the desktop log would show another
 * task's model, tools and dispatch under this task's question.
 * 回合 id 只在对话内唯一：id 由调用方选择，台账有意把两个对话中复用的 id 保留为两行。
 * 投影必须按同样的键，否则桌面日志会在本任务的问题下显示另一个任务的模型、工具与派发。
 */
export function turnAuditKey(conversationId: string, turnId: string): string {
  return `${conversationId}\u0000${turnId}`;
}

export function projectTurnAudits(events: readonly JournalEvent[]): MainAgentTurnAudit[] {
  const byKey = new Map<string, MainAgentTurnAudit>();
  const ordered = [...events]
    .filter((event) => event.type === "main_agent.turn_started" || event.type === "main_agent.turn_completed")
    .sort((left, right) => left.sequence - right.sequence);
  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
    if (turnId === undefined) continue;
    const conversationId = conversationIdOf(typeof payload.conversationId === "string" ? payload.conversationId : undefined);
    const key = turnAuditKey(conversationId, turnId);
    const current = byKey.get(key);
    if (event.type === "main_agent.turn_started") {
      // A retry that reuses a closed turn id must not erase the record the
      // ledger already treats as final; the reader keeps the completed row and
      // so does the audit.
      // 复用已关闭回合 id 的重试不得抹掉台账已视为终态的记录；读者保留已完成行，审计也一样。
      if (current !== undefined && current.status !== "started") continue;
      byKey.set(key, {
        turnId,
        source: typeof payload.source === "string" ? payload.source : "unknown",
        status: "started",
        conversationId,
        input: typeof payload.input === "string" ? payload.input : "",
        ...(payload.inputTruncated === true ? { inputTruncated: true } : {}),
        ...(typeof payload.startedAt === "string" && Number.isFinite(Date.parse(payload.startedAt)) ? { startedAt: payload.startedAt } : { startedAt: event.occurredAt }),
        ...(typeof payload.sessionFile === "string" ? { sessionFile: payload.sessionFile } : {}),
        ...(typeof payload.modelId === "string" ? { modelId: payload.modelId } : {}),
        ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
        ...(typeof payload.effort === "string" ? { effort: payload.effort } : {}),
        ...(typeof payload.promptMaterialHash === "string" ? { promptMaterialHash: payload.promptMaterialHash } : {}),
        ...(typeof payload.historyMessages === "number" ? { historyMessages: payload.historyMessages } : {}),
        ...(typeof payload.historyTurns === "number" ? { historyTurns: payload.historyTurns } : {}),
        toolCalls: [],
        compactions: [],
        runs: [],
      });
      continue;
    }
    const status = payload.status === "completed" || payload.status === "failed" || payload.status === "interrupted"
      ? payload.status
      : "completed";
    const base: MainAgentTurnAudit = current ?? {
      turnId,
      source: typeof payload.source === "string" ? payload.source : "unknown",
      status: "started",
      conversationId,
      input: "",
      startedAt: typeof payload.startedAt === "string" && Number.isFinite(Date.parse(payload.startedAt))
        ? payload.startedAt
        : event.occurredAt,
      toolCalls: [],
      compactions: [],
      runs: [],
    };
    byKey.set(key, {
      ...base,
      status,
      ...(typeof payload.reply === "string" ? { reply: payload.reply } : {}),
      ...(payload.replyTruncated === true ? { replyTruncated: true } : {}),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      ...(typeof payload.completedAt === "string" ? { completedAt: payload.completedAt } : {}),
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      ...(isUsageRecord(payload.usage) ? { usage: payload.usage } : {}),
      ...(Array.isArray(payload.spawnedRunIds) ? { spawnedRunIds: payload.spawnedRunIds.filter((id): id is string => typeof id === "string") } : {}),
      toolCalls: Array.isArray(payload.toolCalls) ? payload.toolCalls.flatMap(parseToolCall) : base.toolCalls,
    });
  }
  const byTurnId = new Map<string, MainAgentTurnAudit[]>();
  for (const turn of byKey.values()) {
    const matches = byTurnId.get(turn.turnId) ?? [];
    matches.push(turn);
    byTurnId.set(turn.turnId, matches);
  }
  // Events written before the conversation id was part of every payload can
  // only be resolved when the turn id is unambiguous; attaching a legacy event
  // to one of two same-named turns would invent a correlation.
  // 对话 id 进入每个载荷之前写入的事件，只有在回合 id 无歧义时才能解析；把旧事件挂到两个
  // 同名回合中的一个会凭空造出对应关系。
  const resolveTurn = (payload: Payload, turnId: string): MainAgentTurnAudit | undefined => {
    if (typeof payload.conversationId === "string") return byKey.get(turnAuditKey(payload.conversationId, turnId));
    const matches = byTurnId.get(turnId) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  // Tool calls, compactions and prompt snapshots are separate events: join them
  // so a running turn already shows what it called, and a finished one shows the
  // context assembly next to the dispatch.
  // 工具调用、压缩与提示词快照是独立事件：把它们关联起来，运行中的回合就能显示已经调用的
  // 工具，已完成的回合能在派发旁显示上下文组装。
  for (const event of events) {
    if (event.type !== "agent.tool_started" && event.type !== "agent.tool_completed"
      && event.type !== "main_agent.context_compacted" && event.type !== "main_agent.prompt_snapshot"
      && event.type !== "conversation.routed") continue;
    const payload = asRecord(event.payload);
    const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
    if (turnId === undefined) continue;
    const turn = resolveTurn(payload, turnId);
    if (turn === undefined) continue;
    if (event.type === "agent.tool_started" || event.type === "agent.tool_completed") {
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
      const tool = typeof payload.tool === "string" ? payload.tool : undefined;
      if (toolCallId === undefined || tool === undefined) continue;
      upsertToolCall(turn, {
        toolCallId,
        name: tool,
        ...(typeof payload.inputSummary === "string" ? { inputSummary: payload.inputSummary } : {}),
        ...(event.type === "agent.tool_completed" ? { isError: payload.isError === true } : {}),
        ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      });
      continue;
    }
    if (event.type === "main_agent.context_compacted") {
      const compaction = parseCompaction(payload, event.occurredAt);
      if (compaction !== undefined) turn.compactions.push(compaction);
      continue;
    }
    if (event.type === "conversation.routed") {
      // The route event names the conversation it chose, so resolveTurn can
      // find the turn even though it starts after this event.
      // 路由事件点名它选中的对话，因此 resolveTurn 能在回合开始之前就找到它。
      turn.routing = {
        decision: payload.decision === "continue" ? "continue" : "new",
        conversationId: typeof payload.conversationId === "string" ? payload.conversationId : turn.conversationId,
        ...(typeof payload.candidateConversationId === "string" ? { candidateConversationId: payload.candidateConversationId } : {}),
        reason: typeof payload.reason === "string" ? payload.reason : "",
        source: typeof payload.source === "string" ? payload.source : "rule",
        ...(typeof payload.model === "string" ? { model: payload.model } : {}),
      };
      continue;
    }
    const snapshot = parseSnapshot(payload);
    if (snapshot !== undefined) turn.snapshot = snapshot;
  }
  const runInfo = projectRunInfo(events);
  for (const turn of byKey.values()) {
    turn.compactions.sort((left, right) => left.at.localeCompare(right.at));
    // The dispatch is half of "how this task was assembled": the model saw the
    // conversation, then it created (or proposed) these runs.
    // 派发是"任务如何被组装"的一半：模型看过对话，然后创建（或提案）了这些 Run。
    turn.runs = (turn.spawnedRunIds ?? []).map((id) => {
      const info = runInfo.get(id);
      return {
        id,
        ...(info?.title === undefined ? {} : { title: info.title }),
        ...(info?.status === undefined ? {} : { status: info.status }),
        ...(info === undefined || info.steps.length === 0 ? {} : { steps: info.steps }),
      };
    });
  }
  return [...byKey.values()];
}

interface RunInfo {
  title?: string;
  status?: string;
  steps: string[];
}

/**
 * Reconstruct the runs a turn dispatched from the events that already carry
 * them: `task.created` (title), `run.created` (initial status), `plan.created`
 * (step titles) and every `run.status_changed` (the last status wins).
 * 从已经携带这些信息的事件重建回合派发的 Run：`task.created`（标题）、
 * `run.created`（初始状态）、`plan.created`（步骤标题）与每次 `run.status_changed`
 * （最后的状态为准）。
 */
function projectRunInfo(events: readonly JournalEvent[]): Map<string, RunInfo> {
  const taskTitles = new Map<string, string>();
  const runs = new Map<string, RunInfo>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (event.type === "task.created" && event.taskId !== undefined) {
      if (typeof payload.title === "string") taskTitles.set(event.taskId, payload.title);
      continue;
    }
    if (event.type === "run.created" && event.runId !== undefined) {
      const title = event.taskId === undefined ? undefined : taskTitles.get(event.taskId);
      runs.set(event.runId, {
        ...(title === undefined ? {} : { title }),
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        steps: [],
      });
      continue;
    }
    if (event.type === "plan.created" && event.runId !== undefined) {
      const steps = Array.isArray(payload.steps)
        ? payload.steps.flatMap((step) => {
            const record = asRecord(step);
            return typeof record.title === "string" ? [record.title] : [];
          })
        : [];
      const run = runs.get(event.runId);
      if (run !== undefined) run.steps = steps;
      continue;
    }
    if (event.type === "run.status_changed" && event.runId !== undefined && typeof payload.status === "string") {
      const run = runs.get(event.runId);
      if (run !== undefined) run.status = payload.status;
    }
  }
  return runs;
}

function upsertToolCall(turn: MainAgentTurnAudit, call: MainAgentTurnToolCall): void {
  const existing = turn.toolCalls.find((item) => item.toolCallId === call.toolCallId);
  if (existing === undefined) {
    turn.toolCalls.push(call);
    return;
  }
  existing.name = call.name;
  if (call.inputSummary !== undefined) existing.inputSummary = call.inputSummary;
  if (call.isError !== undefined) existing.isError = call.isError;
  if (call.durationMs !== undefined) existing.durationMs = call.durationMs;
}

/**
 * Project, filter and sort turns newest first. The query is a case-insensitive
 * substring over the visible fields, so the desktop search covers the whole
 * journal instead of only the page it already loaded.
 * 投影、过滤并按新的在前排序回合。查询是对可见字段的不区分大小写子串搜索，因此桌面搜索
 * 覆盖整个 Journal，而不只是已加载的一页。
 */
export async function searchTurnAudits(
  journal: JournalStore,
  options: { limit?: number; query?: string } = {},
): Promise<{ turns: MainAgentTurnAudit[]; total: number }> {
  const needle = (options.query ?? "").trim().toLowerCase();
  const turns = projectTurnAudits(await journal.list())
    .filter((turn) => needle.length === 0 || matchesTurnQuery(turn, needle))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  return { turns: turns.slice(0, limit), total: turns.length };
}

export async function loadTurnAudits(
  journal: JournalStore,
  options: { limit?: number; query?: string } = {},
): Promise<MainAgentTurnAudit[]> {
  return (await searchTurnAudits(journal, options)).turns;
}

function matchesTurnQuery(turn: MainAgentTurnAudit, needle: string): boolean {
  const fields: Array<string | undefined> = [
    turn.turnId, turn.conversationId, turn.source, turn.status, turn.input, turn.reply, turn.error,
    turn.modelId, turn.provider, turn.effort, turn.promptMaterialHash,
    ...turn.toolCalls.flatMap((call) => [call.name, call.inputSummary]),
    ...turn.compactions.map((compaction) => compaction.summary),
    ...(turn.snapshot === undefined ? [] : [
      turn.snapshot.materialHash, turn.snapshot.locator,
      turn.snapshot.charterHash, turn.snapshot.briefingHash,
      turn.snapshot.promptHash, turn.snapshot.toolsHash,
      ...turn.snapshot.toolNames,
      ...turn.snapshot.instructionSources,
      ...turn.snapshot.instructionWarnings,
    ]),
    ...turn.runs.flatMap((run) => [run.id, run.title, run.status, ...(run.steps ?? [])]),
    turn.routing?.reason, turn.routing?.source, turn.routing?.model, turn.routing?.candidateConversationId,
  ];
  return fields.some((field) => field !== undefined && field.toLowerCase().includes(needle));
}

function parseToolCall(value: unknown): MainAgentTurnToolCall[] {
  const record = asRecord(value);
  if (typeof record.toolCallId !== "string" || typeof record.name !== "string") return [];
  return [{
    toolCallId: record.toolCallId,
    name: record.name,
    ...(typeof record.inputSummary === "string" ? { inputSummary: record.inputSummary } : {}),
    isError: record.isError === true,
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
  }];
}

/**
 * A compaction event is only useful to the log when it names its turn; a
 * record without the counters would render as "compacted to nothing".
 * 压缩事件只有点名回合才对日志有用；缺少计数的记录会渲染成"压缩成了空"。
 */
function parseCompaction(payload: Payload, occurredAt: string): MainAgentTurnCompaction | undefined {
  if (typeof payload.estimatedTokens !== "number" || typeof payload.compactAt !== "number") return undefined;
  return {
    // The journal event carries no `at`; its own occurrence time is the
    // authoritative one. Using the projection clock would reorder compactions
    // by whenever the log happened to be read.
    // Journal 事件本身不带 `at`；以事件发生时间为准。用投影时刻排序会让压缩顺序取决于
    // 日志恰好被读取的时间。
    at: typeof payload.at === "string" ? payload.at : occurredAt,
    estimatedTokens: payload.estimatedTokens,
    compactAt: payload.compactAt,
    droppedMessages: typeof payload.droppedMessages === "number" ? payload.droppedMessages : 0,
    keptMessages: typeof payload.keptMessages === "number" ? payload.keptMessages : 0,
    summary: typeof payload.summary === "string" ? payload.summary : "",
  };
}

function parseSnapshot(payload: Payload): MainAgentTurnPromptSnapshot | undefined {
  // A snapshot event carries hashes and the tool table, not the full prompt;
  // a payload without a material hash and charter version is a different shape.
  // 快照事件携带哈希与工具表，而不是完整提示词；缺少材料哈希与 charter 版本的是另一种形状。
  if (typeof payload.materialHash !== "string" || typeof payload.charterVersion !== "number") return undefined;
  const toolNames = Array.isArray(payload.toolNames)
    ? payload.toolNames.filter((name): name is string => typeof name === "string")
    : [];
  return {
    schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : 1,
    charterVersion: payload.charterVersion,
    charterHash: typeof payload.charterHash === "string" ? payload.charterHash : "",
    briefingHash: typeof payload.briefingHash === "string" ? payload.briefingHash : "",
    promptHash: typeof payload.promptHash === "string" ? payload.promptHash : "",
    toolsHash: typeof payload.toolsHash === "string" ? payload.toolsHash : "",
    materialHash: payload.materialHash,
    toolNames,
    instructionSources: Array.isArray(payload.instructionSources)
      ? payload.instructionSources.filter((source): source is string => typeof source === "string")
      : [],
    instructionWarnings: Array.isArray(payload.instructionWarnings)
      ? payload.instructionWarnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    hasBriefing: payload.hasBriefing === true,
    ...(typeof payload.modelId === "string" ? { modelId: payload.modelId } : {}),
    ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
    ...(typeof payload.effort === "string" ? { effort: payload.effort } : {}),
    locator: typeof payload.locator === "string" ? payload.locator : "",
    capturedAt: typeof payload.capturedAt === "string" ? payload.capturedAt : "",
  };
}

function isUsageRecord(value: unknown): value is UsageRecord {
  const record = asRecord(value);
  return typeof record.source === "string" && typeof record.durationMs === "number";
}

function asRecord(value: unknown): Payload {
  return typeof value === "object" && value !== null ? (value as Payload) : {};
}
