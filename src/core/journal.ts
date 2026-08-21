import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { JournalEvent, NewJournalEvent } from "./contracts.ts";

export interface JournalStore {
  append(event: NewJournalEvent): Promise<JournalEvent>;
  list(): Promise<JournalEvent[]>;
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
 * The JSONL format is inspectable and replayable; a SQLite implementation can
 * later satisfy the same interface without changing the runtime contract.
 *
 * 这是第一阶段刻意保持很小的持久事件存储。JSONL 可检查、可重放；以后 SQLite 实现可以
 * 复用同一接口，而不用改变 Runtime Contract。
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
