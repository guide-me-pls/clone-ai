/**
 * Reading the Main Agent's own conversation history off disk — including the
 * part that auto-compaction has already pushed out of the model's context.
 *
 * Compaction does not delete anything. The session file is append-only: when
 * the context fills, a summary entry is written and a cut point recorded, and
 * every earlier entry stays exactly where it was. So the detail is still on
 * disk after the model can no longer see it.
 *
 * That asymmetry is the whole reason this module exists. Without it the twin
 * has a perfect record it cannot read: the file is there, the ability is not.
 * The Main Agent runs with built-in tools disabled — no read, no grep, no bash
 * — because discovery is an ungoverned injection channel. This module is the
 * narrow, governed exception: read-only, scoped to the owner's own session
 * files, returning excerpts rather than handing over a filesystem.
 *
 * 从磁盘读取 Main Agent 自己的对话历史——包括已经被自动压缩挤出模型上下文的那部分。
 *
 * 压缩不删除任何东西。会话文件是只追加的：上下文写满时，写入一条摘要条目并记录切点，
 * 而此前的每一条都原封不动地留在原处。因此在模型再也看不到之后，细节仍然在磁盘上。
 *
 * 这个不对称正是本模块存在的全部理由。没有它，分身就拥有一份自己读不了的完整记录：
 * 文件在，能力不在。Main Agent 运行时禁用了全部内置工具——没有 read、没有 grep、
 * 没有 bash——因为自动发现是不受治理的注入通道。本模块是那个狭窄的、受治理的例外：
 * 只读、只限所有者自己的会话文件、返回摘录而不是交出一个文件系统。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { tokenize } from "../memory/md-memory-store.ts";

export interface HistoryExcerpt {
  /** Session file the excerpt came from. 摘录所属的会话文件。 */
  session: string;
  /** ISO timestamp of the entry. 条目的 ISO 时间戳。 */
  at: string;
  /** "user", "assistant", "tool", or "compaction summary". 说话方。 */
  speaker: string;
  /** Text around the match, bounded. 命中处附近的文本，有界。 */
  excerpt: string;
  /** Matched-term ratio, 0..1. 命中词占比。 */
  score: number;
  /** Whether compaction has already pushed this entry out of the live context. 该条目是否已被压缩挤出当前上下文。 */
  outOfContext: boolean;
}

export interface CompactionRecord {
  at: string;
  tokensBefore: number;
  summaryPreview: string;
}

export interface HistoryDescription {
  /** Session files found, newest first. 找到的会话文件，最新在前。 */
  sessions: string[];
  /** Entries across all session files. 全部会话文件中的条目数。 */
  totalEntries: number;
  /** Message entries specifically (excludes model switches, labels, and the like). 仅消息条目。 */
  messageEntries: number;
  /** Every compaction that has happened, oldest first. 已发生的每次压缩，最早在前。 */
  compactions: CompactionRecord[];
  /**
   * Entries the model can no longer see but that are still on disk. This is
   * the number that matters: it is the size of the gap that search_history
   * exists to close.
   * 模型已看不到、但仍在磁盘上的条目数。这才是关键数字：它就是 search_history
   * 所要弥合的那道缺口的大小。
   */
  entriesOutOfContext: number;
}

interface ParsedEntry {
  session: string;
  index: number;
  id: string;
  type: string;
  at: string;
  speaker: string;
  text: string;
}

const MAIN_AGENT_SESSION_SUBPATH = ["pi-sessions", "main-agent"] as const;
const EXCERPT_RADIUS = 160;
const MAX_TEXT_PER_ENTRY = 8_000;

export function mainAgentSessionDirectory(dataDirectory: string): string {
  return join(dataDirectory, ...MAIN_AGENT_SESSION_SUBPATH);
}

/**
 * Searches the owner's conversation history for a query.
 *
 * Out-of-context entries are ranked ahead of visible ones at equal relevance:
 * an entry the model can still see needs no retrieving, so surfacing it would
 * spend the result budget re-telling the agent something already in front of
 * it.
 *
 * 在所有者的对话历史中检索。
 *
 * 相关度相同时，已被挤出上下文的条目排在可见条目之前：模型还能看到的条目本就不需要
 * 找回，把它呈上来只会把结果预算花在复述眼前已有的东西上。
 */
export async function searchHistory(
  dataDirectory: string,
  query: string,
  options: { limit?: number } = {},
): Promise<HistoryExcerpt[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const { entries, outOfContext } = await loadEntries(dataDirectory);

  const scored: HistoryExcerpt[] = [];
  for (const entry of entries) {
    if (entry.text.length === 0) continue;
    const haystack = entry.text.toLocaleLowerCase();
    const matched = terms.filter((term) => haystack.includes(term));
    if (matched.length === 0) continue;
    const score = matched.length / terms.length;
    if (score < 0.2) continue;
    scored.push({
      session: entry.session,
      at: entry.at,
      speaker: entry.speaker,
      excerpt: excerptAround(entry.text, matched),
      score: Number(score.toFixed(3)),
      outOfContext: outOfContext.has(`${entry.session}#${entry.id}`),
    });
  }

  scored.sort((left, right) =>
    right.score - left.score
    || Number(right.outOfContext) - Number(left.outOfContext)
    || right.at.localeCompare(left.at));
  return scored.slice(0, options.limit ?? 6);
}

