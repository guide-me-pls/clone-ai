/**
 * OpportunityService: scans, journals, and resolves opportunity cards.
 *
 * Cards are journal events like any other durable fact. A card can be
 * accepted (the owner turns it into a task), dismissed (explicitly declined),
 * or expired (its deadline passed). Nothing here executes work — the owner or
 * the Main Agent converts an accepted card into a real Run.
 *
 * OpportunityService：扫描、记录并处置机会卡片。
 *
 * 卡片与其他持久事实一样是 Journal 事件。卡片可以被接受（所有者把它变成任务）、拒绝
 * （明确放弃）或过期（截止已过）。这里不执行任何工作——所有者或 Main Agent 会把一张
 * 被接受的卡片变成真正的 Run。
 */
import { randomUUID } from "node:crypto";

import type { JournalStore } from "../core/journal.ts";
import type { Commitment, Goal } from "../state/personal-state.ts";
import { projectPersonalState } from "../state/state-projector.ts";
import { dedupeOpportunities, scanOpportunities, type OpportunityCard } from "./opportunity.ts";
import { describeFailureForOwner } from "../core/failure-display.ts";

export class OpportunityService {
  readonly #journal: JournalStore;

  constructor(journal: JournalStore) {
    this.#journal = journal;
  }

  /**
   * Scans the journal for opportunities and records new cards. Already
   * recorded cards are not re-recorded; each card id is derived, so a second
   * scan converges instead of duplicating.
   * 扫描 Journal 生成机会并记录新卡片。已记录的卡片不会重复记录；卡片 ID 是派生的，
   * 因此再次扫描会收敛而不是重复。
   */
  async scanAndRecord(now = new Date()): Promise<OpportunityCard[]> {
    const events = await this.#journal.list();
    const state = projectPersonalState(events);
    const existing = new Set(
      events
        .filter((event) => event.type === "opportunity.proposed")
        .map((event) => (event.payload as { id?: unknown }).id as string | undefined)
        .filter((id): id is string => id !== undefined),
    );

    const goals = Object.values(state.goals).map((goal) => ({
      id: goal.id,
      title: goal.title,
      status: goal.status,
      updatedAt: goal.updatedAt,
      ...(goal.targetDate === undefined ? {} : { targetDate: goal.targetDate }),
    }));
    const commitments = Object.values(state.commitments)
      .filter((commitment) => commitment.dueAt !== undefined)
      .map((commitment) => ({
        id: commitment.id,
        title: commitment.title,
        dueAt: commitment.dueAt as string,
        kind: commitment.kind,
      }));
    const runActivity = new Map<string, string>();
    for (const event of events) {
      if (event.type === "run.status_changed" && event.runId !== undefined) {
        runActivity.set(event.runId, event.occurredAt);
      }
    }
    const inputs = events
      .filter((event) => (
        event.type === "run.status_changed"
        || event.type === "observation.recorded"
        || event.type === "dispatch.blocked"
      ))
      .slice(-60)
      .map((event) => ({
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        runId: event.runId,
        payload: (event.payload ?? {}) as Record<string, unknown>,
      }));

    const fresh = dedupeOpportunities(scanOpportunities({
      now,
      goals,
      commitments,
      runActivity,
      events: inputs,
    })).filter((card) => !existing.has(card.id));

    for (const card of fresh) {
      await this.#journal.append({
        type: "opportunity.proposed",
        payload: card,
      });
    }
    return fresh;
  }

  /** All currently open cards, newest first. Resolved cards are excluded: a
   * card the owner already accepted or dismissed is no longer a decision they
   * need to make, and re-showing it would make the twin look forgetful.
   * 当前所有未处置的卡片，新的在前。已处置的卡片被排除：所有者已接受或已拒绝的卡片
   * 不再是需要他做的决定，重复展示会让分身显得健忘。 */
  async list(): Promise<OpportunityCard[]> {
    const events = await this.#journal.list();
    const resolved = new Set(
      events
        .filter((event) => event.type === "opportunity.resolved")
        .map((event) => (event.payload as { id?: unknown }).id as string | undefined)
        .filter((id): id is string => id !== undefined),
    );
    const cards = events
      .filter((event) => event.type === "opportunity.proposed")
      .map((event) => normalizeOpportunityForDisplay(event.payload as OpportunityCard))
      .filter((card) => !resolved.has(card.id))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    // Legacy failure clicks produced one card per duplicate Run. Keep the
    // newest card per failure title so one unresolved problem is one decision.
    // 旧版失败点击会为每个重复 Run 生成一张卡片。按失败标题只保留最新的一张，
    // 让一个未解决的问题只对应一个决定。
    const seenFailureTitles = new Set<string>();
    return cards.filter((card) => {
      if (card.source !== "failed_task") return true;
      const key = card.title.replace(/\s+/g, " ").trim();
      if (seenFailureTitles.has(key)) return false;
      seenFailureTitles.add(key);
      return true;
    });
  }

  /** A card the owner accepted or dismissed, for audit and for tests. 已被所有者处置的卡片。 */
  async resolvedIds(): Promise<string[]> {
    const events = await this.#journal.list();
    return events
      .filter((event) => event.type === "opportunity.resolved")
      .map((event) => String((event.payload as { id?: unknown }).id ?? ""))
      .filter((id) => id.length > 0);
  }

  /** Finds a proposed card by id, resolved or not. 按 id 查找已提出的卡片。 */
  async find(cardId: string): Promise<OpportunityCard | undefined> {
    const events = await this.#journal.list();
    return events
      .filter((event) => event.type === "opportunity.proposed")
      .map((event) => event.payload as OpportunityCard)
      .find((card) => card.id === cardId);
  }

  async resolve(cardId: string, status: "accepted" | "dismissed"): Promise<void> {
    await this.#journal.append({
      type: "opportunity.resolved",
      payload: { id: cardId, status, resolvedAt: new Date().toISOString() },
    });
  }
}

function normalizeOpportunityForDisplay(card: OpportunityCard): OpportunityCard {
  if (card.source !== "failed_task") return card;
  const display = describeFailureForOwner(card.title, {});
  if (display.permissionBlocked || /Unrestricted host execution|no enforced sandbox/i.test(card.title)) {
    return {
      ...card,
      title: "任务需要跟进：本机 Worker 缺少运行权限",
      whyNow: "这条失败记录由旧版本写入：本机 Worker 没有强制沙箱，默认禁止不受限运行。",
      proposedResult: "打开「设置 → Agent」，为这个 Worker 明确允许不受限运行；也可以把该角色改绑到其他已允许的 Worker。",
      serves: card.serves === undefined ? card.serves : { ...card.serves, title: "本机 Worker 缺少运行权限" },
    };
  }
  if (/[\u3400-\u9fff]/.test(card.title)) return card;
  return {
    ...card,
    title: `任务需要跟进：${display.summary}`,
    whyNow: display.summary,
    proposedResult: display.guidance,
    serves: card.serves === undefined ? card.serves : { ...card.serves, title: display.summary },
  };
}

export { randomUUID as _randomUuidReexport };
