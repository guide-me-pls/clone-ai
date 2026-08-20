/**
 * The queue consumer: what turns an accepted plan into actual work.
 *
 * A Run reaching `queued` means the Kernel accepted the plan — not that
 * anything ran. Without a consumer the GUI shows "in progress" while nothing
 * executes, which is the worst possible failure: the owner believes work is
 * happening. This closes that gap for every entry point at once, because it
 * watches Run state rather than being called by one particular caller.
 *
 * 队列消费者：把已接受的计划变成真正的工作。
 *
 * Run 到达 `queued` 只意味着 Kernel 接受了计划，并不意味着有任何东西在跑。没有消费者
 * 时，GUI 会显示"正在推进"而实际什么都没执行——这是最糟的失败形态：所有者以为工作
 * 正在发生。本模块一次性为所有入口补上这一环，因为它观察的是 Run 状态，而不是被某个
 * 特定调用方调用。
 */
import type { AgentRegistry } from "../core/contracts.ts";
import type { CloneRuntime } from "../core/runtime.ts";

export interface RunQueueOptions {
  runtime: CloneRuntime;
  /** Resolved per tick so a settings change takes effect without a restart. 每次 tick 解析一次，使设置变更无需重启即可生效。 */
  registry: () => Promise<AgentRegistry>;
  intervalMs?: number;
  onError?: (runId: string, error: unknown) => void;
}

export class RunQueueConsumer {
  readonly #options: RunQueueOptions;
  readonly #inFlight = new Set<string>();
  #timer?: NodeJS.Timeout;
  #ticking = false;

  constructor(options: RunQueueOptions) {
    this.#options = options;
  }

  start(): void {
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#options.intervalMs ?? 2_000);
    this.#timer.unref();
  }

  /**
   * Stops scanning and waits for in-flight work to settle.
   *
   * Returning while a Run is still executing would let the consumer keep
   * writing into a data directory its owner believes is closed — during
   * shutdown that is a corrupted journal, and in tests a directory that cannot
   * be removed.
   * 停止扫描并等待进行中的工作落定。
   *
   * 在仍有 Run 执行时就返回，会让消费者继续往一个所有者认为已关闭的数据目录里写——
   * 在关闭流程中这意味着损坏的 Journal，在测试中则是一个删不掉的目录。
   */
  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (let attempt = 0; attempt < 200 && (this.#inFlight.size > 0 || this.#ticking); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Executes every queued Run once. Runs waiting for approval are left alone:
   * the owner's decision is not something a background loop may supply.
   * 每次把所有排队中的 Run 执行一遍。等待审批的 Run 不动：所有者的决定不是后台循环
   * 可以替他给出的东西。
   */
  async tick(): Promise<string[]> {
    if (this.#ticking) return [];
    this.#ticking = true;
    const started: string[] = [];
    try {
      // Runs are created by other processes (Main Agent, CLI, scheduler), so
      // the projection must be replayed before looking for work.
      // Run 由其他进程创建（Main Agent、CLI、调度器），因此必须先重放投影再找活干。
      await this.#options.runtime.refresh();
      const queued = this.#options.runtime.listRuns().filter((run) => run.status === "queued");
      for (const run of queued) {
        if (this.#inFlight.has(run.id)) continue;
        this.#inFlight.add(run.id);
        started.push(run.id);
        void this.#execute(run.id);
      }
      return started;
    } finally {
      this.#ticking = false;
    }
  }

  /** Runs currently executing in this process. 本进程中正在执行的 Run。 */
  inFlight(): string[] {
    return [...this.#inFlight];
  }

  async #execute(runId: string): Promise<void> {
    try {
      const registry = await this.#options.registry();
      await this.#options.runtime.execute(runId, registry);
    } catch (error: unknown) {
      // The Kernel already journaled the failure; surfacing it here keeps the
      // daemon's log useful without turning a worker failure into a crash.
      // Kernel 已经把失败写入 Journal；这里只是让 daemon 日志保持有用，而不会把一次
      // Worker 失败变成进程崩溃。
      this.#options.onError?.(runId, error);
    } finally {
      this.#inFlight.delete(runId);
    }
  }
}