/** The shape of the history: how much exists, how much the model can still see. 历史的形状：有多少、模型还能看见多少。 */
export async function describeHistory(dataDirectory: string): Promise<HistoryDescription> {
  const { entries, outOfContext, compactions, sessions } = await loadEntries(dataDirectory);
  return {
    sessions,
    totalEntries: entries.length,
    messageEntries: entries.filter((entry) => entry.type === "message").length,
    compactions,
    entriesOutOfContext: outOfContext.size,
  };
}

interface LoadedHistory {
  entries: ParsedEntry[];
  /** Keys of entries compaction has cut away, as `session#entryId`. 被压缩切走的条目键。 */
  outOfContext: Set<string>;
  compactions: CompactionRecord[];
  sessions: string[];
}

async function loadEntries(dataDirectory: string): Promise<LoadedHistory> {
  const directory = mainAgentSessionDirectory(dataDirectory);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    // No conversation yet is not an error; it is a twin that has not been
    // spoken to. 还没有对话不是错误，只是一个还没被说过话的分身。
    return { entries: [], outOfContext: new Set(), compactions: [], sessions: [] };
  }

  const withTimes: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    const info = await stat(join(directory, name)).catch(() => undefined);
    withTimes.push({ name, mtimeMs: info?.mtimeMs ?? 0 });
  }
  withTimes.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const entries: ParsedEntry[] = [];
  const outOfContext = new Set<string>();
  const compactions: CompactionRecord[] = [];

  for (const { name } of withTimes) {
    const session = basename(name, ".jsonl");
    let source: string;
    try {
      source = await readFile(join(directory, name), "utf8");
    } catch {
      continue;
    }
    const sessionEntries: ParsedEntry[] = [];
    const cuts: string[] = [];
    let index = 0;
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // A session file is written while it is being read; a torn last line
        // is expected, not corruption.
        // 会话文件在被读取的同时也在被写入；最后一行被截断是预期内的，不是损坏。
        continue;
      }
      const type = typeof raw.type === "string" ? raw.type : "";
      if (type.length === 0 || typeof raw.id !== "string") continue;
      if (type === "compaction") {
        const summary = typeof raw.summary === "string" ? raw.summary : "";
        compactions.push({
          at: timestampOf(raw),
          tokensBefore: typeof raw.tokensBefore === "number" ? raw.tokensBefore : 0,
          summaryPreview: summary.slice(0, 240),
        });
        if (typeof raw.firstKeptEntryId === "string") cuts.push(raw.firstKeptEntryId);
      }
      sessionEntries.push({
        session,
        index: index++,
        id: raw.id,
        type,
        at: timestampOf(raw),
        speaker: speakerOf(raw, type),
        text: extractText(raw).slice(0, MAX_TEXT_PER_ENTRY),
      });
    }

    // Only the newest cut matters: an earlier compaction's kept range was
    // itself compacted by the later one.
    // 只有最新的切点有意义：更早那次压缩保留的范围，已被后一次压缩再次压掉。
    const lastCut = cuts.at(-1);
    if (lastCut !== undefined) {
      const cutIndex = sessionEntries.findIndex((entry) => entry.id === lastCut);
      if (cutIndex > 0) {
        for (const entry of sessionEntries.slice(0, cutIndex)) {
          outOfContext.add(`${entry.session}#${entry.id}`);
        }
      }
    }
    entries.push(...sessionEntries);
  }

  compactions.sort((left, right) => left.at.localeCompare(right.at));
  return { entries, outOfContext, compactions, sessions: withTimes.map((item) => basename(item.name, ".jsonl")) };
}

function timestampOf(raw: Record<string, unknown>): string {
  return typeof raw.timestamp === "string" ? raw.timestamp : "";
}

function speakerOf(raw: Record<string, unknown>, type: string): string {
  if (type === "compaction") return "compaction summary";
  const message = raw.message;
  if (typeof message === "object" && message !== null) {
    const role = (message as { role?: unknown }).role;
    if (typeof role === "string") return role;
  }
  return type;
}

/**
 * Pulls readable text out of an entry without knowing its exact shape.
 *
 * The session format belongs to the agent SDK and may add message part kinds
 * at any time. Matching on a fixed set of shapes would silently stop finding
 * whatever was added; walking for strings keeps working, and the cost of an
 * occasional irrelevant field in an excerpt is far lower than the cost of a
 * search that quietly goes blind.
 *
 * 在不知道确切结构的情况下从条目里取出可读文本。
 *
 * 会话格式属于 Agent SDK，随时可能新增消息片段类型。按固定结构匹配会在新增之后悄悄
 * 找不到新东西；而遍历取字符串则一直有效。偶尔在摘录里混进一个无关字段的代价，
 * 远低于让检索悄无声息地失明。
 */
function extractText(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => extractText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object" || value === null) return "";
  const parts: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Identifiers and timestamps are noise in an excerpt and would also match
    // queries by accident. 标识符与时间戳在摘录里是噪声，还会意外命中查询。
    if (key === "id" || key === "parentId" || key === "timestamp" || key === "uuid" || key === "parentUuid") continue;
    const text = extractText(item, depth + 1);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

function excerptAround(text: string, matched: readonly string[]): string {
  const haystack = text.toLocaleLowerCase();
  let at = -1;
  for (const term of matched) {
    const found = haystack.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return text.slice(0, EXCERPT_RADIUS * 2).trim();
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(text.length, at + EXCERPT_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
