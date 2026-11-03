import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CLONE_DIRECTORY_NAME } from "../config/clone-home.ts";

interface LegacyLockOwner {
  pid: number;
  acquiredAt: string;
}

const localQueues = new Map<string, Promise<void>>();
const LOCK_RETRY_MS = 50;
const MALFORMED_LOCK_STALE_MS = 60_000;

/**
 * Serializes work per Workspace. SQLite's exclusive writer lease is released
 * by the OS on process death, avoiding races when multiple processes recover
 * a stale PID lock. An in-process queue avoids blocking the event loop.
 * 按 Workspace 串行工作。SQLite 写锁在进程死亡时由系统释放，避免多个进程回收
 * 过期 PID 锁时的竞争；进程内队列避免阻塞事件循环。
 */
export class WorkspaceExecutionLock {
  async run<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
    const workspace = resolve(workspacePath);
    const previous = localQueues.get(workspace) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const current = new Promise<void>((resolveRelease) => { releaseLocal = resolveRelease; });
    localQueues.set(workspace, current);

    await previous;
    let releaseExternal: (() => Promise<void>) | undefined;
    try {
      releaseExternal = await acquireExternalLock(workspace);
      return await operation();
    } finally {
      try {
        if (releaseExternal !== undefined) await releaseExternal();
      } finally {
        releaseLocal();
        if (localQueues.get(workspace) === current) localQueues.delete(workspace);
      }
    }
  }
}

/** One queue is shared by separately-created runtimes. 独立创建的 Runtime 共用一条队列。 */
export const workspaceExecutionLock = new WorkspaceExecutionLock();

async function acquireExternalLock(workspace: string): Promise<() => Promise<void>> {
  const directory = join(workspace, CLONE_DIRECTORY_NAME);
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "workspace-execution.sqlite3"));
  try {
    db.exec("PRAGMA busy_timeout=0");
    while (true) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error: unknown) {
        if (!isBusy(error)) throw error;
        await delay(LOCK_RETRY_MS);
      }
    }
    await waitForLegacyLock(join(directory, "workspace-execution.lock"));
    return async () => {
      try { db.exec("ROLLBACK"); } finally { db.close(); }
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 没有事务时无需回滚。 */ }
    db.close();
    throw error;
  }
}

async function waitForLegacyLock(path: string): Promise<void> {
  while (true) {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) return;
      throw error;
    }
    let pid: number | undefined;
    try {
      const owner = JSON.parse(source) as Partial<LegacyLockOwner>;
      if (Number.isInteger(owner.pid) && owner.pid !== undefined && owner.pid > 0) pid = owner.pid;
    } catch {
      // A previous version may have died before finishing the lock file.
      // 旧版本可能在写完锁文件之前崩溃。
    }
    let stale: boolean;
    if (pid === undefined) {
      try {
        stale = Date.now() - (await stat(path)).mtimeMs > MALFORMED_LOCK_STALE_MS;
      } catch (error: unknown) {
        if (isMissingFile(error)) return;
        throw error;
      }
    } else stale = isProcessDead(pid);
    if (stale) {
      await unlink(path).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
      return;
    }
    await delay(LOCK_RETRY_MS);
  }
}

function isProcessDead(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && (error.code === "ESRCH" || error.code === "EINVAL");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5;
}
