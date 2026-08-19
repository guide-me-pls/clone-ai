import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface WorkspaceSnapshot {
  /** Relative path -> content hash. 相对路径 -> 内容哈希。 */
  files: Map<string, string>;
  takenAt: string;
}

export interface WorkspaceChange {
  path: string;
  change: "added" | "modified" | "deleted";
}

export interface WorkspaceSnapshotOptions {
  /** Directory names never walked. 永不遍历的目录名。 */
  ignoredDirectories?: readonly string[];
  /** Refuse to snapshot beyond this many files. 超过该文件数即拒绝快照。 */
  maxFiles?: number;
}

const DEFAULT_IGNORED = [
  ".git",
  ".clone-ai",
  "node_modules",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
] as const;

const DEFAULT_MAX_FILES = 20_000;

/**
 * Evidence taken by observation rather than by asking. A black-box worker
 * cannot be relied on to announce what it produced — it may not know Clone
 * AI's conventions, may summarize inaccurately, or may claim work it never
 * did. Snapshotting the workspace before and after a dispatch makes the
 * artifacts a fact about the filesystem instead of a claim in the worker's
 * output.
 *
 * 通过观察而非询问获得的证据。黑盒 Worker 不能被指望去申报自己产出了什么——它可能
 * 不知道 Clone AI 的约定、可能总结不准确，也可能声称做了从未做过的事。在派发前后对
 * Workspace 拍快照，使产物成为关于文件系统的事实，而不是 Worker 输出里的一句声称。
 */
export async function snapshotWorkspace(
  root: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files = new Map<string, string>();

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is not evidence of a change.
      // 无法读取的目录不构成变更证据。
      return;
    }
    for (const entry of entries) {
      if (files.size >= maxFiles) return;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = relative(root, absolute).split(sep).join("/");
      files.set(key, await hashFile(absolute));
    }
  };

  await walk(root);
  return { files, takenAt: new Date().toISOString() };
}

export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  for (const [path, hash] of after.files) {
    const previous = before.files.get(path);
    if (previous === undefined) changes.push({ path, change: "added" });
    else if (previous !== hash) changes.push({ path, change: "modified" });
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) changes.push({ path, change: "deleted" });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * A deleted file is a real change but not a durable artifact, so only added
 * and modified files can back an artifact claim.
 * 被删除的文件是真实变更但不是可留存的产物，因此只有新增与修改的文件才能支撑
 * Artifact 声明。
 */
export function artifactChanges(changes: readonly WorkspaceChange[]): WorkspaceChange[] {
  return changes.filter((change) => change.change !== "deleted");
}

export function describeChanges(changes: readonly WorkspaceChange[], limit = 20): string {
  if (changes.length === 0) return "no workspace changes";
  const listed = changes.slice(0, limit).map((change) => `${change.change[0]} ${change.path}`).join(", ");
  return changes.length <= limit ? listed : `${listed}, and ${changes.length - limit} more`;
}

async function hashFile(path: string): Promise<string> {
  try {
    const info = await stat(path);
    // Large files are identified by size and mtime: reading them in full would
    // make snapshotting cost more than the work being supervised.
    // 大文件用大小与修改时间标识：完整读取会让拍快照的成本超过被监督的工作本身。
    if (info.size > 2_000_000) return `meta:${info.size}:${info.mtimeMs}`;
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}
