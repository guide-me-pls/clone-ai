/**
 * Failed traces: the hand-off from daily use to the nightly repair pipeline.
 *
 * A failed run already leaves a journal, but a repair job needs one
 * self-contained document: what was asked, what the plan was, who ran which
 * step, how it failed, what the gateway said, and what the owner thought. This
 * module assembles that from facts already on disk — it invents nothing — and
 * adds the implicit failures that no error code records: a retry loop, a cancel,
 * or the owner saying "no, again" shortly after.
 *
 * Everything written here is redacted first. A trace is copied into a git
 * worktree and read by a repair model; it must not carry tokens, emails or
 * secrets with it.
 *
 * 失败轨迹：从日常使用交给夜间修复流水线的材料。
 *
 * 一次失败的 Run 本来就在 Journal 里留下了记录，但修复任务需要一份自包含文档：当初要什么、
 * 计划是什么、每一步由谁执行、怎么失败的、网关说了什么、所有者怎么判断。本模块只用磁盘上
 * 已有的事实拼出这份文档——不编造任何内容——并补上错误码留不下的隐性失败：重试循环、取消，
 * 或者所有者在之后不久说"不对，重来"。
 *
 * 写入前一律先脱敏。轨迹会被复制进 git worktree 交给修复模型阅读，不能把 token、邮箱或密钥
 * 一起带过去。
 */
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { redactMemoryPii } from "../memory/memory-hygiene.ts";
import { writeJsonAtomic } from "../config/json-file.ts";
import { loadAudits } from "./audit-service.ts";
import type { RunAuditRecord } from "./run-audit.ts";
import type { JournalEvent } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";
import { readConversation } from "../main-agent/conversation-history.ts";

export interface FailedTrace {
  schemaVersion: 1;
  id: string;
  runId: string;
  capturedAt: string;
  kind: "explicit" | "implicit";
  signals: string[];
  title: string;
  objective?: string;
  request?: string;
  plan: Array<{ id: string; title: string; risk: string; agentId?: string }>;
  failure?: { stage: string; category?: string; reason?: string };
  executions: Array<{
    stepId: string;
    providerId?: string;
    agentId?: string;
    outcome: string;
    durationMs?: number;
    error?: string;
  }>;
  evidence: Array<{ kind: string; locator?: string; summary?: string }>;
  ownerLabel?: { verdict: string; note?: string };
  /** Recent progress lines, so a repair model sees the last thing that happened. 最近的进度行，让修复模型看到最后发生了什么。 */
  tail: string[];
}

const CORRECTION = /(不对|重来|错了|不是这个|重新来|重新做|别这样|搞错|no,? that.?s not|try again|not right|wrong)/i;
const CORRECTION_WINDOW_MS = 10 * 60_000;

export interface ExportResult {
  written: string[];
  skipped: number;
  directory: string;
}

export function tracesDirectory(dataDirectory: string): string {
  return join(dataDirectory, "failed-traces");
}

export async function exportFailedTraces(
  dataDirectory: string,
  journal: JournalStore,
  options: { limit?: number; now?: Date } = {},
): Promise<ExportResult> {
  const records = await loadAudits(journal, { gateway: false });
  const events = await journal.list();
  const messages = await readConversation(dataDirectory, 400);
  const directory = tracesDirectory(dataDirectory);
  await mkdir(directory, { recursive: true });

  const traces = buildTraces(records, events, messages, options.now ?? new Date())
    .slice(0, options.limit ?? 50);
  const written: string[] = [];
  for (const trace of traces) {
    const path = join(directory, `${trace.runId}.json`);
    await writeJsonAtomic(path, trace);
    written.push(path);
  }
  return { written, skipped: records.length - traces.length, directory };
}

export function buildTraces(
  records: readonly RunAuditRecord[],
  events: readonly JournalEvent[],
  messages: ReadonlyArray<{ at: string; speaker: string; text: string }>,
  now: Date,
  limit = 50,
): FailedTrace[] {
  const eventsByRun = new Map<string, JournalEvent[]>();
  for (const event of events) {
    if (event.runId === undefined) continue;
    const list = eventsByRun.get(event.runId) ?? [];
    list.push(event);
    eventsByRun.set(event.runId, list);
  }
  const traces: FailedTrace[] = [];
  for (const record of records) {
    if (record.status !== "failed" && record.status !== "cancelled") continue;
    const runEvents = eventsByRun.get(record.runId) ?? [];
    const signals = implicitSignals(record, runEvents, messages);
    traces.push(toTrace(record, runEvents, signals, now));
    if (traces.length >= limit) break;
  }
  return traces;
}

