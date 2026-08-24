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

/**
 * Whether the owner can be shown to have said these words.
 *
 * This is the gate for recording personal state from conversation. The agent
 * proposing the record supplies a quote; the quote is checked against every
 * user-role message in the owner's history. An agent cannot record a boundary
 * the owner never stated, because a fabricated quote matches nothing — the rule
 * is enforced by the file system, not by the model's good behaviour.
 *
 * Comparison ignores all whitespace, so a quote survives the agent's own
 * re-wrapping of the owner's sentence; it does not survive paraphrase, which
 * is exactly the intent.
 *
 * 所有者是否真的说过这些话。
 *
 * 这是从对话记录个人状态的门禁。提议记录的 Agent 必须提供引文；引文会与所有者历史中的
 * 每一条 user 消息比对。Agent 无法记录所有者从未说过的边界，因为编造的引文什么也匹配
 * 不上——这条规则由文件系统强制执行，而不是寄希望于模型的自觉。
 *
 * 比对忽略所有空白字符，因此引文能在 Agent 重新断行的句子里存活；但无法挺过改写，
 * 而这正是本意。
 */
export async function ownerStated(dataDirectory: string, quote: string): Promise<boolean> {
  const needle = quote.replace(/\s+/g, "");
  // A quote too short to identify anything would match by accident; refusing
  // it forces the agent to quote a real span of the owner's words.
  // 太短的引文什么都识别不了，只会意外命中；拒绝它迫使 Agent 引用所有者话语中
  // 真实的一段。
  if (needle.length < 6) return false;
  const { entries } = await loadEntries(dataDirectory);
  return entries.some(
    (entry) => entry.speaker === "user" && entry.text.replace(/\s+/g, "").includes(needle),
  );
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
    // itself compacted by the later one, and an earlier summary was merged
    // into the later summary rather than kept alongside it.
    // 只有最新的切点有意义：更早那次压缩保留的范围已被后一次压缩再次压掉，更早的摘要
    // 也被并入了后一次的摘要，而不是与它并存。
    const lastCut = cuts.at(-1);
    if (lastCut !== undefined) {
      const cutIndex = sessionEntries.findIndex((entry) => entry.id === lastCut);
      const newestCompactionId = sessionEntries.filter((entry) => entry.type === "compaction").at(-1)?.id;
      if (cutIndex > 0) {
        for (const entry of sessionEntries.slice(0, cutIndex)) {
          // The newest compaction entry sits before the cut but is the one
          // thing there the model still sees: its summary is the head of the
          // live context. Counting it as lost would overstate the gap by
          // exactly the piece that was written to bridge it.
          // 最新的压缩条目位于切点之前，却是那里唯一仍被模型看到的东西：它的摘要就是
          // 当前上下文的开头。把它算作丢失，恰好会以那段为弥合缺口而写的内容来夸大缺口。
          if (entry.id === newestCompactionId) continue;
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
 * Pulls readable text out of an entry.
 *
 * The obvious implementation — walk the object, collect every string — is
 * wrong in a way that only shows up against a real session file: it harvests
 * type discriminators ("message", "assistant", "text"), provider and model
 * ids, and any raw API payload the SDK kept alongside the message. The
 * excerpt then reads as machinery rather than conversation, and the noise
 * matches queries by accident.
 *
 * So the known text-bearing shapes are read directly, and the tolerant walk is
 * kept only as a fallback for message part kinds the SDK may add later. The
 * fallback still filters plumbing keys, because a format that grows should
 * degrade to a worse excerpt, never to a page of identifiers.
 *
 * 从条目中取出可读文本。
 *
 * 那个显而易见的实现——遍历对象、收集所有字符串——错得只有对着真实会话文件才看得出来：
 * 它会把类型判别字符串（"message"、"assistant"、"text"）、Provider 与模型 id，以及
 * SDK 随消息一起保留的原始 API 载荷统统收进来。于是摘录读起来像机器零件而不是对话，
 * 而这些噪声还会意外命中查询。
 *
 * 因此这里直接读已知的承载文本的结构，只把宽容遍历留作后备，用于 SDK 日后可能新增的
 * 消息片段类型。后备路径仍然过滤管道字段，因为一个会演进的格式应当退化成更差的摘录，
 * 而绝不该退化成一整页标识符。
 */
function extractText(raw: Record<string, unknown>): string {
  if (raw.type === "compaction") return typeof raw.summary === "string" ? raw.summary : "";
  const message = raw.message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    // Text and reasoning are what the owner and the agent actually said.
    // text 与 reasoning 才是所有者与 Agent 真正说过的话。
    for (const key of ["text", "thinking", "reasoning"]) {
      if (typeof record[key] === "string") parts.push(record[key]);
    }
    // A tool result carries its output under content; a tool call carries the
    // arguments the agent chose, which is often the detail worth recovering.
    // 工具结果把输出放在 content 下；工具调用带着 Agent 当时选择的参数，
    // 而那往往正是值得找回的细节。
    if (record.content !== undefined) parts.push(walkForText(record.content));
    if (record.input !== undefined) parts.push(walkForText(record.input));
    if (typeof record.name === "string" && record.type === "toolCall") parts.push(record.name);
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

const PLUMBING_KEYS = new Set([
  "id", "parentId", "timestamp", "uuid", "parentUuid", "type", "role", "api", "provider",
  "model", "stopReason", "usage", "cost", "v", "sessionId", "toolCallId", "signature", "isError",
]);

function walkForText(value: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (typeof value === "string") {
    // A serialized payload that leaked into a field is machinery, not speech.
    // 泄漏进某个字段的序列化载荷是机器零件，不是话语。
    const trimmed = value.trim();
    if (trimmed.startsWith("{\"") || trimmed.startsWith("[{")) return "";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => walkForText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object" || value === null) return "";
  const parts: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PLUMBING_KEYS.has(key)) continue;
    const text = walkForText(item, depth + 1);
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
