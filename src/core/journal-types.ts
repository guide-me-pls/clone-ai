/**
 * Narrow, typed reads over a JournalStore for the background consumers that
 * only ever need a few event types.
 *
 * They used to call `list()` and filter, so their cost grew with the whole
 * history even though they only look at a request marker or a memory decision.
 * The fallback keeps every other store (the JSONL one, test doubles) working:
 * the read is faster when the store supports it, never wrong when it does not.
 *
 * 面向只关心少数几种事件类型的后台消费者，提供收窄且有类型的 Journal 读取。
 *
 * 它们原先调用 `list()` 再过滤，因此即使只关心一个请求标记或一条记忆决策，成本也随整段历史增长。
 * 回退路径让其他存储（JSONL、测试替身）继续可用：支持时更快，不支持时也不会更错。
 */
import type { JournalEvent } from "./contracts.ts";
import type { JournalStore } from "./journal.ts";

/** Events of the given types, oldest first. 指定类型的事件，最旧的在前。 */
export async function readTypes(journal: JournalStore, types: readonly JournalEvent["type"][], since = 0): Promise<JournalEvent[]> {
  if (journal.listTypesSince !== undefined) return journal.listTypesSince(types, since);
  return (await journal.list()).filter((event) => since === 0 || event.sequence > since).filter((event) => types.includes(event.type));
}

/** One run's events, through the run index when the store has one. 某个 Run 的事件；存储支持时走 Run 索引。 */
export async function readForRun(journal: Pick<JournalStore, "list"> & Partial<Pick<JournalStore, "listForRun">>, runId: string): Promise<JournalEvent[]> {
  if (journal.listForRun !== undefined) return journal.listForRun(runId);
  return (await journal.list()).filter((event) => event.runId === runId);
}

/** Events after a sequence, through the incremental read when available. 序号之后的事件；可用时走增量读取。 */
export async function readSince(journal: JournalStore, sequence: number): Promise<JournalEvent[]> {
  if (journal.listSince !== undefined) return journal.listSince(sequence);
  return (await journal.list()).filter((event) => event.sequence > sequence);
}
