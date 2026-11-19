/**
 * Turn-level audit: every Main Agent turn, from every entry point, becomes
 * Journal events instead of a side file.
 *
 * The journal already records what a Run did. It did not record what the Main
 * Agent was asked, what it answered, which tools it called, or how the model was
 * invoked — CLI turns wrote only a prompt snapshot, the companion wrote a JSONL
 * the audit never read, and Pi's tool-execution events were never subscribed to.
 * This module is the single choke point that closes those gaps: begin, observe,
 * finish. The same JSONL ledger is still written for the conversation UI, by the
 * same code, so the two views cannot disagree.
 *
 * 回合级审计：来自所有入口的每一个主 Agent 回合，都变成 Journal 事件而不是旁路文件。
 *
 * Journal 已经记录了 Run 做了什么，却没有记录主 Agent 被问了什么、回答了什么、调用了
 * 哪些工具、模型是怎么被调用的——CLI 回合只写提示词快照，companion 写的是审计从不读取的
 * JSONL，Pi 的工具执行事件从未被订阅。本模块是补齐这些缺口的唯一入口：begin、observe、
 * finish。同一份 JSONL 台账仍由同一段代码写入，供对话界面使用，因此两个视图不会互相矛盾。
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { NewJournalEvent } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";
import { createJournalStore } from "../core/sqlite-journal.ts";
import { redactMemoryPii } from "../memory/memory-hygiene.ts";
import { logJson } from "../observability/json-log.ts";
import type { UsageRecord } from "../observability/usage.ts";
import { conversationIdOf, MAIN_AGENT_DEFAULT_CONVERSATION_ID } from "./conversation.ts";

export type MainAgentTurnSource = "cli" | "main-cli" | "companion" | "server" | "whatsapp" | "unknown";

export interface MainAgentTurnRecord {
  id: string;
  text: string;
  status: "started" | "completed" | "failed" | "interrupted";
  startedAt: string;
  /**
   * The task this turn belongs to. Rows written before scoping omit it and
   * belong to the main conversation.
   * 本回合所属的任务。划分之前写入的行省略它，属于主对话。
   */
  conversationId?: string;
  ownerPid?: number;
  completedAt?: string;
  reply?: string;
  error?: string;
  /** Context compactions that happened during this turn. 本回合发生的上下文压缩。 */
  compactions?: MainAgentCompactionRecord[];
}

export interface MainAgentCompactionRecord {
  at: string;
  estimatedTokens: number;
  compactAt: number;
  droppedMessages: number;
  keptMessages: number;
  summary: string;
}

