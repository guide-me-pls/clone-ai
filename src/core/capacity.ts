/**
 * Machine capacity for worker dispatch: how many runs may execute at once.
 *
 * The owner asked dispatch concurrency to follow the machine instead of the
 * plan's shape. Measuring is deterministic and testable; letting the model pick
 * a number would make concurrency depend on a sampled token. The Kernel reads
 * this snapshot, a shared limiter enforces it, and the Main Agent may only read
 * it to size a plan.
 *
 * Worker 派发的机器容量：同时允许多少个 Run 执行。
 *
 * 所有者要求派发并发跟随机器，而不是计划形状。测量是确定性的、可测试的；让模型挑数字
 * 会让并发取决于一次采样出的 token。Kernel 读取这份快照，共享限流器执行它，主 Agent
 * 只能读它来决定计划规模。
 */
import { cpus, freemem, loadavg, totalmem } from "node:os";

export interface CapacityInput {
  cpuCount: number;
  loadAverage1m: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  /** Owner-pinned ceiling; undefined or 0 means auto. 所有者固定上限；未设置或 0 表示自动。 */
  pinnedLimit?: number;
}

export interface CapacitySnapshot {
  /** CPU cores the OS reports. OS 报告的 CPU 核数。 */
  cpuCount: number;
  loadAverage1m: number;
  freeMemoryMb: number;
  totalMemoryMb: number;
  /** Slots the Kernel will allow at once. Kernel 同时允许的槽位数。 */
  limit: number;
  /** True when the owner pinned the limit. 所有者固定了上限时为 true。 */
  pinned: boolean;
  /** Why this limit, in words the owner can check. 这个上限的理由，用所有者能核对的话表述。 */
  reason: string;
}

/** Memory reserved for the model process and the OS; not worker slots. 为模型进程与系统保留的内存，不是 Worker 槽位。 */
const RESERVED_MEMORY_MB = 1_024;
/** Per-worker working set assumed by the auto formula. 自动公式假定的每个 Worker 工作集。 */
const WORKER_MEMORY_MB = 768;
/** Auto never exceeds this, even on a very large host. 即使在很大的主机上，自动模式也不超过这个数。 */
const AUTO_CEILING = 16;

/**
 * Pure function: the same inputs always give the same limit, so the gate is
 * testable without touching the real machine.
 * 纯函数：相同输入总是得到相同上限，因此无需触碰真实机器即可测试闸门。
 */
export function computeCapacity(input: CapacityInput): CapacitySnapshot {
  const cpuCount = Math.max(1, Math.trunc(input.cpuCount));
  const freeMemoryMb = Math.max(0, Math.floor(input.freeMemoryBytes / (1024 * 1024)));
  const totalMemoryMb = Math.max(0, Math.floor(input.totalMemoryBytes / (1024 * 1024)));
  const load = Number.isFinite(input.loadAverage1m) ? Math.max(0, input.loadAverage1m) : 0;

  if (input.pinnedLimit !== undefined && input.pinnedLimit > 0) {
    const limit = Math.min(Math.trunc(input.pinnedLimit), cpuCount);
    return {
      cpuCount,
      loadAverage1m: Number(load.toFixed(2)),
      freeMemoryMb,
      totalMemoryMb,
      limit,
      pinned: true,
      reason: `The owner pinned ${input.pinnedLimit}; capped at the ${cpuCount} CPU cores.`,
    };
  }

  // Two independent bounds. CPU: never more slots than cores, and never more
  // than half the cores are already busy. Memory: only what is free after a
  // reserved margin, at the assumed per-worker working set.
  // 两个独立上限。CPU：槽位不超过核数，也不超过"空闲一半核数"的量。内存：扣除保留余量后
  // 剩下的空闲内存，按每个 Worker 的假定工作集折算。
  const cpuBudget = Math.max(1, Math.floor(cpuCount * (load >= cpuCount * 0.5 ? 0.25 : 0.75)));
  const memoryBudget = Math.max(1, Math.floor((freeMemoryMb - RESERVED_MEMORY_MB) / WORKER_MEMORY_MB));
  const limit = Math.max(1, Math.min(AUTO_CEILING, cpuCount, cpuBudget, memoryBudget));
  const binding = cpuBudget <= memoryBudget ? "CPU" : "free memory";
  return {
    cpuCount,
    loadAverage1m: Number(load.toFixed(2)),
    freeMemoryMb,
    totalMemoryMb,
    limit,
    pinned: false,
    reason: `${limit} slot(s): bound by ${binding} (${cpuBudget} CPU budget, ${memoryBudget} memory budget, load ${load.toFixed(2)}).`,
  };
}

/** The live machine. 实时机器读数。 */
export function sampleCapacity(options: { pinnedLimit?: number } = {}): CapacitySnapshot {
  return computeCapacity({
    cpuCount: cpus().length,
    loadAverage1m: loadavg()[0] ?? 0,
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
    ...(options.pinnedLimit === undefined ? {} : { pinnedLimit: options.pinnedLimit }),
  });
}

/**
 * A counting semaphore shared by every worker execution in this process. It is
 * re-read on each acquire, so a limit change (owner setting, or a machine under
 * load) takes effect without a restart.
 * 本进程内所有 Worker 执行共享的计数信号量。每次获取时重新读取，因此上限变化（所有者
 * 设置或机器负载）无需重启即可生效。
 */
export class CapacityGate {
  readonly #sample: () => CapacitySnapshot;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(sample: () => CapacitySnapshot = () => sampleCapacity()) {
    this.#sample = sample;
  }

  /** Slots in use right now. 当前占用的槽位。 */
  get active(): number {
    return this.#active;
  }

  /** Queued acquisitions. 排队中的获取请求。 */
  get waiting(): number {
    return this.#waiters.length;
  }

  /** Current snapshot, for the audit and the Main Agent's read-only tool. 当前快照，供审计与主 Agent 的只读工具。 */
  snapshot(): CapacitySnapshot {
    return this.#sample();
  }

  /**
   * Waits for a slot and returns the release function. A caller that never
   * calls release would leak a slot, so this returns a function rather than
   * exposing acquire/release separately.
   * 等待一个槽位并返回释放函数。调用方不释放会泄漏槽位，因此返回函数而不是分开的
   * acquire/release。
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw new Error("Capacity wait was cancelled.");
    const limit = Math.max(1, this.#sample().limit);
    if (this.#active < limit && this.#waiters.length === 0) {
      this.#active += 1;
      return () => this.#release();
    }
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(wake);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("Capacity wait was cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(wake);
    });
    // #release already counted this waiter's slot when it woke it. 唤醒时 #release 已计入该等待者的槽位。
    return () => this.#release();
  }

  /**
   * Release a slot and wake the next waiter.
   *
   * The slot is transferred, not freed: the waiter's slot is counted here, in
   * the same synchronous step, so an acquire() that runs before the woken
   * waiter resumes cannot take a slot that was already promised. Previously
   * the decrement happened here and the increment in the waiter's microtask,
   * and a synchronous acquire in between put `limit + 1` executions in flight.
   * 释放槽位并唤醒下一个等待者。
   *
   * 槽位是转移而不是让出：等待者的槽位在这一同步步骤内计入，因此被唤醒者恢复之前执行的
   * acquire() 拿不到一个已经许诺出去的槽位。此前减一在这里、加一在等待者的微任务里，
   * 其间一次同步 acquire 就能让 `limit + 1` 个执行同时在跑。
   */
  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    const next = this.#waiters.shift();
    if (next === undefined) return;
    this.#active += 1;
    next();
  }
}