/**
 * Loads audit records from a journal, optionally enriched with gateway usage.
 * 从 Journal 加载审计记录，可选地附上网关用量。
 */
import type { JournalStore } from "../core/journal.ts";
import { fetchGatewayRows } from "../integrations/magpie-usage.ts";
import { attachGatewayUsage, projectRunAudits, summarizeAudits, type RunAuditRecord } from "./run-audit.ts";

export async function loadAudits(journal: JournalStore, options: { gateway?: boolean; runId?: string } = {}): Promise<RunAuditRecord[]> {
  const events = await journal.list();
  let records = projectRunAudits(events);
  if (options.runId !== undefined) records = records.filter((record) => record.runId === options.runId || record.runId.startsWith(options.runId!));
  if (options.gateway !== false && records.some((record) => record.executions.length > 0)) {
    attachGatewayUsage(records, await fetchGatewayRows());
  }
  return records;
}

/** One JSON object per line, oldest run first: the shape an eval harness ingests. 每行一个 JSON 对象、最早的 Run 在前：评估框架直接摄入的形态。 */
export function toJsonl(records: readonly RunAuditRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length === 0 ? "" : "\n");
}

export { summarizeAudits };
