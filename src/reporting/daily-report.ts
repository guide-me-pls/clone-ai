/**
 * Daily report: one email a day with yesterday's bad cases and open
 * opportunities, so the owner's optimization loop is driven by evidence, not
 * memory.
 *
 * A "bad case" is anything the runtime could not finish cleanly: failed runs,
 * failed subagents, blocked dispatches, failed installs, verification
 * failures. Each entry cites the journal sequence so it can be traced.
 *
 * 每日报告：每天一封邮件，汇总昨天的坏案例与待处理机会，让所有者的优化循环由证据
 * 驱动，而不是记忆。
 *
 * "坏案例"指任何未能干净完成的事：失败的 Run、失败的子 Agent、被阻塞的派发、失败的
 * 安装、验证失败。每条都引用 Journal sequence 以便追溯。
 */
import type { JournalEvent } from "../core/contracts.ts";

export interface DailyReportInput {
  /** Journal events of the last day. 最近一天的 Journal 事件。 */
  events: readonly JournalEvent[];
  /** Open opportunity cards. 待处理机会卡片。 */
  opportunities: Array<{ title: string; whyNow: string; source: string }>;
  date: Date;
}

export interface DailyReport {
  subject: string;
  text: string;
  /** Counts used by tests and by the scheduler to decide whether to send. 供测试与调度器判断是否发送的计数。 */
  counts: { badCases: number; opportunities: number };
}

const BAD_CASE_TYPES = new Set([
  "run.status_changed", // only when status === failed/cancelled
  "subagent.failed",
  "dispatch.blocked",
  "agent.install_failed",
  "opportunity.proposed",
]);

export function buildDailyReport(input: DailyReportInput): DailyReport {
  const day = input.date.toISOString().slice(0, 10);
  const badCases: string[] = [];

  for (const event of input.events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "run.status_changed" && payload.status !== "failed" && payload.status !== "cancelled") continue;
    if (!BAD_CASE_TYPES.has(event.type)) continue;
    const reason = typeof payload.reason === "string" ? payload.reason
      : typeof payload.message === "string" ? payload.message
        : typeof payload.reason === "string" ? payload.reason
          : event.type;
    badCases.push(`- [seq ${event.sequence}] ${event.type}${event.runId === undefined ? "" : ` (run ${event.runId})`}: ${reason}`);
  }

  const counts = { badCases: badCases.length, opportunities: input.opportunities.length };
  const sections: string[] = [
    `# clone-ai 每日报告 · ${day}`,
    "",
    `坏案例：${counts.badCases} · 待处理机会：${counts.opportunities}`,
    "",
  ];
  sections.push("## 坏案例（优化方向）");
  sections.push(badCases.length > 0 ? badCases.join("\n") : "- 昨天没有记录到失败。");
  sections.push("");
  sections.push("## 待处理机会");
  sections.push(input.opportunities.length > 0
    ? input.opportunities.map((card) => `- [${card.source}] ${card.title} — ${card.whyNow}`).join("\n")
    : "- 没有待处理的机会。");
  sections.push("");
  sections.push("> 由 clone-ai 本地运行时生成；打开会话详情可查看每条记录的完整轨迹。");

  return {
    subject: `clone-ai 日报 ${day}：${counts.badCases} 个坏案例 / ${counts.opportunities} 个机会`,
    text: sections.join("\n"),
    counts,
  };
}
