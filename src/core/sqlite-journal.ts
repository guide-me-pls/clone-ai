import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { JournalEvent, NewJournalEvent, RunStatus } from "./contracts.ts";
import { JsonlJournalStore, parseJournalLines, type JournalStore, type RunClaim } from "./journal.ts";
import { assertJournalInvariants } from "./invariants.ts";
import { logJson } from "../observability/json-log.ts";

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
    this.#db.exec("PRAGMA busy_timeout=5000");
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
      );
      -- Every read that is not a full replay filters by run or type; without
      -- these the journal is a full scan. Replay still walks sequence order,
      -- which the primary key already provides.
      -- 所有非全量重放的读取都按 run 或 type 过滤；没有这些索引，Journal 就是全表扫描。
      -- 重放仍按 sequence 顺序走，主键已提供该顺序。
      CREATE INDEX IF NOT EXISTS idx_journal_events_run ON journal_events (run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_journal_events_type ON journal_events (type, sequence)
    `);
    // Claims are mutable current-ownership rows, deliberately not events: a
    // lease is state that expires, and replaying it as history would resurrect
    // dead owners.
    // 领取是可变的“当前所有权”行，刻意不做成事件：租约是会过期的状态，把它当历史重放
    // 会让已死的持有者复活。
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS run_claims (
        run_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        claimed_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Wins or loses the race inside a single IMMEDIATE transaction. An expired
   * lease is stealable — otherwise a consumer killed mid-run would strand its
   * work forever — and stealing bumps `attempt` so a run that repeatedly kills
   * its owner is visible rather than silently retried.
   * 在单个 IMMEDIATE 事务内分出胜负。过期租约可被抢占——否则被中途杀掉的消费者会让工作
   * 永久搛浅——且抢占会递增 `attempt`，使反复弄死持有者的 Run 可被看见，而非静默重试。
   */
  async claimRun(input: { runId: string; ownerId: string; leaseMs: number }): Promise<RunClaim | undefined> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const leaseUntil = new Date(now + input.leaseMs).toISOString();
      const existing = this.#db
        .prepare("SELECT run_id, owner_id, lease_until, attempt FROM run_claims WHERE run_id = ?")
        .get(input.runId) as { owner_id: string; lease_until: string; attempt: number | bigint } | undefined;
      let attempt = 1;
      if (existing !== undefined) {
        const deadline = Date.parse(existing.lease_until);
        if (!Number.isFinite(deadline)) throw new Error(`Run claim for ${input.runId} has an invalid deadline.`);
        const live = deadline > now;
        if (live && existing.owner_id !== input.ownerId) {
          this.#db.exec("ROLLBACK");
          return undefined;
        }
        attempt = Number(existing.attempt) + (existing.owner_id === input.ownerId ? 0 : 1);
      }
      this.#db
        .prepare(
          "INSERT INTO run_claims (run_id, owner_id, lease_until, attempt, claimed_at) VALUES (?, ?, ?, ?, ?) "
          + "ON CONFLICT(run_id) DO UPDATE SET owner_id = excluded.owner_id, lease_until = excluded.lease_until, "
          + "attempt = excluded.attempt, claimed_at = excluded.claimed_at",
        )
        .run(input.runId, input.ownerId, leaseUntil, attempt, new Date(now).toISOString());
      this.#db.exec("COMMIT");
      return { runId: input.runId, ownerId: input.ownerId, leaseUntil, attempt };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async renewClaim(input: { runId: string; ownerId: string; leaseMs: number }): Promise<boolean> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#db.prepare("SELECT owner_id, lease_until FROM run_claims WHERE run_id = ?").get(input.runId) as { owner_id: string; lease_until: string } | undefined;
      const now = Date.now();
      const deadline = current === undefined ? NaN : Date.parse(current.lease_until);
      if (current === undefined || current.owner_id !== input.ownerId || !Number.isFinite(deadline) || deadline <= now) {
        this.#db.exec("ROLLBACK");
        return false;
      }
      const leaseUntil = new Date(now + input.leaseMs).toISOString();
      this.#db.prepare("UPDATE run_claims SET lease_until = ? WHERE run_id = ? AND owner_id = ?")
        .run(leaseUntil, input.runId, input.ownerId);
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async cancelRun(runId: string): Promise<void> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare(
        "SELECT type, task_id, payload FROM journal_events WHERE run_id = ? ORDER BY sequence",
      ).all(runId) as Array<{ type: string; task_id: string | null; payload: string }>;
      const created = rows.find((row) => row.type === "run.created");
      if (created === undefined) throw new Error(`Unknown run ${runId}.`);
      const initial = JSON.parse(created.payload) as { status?: string; activeStepId?: string };
      const lastStatus = rows.findLast((row) => row.type === "run.status_changed");
      const current = lastStatus === undefined ? initial : JSON.parse(lastStatus.payload) as { status?: string; activeStepId?: string };
      if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
        throw new Error(`Run ${runId} cannot be cancelled while ${current.status}.`);
      }
      const activeOrders = new Set<string>();
      for (const row of rows) {
        if (!row.type.startsWith("subagent.")) continue;
        const payload = JSON.parse(row.payload) as { workOrderId?: unknown };
        if (typeof payload.workOrderId !== "string") continue;
        if (row.type === "subagent.dispatched" || row.type === "subagent.resumed") activeOrders.add(payload.workOrderId);
        if (row.type === "subagent.completed" || row.type === "subagent.failed" || row.type === "subagent.cancelled") activeOrders.delete(payload.workOrderId);
      }
      const insert = this.#db.prepare("INSERT INTO journal_events (id, type, occurred_at, task_id, run_id, payload) VALUES (?, ?, ?, ?, ?, ?)");
      const now = new Date().toISOString();
      for (const workOrderId of activeOrders) {
        insert.run(randomUUID(), "subagent.cancelled", now, created.task_id, runId, JSON.stringify({
          workOrderId, message: "Cancellation requested; worker shutdown is best effort.",
        }));
      }
      insert.run(randomUUID(), "run.status_changed", now, created.task_id, runId, JSON.stringify({
        status: "cancelled", activeStepId: current.activeStepId,
      }));
      this.#db.prepare("UPDATE run_claims SET lease_until = ? WHERE run_id = ?").run(now, runId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async releaseClaim(input: { runId: string; ownerId: string }): Promise<void> {
    // Expire rather than delete: the row is the attempt ledger, and it is only
    // useful if it survives the release-retry cycle. Deleting here would make
    // `attempt` mean "steals in a row with no clean failure between them" —
    // a much weaker signal than "execution attempts so far". One row per run
    // is bounded, and an expired lease is immediately stealable, so the retry
    // the release exists for still happens at once.
    // 到期而不是删除：这一行就是尝试账本，只有挺过"释放-重试"循环它才有用。在这里删除
    // 会让 `attempt` 变成"两次干净失败之间的连续抢占次数"——远弱于"至今的执行尝试数"。
    // 每个 Run 一行是有界的，而过期租约立即可被抢占，因此释放所要促成的重试依然立刻发生。
    this.#db
      .prepare("UPDATE run_claims SET lease_until = ? WHERE run_id = ? AND owner_id = ?")
      .run(new Date().toISOString(), input.runId, input.ownerId);
  }

  async readClaim(runId: string): Promise<RunClaim | undefined> {
    const row = this.#db
      .prepare("SELECT run_id, owner_id, lease_until, attempt FROM run_claims WHERE run_id = ?")
      .get(runId) as { run_id: string; owner_id: string; lease_until: string; attempt: number | bigint } | undefined;
    if (row === undefined) return undefined;
    return { runId: row.run_id, ownerId: row.owner_id, leaseUntil: row.lease_until, attempt: Number(row.attempt) };
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

  async appendBatch(events: readonly NewJournalEvent[]): Promise<JournalEvent[]> {
    return this.appendTransactional(events);
  }

  async appendClaimed(event: NewJournalEvent, claim: { runId: string; ownerId: string }): Promise<JournalEvent> {
    return this.appendTransactional([event], claim)[0]!;
  }

  async appendBatchClaimed(events: readonly NewJournalEvent[], claim: { runId: string; ownerId: string }): Promise<JournalEvent[]> {
    return this.appendTransactional(events, claim);
  }

  async appendBatchIfStatus(events: readonly NewJournalEvent[], expected: { runId: string; status: RunStatus }): Promise<JournalEvent[]> {
    return this.appendTransactional(events, undefined, expected);
  }

  private appendTransactional(
    events: readonly NewJournalEvent[],
    claim?: { runId: string; ownerId: string },
    expected?: { runId: string; status: RunStatus },
  ): JournalEvent[] {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (expected !== undefined) {
        if (events.some((event) => event.runId !== expected.runId)) throw new Error("A conditional batch may only write its specified run.");
        const latest = this.#db.prepare(
          "SELECT payload FROM journal_events WHERE run_id = ? AND type IN ('run.created', 'run.status_changed') ORDER BY sequence DESC LIMIT 1",
        ).get(expected.runId) as { payload: string } | undefined;
        const current = latest === undefined ? undefined : (JSON.parse(latest.payload) as { status?: unknown }).status;
        if (current !== expected.status) throw new Error(`Run ${expected.runId} status changed from ${expected.status} to ${String(current)}.`);
      }
      if (claim !== undefined) {
        if (events.some((event) => event.runId !== claim.runId)) throw new Error("A fenced batch may only write its claimed run.");
        const current = this.#db.prepare("SELECT owner_id, lease_until FROM run_claims WHERE run_id = ?").get(claim.runId) as { owner_id: string; lease_until: string } | undefined;
        const deadline = current === undefined ? NaN : Date.parse(current.lease_until);
        if (current === undefined || current.owner_id !== claim.ownerId || !Number.isFinite(deadline) || deadline <= Date.now()) {
          throw new Error(`Run claim lost for ${claim.runId}; refusing a stale executor's journal write.`);
        }
      }
      const insert = this.#db.prepare("INSERT INTO journal_events (id, type, occurred_at, task_id, run_id, payload) VALUES (?, ?, ?, ?, ?, ?)");
      const recorded = events.map((event) => {
        const id = randomUUID();
        const occurredAt = new Date().toISOString();
        const result = insert.run(id, event.type, occurredAt, event.taskId ?? null, event.runId ?? null, JSON.stringify(event.payload ?? null));
        return { ...event, id, occurredAt, sequence: Number(result.lastInsertRowid) };
      });
      this.#db.exec("COMMIT");
      return recorded;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Events after a sequence, in order. The incremental half of `list()`: a
   * consumer that already holds a projection replays only what it has not
   * seen, instead of the whole history on every refresh.
   * 序号之后的事件，按顺序。这是 `list()` 的增量版本：已经持有投影的消费者只重放没见过的部分，
   * 而不是每次刷新都重放整段历史。
   */
  /**
   * Events of the given types after a sequence, in order. Several background
   * consumers only ever read a handful of event types (a request marker, an
   * audit label); handing them the whole history made their cost grow with it.
   * 给定类型中序号之后的事件，按顺序。若干后台消费者只读少数几种事件类型（一个请求标记、
   * 一条审计标签）；把整段历史交给它们，会让它们的成本随历史一起增长。
   */
  async listTypesSince(types: readonly JournalEvent["type"][], sequence: number): Promise<JournalEvent[]> {
    if (types.length === 0) return [];
    const placeholders = types.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(`SELECT sequence, id, type, occurred_at, task_id, run_id, payload FROM journal_events
        WHERE type IN (${placeholders}) AND sequence > ? ORDER BY sequence`)
      .all(...types, sequence) as Array<{
        sequence: number | bigint;
        id: string;
        type: string;
        occurred_at: string;
        task_id: string | null;
        run_id: string | null;
        payload: string;
      }>;
    return rows.map(toJournalEvent);
  }

  async listSince(sequence: number): Promise<JournalEvent[]> {
    const rows = this.#db
      .prepare("SELECT sequence, id, type, occurred_at, task_id, run_id, payload FROM journal_events WHERE sequence > ? ORDER BY sequence")
      .all(sequence) as Array<{
        sequence: number | bigint;
        id: string;
        type: string;
        occurred_at: string;
        task_id: string | null;
        run_id: string | null;
        payload: string;
      }>;
    return rows.map(toJournalEvent);
  }

  /** One run's events, through the run index. 某个 Run 的事件，走 Run 索引。 */
  async listForRun(runId: string): Promise<JournalEvent[]> {
    const rows = this.#db
      .prepare("SELECT sequence, id, type, occurred_at, task_id, run_id, payload FROM journal_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as Array<{
        sequence: number | bigint;
        id: string;
        type: string;
        occurred_at: string;
        task_id: string | null;
        run_id: string | null;
        payload: string;
      }>;
    return rows.map(toJournalEvent);
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
    return rows.map(toJournalEvent);
  }

  close(): void {
    this.#db.close();
  }
}

