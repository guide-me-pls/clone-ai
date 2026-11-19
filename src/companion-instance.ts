/**
 * One companion runtime per clone home.
 *
 * The clone home holds one journal, one scheduler, one turn ledger and one
 * published endpoint. Two sidecars on the same home are not two windows onto
 * one runtime: they hydrate the same journal independently, race its
 * transitions, both claim the turn ledger, overwrite each other's endpoint, and
 * the one that exits first deletes an endpoint the other still needs. The
 * window then waits for an endpoint that no process is going to publish.
 *
 * A directory lock is taken before the journal is hydrated, so a second process
 * is refused before it writes anything. The lock is reclaimed when its owner
 * pid is gone; release only removes the lock this process still owns.
 *
 * 每个 clone home 只跑一个 companion 运行时。
 *
 * clone home 里只有一本 Journal、一个调度器、一份回合台账与一个已发布端点。同一 home 上
 * 的两个 sidecar 不是"一个运行时的两扇窗"：它们各自重放同一本 Journal、竞态它的状态转换、
 * 都声明回合台账、互相覆盖端点，而先退出的那个会删掉另一个仍需要的端点。窗口随后等待一个
 * 不会再被发布的端点。
 *
 * 目录锁在重放 Journal 之前取得，因此第二个进程在写入任何东西之前就被拒绝。属主 pid 已
 * 消失时锁会被回收；释放只删除本进程仍持有的锁。
 */
import { join } from "node:path";

import { inspectLock, tryAcquireDirectoryLock, type DirectoryLock } from "./main-agent/file-lock.ts";

/** The lock directory inside the clone home. clone home 内的锁目录。 */
export const COMPANION_INSTANCE_LOCK = "companion-runtime.lock";

export class CompanionAlreadyRunningError extends Error {
  readonly dataDirectory: string;
  readonly pid: number | undefined;

  constructor(dataDirectory: string, pid: number | undefined) {
    super(
      pid === undefined
        ? `Another Clone AI runtime is starting in ${dataDirectory}; retry in a moment.`
        : `Another Clone AI runtime (pid ${pid}) already owns ${dataDirectory}; stop it or set CLONE_HOME to a separate home.`,
    );
    this.name = "CompanionAlreadyRunningError";
    this.dataDirectory = dataDirectory;
    this.pid = pid;
  }
}

/**
 * Takes the home's runtime lock, or throws with the live owner's pid.
 * 取得该 home 的运行时锁，或带着存活属主的 pid 抛出。
 */
export async function acquireCompanionInstanceLock(dataDirectory: string): Promise<DirectoryLock> {
  const path = join(dataDirectory, COMPANION_INSTANCE_LOCK);
  const lock = await tryAcquireDirectoryLock(path);
  if (lock !== undefined) return lock;
  const owner = (await inspectLock(path))?.owner;
  throw new CompanionAlreadyRunningError(dataDirectory, owner?.pid);
}