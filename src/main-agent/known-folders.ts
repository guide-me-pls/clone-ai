/**
 * Folders the twin has learned from use.
 *
 * There is no folder setting. A folder becomes known because the owner named
 * it in a request; it stays known because the turn ledger is durable. The
 * briefing shows the list every turn, and recent_file_changes reads it when
 * the owner asks what changed today. A path the owner merely pasted once is
 * remembered only if it exists on disk; a protected location is never learned.
 *
 * 分身从使用中学到的文件夹。
 *
 * 没有文件夹设置。所有者在请求里点名过，它就成为已知；回合台账持久存在，它就一直被记住。
 * 简报每回合展示这份列表，recent_file_changes 在所有者问"今天改了什么"时读取它。所有者
 * 只是粘贴过一次的路径，只有在磁盘上真实存在时才会被记住；受保护位置永远不会被学习。
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalPath, isForbiddenPath } from "../authority/scope.ts";
import { createJournalStore } from "../core/sqlite-journal.ts";
import { readMainAgentTurnRecords, type MainAgentTurnRecord } from "./turn-audit.ts";

export interface KnownFolder {
  /** Canonical directory the twin remembers. 分身记住的规范目录。 */
  path: string;
  /** How many requests named it. 有多少次请求点名过它。 */
  uses: number;
  /** When the most recent request named it. 最近一次点名它的时间。 */
  lastUsedAt: string;
  /** The most recent request, shortened, so the memory can explain itself. 最近一次请求的摘要，让这条记忆能解释自己。 */
  example: string;
}

/**
 * Top-level folders that hold unrelated personal material. A project inside
 * one of these is remembered as its own folder instead of opening the whole
 * container to a digest scan.
 * 存放各类无关个人材料的顶层文件夹。其中的项目会被记成它自己的文件夹，而不是把整个容器
 * 交给摘要扫描。
 */
const NOISY_CONTAINERS = new Set([
  "Applications",
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
]);

const PATH_PATTERN = /(?:^|[^\p{L}\p{N}_~])((?:~\/|\/)[\p{L}\p{N}\p{M}_./~+@%\-]+)/gu;
const QUOTED_PATH_PATTERN = /[`"“]([^`"”]+)[`"”]/g;
const FOLDER_PHRASE_PATTERN = /([\p{L}\p{N}_-]{1,40})\s*(?:文件夹|目录|folder|directory)/giu;

