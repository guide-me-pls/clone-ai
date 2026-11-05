/**
 * Long-term consistency and restraint: the two things a personal agent is
 * judged on that a coding agent never is.
 *
 * A coding agent is scored on whether the task finished. A personal twin is
 * scored on whether its picture of the owner's life stays coherent — this
 * morning's "move the Friday meeting to Thursday" must outrank last week's
 * "Friday meeting at 3" — and on whether it can stay quiet. Both fail in the
 * same way if untested: silently, in a conversation nobody re-reads.
 *
 * This suite is deliberately small and declarative. Each scenario states the
 * memories, the question, and which memories must and must not reach the
 * context; scoring is a function of the context builder, so the same suite
 * runs against any future retrieval change.
 *
 * 长期一致性与克制：这是个人 Agent 被评判、而编码 Agent 从不会被评判的两件事。
 *
 * 编码 Agent 的分数是任务是否完成。数字分身的分数是对所有者生活的画像是否保持连贯——今早那句
 * "把周五的会改到周四"必须压过上周那句"周五三点开会"——以及它能否保持安静。两者在未测试时
 * 都以同一种方式失败：悄无声息地，发生在没有人重读的对话里。
 *
 * 本套件刻意小而声明式。每个场景写明记忆、问题，以及哪些记忆必须、哪些绝不进入上下文；评分是
 * 上下文构建器的函数，因此同一套件可对任何未来的检索改动复用。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MdMemoryStore } from "../memory/md-memory-store.ts";
import { buildMemoryContextFromCandidates } from "../main-agent/memory-context-builder.ts";
import { buildAttention } from "../opportunity/attention.ts";
import type { Observation } from "../connectors/connector.ts";

export interface ScenarioMemory {
  id: string;
  summary: string;
  /** When the owner said it; ordering is what makes superseding meaningful. 所有者说这句话的时间；顺序正是"取代"有意义的前提。 */
  at: string;
  type?: "fact" | "preference" | "procedure" | "decision" | "commitment";
}

export interface ConsistencyScenario {
  id: string;
  description: string;
  memories: ScenarioMemory[];
  question: string;
  /** The current truth: at least one must reach the context. 当前事实：至少一条必须进入上下文。 */
  mustInclude: string[];
  /** Superseded or irrelevant: none may reach the context alongside the truth. 已被取代或无关：不得与事实同时进入上下文。 */
  mustExclude: string[];
}

export interface ScenarioResult {
  id: string;
  description: string;
  included: string[];
  missingTruth: boolean;
  contaminated: string[];
  passed: boolean;
}

/**
 * The scenarios are the product requirements, written as assertions: a
 * preference survives unrelated work, an updated fact replaces the old one, and
 * a fact said once is still found weeks later.
 * 这些场景就是产品需求，写成断言：偏好能挺过无关工作，更新过的事实取代旧的，只说过一次的事实
 * 在数周后仍能被找到。
 */
export const CONSISTENCY_SCENARIOS: readonly ConsistencyScenario[] = [
  {
    id: "meeting-moved",
    description: "A meeting moved this morning must replace last week's time when asked about the original day.",
    memories: [
      { id: "old", summary: "周五下午三点和产品团队开会", at: "2026-10-26T09:00:00Z", type: "fact" },
      { id: "new", summary: "周五的会议已经改到周四下午两点", at: "2026-11-04T09:00:00Z", type: "fact" },
    ],
    question: "我周五下午有空吗？",
    mustInclude: ["new"],
    mustExclude: ["old"],
  },
  {
    id: "preference-updated",
    description: "A changed preference must replace the earlier one rather than compete with it.",
    memories: [
      { id: "old", summary: "周报模板使用蓝色", at: "2026-10-01T09:00:00Z", type: "preference" },
      { id: "new", summary: "周报模板改用绿色", at: "2026-11-03T09:00:00Z", type: "preference" },
    ],
    question: "周报模板现在用什么颜色？",
    mustInclude: ["new"],
    mustExclude: ["old"],
  },
  {
    id: "preference-survives-drift",
    description: "Weeks of unrelated task memories must not bury a stated preference.",
    memories: [
      { id: "preference", summary: "我偏好周报用简洁的要点列表", at: "2026-09-20T09:00:00Z", type: "preference" },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `task-${index}`,
        summary: `完成任务 ${index}：整理了第 ${index} 份交付材料并归档`,
        at: `2026-10-${String(index + 1).padStart(2, "0")}T09:00:00Z`,
        type: "decision" as const,
      })),
    ],
    question: "这周的周报应该怎么写？",
    mustInclude: ["preference"],
    mustExclude: [],
  },
  {
    id: "fact-recalled-once-removed-later",
    description: "A fact stated once is still retrievable a month later.",
    memories: [
      { id: "fact", summary: "我住在杭州西湖区", at: "2026-09-01T09:00:00Z", type: "fact" },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `noise-${index}`,
        summary: `第 ${index} 次构建日志：产物已生成并校验`,
        at: `2026-10-${String(index + 1).padStart(2, "0")}T09:00:00Z`,
        type: "decision" as const,
      })),
    ],
    question: "我住哪个区？",
    mustInclude: ["fact"],
    mustExclude: [],
  },
];

