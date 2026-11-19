/**
 * A cross-process pool of Main Agent turn slots.
 *
 * The daemon, the CLI and the WhatsApp bridge are separate processes, so an
 * in-process semaphore would let each of them run up to the full limit. Each
 * slot is a directory lock; allocation happens under a short-lived pool mutex,
 * so two processes cannot both read "one slot free" and take two. The pool
 * counts live slots across all indices, which means a limit that shrinks while
 * slots are held really stops admitting new turns instead of admitting them
 * into the low indices that just freed up.
 *
 * 跨进程的 Main Agent 回合槽位池。
 *
 * Daemon、CLI 与 WhatsApp 桥是不同进程，进程内信号量会让每个进程都跑到完整上限。每个槽位
 * 是一把目录锁；分配在一把短命的池互斥锁下进行，因此两个进程不会同时读到"还剩一个槽位"而
 * 各拿走一个。池统计所有编号上的存活槽位，因此上限收缩时真的会停止接纳新回合，而不是把新
 * 回合计入刚刚释放的低编号槽位。
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  isLockLive,
  inspectLock,
  removeLockPath,
  tryAcquireDirectoryLock,
  type DirectoryLock,
} from "./file-lock.ts";
import {
  readMainAgentCapacityPin,
  sampleMainAgentCapacity,
  type MainAgentCapacitySnapshot,
} from "./main-agent-capacity.ts";

/** The pool is full and the wait was aborted. 槽位池已满，且等待被中止。 */
export class MainAgentCapacityError extends Error {
  constructor(message = "The Main Agent capacity wait was cancelled before a slot became free.") {
    super(message);
    this.name = "MainAgentCapacityError";
  }
}

export interface MainAgentSlotOptions {
  /** Stops the wait without taking a slot. 中止等待，不占用槽位。 */
  signal?: AbortSignal;
  /** Test seam: a fixed snapshot instead of the live machine. 测试切口：固定快照，而不是实时机器。 */
  sample?: () => MainAgentCapacitySnapshot | Promise<MainAgentCapacitySnapshot>;
  /** How often a waiting acquirer re-samples the limit. 等待者重新采样上限的间隔。 */
  pollMs?: number;
  /** Called when a turn could not take a slot this pass, so a stream can show the wait. 本轮拿不到槽位时调用，使流式界面能显示等待。 */
  onWait?: (snapshot: MainAgentCapacitySnapshot) => void;
}

export function mainAgentSlotsDirectory(dataDirectory: string): string {
  return join(dataDirectory, "pi-sessions", "main-agent", "slots");
}

/**
 * Acquires a slot for the duration of `run` and always releases it. A caller
 * that throws still frees the slot; a leaked slot would shrink the pool until
 * its process died.
 * 在 `run` 期间获取槽位并始终释放。抛错的调用方同样释放槽位；泄漏的槽位会一直缩小槽位池，
 * 直到其进程退出。
 */
export async function withMainAgentSlot<T>(
  dataDirectory: string,
  run: () => Promise<T>,
  options: MainAgentSlotOptions = {},
): Promise<T> {
  const release = await acquireMainAgentSlot(dataDirectory, options);
  try {
    return await run();
  } finally {
    await release();
  }
}

/**
 * Waits until fewer than the current limit slots are live. The limit is
 * re-sampled on every pass, so load that falls lets a queued turn in without a
 * restart, and a limit that shrinks stops admitting new turns while those
 * already holding slots finish normally.
 * 等到存活槽位少于当前上限。每一轮都重新采样上限，因此负载下降时排队的回合无需重启即可
 * 进入；上限收缩时停止接纳新回合，已持有槽位的回合正常跑完。
 */
export async function acquireMainAgentSlot(
  dataDirectory: string,
  options: MainAgentSlotOptions = {},
): Promise<() => Promise<void>> {
  const directory = mainAgentSlotsDirectory(dataDirectory);
  await mkdir(directory, { recursive: true });
  const sample = options.sample ?? defaultSample(dataDirectory);
  const pollMs = Math.max(20, options.pollMs ?? 200);
  for (;;) {
    if (options.signal?.aborted === true) throw new MainAgentCapacityError();
    const sampled = await sample();
    const limit = Math.max(1, Math.trunc(sampled.limit));
    const mutex = await acquirePoolMutex(directory, options.signal);
    let admitted: (() => Promise<void>) | undefined;
    try {
      const slots = await listSlots(directory);
      const used = new Set<number>();
      let live = 0;
      for (const slot of slots) {
        if (isLockLive(slot.inspection)) {
          used.add(slot.index);
          live += 1;
          continue;
        }
        await removeLockPath(slot.path);
      }
      if (live < limit) {
        const lock = await tryAcquireDirectoryLock(join(directory, `slot-${nextFreeIndex(used)}`));
        if (lock !== undefined) admitted = lock.release;
      }
    } finally {
      await mutex.release();
    }
    if (admitted !== undefined) return admitted;
    options.onWait?.(sampled);
    await waitBeforeRetry(pollMs, options.signal);
  }
}

function defaultSample(dataDirectory: string): () => Promise<MainAgentCapacitySnapshot> {
  return async () => sampleMainAgentCapacity(pinOption(await readMainAgentCapacityPin(dataDirectory)));
}

function pinOption(pinnedLimit: number | undefined): { pinnedLimit?: number } {
  return pinnedLimit === undefined ? {} : { pinnedLimit };
}

async function acquirePoolMutex(directory: string, signal?: AbortSignal): Promise<DirectoryLock> {
  const path = join(directory, ".pool.lock");
  for (;;) {
    if (signal?.aborted === true) throw new MainAgentCapacityError();
    // The mutex is held for a directory listing and one mkdir; a one-second
    // grace only matters when its owner crashed inside that window.
    // 互斥锁只覆盖一次目录枚举与一次 mkdir；一秒宽限期只在属主于该窗口内崩溃时才有意义。
    const lock = await tryAcquireDirectoryLock(path, { graceMs: 1_000 });
    if (lock !== undefined) return lock;
    await waitBeforeRetry(50, signal);
  }
}

interface Slot {
  index: number;
  path: string;
  inspection: Awaited<ReturnType<typeof inspectLock>>;
}

async function listSlots(directory: string): Promise<Slot[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const slots: Slot[] = [];
  for (const entry of entries) {
    const match = /^slot-(\d+)$/.exec(entry.name);
    if (match === null) continue;
    const path = join(directory, entry.name);
    slots.push({ index: Number(match[1]), path, inspection: await inspectLock(path) });
  }
  return slots.sort((left, right) => left.index - right.index);
}

function nextFreeIndex(used: Set<number>): number {
  let index = 0;
  while (used.has(index)) index += 1;
  return index;
}

/** Waits one poll interval, rejecting as soon as the caller aborts. 等待一个轮询间隔，调用方中止时立即拒绝。 */
function waitBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new MainAgentCapacityError());
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new MainAgentCapacityError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
