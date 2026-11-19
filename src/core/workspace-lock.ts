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

export interface WorkspaceLockOptions {
  /**
   * Aborts only the wait for the lock, never an operation that already holds
   * it. Shutdown uses this so a background pass queued behind another process's
   * lock can unwind instead of blocking the process until SIGKILL.
   * 只中止对锁的等待，不中止已经持有锁的操作。关停用它来让排在别的进程锁后面的后台轮
   * 解除等待，而不是把进程阻塞到 SIGKILL。
   */
  signal?: AbortSignal;
}

/**
 * Serializes work per Workspace. SQLite's exclusive writer lease is released
 * by the OS on process death, avoiding races when multiple processes recover
 * a stale PID lock. An in-process queue avoids blocking the event loop.
 * 按 Workspace 串行工作。SQLite 写锁在进程死亡时由系统释放，避免多个进程回收
 * 过期 PID 锁时的竞争；进程内队列避免阻塞事件循环。
 */
export class WorkspaceExecutionLock {
  async run<T>(workspacePath: string, operation: () => Promise<T>, options: WorkspaceLockOptions = {}): Promise<T> {
    const workspace = resolve(workspacePath);
    const previous = localQueues.get(workspace) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const current = new Promise<void>((resolveRelease) => { releaseLocal = resolveRelease; });
    localQueues.set(workspace, current);
    const releaseQueue = (): void => {
      releaseLocal();
      if (localQueues.get(workspace) === current) localQueues.delete(workspace);
    };

    // Waiting for an in-process holder must honour the signal too: an aborted
    // pass queued behind a scheduled run's extraction would otherwise stay
    // parked until that run finishes, and close() waits for the pass.
    // 等待进程内持有者也必须遵守信号：被中止的维护轮若排在定时任务的提炼之后，否则会一直
    // 停到那次运行结束，而 close() 又要等维护轮。
    await waitForPrevious(previous, options.signal, releaseQueue);
    let releaseExternal: (() => Promise<void>) | undefined;
    try {
      releaseExternal = await acquireExternalLock(workspace, options.signal);
      options.signal?.throwIfAborted();
      return await operation();
    } finally {
      try {
        if (releaseExternal !== undefined) await releaseExternal();
      } finally {
        releaseQueue();
      }
    }
  }
}

/** One queue is shared by separately-created runtimes. 独立创建的 Runtime 共用一条队列。 */
export const workspaceExecutionLock = new WorkspaceExecutionLock();

/**
 * Wait for the in-process holder, but stop waiting when the caller aborts. The
 * caller's queue slot still resolves when the holder finishes, so an aborted
 * caller cannot wedge the next waiter behind a promise nobody releases.
 * 等待进程内持有者，但调用方中止时停止等待。调用方的队列槽仍在持有结束后解析，因此被中止
 * 的调用不会把下一个等待者卡在一个无人释放的 Promise 后面。
 */
async function waitForPrevious(previous: Promise<void>, signal: AbortSignal | undefined, releaseQueue: () => void): Promise<void> {
  if (signal === undefined) {
    await previous;
    return;
  }
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([previous, aborted]);
  } catch (error) {
    void previous.finally(releaseQueue);
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function acquireExternalLock(workspace: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const directory = join(workspace, CLONE_DIRECTORY_NAME);
  await mkdir(directory, { recursive: true });
  signal?.throwIfAborted();
  const db = new DatabaseSync(join(directory, "workspace-execution.sqlite3"));
  try {
    db.exec("PRAGMA busy_timeout=0");
    while (true) {
      signal?.throwIfAborted();
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error: unknown) {
        if (!isBusy(error)) throw error;
        await delay(LOCK_RETRY_MS);
      }
    }
    await waitForLegacyLock(join(directory, "workspace-execution.lock"), signal);
    return async () => {
      try { db.exec("ROLLBACK"); } finally { db.close(); }
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 没有事务时无需回滚。 */ }
    db.close();
    throw error;
  }
}

async function waitForLegacyLock(path: string, signal?: AbortSignal): Promise<void> {
  while (true) {
    signal?.throwIfAborted();
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
