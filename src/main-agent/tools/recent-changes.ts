/**
 * A read-only window onto what changed on this computer.
 *
 * The Main Agent has no filesystem tool of its own, and a read-only worker
 * needs evidence that a failed dispatch kept turning into silence. "What did I
 * work on today" is a question the Kernel can answer deterministically: list
 * the files whose content changed in the folders the twin has learned, plus
 * each repository's uncommitted changes and commits. Nothing here writes, and
 * every path is checked against the protected list first.
 *
 * 一扇只读的"本机改了什么"窗口。
 *
 * 主 Agent 自己没有文件系统工具，而只读 Worker 需要证据——一次失败的派发会让它一直沉默。
 * "今天做了什么"是 Kernel 可以确定性回答的问题：列出分身已学会的文件夹中内容发生变化的
 * 文件，以及每个仓库的未提交改动与提交。这里不写任何东西，且每个路径先过受保护清单。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { Type } from "typebox";

import { canonicalPath, isForbiddenPath } from "../../authority/scope.ts";
import type { PlainKernelTool } from "./kernel-tools.ts";
import { knownOwnerFolders, type KnownFolder } from "../known-folders.ts";

const execFileAsync = promisify(execFile);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".clone",
  ".clone-ai",
  ".idea",
  ".next",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);

const MAX_MDFIND_FILES = 2_000;
const WALK_DEADLINE_MS = 8_000;
const WALK_MAX_DIRECTORIES = 4_000;
const MAX_REPOSITORIES = 20;

export interface RecentChangesOptions {
  dataDirectory: string;
  /** The turn's workspace, used only when no folder has been learned yet. 本回合的工作区；仅在还没有学到任何文件夹时使用。 */
  workspacePath?: string;
  /** The owner's current request; a folder named in it counts as known. 所有者当前请求；其中点名的文件夹算作已知。 */
  query?: string;
  /** Home-directory seam for tests. 测试用的 home 切口。 */
  home?: string;
  /** Clock seam so "today" is reproducible in tests. 时钟切口，使测试中的"今天"可复现。 */
  now?: () => Date;
}

export interface RecentFile {
  path: string;
  modifiedAt: string;
}

export interface RepoReport {
  path: string;
  branch?: string;
  status: string[];
  commits: Array<{ id: string; at: string; subject: string }>;
  error?: string;
}

export interface FolderReport {
  folder: string;
  files: RecentFile[];
  totalFiles: number;
  truncated: boolean;
  source: "spotlight" | "walk";
  repos: RepoReport[];
  error?: string;
}

interface RecentFileScan {
  files: RecentFile[];
  total: number;
  truncated: boolean;
  source: "spotlight" | "walk";
}

