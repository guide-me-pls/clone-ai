import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LoopEvent, LoopJournal, NewLoopEvent } from "./contracts.ts";

/**
 * An inspectable, append-only journal for the learning loop. It is separate
 * from the existing Supervisor journal until the two runtimes share a stable
 * event contract.
 */
export class JsonlLoopJournal implements LoopJournal {
  readonly #path: string;
  #events: LoopEvent[] = [];
  #nextSequence = 1;
  #ready: Promise<void>;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#ready = this.load();
  }

  async append(event: NewLoopEvent): Promise<LoopEvent> {
    await this.#ready;

    let stamped: LoopEvent | undefined;
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

  async list(runId?: string): Promise<LoopEvent[]> {
    await this.#ready;
    await this.#writes;
    return runId === undefined ? [...this.#events] : this.#events.filter((event) => event.runId === runId);
  }

  private async load(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      const source = await readFile(this.#path, "utf8");
      this.#events = source
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as LoopEvent);
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
