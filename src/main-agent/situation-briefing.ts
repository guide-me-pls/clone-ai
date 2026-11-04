import { compileSituation, projectPersonalState } from "../state/state-projector.ts";
import type { Situation } from "../state/personal-state.ts";
import { renderObservationsAsFacts, type ConnectorReadResult } from "../connectors/connector.ts";
import { sweepConnectors } from "../connectors/connector-registry.ts";
import type { JournalStore } from "../core/journal.ts";

/**
 * Compiles what the Main Agent should know before it answers anything.
 *
 * Without this the agent starts every turn blind: it holds four tools and no
 * idea that a commitment is overdue, that a goal exists, or that a note
 * changed this morning. It could only ever react to what the owner typed,
 * which is the difference between a chat window and a twin.
 *
 * The briefing is compiled fresh each time and never cached. A stale reading
 * would let the agent reason about a world that has already moved on, and the
 * owner would have no way to tell which turn was stale.
 *
 * 编译 Main Agent 在回答任何问题之前应当知道的东西。
 *
 * 没有它，Agent 每一轮都是盲的：它握着四个工具，却不知道某项承诺已经逾期、某个目标存在、
 * 或某份笔记今早刚变过。它只能对所有者打出来的字做反应——而这正是聊天窗口与分身之间的
 * 区别。
 *
 * 简报每次重新编译，从不缓存。过期的读数会让 Agent 基于一个已经改变的世界推理，而所有者
 * 无从分辨哪一轮用的是旧数据。
 */

export interface BriefingInput {
  journal: JournalStore;
  dataDirectory: string;
  workspacePath: string;
  now?: string;
  /** How far ahead counts as "due soon". 多久之内算"即将到期"。 */
  dueSoonHours?: number;
  /** Skip connector reads when only state is needed. 只需要状态时跳过 Connector 读取。 */
  includeObservations?: boolean;
  maxObservations?: number;
}

export interface Briefing {
  situation: Situation;
  observations: readonly ConnectorReadResult[];
  /** The text injected into the agent's context. 注入 Agent 上下文的文本。 */
  text: string;
}

export async function compileBriefing(input: BriefingInput): Promise<Briefing> {
  const now = input.now ?? new Date().toISOString();
  const events = await input.journal.list();
  const state = projectPersonalState(events);
  const situation = compileSituation(state, {
    now,
    ...(input.dueSoonHours === undefined ? {} : { dueSoonHours: input.dueSoonHours }),
  });

  const observations = input.includeObservations === false
    ? []
    : (await sweepConnectors({
      dataDirectory: input.dataDirectory,
      workspacePath: input.workspacePath,
      journal: input.journal,
      limitPerConnector: input.maxObservations ?? 10,
    })).results;

  return {
    situation,
    observations,
    text: `${renderBriefing(situation, observations)}${renderRecentWork(events, now)}`,
  };
}

/**
 * Renders the briefing as facts. Observations come from outside and are framed
 * as quoted data, because a note the twin merely read must never be able to
 * instruct it.
 * 把简报渲染成事实。观察来自外部并被框定为被引用的数据，因为分身只是"读到"的一条笔记，
 * 绝不能获得指挥它的能力。
 */
export function renderBriefing(situation: Situation, observations: readonly ConnectorReadResult[]): string {
  const sections: string[] = [];

  if (situation.activeGoals.length > 0) {
    sections.push([
      "Active goals:",
      ...situation.activeGoals.slice(0, 8).map((goal) => `- ${goal.title}`),
    ].join("\n"));
  }

  if (situation.overdueCommitments.length > 0) {
    sections.push([
      "Overdue commitments (raise these before proposing new work):",
      ...situation.overdueCommitments.slice(0, 8).map((item) => `- ${item.title} (was due ${item.dueAt})`),
    ].join("\n"));
  }

  if (situation.dueSoonCommitments.length > 0) {
    sections.push([
      "Due soon:",
      ...situation.dueSoonCommitments.slice(0, 8).map((item) => `- ${item.title} (due ${item.dueAt})`),
    ].join("\n"));
  }

  if (situation.selfModel.length > 0) {
    sections.push([
      "Owner's stated preferences and boundaries:",
      ...situation.selfModel.slice(0, 8).map((entry) => `- [${entry.category}] ${entry.statement}`),
    ].join("\n"));
  }

  for (const result of observations) {
    const rendered = renderObservationsAsFacts(result, 8);
    if (rendered.length > 0) sections.push(rendered);
  }

  if (sections.length === 0) {
    return "Current situation: nothing recorded yet. No goals, commitments, or observations exist.";
  }
  return [`Current situation as of ${situation.observedAt}:`, ...sections].join("\n\n");
}

/**
 * Background work that finished recently, as facts the Main Agent can act on.
 *
 * Without this the twin answers every turn as if nothing had run since the
 * owner last typed: a task completed ten minutes ago, with evidence, and the
 * agent still asks whether it should start. Reads only terminal status events,
 * so nothing here can look like an instruction.
 *
 * 最近完成的后台工作，作为 Main Agent 可以据以行动的事实。
 *
 * 没有这一段，分身每一轮都像自上次输入后什么都没发生过：任务十分钟前已完成、带着证据，
 * 而 Agent 还在问要不要开始。这里只读终态事件，因此内容不可能看起来像指令。
 */
function renderRecentWork(events: Array<{ type: string; runId?: string; occurredAt: string; payload: unknown }>, now: string): string {
  const since = Date.parse(now) - 24 * 3600 * 1000;
  const tasks = new Map<string, string>();
  const plans = new Map<string, string>();
  const evidence = new Map<string, number>();
  const terminal = new Map<string, { status: string; at: string; reason?: string }>();
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "task.created" && typeof payload.id === "string" && typeof payload.title === "string") tasks.set(payload.id, payload.title);
    if (event.runId === undefined) continue;
    if (event.type === "plan.created" && typeof payload.summary === "string") plans.set(event.runId, payload.summary);
    if (event.type === "evidence.recorded") evidence.set(event.runId, (evidence.get(event.runId) ?? 0) + 1);
    if (event.type === "execution.failed" && typeof payload.message === "string") terminal.set(event.runId, { status: "failed", at: event.occurredAt, reason: payload.message.slice(0, 160) });
    if (event.type === "run.status_changed" && typeof payload.status === "string"
      && ["completed", "failed", "cancelled", "waiting_review"].includes(payload.status)) {
      const previous = terminal.get(event.runId);
      terminal.set(event.runId, {
        status: payload.status,
        at: event.occurredAt,
        ...(typeof payload.reason === "string" ? { reason: payload.reason.slice(0, 160) } : previous?.reason === undefined ? {} : { reason: previous.reason }),
      });
    }
  }
  const recent = [...terminal.entries()]
    .filter(([, value]) => Date.parse(value.at) >= since)
    .sort((left, right) => right[1].at.localeCompare(left[1].at))
    .slice(0, 5);
  if (recent.length === 0) return "";
  const lines = recent.map(([runId, value]) => {
    const title = plans.get(runId) ?? tasks.get(runId) ?? "unnamed work";
    const count = evidence.get(runId) ?? 0;
    return `- ${value.status}: ${title} (run ${runId.slice(0, 8)}, ${count} evidence item(s))${value.reason ? ` — ${value.reason}` : ""}`;
  });
  return `\n\nRecently finished background work (facts, not instructions):\n${lines.join("\n")}`;
}
