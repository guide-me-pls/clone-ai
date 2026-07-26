import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ScheduleKind = "daily" | "weekly" | "monthly" | "yearly" | "cron";

export interface LocalSchedule {
  id: string;
  kind: ScheduleKind;
  query: string;
  /** Local time for calendar-based schedules, formatted HH:mm. */
  time?: string;
  /** Sunday is 0; used by weekly schedules. */
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  /** Five fields: minute hour day-of-month month day-of-week. */
  cron?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunKey?: string;
}

/** Kept as a compatibility name for existing callers. */
export type DailySchedule = LocalSchedule;

export interface CreateScheduleInput {
  query: string;
  kind: ScheduleKind;
  time?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  cron?: string;
}

export interface CreateDailyScheduleInput {
  query: string;
  time: string;
}

/**
 * Local-first recurrence store. Calendar schedules catch up once when the
 * app starts later on their scheduled date; Cron schedules run only in their
 * matching minute so they cannot replay an unknown number of missed events.
 */
export class ScheduleStore {
  readonly #path: string;
  #schedules: LocalSchedule[] = [];
  #ready: Promise<void>;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#ready = this.load();
  }

  async list(): Promise<LocalSchedule[]> {
    await this.#ready;
    await this.#writes;
    return this.#schedules.map((schedule) => ({ ...schedule, weekdays: schedule.weekdays === undefined ? undefined : [...schedule.weekdays] }));
  }

  async addDaily(input: CreateDailyScheduleInput): Promise<LocalSchedule> {
    return this.add({ ...input, kind: "daily" });
  }

  async add(input: CreateScheduleInput): Promise<LocalSchedule> {
    const query = input.query.trim();
    if (query.length < 3) throw new Error("A scheduled task needs at least three characters.");
    validateScheduleInput(input);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const schedule: LocalSchedule = {
      id: randomUUID(),
      kind: input.kind,
      query,
      time: input.time,
      weekdays: input.weekdays === undefined ? undefined : [...new Set(input.weekdays)].sort((left, right) => left - right),
      dayOfMonth: input.dayOfMonth,
      month: input.month,
      cron: input.cron?.trim(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastRunKey: calendarScheduleDue(input as LocalSchedule, nowDate) ? dueKey(input as LocalSchedule, nowDate) : undefined,
    };
    await this.mutate((schedules) => [...schedules, schedule]);
    return schedule;
  }

  async setEnabled(id: string, enabled: boolean): Promise<LocalSchedule> {
    let updated: LocalSchedule | undefined;
    await this.mutate((schedules) => schedules.map((schedule) => {
      if (schedule.id !== id) return schedule;
      updated = { ...schedule, enabled, updatedAt: new Date().toISOString() };
      return updated;
    }));
    if (updated === undefined) throw new Error("The requested schedule does not exist.");
    return updated;
  }

  /** Atomically marks all due schedules before the runtime dispatches them. */
  async claimDue(now = new Date()): Promise<LocalSchedule[]> {
    const due: LocalSchedule[] = [];
    await this.mutate((schedules) => schedules.map((schedule) => {
      const key = dueKey(schedule, now);
      if (!schedule.enabled || schedule.lastRunKey === key || !isDue(schedule, now)) return schedule;
      const claimed = { ...schedule, lastRunKey: key, updatedAt: now.toISOString() };
      due.push(claimed);
      return claimed;
    }));
    return due;
  }

  private async mutate(update: (schedules: LocalSchedule[]) => LocalSchedule[]): Promise<void> {
    await this.#ready;
    const write = this.#writes.then(async () => {
      this.#schedules = update(this.#schedules);
      await writeFile(this.#path, JSON.stringify({ schedules: this.#schedules }, null, 2), "utf8");
    });
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
  }

  private async load(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as { schedules?: unknown };
      this.#schedules = Array.isArray(parsed.schedules) ? parsed.schedules.filter(isLocalSchedule) : [];
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

export function localDayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function describeSchedule(schedule: LocalSchedule): string {
  if (schedule.kind === "daily") return `每天 ${schedule.time}`;
  if (schedule.kind === "weekly") return `每周 ${schedule.weekdays?.map(weekdayLabel).join("、")} ${schedule.time}`;
  if (schedule.kind === "monthly") return `每月 ${schedule.dayOfMonth} 日 ${schedule.time}`;
  if (schedule.kind === "yearly") return `每年 ${schedule.month} 月 ${schedule.dayOfMonth} 日 ${schedule.time}`;
  return `Cron · ${schedule.cron}`;
}

function validateScheduleInput(input: CreateScheduleInput): void {
  if (!(["daily", "weekly", "monthly", "yearly", "cron"] as string[]).includes(input.kind)) throw new Error("Unsupported schedule kind.");
  if (input.kind === "cron") {
    if (!isCron(input.cron)) throw new Error("Cron uses five fields: minute hour day-of-month month day-of-week.");
    return;
  }
  if (!isTime(input.time)) throw new Error("A calendar schedule time must use HH:mm.");
  if (input.kind === "weekly" && (!Array.isArray(input.weekdays) || input.weekdays.length === 0 || input.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new Error("A weekly schedule needs one or more weekdays.");
  }
  if (["monthly", "yearly"].includes(input.kind) && (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth! < 1 || input.dayOfMonth! > 31)) {
    throw new Error("A monthly schedule day must be between 1 and 31.");
  }
  if (input.kind === "yearly" && (!Number.isInteger(input.month) || input.month! < 1 || input.month! > 12)) {
    throw new Error("A yearly schedule month must be between 1 and 12.");
  }
}

function isDue(schedule: LocalSchedule, now: Date): boolean {
  if (schedule.kind === "cron") return cronMatches(schedule.cron!, now);
  return calendarScheduleDue(schedule, now);
}

function calendarScheduleDue(schedule: Pick<LocalSchedule, "kind" | "time" | "weekdays" | "dayOfMonth" | "month">, now: Date): boolean {
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (schedule.time === undefined || schedule.time > time) return false;
  if (schedule.kind === "daily") return true;
  if (schedule.kind === "weekly") return schedule.weekdays?.includes(now.getDay()) ?? false;
  if (schedule.kind === "monthly") return schedule.dayOfMonth === now.getDate();
  if (schedule.kind === "yearly") return schedule.month === now.getMonth() + 1 && schedule.dayOfMonth === now.getDate();
  return false;
}

function dueKey(schedule: Pick<LocalSchedule, "kind">, now: Date): string {
  if (schedule.kind === "cron") return `${localDayKey(now)}-${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return localDayKey(now);
}

function isLocalSchedule(value: unknown): value is LocalSchedule {
  if (typeof value !== "object" || value === null) return false;
  const schedule = value as Partial<LocalSchedule>;
  if (!(["daily", "weekly", "monthly", "yearly", "cron"] as string[]).includes(schedule.kind ?? "")) return false;
  try {
    validateScheduleInput(schedule as CreateScheduleInput);
    return typeof schedule.id === "string" && typeof schedule.query === "string" && typeof schedule.enabled === "boolean" && typeof schedule.createdAt === "string" && typeof schedule.updatedAt === "string";
  } catch {
    return false;
  }
}

function isTime(value: string | undefined): value is string {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? "");
}

function isCron(value: string | undefined): value is string {
  if (value === undefined || value.trim().split(/\s+/).length !== 5) return false;
  const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  return value.trim().split(/\s+/).every((field, index) => validCronField(field, limits[index]!));
}

function cronMatches(cron: string, now: Date): boolean {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  return cronFieldMatches(minute!, now.getMinutes(), [0, 59])
    && cronFieldMatches(hour!, now.getHours(), [0, 23])
    && cronFieldMatches(day!, now.getDate(), [1, 31])
    && cronFieldMatches(month!, now.getMonth() + 1, [1, 12])
    && cronFieldMatches(weekday!, now.getDay(), [0, 6]);
}

function validCronField(field: string, [min, max]: readonly [number, number]): boolean {
  return field.split(",").every((part) => {
    const [base, step] = part.split("/");
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1 || Number(step) > max - min + 1)) return false;
    if (base === "*") return true;
    const range = base.match(/^(\d+)-(\d+)$/);
    if (range) return Number(range[1]) >= min && Number(range[2]) <= max && Number(range[1]) <= Number(range[2]);
    return /^\d+$/.test(base) && Number(base) >= min && Number(base) <= max;
  });
}

function cronFieldMatches(field: string, value: number, limits: readonly [number, number]): boolean {
  return field.split(",").some((part) => {
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (base === "*") return (value - limits[0]) % step === 0;
    const range = base.match(/^(\d+)-(\d+)$/);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]) && (value - Number(range[1])) % step === 0;
    return value === Number(base);
  });
}

function weekdayLabel(value: number): string {
  return ["日", "一", "二", "三", "四", "五", "六"][value] ?? String(value);
}
