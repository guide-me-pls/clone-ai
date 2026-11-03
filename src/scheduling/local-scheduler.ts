import { randomUUID } from "node:crypto";

import { logJson } from "../observability/json-log.ts";
import type { LocalSchedule, ScheduleOccurrence, ScheduleStore } from "./schedule-store.ts";

const activeDispatchers = new Set<string>();

export class LocalScheduler {
  readonly #store: ScheduleStore;
  readonly #run: (schedule: LocalSchedule, occurrence: ScheduleOccurrence) => Promise<void | { runId?: string }>;
  readonly #onError: (error: unknown) => void;
  #timer?: NodeJS.Timeout;
  #ticking = false;
  #tickDone?: Promise<void>;

  constructor(input: {
    store: ScheduleStore;
    run(schedule: LocalSchedule, occurrence: ScheduleOccurrence): Promise<void | { runId?: string }>;
    onError?: (error: unknown) => void;
  }) {
    this.#store = input.store;
    this.#run = input.run;
    this.#onError = input.onError ?? ((error) => {
      logJson("error", "Scheduled dispatch failed; its outcome needs review", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  start(intervalMs = 15_000): void {
    if (this.#timer !== undefined) return;
    const tick = (): void => { void this.tick().catch(this.#onError); };
    tick();
    this.#timer = setInterval(tick, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#tickDone;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.#tickDone = done;
    try {
      await this.#store.recoverAbandonedOccurrences((ownerId) => activeDispatchers.has(ownerId));
      await this.#store.claimDue(now);
      for (const pending of await this.#store.listOccurrences()) {
        if (pending.status !== "pending") continue;
        const ownerId = `scheduler-${process.pid}-${randomUUID()}`;
        activeDispatchers.add(ownerId);
        try {
          const occurrence = await this.#store.beginOccurrence(pending.id, ownerId);
          if (occurrence === undefined) continue;
          try {
            const result = await this.#run(occurrence.schedule, occurrence);
            await this.#store.finishOccurrence({
              id: occurrence.id,
              ownerId,
              status: "dispatched",
              ...(result?.runId === undefined ? {} : { runId: result.runId }),
            });
          } catch (error: unknown) {
            // A thrown dispatch may already have produced an external effect.
            // Keep it visible and require an explicit decision before retrying.
            // 派发报错时外部动作可能已经发生；保留待核验状态，不盲目重试。
            await this.#store.finishOccurrence({
              id: occurrence.id,
              ownerId,
              status: "unknown",
              error: "Dispatch failed after starting; check the outcome before retrying.",
            });
            this.#onError(error);
          }
        } finally {
          activeDispatchers.delete(ownerId);
        }
      }
    } finally {
      this.#ticking = false;
      finish();
      if (this.#tickDone === done) this.#tickDone = undefined;
    }
  }
}
