/**
 * Loads audit records from a journal, optionally enriched with gateway usage.
 * 从 Journal 加载审计记录，可选地附上网关用量。
 */
import type { JournalStore } from "../core/journal.ts";
import { fetchGatewayRows } from "../integrations/magpie-usage.ts";
import { attachGatewayUsage, projectRunAudits, summarizeAudits, type RunAuditRecord } from "./run-audit.ts";

export async function loadAudits(journal: JournalStore, options: { gateway?: boolean; runId?: string; deletedRunIds?: ReadonlySet<string> } = {}): Promise<RunAuditRecord[]> {
  const events = await journal.list();
  let records = projectRunAudits(events);
  if (options.deletedRunIds !== undefined) for (const record of records) if (options.deletedRunIds.has(record.runId)) record.deleted = true;
  if (options.runId !== undefined) records = records.filter((record) => record.runId === options.runId || record.runId.startsWith(options.runId!));
  if (options.gateway !== false && records.some((record) => record.executions.length > 0)) {
    attachGatewayUsage(records, await fetchGatewayRows());
  }
  return records;
}

/**
 * Records an owner verdict as a journal event. It is judgement about a finished run, so it is
 * refused for a run that has not finished.
 * 把所有者的判定记为 Journal 事件。它是对已结束 Run 的判断，所以未结束的 Run 会被拒绝。
 */
export async function labelRun(journal: JournalStore, runId: string, verdict: unknown, note: unknown): Promise<void> {
  if (verdict !== "pass" && verdict !== "fail") throw new Error('verdict must be "pass" or "fail".');
  const [record] = await loadAudits(journal, { runId, gateway: false });
  if (record === undefined || record.runId !== runId) throw new Error("Unknown run.");
  if (!["completed", "failed", "cancelled", "waiting_review"].includes(record.status)) throw new Error("Only a finished run can be labeled.");
  const text = typeof note === "string" ? note.trim().slice(0, 1000) : "";
  await journal.append({ type: "audit.labeled", runId, payload: { verdict, ...(text.length > 0 ? { note: text } : {}) } });
}

/** One JSON object per line, oldest run first: the shape an eval harness ingests. 每行一个 JSON 对象、最早的 Run 在前：评估框架直接摄入的形态。 */
export function toJsonl(records: readonly RunAuditRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length === 0 ? "" : "\n");
}

export { summarizeAudits };
