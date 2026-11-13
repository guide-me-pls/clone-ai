/**
 * Version history for memories: what a memory said before each change.
 *
 * The store's recovery path already proved the idea for one mutation at a time,
 * but a mutation row is deleted when it lands. Nothing remembered the previous
 * text, so an edit made in the GUI (or folded in from a hand-edited `.md` file)
 * could not be undone once committed. The owner is told the files are theirs;
 * a file they cannot get back is only conditionally theirs.
 *
 * A version row is written in the same SQLite transaction as the entry it
 * precedes, so a failed change cannot leave a version claiming a state that
 * never existed. The newest 20 versions per memory are kept; the change list is
 * therefore bounded for a memory edited every day for years.
 *
 * 记忆的版本历史：每次变更之前它说的是什么。
 *
 * Store 的恢复路径已对单次暂存证明了这个想法，但 mutation 行在落地后即删除。没有任何东西记住
 * 之前的文本，因此 GUI 里的编辑（或从手改 `.md` 折叠进来的编辑）一旦提交就无法撤回。所有者被告知
 * 文件是他们的；拿不回来的文件只是有条件地属于他们。
 *
 * 版本行与它所记录的那次变更在同一 SQLite 事务中写入，因此失败的变更不会留下一个宣称从未存在过的
 * 状态的版本。每条记忆最多保留最新 20 个版本；一条被每天编辑多年的记忆，其变更列表因此也是有界的。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { MemoryEntry } from "./md-memory-store.ts";

/** Versions kept per memory; older ones are trimmed on write. 每条记忆保留的版本数；写入时裁掉更早的。 */
export const MAX_MEMORY_VERSIONS = 20;

/** One recorded state: the entry before a change, and what changed it. 一个被记录下来的状态：变更前的条目，以及是什么改变了它。 */
export interface MemoryVersion {
  id: string;
  memoryId: string;
  /** The entry as it was before the change. 变更前的条目。 */
  entry: MemoryEntry;
  /** The journal event type that produced the change. 产生这次变更的 Journal 事件类型。 */
  change: string;
  /** Journal sequence of the change, when the journal assigned one. 变更的 Journal 序号，Journal 分配了时存在。 */
  sequence?: number;
  recordedAt: string;
  /**
   * When an undo restored this version. A consumed version stays in the history
   * — the audit still shows what the memory used to say — but the next undo
   * steps past it, which is what makes "undo, undo" walk back two changes
   * instead of toggling between two states.
   * 该版本被撤销恢复的时间。被消费的版本仍留在历史中——审计仍能看到记忆曾说过什么——但下一次撤销会
   * 越过它，这正是"撤销、再撤销"会回退两次变更、而不是在两个状态间来回切换的原因。
   */
  consumedAt?: string;
}

export const MEMORY_VERSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_versions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    entry TEXT NOT NULL,
    change TEXT NOT NULL,
    sequence INTEGER,
    recorded_at TEXT NOT NULL,
    consumed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_versions ON memory_versions (memory_id, recorded_at);
`;

/**
 * Bring a table created by an earlier build up to the current shape. The
 * version table shipped without `consumed_at`; a clone home that opened it once
 * would otherwise fail every later write.
 * 把旧构建创建的表调整到当前形状。版本表最初没有 `consumed_at`；打开过它的 clone home 否则会在之后
 * 每次写入时失败。
 */
export function migrateVersionColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(memory_versions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "consumed_at")) {
    db.exec("ALTER TABLE memory_versions ADD COLUMN consumed_at TEXT");
  }
}

/** Write one version row and trim the memory's history to the newest N. 写入一条版本行，并把该记忆的历史裁到最新 N 条。 */
export function recordVersion(
  db: DatabaseSync,
  input: { entryBefore: MemoryEntry; change: string; sequence?: number },
): void {
  db.prepare("INSERT INTO memory_versions (id, memory_id, entry, change, sequence, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      randomUUID(),
      input.entryBefore.id,
      JSON.stringify(input.entryBefore),
      input.change,
      input.sequence ?? null,
      new Date().toISOString(),
    );
  db.prepare(`
    DELETE FROM memory_versions
    WHERE memory_id = ? AND id NOT IN (
      SELECT id FROM memory_versions WHERE memory_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?
    )
  `).run(input.entryBefore.id, input.entryBefore.id, MAX_MEMORY_VERSIONS);
}

/** Mark a version as restored by an undo. 把某版本标记为已被撤销恢复。 */
export function consumeVersion(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE memory_versions SET consumed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

/** Mark the version row written by one journaled change as restored. 把某次已入账变更写下的版本行标记为已恢复。 */
export function consumeVersionOfSequence(db: DatabaseSync, sequence: number): void {
  db.prepare("UPDATE memory_versions SET consumed_at = ? WHERE sequence = ? AND consumed_at IS NULL").run(new Date().toISOString(), sequence);
}

/** The versions of one memory, newest first. 某条记忆的版本，最新在前。 */
export function versionsOf(db: DatabaseSync, memoryId: string, limit = MAX_MEMORY_VERSIONS): MemoryVersion[] {
  const rows = db.prepare("SELECT id, memory_id, entry, change, sequence, recorded_at, consumed_at FROM memory_versions WHERE memory_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?")
    .all(memoryId, limit) as Array<{ id: string; memory_id: string; entry: string; change: string; sequence: number | null; recorded_at: string; consumed_at: string | null }>;
  return rows.map((row) => ({
    id: row.id,
    memoryId: row.memory_id,
    entry: JSON.parse(row.entry) as MemoryEntry,
    change: row.change,
    ...(row.sequence === null ? {} : { sequence: row.sequence }),
    recordedAt: row.recorded_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
  }));
}

/**
 * The version an undo should restore: the newest one no earlier undo took back.
 * The newest row describes a change that has already landed; restoring it is
 * exactly "undo the last edit".
 * 撤销应恢复的版本：最新的、尚未被更早的撤销取回的版本。最新一行描述的是已经落地的变更；恢复它就是
 * "撤销上一次编辑"。
 */
export function undoVersionOf(db: DatabaseSync, memoryId: string): MemoryVersion | undefined {
  return versionsOf(db, memoryId).find((version) => version.consumedAt === undefined);
}
