import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ScheduleKind = "daily" | "weekly" | "monthly" | "yearly" | "cron" | "interval";

export interface LocalSchedule {
  id: string;
  kind: ScheduleKind;
  query: string;
  /**
   * Local time for calendar-based schedules, formatted HH:mm.
   * 日历型定时任务的本地时间，格式为 HH:mm。
   */
  time?: string;
  /**
   * Sunday is 0; used by weekly schedules.
   * 星期日为 0；用于每周任务。
   */
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  /**
   * Five fields: minute hour day-of-month month day-of-week.
   * 五个字段：分钟、小时、日期、月份、星期。
   */
  cron?: string;
  /**
   * Fixed gap between runs, in minutes; used by interval schedules.
   * 两次执行的固定分钟间隔；用于 interval Schedule。
   */
  intervalMinutes?: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunKey?: string;
}

/**
 * Kept as a compatibility name for existing callers.
 * 为了兼容既有调用方而保留的名称。
 */
export type DailySchedule = LocalSchedule;

export interface CreateScheduleInput {
  query: string;
  kind: ScheduleKind;
  time?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  cron?: string;
  intervalMinutes?: number;
}

export interface CreateDailyScheduleInput {
  query: string;
  time: string;
}

export type ScheduleOccurrenceStatus = "pending" | "dispatching" | "dispatched" | "unknown" | "dismissed";

export interface ScheduleOccurrence {
  id: string;
  scheduleId: string;
  runKey: string;
  schedule: LocalSchedule;
  status: ScheduleOccurrenceStatus;
  createdAt: string;
  updatedAt: string;
  ownerId?: string;
  ownerPid?: number;
  runId?: string;
  error?: string;
}

/**
 * Schedule definitions and occurrences share a transactional local database.
 * A committed occurrence stays pending until a dispatcher owns it. A process
 * that dies after dispatch starts leaves an unknown outcome, never a blind retry.
 * Existing schedules.json is imported once and left untouched as a backup.
 * 定时配置与触发实例共用事务数据库；中断的执行标为未知，旧 JSON 保留为备份。
 */
export class ScheduleStore {
  readonly #path: string;
  readonly #databasePath: string;
  #ready: Promise<void>;

  constructor(path: string) {
    this.#path = path;
    this.#databasePath = path.endsWith(".json") ? `${path.slice(0, -5)}.sqlite3` : `${path}.sqlite3`;
    this.#ready = this.initialize();
  }

  async list(): Promise<LocalSchedule[]> {
    return this.withDatabase((db) => readSchedules(db));
  }

  async addDaily(input: CreateDailyScheduleInput): Promise<LocalSchedule> {
    return this.add({ ...input, kind: "daily" });
  }

