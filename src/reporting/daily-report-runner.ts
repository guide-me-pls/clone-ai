/**
 * Daily reports use a durable delivery record, not a post-send marker. A
 * process that disappears after sending starts leaves an unknown outcome;
 * another process must not send the same report without an owner decision.
 * 日报在发送前写入持久记录。发送开始后进程中断会留下未知结果，其他进程不得盲目重发。
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { JournalStore } from "../core/journal.ts";
import { readSince } from "../core/journal-types.ts";
import { workspaceExecutionLock } from "../core/workspace-lock.ts";
import type { SmtpConfig } from "./smtp-sender.ts";
import { sendEmail } from "./smtp-sender.ts";
import { buildDailyReport } from "./daily-report.ts";
import type { OpportunityCard } from "../opportunity/opportunity.ts";

export interface DailyReportSettings {
  enabled: boolean;
  smtp: SmtpConfig;
  /** Local hour to send, 0-23. 本地发送时刻（小时）。 */
  hour?: number;
}

export interface DailyReportRunnerOptions {
  journal: JournalStore;
  dataDirectory: string;
  settings: DailyReportSettings;
  opportunities: () => Promise<OpportunityCard[]>;
  now?: () => Date;
}

export interface UnknownReportDelivery {
  day: string;
  status: "unknown";
}

type DeliveryStatus = "ready" | "dispatching" | "unknown" | "sent" | "dismissed";

export class DailyReportRunner {
  readonly #journal: JournalStore;
  readonly #settings: DailyReportSettings;
  readonly #legacyPath: string;
  readonly #databasePath: string;
  readonly #lockPath: string;
  readonly #opportunities: () => Promise<OpportunityCard[]>;
  readonly #now: () => Date;
  /** Highest journal sequence the last delivered report covered. 上一次已送达日报覆盖的最高序号。 */
  #coveredSequence = 0;

  constructor(options: DailyReportRunnerOptions) {
    this.#journal = options.journal;
    this.#settings = options.settings;
    this.#legacyPath = join(options.dataDirectory, "reporting", "last-sent.json");
    this.#databasePath = join(options.dataDirectory, "reporting", "deliveries.sqlite3");
    this.#lockPath = join(options.dataDirectory, "reporting", "delivery-lock");
    this.#opportunities = options.opportunities;
    this.#now = options.now ?? (() => new Date());
  }

