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
import type { UsageRecord } from "../observability/usage.ts";

export interface MainAgentTurnToolCall {
  toolCallId: string;
  name: string;
  inputSummary?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface MainAgentTurnAudit {
  turnId: string;
  source: string;
  status: "started" | "completed" | "failed" | "interrupted";
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
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  spawnedRunIds?: string[];
}

type Payload = Record<string, unknown>;

export function projectTurnAudits(events: readonly JournalEvent[]): MainAgentTurnAudit[] {
  const byId = new Map<string, MainAgentTurnAudit>();
  const ordered = [...events]
    .filter((event) => event.type === "main_agent.turn_started" || event.type === "main_agent.turn_completed")
    .sort((left, right) => left.sequence - right.sequence);
  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
    if (turnId === undefined) continue;
    const current = byId.get(turnId);
    if (event.type === "main_agent.turn_started") {
      byId.set(turnId, {
        turnId,
        source: typeof payload.source === "string" ? payload.source : "unknown",
        status: "started",
        input: typeof payload.input === "string" ? payload.input : "",
        ...(payload.inputTruncated === true ? { inputTruncated: true } : {}),
        ...(typeof payload.startedAt === "string" && Number.isFinite(Date.parse(payload.startedAt)) ? { startedAt: payload.startedAt } : { startedAt: event.occurredAt }),
        ...(typeof payload.sessionFile === "string" ? { sessionFile: payload.sessionFile } : {}),
        ...(typeof payload.modelId === "string" ? { modelId: payload.modelId } : {}),
        ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
        ...(typeof payload.effort === "string" ? { effort: payload.effort } : {}),
        ...(typeof payload.promptMaterialHash === "string" ? { promptMaterialHash: payload.promptMaterialHash } : {}),
        toolCalls: [],
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
      input: "",
      startedAt: typeof payload.startedAt === "string" && Number.isFinite(Date.parse(payload.startedAt))
        ? payload.startedAt
        : event.occurredAt,
      toolCalls: [],
    };
    byId.set(turnId, {
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
  return [...byId.values()];
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
    turn.turnId, turn.source, turn.status, turn.input, turn.reply, turn.error,
    turn.modelId, turn.provider, turn.effort,
    ...turn.toolCalls.flatMap((call) => [call.name, call.inputSummary]),
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

function isUsageRecord(value: unknown): value is UsageRecord {
  const record = asRecord(value);
  return typeof record.source === "string" && typeof record.durationMs === "number";
}

function asRecord(value: unknown): Payload {
  return typeof value === "object" && value !== null ? (value as Payload) : {};
}
