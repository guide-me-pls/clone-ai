import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { JournalEvent, NewJournalEvent } from "./contracts.ts";

/**
 * A lease granting one process the exclusive right to execute a Run.
 * 授予某个进程独占执行某个 Run 的租约。
 */
export interface RunClaim {
  runId: string;
  ownerId: string;
  leaseUntil: string;
  attempt: number;
}

export interface JournalStore {
  append(event: NewJournalEvent): Promise<JournalEvent>;
  list(): Promise<JournalEvent[]>;
  /**
   * Atomically take exclusive ownership of a Run, or return undefined if
   * another live owner holds it.
   *
   * Scanning for `queued` runs and then executing them is a read followed by a
   * write: two consumers can both read the same run as unclaimed and both
   * dispatch it. Only a store that decides the winner inside one transaction
   * can prevent duplicate execution, so the claim belongs here rather than in
   * the consumer.
   *
   * 原子地取得某个 Run 的独占所有权；若已有其他存活持有者，则返回 undefined。
   *
   * 先扫描 `queued` 再执行，是一次读后跟一次写：两个消费者可能都读到同一个 Run 尚未
   * 被领取，然后都去派发。只有在单个事务内定胜负的存储才能阻止重复执行，因此领取
   * 属于这里，而不是消费者。
   */
  claimRun?(input: { runId: string; ownerId: string; leaseMs: number }): Promise<RunClaim | undefined>;
  /** Extends a held lease so long work is not stolen mid-flight. 延长已持有的租约，避免长任务中途被抢走。 */
  renewClaim?(input: { runId: string; ownerId: string; leaseMs: number }): Promise<boolean>;
  /** Releases a lease so a retry can happen immediately. 释放租约，使重试可以立即发生。 */
  releaseClaim?(input: { runId: string; ownerId: string }): Promise<void>;
  /**
   * Reads the current claim on a run, if any. The liveness probe for orphan
   * recovery: a run left mid-execution by a dead process is distinguished from
   * one being executed right now by whether a live lease still backs it.
   * Undefined on stores without claim support — those are single-process by
   * contract, and single-process means no orphan to recover.
   * 读取某个 Run 当前的领取（若有）。孤儿恢复的活性探针：被死掉的进程中途丢下的 Run，
   * 与此刻正在被执行的 Run，靠是否仍有存活的租约背书来区分。不支持领取的存储返回
   * undefined——那种存储按契约是单进程的，而单进程意味着没有孤儿可恢复。
   */
  readClaim?(runId: string): Promise<RunClaim | undefined>;
  /**
   * Re-reads the durable log so events appended by another process become
   * visible. A store that queries storage on every read may implement this as
   * a no-op.
   * 重新读取持久日志，使其他进程追加的事件可见。每次读取都会查询存储的实现可以把它
   * 实现为空操作。
   */
  reload?(): Promise<void>;
}

/**
 * A deliberately small durable event store for the first runtime milestone.
 * The JSONL format is inspectable and replayable.
 *
 * It is single-process only. `#nextSequence` lives in memory, so two processes
 * writing the same file both start from the sequence they read at startup and
 * produce duplicates; it also offers no way to claim a Run. The daemon uses
 * SQLite for exactly these reasons — this remains for inspection, tests, and
 * migration.
 *
 * 这是第一阶段刻意保持很小的持久事件存储，JSONL 可检查、可重放。
 *
 * 它仅限单进程。`#nextSequence` 住在内存里，两个进程写同一文件时都从启动时读到的
 * sequence 开始，从而产生重复；它也无法领取 Run。Daemon 正是因此使用 SQLite——
 * 本实现保留给检查、测试与迁移使用。
 */
export class JsonlJournalStore implements JournalStore {
  readonly #path: string;
  #events: JournalEvent[] = [];
  #nextSequence = 1;
  #ready: Promise<void>;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#ready = this.load();
  }

  async append(event: NewJournalEvent): Promise<JournalEvent> {
    await this.#ready;

    let stamped: JournalEvent | undefined;
    const write = this.#writes.then(async () => {
      stamped = {
        ...event,
        id: randomUUID(),
        sequence: this.#nextSequence++,
        occurredAt: new Date().toISOString(),
      };
      await appendFile(this.#path, `${JSON.stringify(stamped)}\n`, "utf8");
      this.#events.push(stamped);
    });

    this.#writes = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    return stamped!;
  }

  async list(): Promise<JournalEvent[]> {
    await this.#ready;
    await this.#writes;
    return [...this.#events];
  }

  /**
   * Re-reads the file. The in-memory cache is this process's view; another
   * process writing to the same journal is invisible until it is re-read, and
   * a consumer that never re-reads would silently ignore work created
   * elsewhere.
   * 重新读取文件。内存缓存只是本进程的视图；另一个进程写入同一本 Journal 的内容在重读
   * 之前不可见，而从不重读的消费者会静默忽略别处创建的工作。
   */
  async reload(): Promise<void> {
    await this.#writes;
    this.#ready = this.load();
    await this.#ready;
  }

  private async load(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });

    try {
      const source = await readFile(this.#path, "utf8");
      this.#events = source
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JournalEvent);
      this.#nextSequence = (this.#events.at(-1)?.sequence ?? 0) + 1;
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return;
      }
      throw error;
    }
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
