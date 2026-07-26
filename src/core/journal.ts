import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { JournalEvent, NewJournalEvent } from "./contracts.ts";

export interface JournalStore {
  append(event: NewJournalEvent): Promise<JournalEvent>;
  list(): Promise<JournalEvent[]>;
}

/**
 * A deliberately small durable event store for the first runtime milestone.
 * The JSONL format is inspectable and replayable; a SQLite implementation can
 * later satisfy the same interface without changing the runtime contract.
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