/** Implicit failure rules; each one is a fact the journal already holds. 隐性失败规则；每条都是 Journal 已有的事实。 */
function implicitSignals(
  record: RunAuditRecord,
  events: readonly JournalEvent[],
  messages: ReadonlyArray<{ at: string; speaker: string; text: string }>,
): string[] {
  const signals: string[] = [];
  const attempts = events.filter((event) => event.type === "execution.started" || event.type === "subagent.dispatched").length;
  if (attempts >= 3) signals.push(`retry>=3 (${attempts})`);
  if (events.some((event) => event.type === "run.status_changed" && (event.payload as { status?: string }).status === "cancelled")) {
    signals.push("cancelled-by-owner");
  }
  if (record.label?.verdict === "fail") signals.push("owner-labeled-fail");
  const endedAt = Date.parse(record.endedAt ?? record.createdAt ?? "");
  if (Number.isFinite(endedAt)) {
    const correction = messages.find((message) => message.speaker === "user"
      && Date.parse(message.at) >= endedAt
      && Date.parse(message.at) <= endedAt + CORRECTION_WINDOW_MS
      && CORRECTION.test(message.text));
    if (correction !== undefined) signals.push(`owner-correction:"${redact(correction.text).slice(0, 40)}"`);
  }
  return signals;
}

function toTrace(record: RunAuditRecord, events: readonly JournalEvent[], signals: string[], now: Date): FailedTrace {
  const progress = events
    .filter((event) => event.type === "execution.progress" || event.type === "subagent.progress")
    .map((event) => redact(String((event.payload as { message?: string }).message ?? "")))
    .filter((line) => line.length > 0)
    .slice(-5);
  const plan = (record.plan ?? []).map((step) => ({
    id: step.id,
    title: redact(step.title),
    risk: step.risk,
    ...(step.agentId === undefined ? {} : { agentId: step.agentId }),
  }));
  return {
    schemaVersion: 1,
    id: record.runId,
    runId: record.runId,
    capturedAt: now.toISOString(),
    kind: signals.length > 0 ? "implicit" : "explicit",
    signals,
    title: redact(record.taskTitle ?? record.objective ?? record.runId.slice(0, 8)),
    ...(record.objective === undefined ? {} : { objective: redact(record.objective) }),
    plan,
    ...(record.outcome.reason === undefined && record.outcome.failureStage === "none"
      ? {}
      : {
          failure: {
            stage: record.outcome.failureStage,
            ...(record.outcome.failureCategory === undefined ? {} : { category: record.outcome.failureCategory }),
            ...(record.outcome.reason === undefined ? {} : { reason: redact(record.outcome.reason) }),
          },
        }),
    executions: record.executions.map((execution) => ({
      stepId: execution.stepId,
      ...(execution.providerId === undefined ? {} : { providerId: execution.providerId }),
      ...(execution.agentId === undefined ? {} : { agentId: execution.agentId }),
      outcome: execution.outcome,
      ...(execution.durationMs === undefined ? {} : { durationMs: execution.durationMs }),
      ...(execution.failure?.message === undefined ? {} : { error: redact(execution.failure.message) }),
    })),
    evidence: record.evidence.map((item) => ({
      kind: item.kind,
      ...(item.locator === undefined ? {} : { locator: item.locator }),
      ...(item.summary === undefined ? {} : { summary: redact(item.summary) }),
    })),
    ...(record.label === undefined ? {} : { ownerLabel: { verdict: record.label.verdict, ...(record.label.note === undefined ? {} : { note: redact(record.label.note) }) } }),
    tail: progress,
  };
}

function redact(value: string): string {
  const { text } = redactMemoryPii(String(value ?? ""));
  return text
    .replace(/\b(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[bap]-[A-Za-z0-9-]{8,})\b/g, "[redacted-token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_500);
}

export interface TraceSummary {
  runId: string;
  title: string;
  kind: string;
  signals: string[];
  capturedAt: string;
  path: string;
}

/** What the nightly job and the CLI both need: the traces on disk, newest first. 夜间任务与 CLI 都需要的东西：磁盘上的轨迹，最新在前。 */
export async function listFailedTraces(dataDirectory: string): Promise<TraceSummary[]> {
  const directory = tracesDirectory(dataDirectory);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const summaries: TraceSummary[] = [];
  for (const name of names) {
    try {
      const trace = JSON.parse(await readFile(join(directory, name), "utf8")) as FailedTrace;
      summaries.push({
        runId: trace.runId ?? name.replace(/\.json$/, ""),
        title: trace.title ?? "",
        kind: trace.kind ?? "explicit",
        signals: Array.isArray(trace.signals) ? trace.signals : [],
        capturedAt: trace.capturedAt ?? "",
        path: join(directory, name),
      });
    } catch {
      continue;
    }
  }
  return summaries.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
}