function localMidnight(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** Turn a user-supplied instant into a cutoff. `today` means local midnight. 把用户给出的时间点变成截止时间；`today` 表示本地午夜。 */
export function parseSince(value: string | undefined, now: Date): Date {
  const raw = (value ?? "today").trim().toLowerCase();
  if (raw === "" || raw === "today" || raw === "今天") return localMidnight(now);
  if (raw === "24h" || raw === "24小时" || raw === "1d") return new Date(now.getTime() - 24 * 3_600_000);
  if (raw === "yesterday" || raw === "昨天") return new Date(localMidnight(now).getTime() - 24 * 3_600_000);
  const parsed = Date.parse(value ?? "");
  if (Number.isNaN(parsed)) throw new Error(`Unrecognized since value "${value}". Use an ISO timestamp, "today", "24h" or "yesterday".`);
  return new Date(parsed);
}

function localStamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ignoredPath(path: string, root: string): boolean {
  if (relative(root, path).split(/[\\/]/).some((segment) => IGNORED_DIRECTORIES.has(segment))) return true;
  return basename(path).startsWith(".git");
}

async function statFile(path: string, sinceMs: number): Promise<RecentFile | undefined> {
  try {
    const info = await fs.stat(path);
    if (!info.isFile() || info.mtimeMs < sinceMs) return undefined;
    return { path, modifiedAt: new Date(info.mtimeMs).toISOString() };
  } catch {
    return undefined;
  }
}

/**
 * macOS Spotlight answers a "changed today" query in milliseconds; a directory
 * walk over a 130 GB tree takes seconds. The walk remains as the honest fallback
 * for an unindexed folder or another platform.
 * macOS 的 Spotlight 在毫秒级回答"今天改过"的查询；遍历 130 GB 的目录树要数秒。目录遍历
 * 仍作为未建索引的文件夹或其他平台上的诚实回退。
 */
async function spotlightCandidates(folder: string): Promise<string[] | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync(
      "mdfind",
      ["-onlyin", folder, "kMDItemFSContentChangeDate >= $time.today"],
      { timeout: 8_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

async function spotFiles(folder: string, sinceMs: number, limit: number): Promise<RecentFileScan | undefined> {
  const candidates = await spotlightCandidates(folder);
  if (candidates === undefined) return undefined;
  const files: RecentFile[] = [];
  let total = 0;
  for (const candidate of candidates.slice(0, MAX_MDFIND_FILES)) {
    if (ignoredPath(candidate, folder)) continue;
    const file = await statFile(candidate, sinceMs);
    if (file === undefined) continue;
    total += 1;
    if (files.length < limit) files.push(file);
  }
  files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return { files, total, truncated: total > files.length, source: "spotlight" };
}

async function walkFiles(folder: string, sinceMs: number, limit: number): Promise<RecentFileScan> {
  const deadline = Date.now() + WALK_DEADLINE_MS;
  const files: RecentFile[] = [];
  let total = 0;
  let visited = 0;
  let truncated = false;
  const stack: string[] = [folder];
  while (stack.length > 0) {
    if (visited >= WALK_MAX_DIRECTORIES || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const directory = stack.pop();
    if (directory === undefined) break;
    visited += 1;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Hidden directories are tooling, not work; hidden files (`.env`,
        // `.gitignore`) still change with the owner's edits.
        // 隐藏目录是工具产物，不是工作；隐藏文件（`.env`、`.gitignore`）仍随所有者的编辑变化。
        if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const file = await statFile(absolute, sinceMs);
      if (file === undefined) continue;
      total += 1;
      if (files.length < limit) files.push(file);
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
    }
  }
  files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return { files, total, truncated: truncated || total > files.length, source: "walk" };
}

async function scanFiles(folder: string, sinceMs: number, limit: number, now: Date): Promise<RecentFileScan> {
  // Spotlight only knows "today"; an older cutoff goes through the bounded walk.
  // Spotlight 只知道"今天"；更早的截止时间走有界遍历。
  const spotlight = sinceMs >= localMidnight(now).getTime()
    ? await spotFiles(folder, sinceMs, limit)
    : undefined;
  if (spotlight !== undefined && spotlight.total > 0) return spotlight;
  return walkFiles(folder, sinceMs, limit);
}

async function findRepositories(folder: string): Promise<string[]> {
  const repositories: string[] = [];
  const stack: Array<{ directory: string; depth: number }> = [{ directory: folder, depth: 0 }];
  while (stack.length > 0 && repositories.length < MAX_REPOSITORIES) {
    const next = stack.pop();
    if (next === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(next.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // A worktree's `.git` is a file, not a directory; both mark a repository.
      // 工作区的 `.git` 是文件而不是目录；两者都表示一个仓库。
      if (entry.name === ".git") {
        repositories.push(next.directory);
        break;
      }
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
      if (next.depth < 3) stack.push({ directory: join(next.directory, entry.name), depth: next.depth + 1 });
    }
  }
  return repositories;
}

async function git(repository: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
      timeout: 4_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch {
    return undefined;
  }
}

async function readRepository(repository: string, since: Date): Promise<RepoReport> {
  const branch = await git(repository, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await git(repository, ["status", "--porcelain=v1"]);
  const log = await git(repository, [
    "log",
    `--since=${since.toISOString()}`,
    "--pretty=format:%h%x09%ad%x09%s",
    "--date=format-local:%H:%M",
    "-n", "20",
  ]);
  if (branch === undefined && status === undefined && log === undefined) {
    return { path: repository, status: [], commits: [], error: "git could not read this repository" };
  }
  return {
    path: repository,
    ...(branch === undefined || branch.length === 0 ? {} : { branch }),
    status: (status ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0).slice(0, 20),
    commits: (log ?? "").split("\n").filter((line) => line.length > 0).slice(0, 20).map((line) => {
      const [id = "", at = "", ...subject] = line.split("\t");
      return { id, at, subject: subject.join("\t") };
    }),
  };
}

export async function collectFolderReport(
  folder: string,
  options: { since: Date; limit: number; now?: Date; home?: string },
): Promise<FolderReport> {
  const home = options.home ?? homedir();
  const canonical = canonicalPath(folder, home);
  const empty = (error: string): FolderReport => ({
    folder: canonical,
    files: [],
    totalFiles: 0,
    truncated: false,
    source: "walk",
    repos: [],
    error,
  });
  if (isForbiddenPath(canonical, home)) return empty("This is a protected location; no read is allowed.");
  let info;
  try {
    info = await fs.stat(canonical);
  } catch {
    return empty("This folder does not exist.");
  }
  if (!info.isDirectory()) return empty("This path is a file, not a folder.");

  const scan = await scanFiles(canonical, options.since.getTime(), options.limit, options.now ?? new Date());
  const repos = await findRepositories(canonical);
  const reports: RepoReport[] = [];
  for (const repository of repos) reports.push(await readRepository(repository, options.since));
  return {
    folder: canonical,
    files: scan.files,
    totalFiles: scan.total,
    truncated: scan.truncated,
    source: scan.source,
    repos: reports,
  };
}

export function formatFolderReport(report: FolderReport, folderNote?: string): string {
  const lines: string[] = [];
  lines.push(`Folder: ${report.folder}${folderNote === undefined ? "" : ` — ${folderNote}`}`);
  if (report.error !== undefined) {
    lines.push(`Could not read: ${report.error}`);
    return lines.join("\n");
  }
  const shown = report.files.length;
  lines.push(`Files whose content changed: ${report.totalFiles}${report.totalFiles > shown ? ` (listing the newest ${shown})` : ""}${report.source === "walk" ? " (directory walk; Spotlight unavailable or unindexed)" : ""}`);
  for (const file of report.files) {
    lines.push(`- ${relative(report.folder, file.path)} — ${localStamp(file.modifiedAt)}`);
  }
  if (report.totalFiles > shown && report.truncated) {
    lines.push(`…${report.totalFiles - shown} more not listed. Raise the limit to see them.`);
  }
  if (report.repos.length > 0) {
    lines.push(`Git repositories: ${report.repos.length}`);
    for (const repo of report.repos) {
      const name = relative(report.folder, repo.path) || repo.path;
      if (repo.error !== undefined) {
        lines.push(`- ${name}: ${repo.error}`);
        continue;
      }
      const branch = repo.branch === undefined ? "" : ` (${repo.branch})`;
      const status = repo.status.length === 0 ? "working tree clean" : `${repo.status.length} uncommitted change(s)`;
      const commits = repo.commits.length === 0 ? "no commits since the cutoff" : `${repo.commits.length} commit(s) since the cutoff`;
      lines.push(`- ${name}${branch}: ${status}; ${commits}`);
      for (const change of repo.status.slice(0, 8)) lines.push(`    ${change}`);
      for (const commit of repo.commits.slice(0, 8)) lines.push(`    ${commit.id} ${commit.at} ${commit.subject}`);
    }
  } else {
    lines.push("Git repositories: none under this folder.");
  }
  return lines.join("\n");
}

function folderNote(folder: KnownFolder): string {
  return `learned from ${folder.uses} past request(s), last ${localStamp(folder.lastUsedAt)}`;
}

/**
 * The tool the Main Agent calls for "what changed today". It takes a folder
 * only when the owner names one; otherwise it reads what the twin remembers.
 * 主 Agent 为"今天改了什么"调用的工具。只有所有者点名时才接收文件夹；否则读取分身记住的。
 */
export function recentFileChangesTool(options: RecentChangesOptions): PlainKernelTool {
  return {
    name: "recent_file_changes",
    label: "Recent File Changes",
    description:
      "Read what changed in the owner's folders since a point in time: files whose content changed (Spotlight on macOS; a bounded walk elsewhere), "
      + "plus each git repository's branch, uncommitted changes and commits. Read-only. "
      + "Call this when the owner asks what they worked on today, what changed recently, or to 整理今天的工作信息 — before saying there is no work material. "
      + "With no path it reads the folders the twin has learned from the owner's past requests; there is no folder setting. "
      + "Pass a path only when the owner names a different folder.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({
        description: "Absolute folder path or ~/path. Omit to use the folders learned from the owner's past requests.",
      })),
      since: Type.Optional(Type.String({
        description: "ISO timestamp, \"today\" (local midnight, the default), \"24h\", or \"yesterday\".",
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum files listed per folder. Defaults to 60.",
      })),
    }),
    execute: async (_toolCallId, params: Record<string, unknown>) => {
      const now = options.now?.() ?? new Date();
      const limit = Math.max(1, Math.min(200, Math.trunc(Number(params.limit ?? 60)) || 60));
      let since: Date;
      try {
        since = parseSince(typeof params.since === "string" ? params.since : undefined, now);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { error: message } };
      }

      const explicit = typeof params.path === "string" && params.path.trim().length > 0
        ? params.path.trim()
        : undefined;
      const learned = explicit === undefined
        ? await knownOwnerFolders(options.dataDirectory, {
          ...(options.query === undefined ? {} : { query: options.query }),
          ...(options.home === undefined ? {} : { home: options.home }),
          now: now.toISOString(),
          limit: 5,
        })
        : [];
      const folders: Array<{ path: string; note?: string }> = explicit !== undefined
        ? [{ path: explicit }]
        : learned.length > 0
          ? learned.map((folder) => ({ path: folder.path, note: folderNote(folder) }))
          : options.workspacePath === undefined
            ? []
            : [{ path: options.workspacePath, note: "the current workspace; no folder has been learned yet" }];

      if (folders.length === 0) {
        const message = "No folder has been learned yet and none was named. Ask the owner which folder to read, or dispatch a read-only step.";
        return { content: [{ type: "text", text: message }], details: { folders: [] } };
      }

      const reports: FolderReport[] = [];
      for (const folder of folders) {
        reports.push(await collectFolderReport(folder.path, {
          since,
          limit,
          now,
          ...(options.home === undefined ? {} : { home: options.home }),
        }));
      }
      const header = `Changes since ${localStamp(since)} (local time).`;
      const text = [header, ...reports.map((report, index) => formatFolderReport(report, folders[index]?.note))].join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: { since: since.toISOString(), folders: reports.map((report) => ({ folder: report.folder, totalFiles: report.totalFiles, repos: report.repos.length, error: report.error })) },
      };
    },
  };
}