  /** Dispatches once or reports an uncertain previous outcome. 最多派发一次，或返回上次结果未知。 */
  async maybeSend(): Promise<"sent" | "skipped" | "disabled" | "unknown"> {
    if (!this.#settings.enabled) return "disabled";
    const now = this.#now();
    const hour = this.#settings.hour;
    if (hour !== undefined) {
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("Daily report hour must be an integer 0-23.");
      if (now.getHours() < hour) return "skipped";
    }
    return workspaceExecutionLock.run(this.#lockPath, () => this.withDatabase(async (db) => {
      const day = localDayKey(now);
      const row = db.prepare("SELECT status FROM report_deliveries WHERE day = ?").get(day) as { status: DeliveryStatus } | undefined;
      if (row?.status === "sent" || row?.status === "dismissed") return "skipped";
      if (row?.status === "dispatching" || row?.status === "unknown") {
        this.markUnknown(db, day);
        return "unknown";
      }
      if (row !== undefined && row.status !== "ready") throw new Error("The report delivery has an invalid status.");
      db.prepare(
        "INSERT INTO report_deliveries (day, status, updated_at) VALUES (?, 'dispatching', ?) "
        + "ON CONFLICT(day) DO UPDATE SET status = 'dispatching', updated_at = excluded.updated_at",
      ).run(day, new Date().toISOString());
      try {
        await this.send(now);
        db.prepare("UPDATE report_deliveries SET status = 'sent', updated_at = ? WHERE day = ?")
          .run(new Date().toISOString(), day);
        return "sent";
      } catch (error) {
        this.markUnknown(db, day);
        throw error;
      }
    }));
  }

  async unknownDeliveries(): Promise<UnknownReportDelivery[]> {
    return workspaceExecutionLock.run(this.#lockPath, () => this.withDatabase(async (db) => {
      db.prepare("UPDATE report_deliveries SET status = 'unknown', updated_at = ? WHERE status = 'dispatching'")
        .run(new Date().toISOString());
      const rows = db.prepare("SELECT day FROM report_deliveries WHERE status = 'unknown' ORDER BY day").all() as Array<{ day: string }>;
      return rows.map((row) => ({ day: row.day, status: "unknown" as const }));
    }));
  }

  async resolveDelivery(day: string, resolution: "retry" | "dismiss"): Promise<void> {
    await workspaceExecutionLock.run(this.#lockPath, () => this.withDatabase(async (db) => {
      if (resolution === "retry" && !this.#settings.enabled) throw new Error("Daily reporting is disabled.");
      if (resolution === "retry" && day !== localDayKey(this.#now())) throw new Error("Only today's report can be retried.");
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(
          "UPDATE report_deliveries SET status = ?, updated_at = ? WHERE day = ? AND status IN ('unknown', 'dispatching')",
        ).run(resolution === "retry" ? "ready" : "dismissed", new Date().toISOString(), day);
        if (Number(result.changes) !== 1) throw new Error("Only an unknown report delivery can be resolved.");
        db.prepare("INSERT INTO report_delivery_decisions (day, resolution, decided_at) VALUES (?, ?, ?)")
          .run(day, resolution, new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }));
  }

  private async send(now: Date): Promise<void> {
    // A daily report only covers the last day; replaying the whole journal to
    // find one day of it made the cost grow with total history.
    // 日报只覆盖最近一天；为了找这一天而重放整段历史，会让成本随历史总量增长。
    const since = new Date(now);
    since.setDate(since.getDate() - 1);
    const events = await readSince(this.#journal, this.#sequenceOlderThan(since));
    const last = events.at(-1);
    if (last !== undefined) this.#coveredSequence = last.sequence;
    const opportunities = await this.#opportunities();
    const report = buildDailyReport({ events, opportunities, date: now });
    await sendEmail(this.#settings.smtp, { subject: report.subject, text: report.text });
  }

  /**
   * Start from the last sequence a report covered. `buildDailyReport` still
   * filters by date, so a wider tail only costs a little more work; a narrower
   * one would drop events, which is the failure this deliberately avoids.
   * 从上一次日报覆盖的序号开始。`buildDailyReport` 仍会按日期过滤，因此尾部多含一些只是多一点开销；
   * 少含则会丢事件——这正是这里刻意避免的失败。
   */
  #sequenceOlderThan(_since: Date): number {
    return this.#coveredSequence;
  }

  private markUnknown(db: DatabaseSync, day: string): void {
    db.prepare("UPDATE report_deliveries SET status = 'unknown', updated_at = ? WHERE day = ?")
      .run(new Date().toISOString(), day);
  }

  private async withDatabase<T>(operation: (db: DatabaseSync) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#databasePath), { recursive: true });
    const db = new DatabaseSync(this.#databasePath);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
      db.exec(`
        CREATE TABLE IF NOT EXISTS report_deliveries (day TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS report_delivery_decisions (day TEXT NOT NULL, resolution TEXT NOT NULL, decided_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS report_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      if (db.prepare("SELECT value FROM report_metadata WHERE key = 'legacy_imported'").get() === undefined) {
        let legacy: { day?: unknown; status?: unknown } | undefined;
        try {
          legacy = JSON.parse(await readFile(this.#legacyPath, "utf8")) as typeof legacy;
        } catch (error: unknown) {
          if (!isMissingFile(error)) throw error;
        }
        if (legacy !== undefined && (typeof legacy.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(legacy.day)
          || (legacy.status !== undefined && legacy.status !== "sent" && legacy.status !== "dispatching" && legacy.status !== "unknown"))) {
          throw new Error("The legacy report delivery marker is malformed.");
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          if (legacy !== undefined) {
            db.prepare("INSERT OR IGNORE INTO report_deliveries (day, status, updated_at) VALUES (?, ?, ?)")
              .run(legacy.day as string, legacy.status === "dispatching" || legacy.status === "unknown" ? "unknown" : "sent", new Date().toISOString());
          }
          db.prepare("INSERT INTO report_metadata (key, value) VALUES ('legacy_imported', '1')").run();
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      return await operation(db);
    } finally {
      db.close();
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Local calendar day key, e.g. 2026-08-19. 本地日历日键。 */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