function toJournalEvent(row: {
  sequence: number | bigint;
  id: string;
  type: string;
  occurred_at: string;
  task_id: string | null;
  run_id: string | null;
  payload: string;
}): JournalEvent {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    type: row.type as JournalEvent["type"],
    occurredAt: row.occurred_at,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    payload: JSON.parse(row.payload) as unknown,
  };
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
  const events = parseJournalLines(source);
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
 * Storage selection for the Kernel.
 *
 * SQLite is the default because the runtime is multi-process by design (GUI
 * daemon, CLI, scheduler, and Main Agent all write the same journal) and only
 * the transactional store gives unique sequences and unique Run claims.
 * CLONE_AI_JOURNAL=jsonl opts back into the inspectable single-process file.
 *
 * Kernel 的存储选择。
 *
 * 默认 SQLite，因为本 Runtime 天生多进程（GUI Daemon、CLI、调度器、Main Agent 都写
 * 同一本 Journal），而只有事务型存储能给出唯一 sequence 与唯一 Run 领取。
 * CLONE_AI_JOURNAL=jsonl 可切回可直接检查的单进程文件。
 */
export function createJournalStore(dataDirectory: string): JournalStore {
  const backend = process.env.CLONE_AI_JOURNAL ?? "sqlite";
  if (backend === "jsonl") {
    return new JsonlJournalStore(`${dataDirectory}/journal.jsonl`);
  }
  const sqlitePath = `${dataDirectory}/journal.sqlite3`;
  const jsonlPath = `${dataDirectory}/journal.jsonl`;
  // First boot under the SQLite default with a JSONL past: import the history
  // synchronously, before anything reads the new store. Without this, flipping
  // the default hands the owner a brand-new empty journal — every run,
  // approval, and observation they ever had silently vanishes. This also
  // covers the window where the flipped default already created an empty
  // SQLite file next to a populated JSONL: there is nothing in it to lose.
  // The original file stays on disk as an untouched backup.
  // SQLite 默认下的首次启动遇到 JSONL 历史：在任何读取之前同步导入。否则一次默认值切换
  // 就会递给所有者一本全新的空 Journal——他所有的 Run、审批与观察都会凭空消失。这同时
  // 覆盖“切换后已创建空 SQLite 文件、旁边却躺着有内容的 JSONL”的窗口：那里面没有任何
  // 可丢失的东西。原文件保留在磁盘上，作为未被动过的备份。
  try {
    if (legacyJsonlNeedsImport(jsonlPath, sqlitePath)) {
      importJsonlIntoSqliteSync(jsonlPath, sqlitePath);
    }
  } catch (error) {
    // A legacy file that fails validation keeps being used as-is: falling
    // back to the old store beats starting a blank new one.
    // 校验失败的旧文件继续原样使用：退回旧存储总好过开一本空白新账。
    logJson("error", "legacy journal import failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new JsonlJournalStore(jsonlPath);
  }
  return new SqliteJournalStore(sqlitePath);
}

/**
 * True when a JSONL journal holds events that no SQLite journal has taken
 * over yet: either no SQLite file exists, or the one that exists is empty.
 * A SQLite journal that already holds events is never touched — merging two
 * diverged histories is a decision for the owner, not for boot code.
 * 当 JSONL Journal 里的事件还没有被任何 SQLite Journal 接管时返回 true：要么 SQLite
 * 文件不存在，要么存在但是空的。已持有事件的 SQLite Journal 绝不被碰——合并两本已经
 * 分叉的历史是所有者的决定，不是启动代码的决定。
 */
function legacyJsonlNeedsImport(jsonlPath: string, sqlitePath: string): boolean {
  if (!existsSync(jsonlPath)) return false;
  const events = countJsonlEvents(jsonlPath);
  if (events === 0) return false;
  if (!existsSync(sqlitePath)) return true;
  const db = new DatabaseSync(sqlitePath);
  try {
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
    const row = db.prepare("SELECT COUNT(*) AS count FROM journal_events").get() as { count: number | bigint };
    return Number(row.count) === 0;
  } finally {
    db.close();
  }
}

function countJsonlEvents(jsonlPath: string): number {
  return readFileSync(jsonlPath, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * One-shot boot-time import of a legacy JSONL journal into a fresh SQLite one.
 * The explicit async migration (migrateJsonlJournalToSqlite) stays for callers
 * that want a report; this is the silent path every entry point passes
 * through, so it must not require an await or an assembly.
 * 开机时对旧 JSONL Journal 的一次性导入。显式的异步迁移
 * （migrateJsonlJournalToSqlite）留给想要报告的调用方；这是所有入口都会路过的静默
 * 路径，因此不能要求 await，也不能依赖组装。
 */
function importJsonlIntoSqliteSync(jsonlPath: string, sqlitePath: string): void {
  const source = readFileSync(jsonlPath, "utf8");
  let events = parseJournalLines(source);
  // The whole history must pass the invariant checker first: importing a
  // corrupted past would make it the new source of truth.
  // 整段历史必须先通过不变量校验：导入损坏的过去等于让它成为新的事实来源。
  assertJournalInvariants(events);

  // Duplicate sequence numbers are the signature of the multi-process JSONL
  // bug — two daemons each counting from what they read at startup. The events
  // themselves are real; only the numbering broke. Renumber in file order,
  // which for an append-only log is the true write order, and say so.
  // 重复的 sequence 号是多进程 JSONL bug 的签名——两个 daemon 各自从启动时读到的计数开始。
  // 事件本身是真实的，坏的只是编号。按文件顺序重编号（对只追加的日志来说即真实写入
  // 顺序），并如实告知。
  if (new Set(events.map((event) => event.sequence)).size !== events.length) {
    console.warn(
      `clone-ai: the legacy journal contains duplicate sequence numbers (the multi-process JSONL bug); renumbering ${events.length} events in file order.`,
    );
    events = events.map((event, index) => ({ ...event, sequence: index + 1 }));
  }

  const db = new DatabaseSync(sqlitePath);
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
    db.exec("BEGIN");
    try {
      const insert = db.prepare(
        "INSERT INTO journal_events (sequence, id, type, occurred_at, task_id, run_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const event of events) {
        insert.run(event.sequence, event.id, event.type, event.occurredAt, event.taskId ?? null, event.runId ?? null, JSON.stringify(event.payload ?? null));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
