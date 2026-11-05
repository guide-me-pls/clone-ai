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

export type MainAgentTurnSource = "cli" | "main-cli" | "companion" | "server" | "whatsapp" | "unknown";

export interface MainAgentTurnRecord {
  id: string;
  text: string;
  status: "started" | "completed" | "failed" | "interrupted";
  startedAt: string;
  ownerPid?: number;
  completedAt?: string;
  reply?: string;
  error?: string;
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
  text: string;
  startedAt: string;
  toolCalls: MainAgentToolCall[];
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
      byId.set(record.id, {
        id: record.id,
        text: record.text,
        status: record.status,
        startedAt: record.startedAt,
        ...(typeof record.ownerPid === "number" ? { ownerPid: record.ownerPid } : {}),
        ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
        ...(typeof record.reply === "string" ? { reply: record.reply } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
      });
    } catch {
      continue;
    }
  }
  return [...byId.values()];
}

export async function appendMainAgentTurnRecord(dataDirectory: string, record: MainAgentTurnRecord): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(mainAgentTurnFile(dataDirectory), `${JSON.stringify(record)}\n`, "utf8");
}

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
  turnId?: string;
  sessionFile?: string;
  modelId?: string;
  provider?: string;
  effort?: string;
  promptMaterialHash?: string;
}): Promise<MainAgentTurnContext> {
  const turnId = input.turnId ?? randomUUID();
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
      input: capped.text,
      ...(capped.truncated ? { inputTruncated: true } : {}),
      startedAt,
      ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.promptMaterialHash === undefined ? {} : { promptMaterialHash: input.promptMaterialHash }),
    },
  }));
  await context.pending;
  await appendMainAgentTurnRecord(input.dataDirectory, {
    id: turnId,
    text: input.text,
    status: "started",
    startedAt,
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
 * a client that gave up). Refuses to overwrite a terminal ledger row.
 * 从拥有进程之外把回合标记为中断（通道超时、客户端放弃）。不会覆盖已终态的台账行。
 */
export async function recordMainAgentTurnInterrupted(
  dataDirectory: string,
  input: { turnId: string; text: string; error: string; startedAt?: string },
): Promise<MainAgentTurnRecord> {
  const records = await readMainAgentTurnRecords(dataDirectory);
  const existing = records.find((record) => record.id === input.turnId);
  if (existing?.status === "completed" || existing?.status === "failed" || existing?.status === "interrupted") {
    return existing;
  }
  const startedAt = existing?.startedAt ?? input.startedAt ?? new Date().toISOString();
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
    completedAt,
    error: input.error.slice(0, 2_000),
    ...(existing?.ownerPid === undefined ? {} : { ownerPid: existing.ownerPid }),
  };
  await appendMainAgentTurnRecord(dataDirectory, record);
  return record;
}

function appendSafely(journal: JournalStore | undefined, turnId: string, event: NewJournalEvent): Promise<void> {
  if (journal === undefined) return Promise.resolve();
  return journal.append(event).then(() => undefined).catch((error: unknown) => {
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
