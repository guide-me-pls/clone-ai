import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

interface LockOwner {
  pid: number;
  acquiredAt: string;
}

const localQueues = new Map<string, Promise<void>>();
const LOCK_RETRY_MS = 50;
const MALFORMED_LOCK_STALE_MS = 60_000;

/**
 * Serializes work against one Workspace and leaves an atomic marker for other
 * Supervisor processes. The conservative first version uses one exclusive
 * lease for readers and writers alike: safety comes before parallelism.
 * 对同一个 Workspace 串行化工作，并为其他 Supervisor 进程留下原子标记。第一版保守地
 * 对读写都使用独占 lease：先保证安全，再考虑并行度。
 */
export class WorkspaceExecutionLock {
  async run<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
    const workspace = resolve(workspacePath);
    const previous = localQueues.get(workspace) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      releaseLocal = resolveRelease;
    });
    localQueues.set(workspace, current);

    await previous;
    let releaseExternal: (() => Promise<void>) | undefined;
    try {
      releaseExternal = await acquireExternalLock(workspace);
      return await operation();
    } finally {
      if (releaseExternal !== undefined) await releaseExternal();
      releaseLocal();
      if (localQueues.get(workspace) === current) localQueues.delete(workspace);
    }
  }
}

/**
 * One process-wide queue lets separately-created CloneRuntime instances share the lease.
 * 进程级的单一队列，让各自创建的 CloneRuntime 实例共享同一个 lease。
 */
export const workspaceExecutionLock = new WorkspaceExecutionLock();

async function acquireExternalLock(workspace: string): Promise<() => Promise<void>> {
  const directory = join(workspace, ".clone-ai");
  const path = join(directory, "workspace-execution.lock");
  await mkdir(directory, { recursive: true });

  while (true) {
    try {
      const handle = await open(path, "wx");
      const owner: LockOwner = { pid: process.pid, acquiredAt: new Date().toISOString() };
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.close();
      return async () => {
        await unlink(path).catch((error: unknown) => {
          if (!isMissingFile(error)) throw error;
        });
      };
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      if (await reclaimIfStale(path)) continue;
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function reclaimIfStale(path: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    return isMissingFile(error);
  }

  try {
    const owner = JSON.parse(source) as Partial<LockOwner>;
    if (Number.isInteger(owner.pid) && owner.pid !== undefined) {
      if (isProcessDead(owner.pid)) {
        await unlink(path).catch(() => undefined);
        return true;
      }
      return false;
    }
  } catch {
    // A supervisor may have died between creating and writing the owner JSON.
    // Supervisor 可能在创建锁文件与写入 Owner JSON 之间崩溃。
  }

  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > MALFORMED_LOCK_STALE_MS) {
      await unlink(path).catch(() => undefined);
      return true;
    }
  } catch (error: unknown) {
    return isMissingFile(error);
  }
  return false;
}

function isProcessDead(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error.code === "ESRCH" || error.code === "EINVAL");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
