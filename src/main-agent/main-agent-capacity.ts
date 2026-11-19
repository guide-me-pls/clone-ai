/**
 * How many Main Agent turns may run at once, measured from the machine.
 *
 * A turn mostly waits on a remote model, so CPU and load are the honest
 * ceiling; memory is not. `os.freemem()` reports only truly free pages on
 * macOS, where the OS deliberately uses most of RAM for cache — trusting it
 * serialized every task on the primary platform. The memory heavy lifting is
 * worker dispatch, which has its own measured gate. The owner can pin this
 * limit too.
 *
 * 同时允许多少个 Main Agent 回合运行，由机器实测决定。
 *
 * 回合大部分时间在等远端模型，因此 CPU 与负载才是诚实的上限，内存不是。macOS 上
 * `os.freemem()` 只报告真正空闲的页，而系统会刻意把大部分内存用作缓存——信任它会让主平台上的
 * 每个任务都被串行化。吃内存的是 Worker 派发，那里有自己的实测闸门。所有者也可以固定此上限。
 */
import { cpus, freemem, loadavg, totalmem } from "node:os";

import { CloneConfigStore } from "../config/clone-config.ts";
import { resolveClonePaths } from "../config/clone-home.ts";

export interface MainAgentCapacityInput {
  cpuCount: number;
  loadAverage1m: number;
  /** Reported for the audit; it does not bound the limit. 供审计展示；不约束上限。 */
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  /** Owner-pinned ceiling; undefined or 0 means auto. 所有者固定上限；未设置或 0 表示自动。 */
  pinnedLimit?: number;
}

export interface MainAgentCapacitySnapshot {
  /** CPU cores the OS reports. OS 报告的 CPU 核数。 */
  cpuCount: number;
  loadAverage1m: number;
  freeMemoryMb: number;
  totalMemoryMb: number;
  /** Main Agent turns the runtime will run at once. 运行时同时运行的 Main Agent 回合数。 */
  limit: number;
  /** True when the owner pinned the limit. 所有者固定了上限时为 true。 */
  pinned: boolean;
  /** Why this limit, in words the owner can check. 这个上限的理由，用所有者能核对的话表述。 */
  reason: string;
}

/** Auto never exceeds this, even on a very large host. 即使在很大的主机上，自动模式也不超过这个数。 */
const AUTO_CEILING = 8;

/**
 * Pure function: the same inputs always give the same limit, so the gate is
 * testable without touching the real machine.
 * 纯函数：相同输入总是得到相同上限，因此无需触碰真实机器即可测试闸门。
 */
export function computeMainAgentCapacity(input: MainAgentCapacityInput): MainAgentCapacitySnapshot {
  const cpuCount = Math.max(1, Math.trunc(input.cpuCount));
  const freeMemoryMb = Math.max(0, Math.floor(input.freeMemoryBytes / (1024 * 1024)));
  const totalMemoryMb = Math.max(0, Math.floor(input.totalMemoryBytes / (1024 * 1024)));
  const load = Number.isFinite(input.loadAverage1m) ? Math.max(0, input.loadAverage1m) : 0;

  if (input.pinnedLimit !== undefined && input.pinnedLimit > 0) {
    const limit = Math.max(1, Math.min(Math.trunc(input.pinnedLimit), cpuCount));
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

  // Half a core per turn, two when the machine has room so a second task
  // starts on a small laptop. A machine already half busy halves the budget
  // again, down to one. The limit never exceeds the core count.
  // 每回合约半个核，机器有余量时给两个，使小笔记本也能启动第二个任务。机器已有一半忙时
  // 预算再减半，最低到一。上限不超过核数。
  const cpuBudget = Math.max(2, Math.floor(cpuCount / 2));
  const loaded = load >= cpuCount * 0.5;
  const loadBudget = loaded ? Math.max(1, Math.floor(cpuBudget / 2)) : cpuBudget;
  const limit = Math.max(1, Math.min(AUTO_CEILING, cpuCount, loadBudget));
  return {
    cpuCount,
    loadAverage1m: Number(load.toFixed(2)),
    freeMemoryMb,
    totalMemoryMb,
    limit,
    pinned: false,
    reason: `${limit} slot(s): bound by ${loaded ? "CPU load" : "CPU cores"} (${loadBudget} CPU budget, load ${load.toFixed(2)}). Worker memory is gated at dispatch.`,
  };
}

/** The live machine. 实时机器读数。 */
export function sampleMainAgentCapacity(options: { pinnedLimit?: number } = {}): MainAgentCapacitySnapshot {
  return computeMainAgentCapacity({
    cpuCount: cpus().length,
    loadAverage1m: loadavg()[0] ?? 0,
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
    ...(options.pinnedLimit === undefined ? {} : { pinnedLimit: options.pinnedLimit }),
  });
}

/**
 * The owner's pin, read when a turn needs a slot. An unreadable config must
 * not stop every turn, so it degrades to auto instead of throwing.
 * 所有者的固定值，在回合需要槽位时读取。读不了配置不能让所有回合停摆，因此退化为自动而不是抛错。
 */
export async function readMainAgentCapacityPin(dataDirectory: string): Promise<number | undefined> {
  try {
    return (await new CloneConfigStore(resolveClonePaths({ dataDirectory })).get()).maxConcurrentMainAgents;
  } catch {
    return undefined;
  }
}
