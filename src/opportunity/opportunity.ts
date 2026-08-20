/**
 * The opportunity plane: the twin notices what deserves attention without
 * being asked.
 *
 * An OpportunityCard is a proposal, never an action. It states why now, what
 * was observed, what could be prepared, and what authority would be required.
 * Opportunities are journaled like every other durable fact, so "why did you
 * think that?" always has an answer.
 *
 * 机会平面：分身不等人提问，自己发现值得关注的事。
 *
 * OpportunityCard 是提案，绝不是行动。它说明为什么是现在、观察到了什么、可以准备什么、
 * 以及需要什么权限。机会与其他持久事实一样写入 Journal，"你为什么这么认为"永远有答案。
 */
import type { RiskClass } from "../core/contracts.ts";

export type OpportunitySource = "deadline" | "failed_task" | "neglected_goal" | "observation";

export interface OpportunityCard {
  id: string;
  title: string;
  source: OpportunitySource;
  /** Why now: the concrete observation that makes this timely. 为什么是现在：让它及时的观察。 */
  whyNow: string;
  /** Journal event ids that ground this card. 支撑这张卡片的 Journal 事件 ID。 */
  observedBasis: string[];
  /** What the twin proposes to prepare or do. 分身提议准备或执行什么。 */
  proposedResult: string;
  expectedValue: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  risk: RiskClass;
  /** Authority required to act on the proposed result. 执行 proposedResult 所需权限。 */
  requiredAuthority: "prepare_auto" | "owner_approval";
  /** The goal/commitment/run this opportunity serves, when one exists. 它服务的目标/承诺/Run。 */
  serves?: { kind: "goal" | "commitment" | "run"; id: string; title: string };
  status: "proposed" | "accepted" | "dismissed" | "expired";
  createdAt: string;
}

export interface OpportunityScanInput {
  now?: Date;
  /** Active goals, used for neglect detection. 活跃目标，用于忽略检测。 */
  goals: Array<{ id: string; title: string; status?: string; updatedAt: string; targetDate?: string }>;
  /** Active commitments with deadlines. 带截止时间的活跃承诺。 */
  commitments: Array<{ id: string; title: string; dueAt: string; kind: string }>;
  /** Run ids and their latest activity, used to tell neglected goals from busy ones. 各 Run 的最新活动时间，用于区分被忽略的目标与忙碌的目标。 */
  runActivity: Map<string, string>;
  /** Recent journal events (failures, observations, dispatch blocks). 最近的 Journal 事件。 */
  events: Array<{ id: string; type: string; occurredAt: string; runId?: string; payload: Record<string, unknown> }>;
}

/** Deadline proximity windows in hours. 截止临近窗口（小时）。 */
const DEADLINE_WINDOWS = [24, 48, 72] as const;

/**
 * Rule-based opportunity scan. The model is not needed to notice a deadline,
 * a failed run, or a goal that has gone quiet for two weeks — deterministic
 * rules are cheaper, explainable, and testable.
 *
 * 基于规则的扫描。注意到截止、失败 Run 或沉寂两周的目标不需要模型——确定性规则更便宜、
 * 可解释、可测试。
 */