export interface ConsistencyReport {
  scenarios: ScenarioResult[];
  passed: number;
  total: number;
  /** Share of scenarios where a superseded memory also reached the context. 被取代的记忆也进入上下文的场景占比。 */
  contaminationRate: number;
}

/** Runs every scenario against a fresh store, scoring the context each one produces. 用全新的存储运行每个场景，评分它产生的上下文。 */
export async function runConsistencySuite(scenarios: readonly ConsistencyScenario[] = CONSISTENCY_SCENARIOS): Promise<ConsistencyReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(tmpdir(), "clone-ai-consistency-"));
    const store = new MdMemoryStore({ dataDirectory: directory });
    try {
      const ids = new Map<string, string>();
      for (const memory of scenario.memories) {
        const entry = await store.commit({
          summary: memory.summary,
          type: memory.type ?? "fact",
          confidence: "high",
          occurredAt: memory.at,
        });
        ids.set(memory.id, entry.id);
      }
      const matches = await store.recall(scenario.question, { maxResults: 10 });
      const context = buildMemoryContextFromCandidates(matches.map((match) => ({
        id: match.entry.id,
        summary: match.entry.summary,
        score: match.score,
        type: match.entry.type,
        createdAt: match.entry.createdAt,
      })));
      const includedIds = new Set(context?.sourceMemoryIds ?? []);
      const label = (id: string): string => {
        const entryId = ids.get(id);
        return entryId !== undefined && includedIds.has(entryId) ? id : "";
      };
      const included = [...ids.keys()].filter((id) => label(id).length > 0);
      const missingTruth = scenario.mustInclude.some((id) => !included.includes(id));
      const contaminated = scenario.mustExclude.filter((id) => included.includes(id));
      results.push({
        id: scenario.id,
        description: scenario.description,
        included,
        missingTruth,
        contaminated,
        passed: !missingTruth && contaminated.length === 0,
      });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const passed = results.filter((result) => result.passed).length;
  const contaminated = results.filter((result) => result.contaminated.length > 0).length;
  return { scenarios: results, passed, total: results.length, contaminationRate: results.length === 0 ? 0 : contaminated / results.length };
}

export interface InterruptionScenario {
  id: string;
  description: string;
  observations: Observation[];
  /** Items the owner genuinely needs; everything else is noise. 所有者真正需要的事项；其余都是噪声。 */
  interruptions: number;
}

/**
 * The restraint half. A daemon that pings the owner about a marketing email is
 * worse than one that says nothing: it teaches the owner to ignore it.
 * 克制的那一半。因为一封营销邮件就推送的分身，比什么都不说的分身更糟：它训练所有者忽略它。
 */
export const INTERRUPTION_SCENARIOS: readonly InterruptionScenario[] = [
  {
    id: "spam-and-group-chat",
    description: "A marketing email plus routine group chatter must produce no interruptions.",
    observations: [
      { externalId: "spam-1", kind: "message", title: "限时优惠：本周全场五折 — marketing@shop.example", body: "点击领取优惠券" },
      { externalId: "chat-1", kind: "message", title: "项目群：中午吃什么 — 同事", body: "有人要一起点外卖吗" },
      { externalId: "cal-1", kind: "calendar_event", title: "每周同步会", occurredAt: "2026-11-06T10:00:00Z" },
    ],
    interruptions: 0,
  },
  {
    id: "one-real-message",
    description: "One message from the owner's accountant among noise is worth surfacing at most once.",
    observations: [
      { externalId: "spam-2", kind: "message", title: "您的账户有新的活动 — no-reply@bank.example" },
      { externalId: "real-1", kind: "message", title: "请确认本季度发票抬头 — 会计", body: "需要在周五前确认" },
    ],
    interruptions: 1,
  },
];

export interface InterruptionResult {
  id: string;
  surfaced: number;
  expected: number;
  falsePositives: number;
  passed: boolean;
}

export interface RestraintReport {
  scenarios: InterruptionResult[];
  falsePositiveRate: number;
}

/** Counts attention items raised by observations; every item is an interruption. 统计由观察产生的注意力条目；每一条都是一次打扰。 */
export function runRestraintSuite(scenarios: readonly InterruptionScenario[] = INTERRUPTION_SCENARIOS): RestraintReport {
  const results = scenarios.map((scenario) => {
    const items = buildAttention({ observations: scenario.observations });
    const surfaced = items.filter((item) => item.kind === "observation").length;
    return {
      id: scenario.id,
      surfaced,
      expected: scenario.interruptions,
      falsePositives: Math.max(0, surfaced - scenario.interruptions),
      passed: surfaced <= scenario.interruptions,
    };
  });
  const totalNoise = scenarios.reduce((sum, scenario) => sum + Math.max(0, scenario.observations.length - scenario.interruptions), 0);
  const falsePositives = results.reduce((sum, result) => sum + result.falsePositives, 0);
  return { scenarios: results, falsePositiveRate: totalNoise === 0 ? 0 : falsePositives / totalNoise };
}