  async add(input: CreateScheduleInput): Promise<LocalSchedule> {
    const query = input.query.trim();
    if (query.length === 0) throw new Error("A scheduled task needs a request.");
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
      intervalMinutes: input.intervalMinutes,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastRunKey: initialLastRunKey(input as LocalSchedule, nowDate),
    };
    await this.withDatabase((db) => {
      db.prepare("INSERT INTO schedules (id, body) VALUES (?, ?)").run(schedule.id, JSON.stringify(schedule));
    });
    return schedule;
  }

  async setEnabled(id: string, enabled: boolean): Promise<LocalSchedule> {
    return this.withDatabase((db) => transaction(db, () => {
      const row = db.prepare("SELECT body FROM schedules WHERE id = ?").get(id) as { body: string } | undefined;
      if (row === undefined) throw new Error("The requested schedule does not exist.");
      const updated: LocalSchedule = { ...parseSchedule(row.body), enabled, updatedAt: new Date().toISOString() };
      db.prepare("UPDATE schedules SET body = ? WHERE id = ?").run(JSON.stringify(updated), id);
      return updated;
    }));
  }

  /**
   * A recurrence key and its pending occurrence are committed together. The
   * unique constraint also prevents two local daemons claiming the same slot.
   * 周期键与待派发实例一起提交，唯一约束阻止多个本地进程重复领取。
   */
  async claimDue(now = new Date()): Promise<LocalSchedule[]> {
    return this.withDatabase((db) => transaction(db, () => {
      const due: LocalSchedule[] = [];
      for (const schedule of readSchedules(db)) {
        const key = dueKey(schedule, now);
        if (!schedule.enabled || schedule.lastRunKey === key || !isDue(schedule, now)) continue;
        const claimed = { ...schedule, lastRunKey: key, updatedAt: now.toISOString() };
        const inserted = db.prepare(
          "INSERT OR IGNORE INTO schedule_occurrences "
          + "(id, schedule_id, run_key, schedule, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        ).run(randomUUID(), schedule.id, key, JSON.stringify(claimed), now.toISOString(), now.toISOString());
        if (Number(inserted.changes) === 0) continue;
        db.prepare("UPDATE schedules SET body = ? WHERE id = ?").run(JSON.stringify(claimed), schedule.id);
        due.push(claimed);
      }
      return due;
    }));
  }

  async listOccurrences(): Promise<ScheduleOccurrence[]> {
    return this.withDatabase((db) => {
      const rows = db.prepare("SELECT * FROM schedule_occurrences ORDER BY rowid").all();
      return rows.map((row) => parseOccurrence(row as Record<string, unknown>));
    });
  }

  async beginOccurrence(id: string, ownerId: string): Promise<ScheduleOccurrence | undefined> {
    return this.withDatabase((db) => transaction(db, () => {
      const current = db.prepare("SELECT * FROM schedule_occurrences WHERE id = ? AND status = 'pending'").get(id);
      if (current === undefined) return undefined;
      const occurrence = parseOccurrence(current as Record<string, unknown>);
      const schedule = db.prepare("SELECT body FROM schedules WHERE id = ?").get(occurrence.scheduleId) as { body: string } | undefined;
      if (schedule === undefined || !parseSchedule(schedule.body).enabled) return undefined;
      const result = db.prepare(
        "UPDATE schedule_occurrences SET status = 'dispatching', owner_id = ?, owner_pid = ?, updated_at = ? "
        + "WHERE id = ? AND status = 'pending'",
      ).run(ownerId, process.pid, new Date().toISOString(), id);
      if (Number(result.changes) === 0) return undefined;
      const row = db.prepare("SELECT * FROM schedule_occurrences WHERE id = ?").get(id);
      return parseOccurrence(row as Record<string, unknown>);
    }));
  }

  async finishOccurrence(input: {
    id: string;
    ownerId: string;
    status: "dispatched" | "unknown";
    runId?: string;
    error?: string;
  }): Promise<void> {
    await this.withDatabase((db) => {
      const result = db.prepare(
        "UPDATE schedule_occurrences SET status = ?, run_id = ?, error = ?, owner_id = NULL, owner_pid = NULL, updated_at = ? "
        + "WHERE id = ? AND status = 'dispatching' AND owner_id = ?",
      ).run(input.status, input.runId ?? null, input.error ?? null, new Date().toISOString(), input.id, input.ownerId);
      if (Number(result.changes) !== 1) throw new Error("The schedule occurrence is not held by this dispatcher.");
    });
  }

  async recoverAbandonedOccurrences(isLocalOwnerActive: (ownerId: string) => boolean): Promise<void> {
    await this.withDatabase((db) => transaction(db, () => {
      const rows = db.prepare("SELECT * FROM schedule_occurrences WHERE status = 'dispatching'").all();
      for (const row of rows) {
        const occurrence = parseOccurrence(row as Record<string, unknown>);
        const alive = occurrence.ownerPid === process.pid
          ? occurrence.ownerId !== undefined && isLocalOwnerActive(occurrence.ownerId)
          : occurrence.ownerPid !== undefined && isProcessAlive(occurrence.ownerPid);
        if (alive) continue;
        db.prepare(
          "UPDATE schedule_occurrences SET status = 'unknown', error = ?, owner_id = NULL, owner_pid = NULL, updated_at = ? "
          + "WHERE id = ? AND status = 'dispatching'",
        ).run("Dispatcher stopped after starting; check the outcome before retrying.", new Date().toISOString(), occurrence.id);
      }
    }));
  }

  async resolveOccurrence(id: string, resolution: "retry" | "dismiss"): Promise<void> {
    await this.withDatabase((db) => {
      const result = db.prepare(
        "UPDATE schedule_occurrences SET status = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'unknown'",
      ).run(resolution === "retry" ? "pending" : "dismissed", new Date().toISOString(), id);
      if (Number(result.changes) !== 1) throw new Error("Only an unknown occurrence can be resolved.");
    });
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const db = this.openDatabase();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS schedule_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS schedule_occurrences (
          id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, run_key TEXT NOT NULL,
          schedule TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, owner_id TEXT, owner_pid INTEGER, run_id TEXT, error TEXT,
          UNIQUE (schedule_id, run_key)
        );
      `);
      if (db.prepare("SELECT value FROM schedule_metadata WHERE key = 'legacy_imported'").get() !== undefined) return;
      let legacy: unknown = { schedules: [] };
      try {
        legacy = JSON.parse(await readFile(this.#path, "utf8")) as unknown;
      } catch (error: unknown) {
        if (!isMissingFile(error)) throw error;
      }
      const entries = (legacy as { schedules?: unknown } | null)?.schedules;
      if (!Array.isArray(entries) || entries.some((entry) => !isLocalSchedule(entry))) {
        throw new Error("The legacy schedule file is malformed; it was not migrated.");
      }
      transaction(db, () => {
        if (db.prepare("SELECT value FROM schedule_metadata WHERE key = 'legacy_imported'").get() !== undefined) return;
        const insert = db.prepare("INSERT INTO schedules (id, body) VALUES (?, ?)");
        for (const schedule of entries as LocalSchedule[]) insert.run(schedule.id, JSON.stringify(schedule));
        db.prepare("INSERT INTO schedule_metadata (key, value) VALUES ('legacy_imported', '1')").run();
      });
    } finally {
      db.close();
    }
  }

  private openDatabase(): DatabaseSync {
    const db = new DatabaseSync(this.#databasePath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    return db;
  }

  private async withDatabase<T>(operation: (db: DatabaseSync) => T): Promise<T> {
    await this.#ready;
    const db = this.openDatabase();
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readSchedules(db: DatabaseSync): LocalSchedule[] {
  const rows = db.prepare("SELECT body FROM schedules ORDER BY rowid").all() as Array<{ body: string }>;
  return rows.map((row) => parseSchedule(row.body));
}

function parseSchedule(source: string): LocalSchedule {
  const schedule = JSON.parse(source) as unknown;
  if (!isLocalSchedule(schedule)) throw new Error("A stored schedule is malformed.");
  return schedule;
}

function parseOccurrence(row: Record<string, unknown>): ScheduleOccurrence {
  return {
    id: String(row.id),
    scheduleId: String(row.schedule_id),
    runKey: String(row.run_key),
    schedule: parseSchedule(String(row.schedule)),
    status: row.status as ScheduleOccurrenceStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.owner_id == null ? {} : { ownerId: String(row.owner_id) }),
    ...(row.owner_pid == null ? {} : { ownerPid: Number(row.owner_pid) }),
    ...(row.run_id == null ? {} : { runId: String(row.run_id) }),
    ...(row.error == null ? {} : { error: String(row.error) }),
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function localDayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function describeSchedule(schedule: LocalSchedule): string {
  if (schedule.kind === "daily") return `每天 ${schedule.time}`;
  if (schedule.kind === "weekly") return `每周 ${schedule.weekdays?.map(weekdayLabel).join("、")} ${schedule.time}`;
  if (schedule.kind === "monthly") return `每月 ${schedule.dayOfMonth} 日 ${schedule.time}`;
  if (schedule.kind === "yearly") return `每年 ${schedule.month} 月 ${schedule.dayOfMonth} 日 ${schedule.time}`;
  if (schedule.kind === "interval") {
    const minutes = schedule.intervalMinutes ?? 0;
    return minutes % 60 === 0 ? `每隔 ${minutes / 60} 小时` : `每隔 ${minutes} 分钟`;
  }
  return `Cron · ${schedule.cron}`;
}

function validateScheduleInput(input: CreateScheduleInput): void {
  if (!(["daily", "weekly", "monthly", "yearly", "cron", "interval"] as string[]).includes(input.kind)) throw new Error("Unsupported schedule kind.");
  if (input.kind === "cron") {
    if (!isCron(input.cron)) throw new Error("Cron uses five fields: minute hour day-of-month month day-of-week.");
    return;
  }
  if (input.kind === "interval") {
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes! < 1 || input.intervalMinutes! > 10080) {
      throw new Error("An interval schedule needs an interval between 1 minute and 7 days.");
    }
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
  // Interval schedules are throttled purely by their bucketed lastRunKey, so
  // every tick is "due" as long as the current bucket has not been claimed.
  // Interval Schedule 只靠分桶的 lastRunKey 限流；只要当前桶尚未被认领，每次 tick 都算到期。
  if (schedule.kind === "interval") return true;
  if (schedule.kind === "cron") return cronMatches(schedule.cron!, now);
  return calendarScheduleDue(schedule, now);
}

function initialLastRunKey(schedule: LocalSchedule, now: Date): string | undefined {
  // Interval schedules wait one full interval before their first run instead
  // of firing immediately after being created.
  // Interval Schedule 创建后先等待一个完整周期，而不是立刻触发第一次执行。
  if (schedule.kind === "interval") return dueKey(schedule, now);
  return calendarScheduleDue(schedule, now) ? dueKey(schedule, now) : undefined;
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

function dueKey(schedule: Pick<LocalSchedule, "kind" | "intervalMinutes">, now: Date): string {
  if (schedule.kind === "interval") return `interval:${schedule.intervalMinutes}:${Math.floor(now.getTime() / 60_000 / schedule.intervalMinutes!)}`;
  if (schedule.kind === "cron") return `${localDayKey(now)}-${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return localDayKey(now);
}

function isLocalSchedule(value: unknown): value is LocalSchedule {
  if (typeof value !== "object" || value === null) return false;
  const schedule = value as Partial<LocalSchedule>;
  if (!(["daily", "weekly", "monthly", "yearly", "cron", "interval"] as string[]).includes(schedule.kind ?? "")) return false;
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