export interface MainAgentToolCall {
  toolCallId: string;
  name: string;
  inputSummary?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface MainAgentTurnContext {
  turnId: string;
  source: MainAgentTurnSource;
  dataDirectory: string;
  /** The conversation whose history this turn extends. 本回合扩展其历史的对话。 */
  conversationId: string;
  text: string;
  startedAt: string;
  toolCalls: MainAgentToolCall[];
  compactions?: MainAgentCompactionRecord[];
  /** Journal appends are chained so tool events land before the turn completes. Journal 追加串行化，确保工具事件先于回合完成落盘。 */
  pending: Promise<void>;
  journal?: JournalStore;
  finished: boolean;
}

/** Caps keep one long answer from dominating the journal; the full text stays in the Pi session file. 上限避免一次长回答撑大 Journal；全文仍在 Pi 会话文件中。 */
export const TURN_TEXT_LIMIT = 20_000;
export const TOOL_INPUT_LIMIT = 2_000;

export function mainAgentTurnFile(dataDirectory: string): string {
  return join(dataDirectory, "main-agent-turns.jsonl");
}

export async function readMainAgentTurnRecords(dataDirectory: string): Promise<MainAgentTurnRecord[]> {
  let source: string;
  try {
    source = await readFile(mainAgentTurnFile(dataDirectory), "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const byId = new Map<string, MainAgentTurnRecord>();
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record = JSON.parse(trimmed) as Partial<MainAgentTurnRecord>;
      if (typeof record.id !== "string" || typeof record.text !== "string") continue;
      if (record.status !== "started" && record.status !== "completed" && record.status !== "failed" && record.status !== "interrupted") continue;
      if (typeof record.startedAt !== "string") continue;
      const parsed: MainAgentTurnRecord = {
        id: record.id,
        text: record.text,
        status: record.status,
        startedAt: record.startedAt,
        ...(typeof record.conversationId === "string" ? { conversationId: record.conversationId } : {}),
        ...(typeof record.ownerPid === "number" ? { ownerPid: record.ownerPid } : {}),
        ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
        ...(typeof record.reply === "string" ? { reply: record.reply } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
      };
      // A completed row outranks a late interruption or failure, in either
      // append order: a client that gave up after the answer must not erase it.
      // The key includes the conversation, so a turn id reused in another task
      // stays two independent turns.
      // 已完成行优先于迟到的中断或失败，无论追加顺序如何：在答案之后放弃的客户端不能抹掉它。
      // 键包含对话，因此在另一个任务中复用的回合 id 仍是两个独立的回合。
      const key = `${conversationIdOf(parsed.conversationId)}\u0000${parsed.id}`;
      const current = byId.get(key);
      if (current === undefined || statusRank(parsed.status) >= statusRank(current.status)) byId.set(key, parsed);
    } catch {
      // A torn or interleaved write must be visible, not silently dropped:
      // losing a line loses a turn from the transcript and the sidebar.
      // 被截断或交错的写入必须可见，而不是被静默丢弃：丢一行就丢掉转录与侧栏中的一个回合。
      logJson("warn", "main_agent turn ledger line skipped", { line: trimmed.slice(0, 200) });
      continue;
    }
  }
  return [...byId.values()];
}

function statusRank(status: MainAgentTurnRecord["status"]): number {
  return status === "completed" ? 3 : status === "failed" ? 2 : status === "interrupted" ? 1 : 0;
}

export async function appendMainAgentTurnRecord(dataDirectory: string, record: MainAgentTurnRecord): Promise<void> {
  const append = async (): Promise<void> => {
    await mkdir(dataDirectory, { recursive: true });
    await appendFile(mainAgentTurnFile(dataDirectory), `${JSON.stringify(record)}\n`, "utf8");
  };
  // Turns in one process append through one queue: concurrent conversations
  // would otherwise write 20k-character rows to the same file at once.
  // 同一进程内的回合经一条队列追加：否则并发对话会同时向同一文件写入两万字符的行。
  const next = ledgerWriteQueue.then(append, append);
  ledgerWriteQueue = next.then(() => undefined, () => undefined);
  await next;
}

let ledgerWriteQueue: Promise<void> = Promise.resolve();

/**
 * Opens a turn: journals the input before the model sees it, and writes the
 * ledger's `started` row so a crash leaves both views with evidence.
 * 开启一个回合：在模型看到输入之前写入 Journal，并写台账的 `started` 行，使崩溃时两个
 * 视图都留下证据。
 */
export async function beginMainAgentTurn(input: {
  dataDirectory: string;
  text: string;
  source: MainAgentTurnSource;
  conversationId?: string;
  turnId?: string;
  sessionFile?: string;
  modelId?: string;
  provider?: string;
  effort?: string;
  promptMaterialHash?: string;
  /**
   * The conversation window this turn's model was given, for the audit. It is
   * recorded before the model call so a failed turn still shows what it saw.
   * 本回合模型拿到的对话窗口，供审计使用。它在模型调用之前记录，失败的回合因此仍显示它看到了什么。
   */
  historyMessages?: number;
  historyTurns?: number;
}): Promise<MainAgentTurnContext> {
  const turnId = input.turnId ?? randomUUID();
  const conversationId = conversationIdOf(input.conversationId);
  const startedAt = new Date().toISOString();
  let journal: JournalStore | undefined;
  try {
    journal = createJournalStore(input.dataDirectory);
  } catch (error: unknown) {
    logJson("warn", "main_agent.turn_started journal unavailable", {
      error: error instanceof Error ? error.message : String(error),
      turnId,
    });
  }
  const capped = redactAndCap(input.text, TURN_TEXT_LIMIT);
  const context: MainAgentTurnContext = {
    turnId,
    source: input.source,
    dataDirectory: input.dataDirectory,
    conversationId,
    text: input.text,
    startedAt,
    toolCalls: [],
    pending: Promise.resolve(),
    ...(journal === undefined ? {} : { journal }),
    finished: false,
  };
  context.pending = context.pending.then(() => appendSafely(context.journal, context.turnId, {
    type: "main_agent.turn_started",
    payload: {
      schemaVersion: 1,
      turnId,
      source: input.source,
      conversationId,
      input: capped.text,
      ...(capped.truncated ? { inputTruncated: true } : {}),
      startedAt,
      ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.promptMaterialHash === undefined ? {} : { promptMaterialHash: input.promptMaterialHash }),
      ...(input.historyMessages === undefined ? {} : { historyMessages: input.historyMessages }),
      ...(input.historyTurns === undefined ? {} : { historyTurns: input.historyTurns }),
    },
  }));
  await context.pending;
  await appendMainAgentTurnRecord(input.dataDirectory, {
    id: turnId,
    text: input.text,
    status: "started",
    startedAt,
    conversationId,
    ownerPid: process.pid,
  }).catch((error: unknown) => {
    logJson("warn", "main_agent turn ledger append failed", {
      error: error instanceof Error ? error.message : String(error),
      turnId,
    });
  });
  return context;
}

/**
 * Subscribes to Pi's tool-execution events. This is the only place a Main Agent
 * tool call becomes durable; the tool's side effects alone are not enough to
 * answer "what did it try?".
 * 订阅 Pi 的工具执行事件。这是主 Agent 工具调用唯一持久化的地方；仅有工具副作用不足以
 * 回答"它尝试做了什么"。
 */
export function observeMainAgentSession(
  session: { subscribe(callback: (event: unknown) => void): unknown },
  context: MainAgentTurnContext,
): void {
  const starts = new Map<string, number>();
  session.subscribe((raw: unknown) => {
    const event = raw as {
      type?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      args?: unknown;
      isError?: unknown;
    };
    if (event === null || typeof event !== "object") return;
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
      const summary = toolInputSummary(event.args);
      starts.set(toolCallId, Date.now());
      context.toolCalls.push({
        toolCallId,
        name: event.toolName,
        ...(summary.text.length === 0 ? {} : { inputSummary: summary.text }),
      });
      context.pending = context.pending.then(() => appendSafely(context.journal, context.turnId, {
        type: "agent.tool_started",
        payload: {
          turnId: context.turnId,
          conversationId: context.conversationId,
          toolCallId,
          tool: event.toolName,
          ...(summary.text.length === 0 ? {} : { inputSummary: summary.text }),
        },
      }));
      return;
    }
    if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
      const start = starts.get(toolCallId);
      const durationMs = start === undefined ? undefined : Math.max(0, Date.now() - start);
      const isError = event.isError === true;
      const existing = context.toolCalls.find((call) => call.toolCallId === toolCallId);
      if (existing === undefined) {
        context.toolCalls.push({
          toolCallId,
          name: event.toolName,
          isError,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
      } else {
        existing.isError = isError;
        if (durationMs !== undefined) existing.durationMs = durationMs;
      }
      context.pending = context.pending.then(() => appendSafely(context.journal, context.turnId, {
        type: "agent.tool_completed",
        payload: {
          turnId: context.turnId,
          conversationId: context.conversationId,
          toolCallId,
          tool: event.toolName,
          isError,
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      }));
    }
  });
}

/**
 * Records a deterministic context compaction on the turn and in the journal.
 * The record is what the desktop context panel reads; the full text stays in
 * the ledger and `search_history`.
 * 在回合与 Journal 上记录一次确定性上下文压缩。桌面上下文面板读这条记录；全文仍在台账与
 * `search_history` 中。
 */
export async function recordContextCompaction(
  turn: MainAgentTurnContext,
  compaction: {
    estimatedTokens: number;
    compactAt: number;
    droppedMessages: number;
    keptMessages: number;
    summary: string;
  },
): Promise<void> {
  const summary = redactAndCap(compaction.summary, 4_000);
  turn.compactions = [...(turn.compactions ?? []), {
    at: new Date().toISOString(),
    estimatedTokens: compaction.estimatedTokens,
    compactAt: compaction.compactAt,
    droppedMessages: compaction.droppedMessages,
    keptMessages: compaction.keptMessages,
    summary: summary.text,
  }];
  await appendSafely(turn.journal, turn.turnId, {
    type: "main_agent.context_compacted",
    payload: {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      estimatedTokens: compaction.estimatedTokens,
      compactAt: compaction.compactAt,
      droppedMessages: compaction.droppedMessages,
      keptMessages: compaction.keptMessages,
      summary: summary.text,
    },
  });
  await turn.pending;
}

/**
 * Records a tool start for a runtime that drives its own loop instead of Pi.
 * It writes the same events and fills the same `toolCalls` list, so both
 * runtimes produce one audit shape.
 * 为自行驱动循环、而非 Pi 的运行时记录一次工具开始。它写入相同事件并填充相同的
 * `toolCalls` 列表，使两个运行时产出一致的审计形状。
 */
export async function recordNativeToolStarted(
  context: MainAgentTurnContext,
  input: { toolCallId: string; tool: string; inputSummary?: string },
): Promise<void> {
  context.toolCalls.push({
    toolCallId: input.toolCallId,
    name: input.tool,
    ...(input.inputSummary === undefined ? {} : { inputSummary: input.inputSummary }),
  });
  context.pending = context.pending.then(() => appendSafely(context.journal, context.turnId, {
    type: "agent.tool_started",
    payload: {
      turnId: context.turnId,
      conversationId: context.conversationId,
      toolCallId: input.toolCallId,
      tool: input.tool,
      ...(input.inputSummary === undefined ? {} : { inputSummary: input.inputSummary }),
    },
  }));
  await context.pending;
}

/** Records the matching tool completion. 记录对应的工具完成。 */
export async function recordNativeToolCompleted(
  context: MainAgentTurnContext,
  input: { toolCallId: string; tool: string; isError: boolean; durationMs?: number },
): Promise<void> {
  const existing = context.toolCalls.find((call) => call.toolCallId === input.toolCallId);
  if (existing === undefined) {
    context.toolCalls.push({
      toolCallId: input.toolCallId,
      name: input.tool,
      isError: input.isError,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    });
  } else {
    existing.isError = input.isError;
    if (input.durationMs !== undefined) existing.durationMs = input.durationMs;
  }
  context.pending = context.pending.then(() => appendSafely(context.journal, context.turnId, {
    type: "agent.tool_completed",
    payload: {
      turnId: context.turnId,
      conversationId: context.conversationId,
      toolCallId: input.toolCallId,
      tool: input.tool,
      isError: input.isError,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    },
  }));
  await context.pending;
}

/**
 * Closes a turn: journals the reply, error, usage and tool calls, updates the
 * ledger, and releases the journal handle. Safe to call twice.
 * 结束一个回合：写入回复、错误、用量与工具调用，更新台账，并释放 Journal 句柄。可重复调用。
 */
export async function finishMainAgentTurn(
  context: MainAgentTurnContext,
  input: {
    status: "completed" | "failed" | "interrupted";
    reply?: string;
    error?: string;
    usage?: UsageRecord;
    spawnedRunIds?: readonly string[];
  },
): Promise<void> {
  if (context.finished) return;
  context.finished = true;
  await context.pending.catch(() => undefined);
  const completedAt = new Date().toISOString();
  const reply = input.reply === undefined ? undefined : redactAndCap(input.reply, TURN_TEXT_LIMIT);
  const error = input.error === undefined ? undefined : redactAndCap(input.error, 4_000);
  await appendSafely(context.journal, context.turnId, {
    type: "main_agent.turn_completed",
    payload: {
      schemaVersion: 1,
      turnId: context.turnId,
      source: context.source,
      conversationId: context.conversationId,
      status: input.status,
      startedAt: context.startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(context.startedAt)),
      ...(reply === undefined ? {} : { reply: reply.text }),
      ...(reply?.truncated ? { replyTruncated: true } : {}),
      ...(error === undefined ? {} : { error: error.text }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      toolCalls: context.toolCalls,
      ...(input.spawnedRunIds === undefined || input.spawnedRunIds.length === 0 ? {} : { spawnedRunIds: [...input.spawnedRunIds] }),
    },
  });
  await appendMainAgentTurnRecord(context.dataDirectory, {
    id: context.turnId,
    text: context.text,
    status: input.status === "completed" ? "completed" : input.status === "interrupted" ? "interrupted" : "failed",
    startedAt: context.startedAt,
    conversationId: context.conversationId,
    ownerPid: process.pid,
    completedAt,
    ...(input.reply === undefined ? {} : { reply: input.reply }),
    ...(input.error === undefined ? {} : { error: input.error.slice(0, 2_000) }),
  }).catch((failure: unknown) => {
    logJson("warn", "main_agent turn ledger append failed", {
      error: failure instanceof Error ? failure.message : String(failure),
      turnId: context.turnId,
    });
  });
  closeJournal(context);
}

/**
 * Marks a turn interrupted from outside the owning process (a channel timeout,
 * a client that gave up). Only a turn that actually started can be interrupted:
 * a request rejected before `beginMainAgentTurn` — a busy 409 or an aborted
 * capacity wait — must not invent a conversation row. Never overwrites a
 * terminal ledger row.
 * 从拥有进程之外把回合标记为中断（通道超时、客户端放弃）。只有真正开始过的回合才能被中断：
 * 在 `beginMainAgentTurn` 之前就被拒绝的请求——忙碌的 409 或中止的容量等待——不得凭空
 * 造出一条对话行。绝不覆盖已终态的台账行。
 */
export async function recordMainAgentTurnInterrupted(
  dataDirectory: string,
  input: { turnId: string; text: string; error: string; startedAt?: string; conversationId?: string },
): Promise<MainAgentTurnRecord | undefined> {
  const records = await readMainAgentTurnRecords(dataDirectory);
  const existing = records.find((record) => record.id === input.turnId
    && (input.conversationId === undefined || conversationIdOf(record.conversationId) === conversationIdOf(input.conversationId)));
  if (existing === undefined) return undefined;
  if (existing.status === "completed" || existing.status === "failed" || existing.status === "interrupted") {
    return existing;
  }
  // The ledger's own start is authoritative; a client-supplied time would let
  // a late interruption reorder history.
  // 台账自己的开始时间才是权威；客户端提供的时间会让迟到的中断重排历史。
  const startedAt = existing.startedAt;
  const conversationId = conversationIdOf(existing.conversationId ?? input.conversationId);
  const completedAt = new Date().toISOString();
  const capped = redactAndCap(input.error, 4_000);
  let journal: JournalStore | undefined;
  try {
    journal = createJournalStore(dataDirectory);
    await appendSafely(journal, input.turnId, {
      type: "main_agent.turn_completed",
      payload: {
        schemaVersion: 1,
        turnId: input.turnId,
        source: "unknown",
        status: "interrupted",
        conversationId,
        startedAt,
        completedAt,
        error: capped.text,
      },
    });
  } catch (error: unknown) {
    logJson("warn", "main_agent interrupted turn journal append failed", {
      error: error instanceof Error ? error.message : String(error),
      turnId: input.turnId,
    });
  } finally {
    (journal as { close?: () => void } | undefined)?.close?.();
  }
  const record: MainAgentTurnRecord = {
    id: input.turnId,
    text: input.text,
    status: "interrupted",
    startedAt,
    conversationId,
    completedAt,
    error: input.error.slice(0, 2_000),
    ...(existing.ownerPid === undefined ? {} : { ownerPid: existing.ownerPid }),
  };
  await appendMainAgentTurnRecord(dataDirectory, record);
  // The owning turn may have completed between the read above and this append;
  // the reader's status precedence keeps the completed row, and returning it
  // here keeps the caller's view consistent with the ledger.
  // 拥有回合可能在上面的读取与这次追加之间完成；读者的状态优先级会保留已完成行，这里返回它，
  // 使调用方的视图与台账一致。
  return (await readMainAgentTurnRecords(dataDirectory))
    .find((value) => value.id === input.turnId && conversationIdOf(value.conversationId) === conversationId) ?? record;
}

/**
 * Serializes turn-audit journal appends in this process. Each turn opens its own
 * SQLite handle; `DatabaseSync`'s busy wait blocks the event loop when two
 * handles write at once, which concurrent conversations make routine.
 * 在本进程内串行化回合审计的 Journal 追加。每个回合打开自己的 SQLite 句柄；两个句柄同时
 * 写入时，`DatabaseSync` 的忙等待会阻塞事件循环，而并发对话会让这成为常态。
 */
let journalWriteQueue: Promise<void> = Promise.resolve();

function appendSafely(journal: JournalStore | undefined, turnId: string, event: NewJournalEvent): Promise<void> {
  if (journal === undefined) return Promise.resolve();
  const append = (): Promise<void> => journal.append(event).then(() => undefined);
  const next = journalWriteQueue.then(append, append);
  journalWriteQueue = next.then(() => undefined, () => undefined);
  return next.catch((error: unknown) => {
    logJson("warn", "main_agent turn audit append failed", {
      type: event.type,
      turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function closeJournal(context: MainAgentTurnContext): void {
  (context.journal as { close?: () => void } | undefined)?.close?.();
  context.journal = undefined;
}

function toolInputSummary(args: unknown): { text: string } {
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? null);
  } catch {
    serialized = String(args);
  }
  const redacted = redactMemoryPii(serialized).text;
  return { text: redacted.length <= TOOL_INPUT_LIMIT ? redacted : `${redacted.slice(0, TOOL_INPUT_LIMIT)}…[truncated]` };
}

function redactAndCap(value: string, limit: number): { text: string; truncated: boolean } {
  const redacted = redactMemoryPii(value).text;
  if (redacted.length <= limit) return { text: redacted, truncated: false };
  return { text: `${redacted.slice(0, limit)}\n…[truncated]`, truncated: true };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code: string }).code === "ENOENT";
}
