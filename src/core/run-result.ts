import type { JournalEvent } from "./contracts.ts";
import type { JournalStore } from "./journal.ts";

/**
 * The last durable answer a run recorded.
 *
 * `execution.completed` carries a single-agent step's final summary;
 * `subagent.completed` carries one per work order. The Main Agent needs this to
 * continue after a dispatch, and the owner needs it to read a run without
 * opening the whole audit. The text is already redacted where it was journaled.
 *
 * Run 记录的最后一条持久答复。
 *
 * `execution.completed` 携带单 Agent 步骤的最终摘要；`subagent.completed` 每个工作单
 * 一条。主 Agent 需要它来在一次派发后继续，所有者需要它在不打开整份审计的情况下读到
 * Run 的结果。文本在写入 Journal 时已经脱敏。
 */
export interface RunResultSummary {
  summary: string;
  occurredAt: string;
}

/** Extracts the answer from a run's events. 从一个 Run 的事件中提取答复。 */
export function runResultFromEvents(events: readonly JournalEvent[]): RunResultSummary | undefined {
  let last: { kind: "step"; summary: string; occurredAt: string } | { kind: "orders"; occurredAt: string } | undefined;
  const subagentSummaries: string[] = [];
  for (const event of events) {
    if (event.type !== "execution.completed" && event.type !== "subagent.completed") continue;
    const summary = (event.payload as Record<string, unknown>).summary;
    if (typeof summary !== "string" || summary.trim().length === 0) continue;
    if (event.type === "execution.completed") {
      last = { kind: "step", summary, occurredAt: event.occurredAt };
      // A later subagent answer belongs to a later step; a later step answer
      // replaces any earlier child answers.
      // 后续子 Agent 答复属于后续步骤；后续步骤答复会取代更早的子答复。
      subagentSummaries.length = 0;
    } else {
      subagentSummaries.push(summary);
      last = { kind: "orders", occurredAt: event.occurredAt };
    }
  }
  if (last === undefined) return undefined;
  if (last.kind === "step") return { summary: last.summary, occurredAt: last.occurredAt };
  return { summary: subagentSummaries.slice(0, 3).join("\n\n"), occurredAt: last.occurredAt };
}

/**
 * Reads one run's answer through the journal's run index, falling back to a
 * full scan for stores without one (the JSONL test store).
 * 通过 Journal 的 Run 索引读取一个 Run 的答复；没有索引的存储（JSONL 测试存储）退回全量扫描。
 */
export async function readRunResult(journal: JournalStore, runId: string): Promise<RunResultSummary | undefined> {
  const events = journal.listForRun === undefined
    ? (await journal.list()).filter((event) => event.runId === runId)
    : await journal.listForRun(runId);
  return runResultFromEvents(events);
}