export function scanOpportunities(input: OpportunityScanInput): OpportunityCard[] {
  const now = input.now ?? new Date();
  const cards: OpportunityCard[] = [];

  // 1. Deadlines approaching with no run activity serving them.
  //    截止临近且没有服务于它的 Run 活动。
  for (const commitment of input.commitments) {
    const due = new Date(commitment.dueAt);
    const hoursLeft = (due.getTime() - now.getTime()) / 3_600_000;
    if (hoursLeft < 0 || hoursLeft > 72) continue;
    const window = DEADLINE_WINDOWS.find((value) => hoursLeft <= value) ?? 72;
    const recentRun = [...input.runActivity.values()].some((updatedAt) => (
      now.getTime() - new Date(updatedAt).getTime() < 24 * 3_600_000
    ));
    if (recentRun && cards.some((card) => card.serves?.id === commitment.id)) continue;
    cards.push({
      id: `opp-${commitment.id}-deadline`,
      title: `承诺即将到期：${commitment.title}`,
      source: "deadline",
      whyNow: `距离到期还有约 ${Math.max(1, Math.round(hoursLeft))} 小时（${window} 小时窗口内）。`,
      observedBasis: [],
      proposedResult: `为「${commitment.title}」准备执行方案或提醒所有者确认。`,
      expectedValue: "high",
      confidence: "high",
      risk: "read_only",
      requiredAuthority: "prepare_auto",
      serves: { kind: "commitment", id: commitment.id, title: commitment.title },
      status: "proposed",
      createdAt: now.toISOString(),
    });
  }

  // 2. Failed runs: propose a follow-up instead of forgetting them.
  //    失败的 Run：提议跟进而不是遗忘。
  for (const event of input.events) {
    if (event.type !== "run.status_changed") continue;
    const payload = event.payload;
    if (payload.status !== "failed" && payload.status !== "cancelled") continue;
    cards.push({
      id: `opp-${event.id}-failed`,
      title: `任务需要跟进：${String(payload.reason ?? "执行失败")}`,
      source: "failed_task",
      whyNow: `Run ${String(event.runId ?? "?")} 在 ${event.occurredAt} 失败/取消。`,
      observedBasis: [event.id],
      proposedResult: "复核失败原因后决定重试、换 Agent 或放弃。",
      expectedValue: "medium",
      confidence: "medium",
      risk: "read_only",
      requiredAuthority: "owner_approval",
      status: "proposed",
      createdAt: now.toISOString(),
    });
  }

  // 3. Neglected goals: active but no related run for two weeks.
  //    被忽略的目标：活跃但两周内没有任何相关 Run。
  for (const goal of input.goals) {
    if (goal.status !== "active") continue;
    const lastActivity = [...input.runActivity.values()].sort().at(-1);
    if (lastActivity !== undefined && now.getTime() - new Date(lastActivity).getTime() < 14 * 24 * 3_600_000) continue;
    cards.push({
      id: `opp-${goal.id}-neglected`,
      title: `目标可能被搁置：${goal.title}`,
      source: "neglected_goal",
      whyNow: "该目标已活跃但近期没有任何推进。",
      observedBasis: [],
      proposedResult: `确认「${goal.title}」是否仍要推进，或更新其状态。`,
      expectedValue: "low",
      confidence: "low",
      risk: "read_only",
      requiredAuthority: "prepare_auto",
      serves: { kind: "goal", id: goal.id, title: goal.title },
      status: "proposed",
      createdAt: now.toISOString(),
    });
  }

  // 4. New observations (files changed, messages, calendar events).
  //    新观察（文件变化、消息、日历事件）。
  for (const event of input.events) {
    if (event.type !== "observation.recorded") continue;
    const title = typeof event.payload.title === "string" ? event.payload.title : "新的观察";
    if (title.trim().length < 4) continue;
    cards.push({
      id: `opp-${event.id}-observation`,
      title: `观察到一个可能相关的变化：${title.slice(0, 60)}`,
      source: "observation",
      whyNow: `观察边界在 ${event.occurredAt} 记录了这条变化。`,
      observedBasis: [event.id],
      proposedResult: "评估这条观察是否影响当前目标或承诺。",
      expectedValue: "low",
      confidence: "low",
      risk: "read_only",
      requiredAuthority: "prepare_auto",
      status: "proposed",
      createdAt: now.toISOString(),
    });
  }

  return cards.slice(0, 12);
}

/** Deduplicates cards that point at the same served entity. 对指向同一服务实体的卡片去重。 */
export function dedupeOpportunities(cards: readonly OpportunityCard[]): OpportunityCard[] {
  const seen = new Set<string>();
  const result: OpportunityCard[] = [];
  for (const card of cards) {
    const key = card.serves === undefined ? card.id : `${card.serves.kind}:${card.serves.id}:${card.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(card);
  }
  return result;
}