function trimmedPath(value: string): string {
  return value
    .replace(/^[（(\[【"'`]+/, "")
    .replace(/[，。；：、！？!?;,.…)\]）】"'`]+$/, "")
    .trim();
}

/** True when the path exists and is a directory. 路径存在且是目录时返回真。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path is inside `home`, excluding `home` itself. 路径位于 home 之内（不含 home 本身）。 */
function withinHome(path: string, home: string): boolean {
  const rest = relative(home, path);
  return rest.length > 0 && !rest.startsWith("..") && !isAbsolute(rest);
}

/** The nearest ancestor (including the directory itself) that is a git checkout. 最近的 Git 检出根（含目录自身）。 */
function findGitRoot(directory: string, home: string): string | undefined {
  let current = directory;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === home || current === dirname(current)) return undefined;
    current = dirname(current);
  }
}

/**
 * The folder a path should teach the twin: a repository's parent for a project
 * in the owner's own tree, the repository itself under a noisy container, and
 * the named directory otherwise. `/Users/user/work/knowledge_base/README.md`
 * therefore teaches `~/work`, not one file or one repository.
 * 一个路径应当让分身记住的文件夹：所有者自己的目录树中的项目取其仓库父目录；位于杂乱容器
 * 下的项目取仓库自身；其余取被点名的目录本身。因此
 * `/Users/user/work/knowledge_base/README.md` 学到的是 `~/work`，而不是一个文件或一个仓库。
 */
export function folderCollection(path: string, home: string = homedir()): string | undefined {
  const resolvedHome = canonicalPath(home, home);
  const target = canonicalPath(path, resolvedHome);
  if (!existsSync(target)) return undefined;
  const directory = isDirectory(target) ? target : dirname(target);
  if (isForbiddenPath(directory, resolvedHome)) return undefined;
  if (directory === resolvedHome) return undefined;
  if (basename(directory).startsWith(".")) return undefined;

  const repo = findGitRoot(directory, resolvedHome);
  let candidate: string;
  if (repo !== undefined) {
    const parent = dirname(repo);
    candidate = parent === resolvedHome || NOISY_CONTAINERS.has(basename(parent))
      ? repo
      : parent;
  } else if (withinHome(directory, resolvedHome)) {
    const first = relative(resolvedHome, directory).split(sep)[0] ?? "";
    candidate = first.length === 0 || NOISY_CONTAINERS.has(first)
      ? directory
      : join(resolvedHome, first);
  } else {
    candidate = directory;
  }

  const collection = canonicalPath(candidate, resolvedHome);
  if (collection === resolvedHome) return undefined;
  if (basename(collection).startsWith(".")) return undefined;
  if (isForbiddenPath(collection, resolvedHome)) return undefined;
  return isDirectory(collection) ? collection : undefined;
}

/**
 * Every folder a piece of owner text names. Paths are canonical and reduced to
 * their collection; a phrase like `work文件夹` resolves to `~/work` when that
 * directory exists. Duplicates inside one text count once.
 * 一段所有者文字点名到的每个文件夹。路径会被规范化并归到所属集合；当目录存在时，
 * `work文件夹` 这样的短语解析为 `~/work`。同一段文字中的重复只算一次。
 */
export function extractFolders(text: string, home: string = homedir()): string[] {
  const found = new Set<string>();
  const add = (value: string): void => {
    const raw = trimmedPath(value);
    if (raw.length < 2 || raw.startsWith("//")) return;
    const absolute = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    if (!isAbsolute(absolute)) return;
    const collection = folderCollection(absolute, home);
    if (collection !== undefined) found.add(collection);
  };

  for (const match of text.matchAll(QUOTED_PATH_PATTERN)) {
    const value = match[1] ?? "";
    if (value.startsWith("/") || value.startsWith("~/")) add(value);
  }
  for (const match of text.matchAll(PATH_PATTERN)) add(match[1] ?? "");
  for (const match of text.matchAll(FOLDER_PHRASE_PATTERN)) {
    const name = (match[1] ?? "").trim();
    if (name.length === 0) continue;
    const candidate = join(home, name);
    if (isDirectory(candidate)) add(candidate);
  }
  return [...found];
}

export interface KnownFolderOptions {
  home?: string;
  /** The owner's current request; it counts as the newest use. 所有者当前的请求；它算作最近一次使用。 */
  query?: string;
  /** A clock seam for tests and reproducible briefings. 供测试与可复现简报使用的时钟切口。 */
  now?: string;
  limit?: number;
  /**
   * Events already read from the journal, so a caller that just compiled the
   * briefing does not open the same journal twice. A dispatched task's title and
   * objective are usage too: the owner asked for it, even when the Main Agent
   * wrote the path into the task rather than the chat message.
   * 已经读出的 Journal 事件，使刚编译过简报的调用方不必重复打开 Journal。派发任务的标题与
   * 目标同样是使用记录：是所有者要求的，即使路径是主 Agent 写进任务而不是聊天消息里的。
   */
  events?: readonly FolderUsageEvent[];
  /**
   * Turn records already read by the caller, so a digest that also renders the
   * day's turns does not read the same ledger twice.
   * 调用方已经读出的回合记录，使同时渲染当天回合的摘要不必重复读取同一份台账。
   */
  records?: readonly MainAgentTurnRecord[];
}

/** The part of a journal event that can name a folder. 能点名文件夹的那部分 Journal 事件。 */
export interface FolderUsageEvent {
  type: string;
  occurredAt: string;
  payload: unknown;
}

function taskTexts(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  return [record.title, record.objective, record.summary]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

async function taskEvents(dataDirectory: string): Promise<FolderUsageEvent[]> {
  const journal = createJournalStore(dataDirectory);
  try {
    const events = await journal.list();
    return events
      .filter((event) => event.type === "task.created")
      .map((event) => ({ type: event.type, occurredAt: event.occurredAt, payload: event.payload }));
  } catch {
    return [];
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

/**
 * The folders named by the owner's persisted requests, newest first.
 * Reads the turn ledger — the same durable record search_history reads — so a
 * restart loses nothing and no extra store has to be kept in sync.
 * 所有者持久请求中点名的文件夹，最新在前。读取回合台账——与 search_history 读的是同一份
 * 持久记录——因此重启不会丢，也不需要维护另一份需要同步的存储。
 */
export async function knownOwnerFolders(
  dataDirectory: string,
  options: KnownFolderOptions = {},
): Promise<KnownFolder[]> {
  const home = options.home ?? homedir();
  const limit = Math.max(1, Math.min(20, options.limit ?? 5));
  const records = options.records ?? await readMainAgentTurnRecords(dataDirectory).catch(() => []);
  const remembered = new Map<string, KnownFolder>();

  const consider = (text: string, at: string): void => {
    const example = text.replace(/\s+/g, " ").trim().slice(0, 120);
    for (const path of extractFolders(text, home)) {
      const previous = remembered.get(path);
      if (previous === undefined) {
        remembered.set(path, { path, uses: 1, lastUsedAt: at, example });
        continue;
      }
      previous.uses += 1;
      if (at >= previous.lastUsedAt) {
        previous.lastUsedAt = at;
        previous.example = example;
      }
    }
  };

  for (const record of records) {
    if (record.text.trim().length === 0) continue;
    consider(record.text, record.completedAt ?? record.startedAt);
  }
  const events = options.events ?? await taskEvents(dataDirectory);
  for (const event of events) {
    if (event.type !== "task.created") continue;
    for (const text of taskTexts(event.payload)) consider(text, event.occurredAt);
  }
  const query = options.query?.trim();
  if (query !== undefined && query.length > 0) {
    consider(query, options.now ?? new Date().toISOString());
  }

  return [...remembered.values()]
    .filter((folder) => existsSync(folder.path))
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, limit);
}

/** Render the remembered folders as plain facts for the Main Agent's briefing. 把记住的文件夹渲染成主 Agent 简报中的纯事实。 */
export function renderKnownFolders(folders: readonly KnownFolder[]): string {
  if (folders.length === 0) return "";
  return [
    "Folders you have worked in (learned from the owner's past requests; there is no folder setting):",
    ...folders.map((folder) => `- ${folder.path} — ${folder.uses} request(s), last ${folder.lastUsedAt}${folder.example.length > 0 ? `, e.g. "${folder.example}"` : ""}`),
  ].join("\n");
}
