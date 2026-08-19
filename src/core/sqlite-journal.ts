import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { JournalEvent, NewJournalEvent } from "./contracts.ts";
import { JsonlJournalStore, type JournalStore } from "./journal.ts";
import { assertJournalInvariants } from "./invariants.ts";

/**
 * The same JournalStore contract on SQLite. WAL mode gives the local daemon
 * single-writer/many-reader concurrency and crash consistency; synchronous
 * FULL trades a little write speed for never losing an acknowledged event —
 * the journal is the runtime's source of truth, so durability wins.
 * 同一 JournalStore 合约的 SQLite 实现。WAL 模式为本地 Daemon 提供单写多读并发与崩溃
 * 一致性；synchronous FULL 用少量写入速度换取"已确认事件永不丢失"——Journal 是 Runtime
 * 的事实来源，耐久性优先。
 */
export class SqliteJournalStore implements JournalStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA synchronous=FULL");
    // AUTOINCREMENT (not plain rowid) guarantees sequences are never reused,
    // even after a crash or a deleted tail — replay ordering depends on it.
    // AUTOINCREMENT（而非普通 rowid）保证 sequence 永不复用，即使崩溃或尾部被删——
    // 重放顺序依赖这一点。
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS journal_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        payload TEXT NOT NULL
      )
    `);
  }

  async append(event: NewJournalEvent): Promise<JournalEvent> {
    const id = randomUUID();
    const occurredAt = new Date().toISOString();
    const inserted = this.#db
      .prepare("INSERT INTO journal_events (id, type, occurred_at, task_id, run_id, payload) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, event.type, occurredAt, event.taskId ?? null, event.runId ?? null, JSON.stringify(event.payload ?? null));
    return {
      type: event.type,
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      payload: event.payload,
      id,
      sequence: Number(inserted.lastInsertRowid),
      occurredAt,
    };
  }

  async list(): Promise<JournalEvent[]> {
    const rows = this.#db
      .prepare("SELECT sequence, id, type, occurred_at, task_id, run_id, payload FROM journal_events ORDER BY sequence")
      .all() as Array<{
        sequence: number | bigint;
        id: string;
        type: string;
        occurred_at: string;
        task_id: string | null;
        run_id: string | null;
        payload: string;
      }>;
    return rows.map((row) => ({
      id: row.id,
      sequence: Number(row.sequence),
      type: row.type as JournalEvent["type"],
      occurredAt: row.occurred_at,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Copies a JSONL journal into a fresh SQLite journal, preserving ids,
 * sequences, and timestamps exactly. The whole history must pass the
 * invariant checker first: a migration is precisely the moment a corrupted
 * past would silently become the new source of truth.
 * 将 JSONL Journal 完整复制进全新的 SQLite Journal，精确保留 id、sequence 与时间戳。
 * 整段历史必须先通过不变量校验：迁移正是"损坏的过去悄悄变成新事实来源"的时刻。
 */
export async function migrateJsonlJournalToSqlite(input: {
  jsonlPath: string;
  sqlitePath: string;
}): Promise<{ migrated: number }> {
  const source = await readFile(input.jsonlPath, "utf8");
  const events = source
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEvent);
  assertJournalInvariants(events);

  mkdirSync(dirname(input.sqlitePath), { recursive: true });
  const db = new DatabaseSync(input.sqlitePath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=FULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS journal_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        payload TEXT NOT NULL
      )
    `);
    const existing = db.prepare("SELECT COUNT(*) AS count FROM journal_events").get() as { count: number | bigint };
    if (Number(existing.count) > 0) {
      throw new Error("The target SQLite journal already contains events; migration requires an empty target.");
    }
    const insert = db.prepare(
      "INSERT INTO journal_events (sequence, id, type, occurred_at, task_id, run_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const event of events) {
        insert.run(
          event.sequence,
          event.id,
          event.type,
          event.occurredAt,
          event.taskId ?? null,
          event.runId ?? null,
          JSON.stringify(event.payload ?? null),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  return { migrated: events.length };
}

/**
 * Storage selection for the Kernel: JSONL remains the inspectable default;
 * CLONE_AI_JOURNAL=sqlite opts into WAL storage behind the same seam.
 * Kernel 的存储选择：JSONL 仍是可直接检查的默认值；CLONE_AI_JOURNAL=sqlite 在同一
 * seam 后启用 WAL 存储。
 */
export function createJournalStore(dataDirectory: string): JournalStore {
  const backend = process.env.CLONE_AI_JOURNAL ?? "jsonl";
  if (backend === "sqlite") {
    return new SqliteJournalStore(`${dataDirectory}/journal.sqlite3`);
  }
  return new JsonlJournalStore(`${dataDirectory}/journal.jsonl`);
}
