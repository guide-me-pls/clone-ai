/**
 * Small directory-based locks shared by the Main Agent prompt lock and the
 * capacity slot pool.
 *
 * A lock is a directory because `mkdir` is the one filesystem operation that
 * both creates and tests atomically: two processes cannot both succeed. The
 * owner file is written immediately after the directory, so a reader that sees
 * a directory without an owner waits out a short grace period instead of
 * stealing a lock that is still being created.
 *
 * Stale reclamation goes through a second directory (`<lock>.steal`). Only one
 * process can hold that mutex, so two reclaimers cannot both decide the same
 * lock is dead and then race to replace it. Release compares the owner token
 * before removing anything, so a slow process cannot delete a successor's
 * fresh lock.
 *
 * 主 Agent 提示锁与容量槽位池共用的小型目录锁。
 *
 * 锁是一个目录，因为 `mkdir` 是唯一既创建又测试的原子文件操作：两个进程不可能同时成功。
 * 属主文件在目录创建后立即写入，因此看到"目录存在但没有属主文件"的读者会先等过一个很短
 * 的宽限期，而不是偷走一把仍在创建中的锁。
 *
 * 陈旧锁的回收经由第二个目录（`<lock>.steal`）。只有一个进程能持有那把互斥锁，因此两个
 * 回收者不会同时判定同一把锁已死、再竞相替换它。释放前会比较属主令牌，慢进程因此无法删除
 * 后继者的新锁。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LockOwner {
  pid: number;
  /** Unique per acquisition; release only removes its own token. 每次获取唯一；释放只删除自己的令牌。 */
  token: string;
  startedAt: string;
}

export interface LockInspection {
  kind: "directory" | "file";
  mtimeMs: number;
  owner?: LockOwner;
}

export interface DirectoryLock {
  release(): Promise<void>;
}

const OWNER_FILE = "owner";
export const LOCK_GRACE_MS = 5_000;

/**
 * Tries once to take the lock. `undefined` means another live owner holds it;
 * a stale owner is reclaimed atomically through the steal mutex and the
 * acquisition is retried.
 * 尝试获取一次。`undefined` 表示另一个存活的属主持有它；陈旧属主经偷取互斥锁被原子回收，
 * 然后重试获取。
 */
export async function tryAcquireDirectoryLock(
  path: string,
  options: { graceMs?: number } = {},
): Promise<DirectoryLock | undefined> {
  const graceMs = Math.max(200, options.graceMs ?? LOCK_GRACE_MS);
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      if (!(await reclaimIfStale(path, graceMs))) return undefined;
      // The stale lock was removed; try the creation again. 陈旧锁已删除，再次尝试创建。
    }
  }
  // The window between mkdir and this write is covered by the grace period: a
  // reader treats a directory with no owner file as live until it is old.
  // mkdir 与这次写入之间的窗口由宽限期覆盖：读者把没有属主文件且尚年轻的目录视为存活。
  const owner: LockOwner = {
    pid: process.pid,
    token: randomBytes(12).toString("hex"),
    startedAt: new Date().toISOString(),
  };
  try {
    await writeFile(join(path, OWNER_FILE), `${JSON.stringify(owner)}\n`, "utf8");
  } catch (error: unknown) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    release: async () => {
      const current = await readOwnerFile(join(path, OWNER_FILE));
      if (current?.token !== owner.token) return;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Reads what is at a lock path, including a legacy pid-only file. 读取锁路径上的内容，包括只有 pid 的旧文件。 */
export async function inspectLock(path: string): Promise<LockInspection | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch (error: unknown) {
    if (isGone(error)) return undefined;
    throw error;
  }
  if (info.isDirectory()) {
    const owner = await readOwnerFile(join(path, OWNER_FILE));
    return { kind: "directory", mtimeMs: info.mtimeMs, ...(owner === undefined ? {} : { owner }) };
  }
  const owner = await readLegacyFile(path);
  return { kind: "file", mtimeMs: info.mtimeMs, ...(owner === undefined ? {} : { owner }) };
}

/**
 * A lock is live when its owner process is alive, or — for a lock caught
 * between creation and its owner write — when it is younger than the grace.
 * 属主进程存活时锁为存活；对于刚创建、属主文件尚未写入的锁，只要还年轻于宽限期也算存活。
 */
export function isLockLive(inspection: LockInspection | undefined, graceMs = LOCK_GRACE_MS): boolean {
  if (inspection === undefined) return false;
  if (inspection.owner !== undefined) return isProcessAlive(inspection.owner.pid);
  return Date.now() - inspection.mtimeMs < graceMs;
}

/** Removes a stale lock, whether it is the current directory form or a legacy file. 删除陈旧锁，无论它是当前目录形式还是旧文件。 */
export async function removeLockPath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

async function reclaimIfStale(path: string, graceMs: number): Promise<boolean> {
  const stealPath = `${path}.steal`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(stealPath);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      const info = await stat(stealPath).catch(() => undefined);
      if (info !== undefined && Date.now() - info.mtimeMs > graceMs) {
        await rm(stealPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      return false;
    }
    try {
      const inspection = await inspectLock(path);
      if (inspection === undefined) return true;
      if (isLockLive(inspection, graceMs)) return false;
      await removeLockPath(path);
      return true;
    } finally {
      await rm(stealPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return false;
}

async function readOwnerFile(path: string): Promise<LockOwner | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return parseOwner(source, undefined);
}

async function readLegacyFile(path: string): Promise<LockOwner | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return parseOwner(source, path);
}

function parseOwner(source: string, path: string | undefined): LockOwner | undefined {
  const trimmed = source.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      && typeof parsed.token === "string" && parsed.token.length > 0) {
      return {
        pid: parsed.pid,
        token: parsed.token,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString(),
      };
    }
  } catch {
    // A legacy lock is just the pid on its own line. 旧锁只有单独一行 pid。
  }
  const pid = Number(trimmed);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    token: `legacy:${path ?? "owner"}`,
    startedAt: new Date().toISOString(),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to another user; a local
    // clone home is normally the same user, but treating it as live is safer.
    // EPERM 表明进程存在但属于另一个用户；本地 clone home 通常属于同一用户，但视为存活更安全。
    return !isGone(error);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "EEXIST";
}

function isGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code: string }).code === "ESRCH" || (error as { code: string }).code === "ENOENT");
}
