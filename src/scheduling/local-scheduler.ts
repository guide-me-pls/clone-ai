import type { LocalSchedule, ScheduleStore } from "./schedule-store.ts";

export class LocalScheduler {
  readonly #store: ScheduleStore;
  readonly #run: (schedule: LocalSchedule) => Promise<void>;
  #timer?: NodeJS.Timeout;
  #ticking = false;

  constructor(input: { store: ScheduleStore; run(schedule: LocalSchedule): Promise<void> }) {
    this.#store = input.store;
    this.#run = input.run;
  }

  start(intervalMs = 15_000): void {
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const schedule of await this.#store.claimDue(now)) {
        await this.#run(schedule);
      }
    } finally {
      this.#ticking = false;
    }
  }
}
