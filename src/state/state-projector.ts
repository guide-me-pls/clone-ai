import type { JournalEvent } from "../core/contracts.ts";
import {
  emptyPersonalState,
  type Commitment,
  type Goal,
  type PersonalStateProjection,
  type SelfModelEntry,
  type Situation,
} from "./personal-state.ts";

/**
 * Rebuilds the personal state plane from journal events.
 *
 * Replay is the only way state comes into existence, which is what makes the
 * plane trustworthy: there is no setter a worker could reach, and no in-memory
 * value that could drift from the recorded history. An event for an unknown id
 * is ignored rather than inventing an entry, so a corrupt or partial log
 * degrades into less state, never into fabricated state.
 *
 * 从 Journal 事件重建个人状态平面。
 *
 * 重放是状态产生的唯一途径，这正是该平面可信的原因：不存在 Worker 能够触达的 setter，
 * 也不存在可能与已记录历史发生漂移的内存值。针对未知 ID 的事件会被忽略而不是凭空创建
 * 条目，因此损坏或残缺的日志只会退化为更少的状态，绝不会退化为伪造的状态。
 */
export function projectPersonalState(
  events: readonly JournalEvent[],
  base: PersonalStateProjection = emptyPersonalState(),
): PersonalStateProjection {
  const state: PersonalStateProjection = {
    selfModel: { ...base.selfModel },
    goals: { ...base.goals },
    commitments: { ...base.commitments },
    lastAppliedSequence: base.lastAppliedSequence,
  };

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.sequence <= state.lastAppliedSequence) continue;
    const payload = event.payload as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") continue;
    const id = typeof payload.id === "string" ? payload.id : undefined;
    if (id === undefined) continue;

    switch (event.type) {
      case "state.self_model.recorded":
        state.selfModel[id] = payload as unknown as SelfModelEntry;
        break;
      case "state.self_model.updated": {
        const current = state.selfModel[id];
        if (current !== undefined) state.selfModel[id] = { ...current, ...payload as object, id } as SelfModelEntry;
        break;
      }
      case "state.self_model.archived": {
        const current = state.selfModel[id];
        if (current !== undefined) {
          state.selfModel[id] = { ...current, status: "archived", updatedAt: event.occurredAt };
        }
        break;
      }
      case "state.goal.recorded":
        state.goals[id] = payload as unknown as Goal;
        break;
      case "state.goal.updated": {
        const current = state.goals[id];
        if (current !== undefined) state.goals[id] = { ...current, ...payload as object, id } as Goal;
        break;
      }
      case "state.goal.archived": {
        const current = state.goals[id];
        if (current !== undefined) state.goals[id] = { ...current, status: "archived", updatedAt: event.occurredAt };
        break;
      }
      case "state.commitment.recorded":
        state.commitments[id] = payload as unknown as Commitment;
        break;
      case "state.commitment.updated": {
        const current = state.commitments[id];
        if (current !== undefined) state.commitments[id] = { ...current, ...payload as object, id } as Commitment;
        break;
      }
      case "state.commitment.archived": {
        const current = state.commitments[id];
        if (current !== undefined) {
          state.commitments[id] = { ...current, status: "cancelled", updatedAt: event.occurredAt };
        }
        break;
      }
      default:
        continue;
    }
    state.lastAppliedSequence = event.sequence;
  }

  return state;
}

export interface SituationOptions {
  /** Instant the situation is observed from; defaults to now. 观察该情境的时刻，默认为当前。 */
  now?: string;
  /** How far ahead counts as "due soon". 多久之内算"即将到期"。 */
  dueSoonHours?: number;
}

/**
 * Compiles a time-bounded view. An overdue commitment is derivable from the
 * journal alone: nothing marks it late, the passage of time does.
 * 编译一份有时间边界的视图。逾期承诺可以仅凭 Journal 推导出来：没有任何东西把它标记为
 * 迟到，是时间的流逝使然。
 */
export function compileSituation(state: PersonalStateProjection, options: SituationOptions = {}): Situation {
  const observedAt = options.now ?? new Date().toISOString();
  const horizon = Date.parse(observedAt) + (options.dueSoonHours ?? 48) * 3_600_000;
  const now = Date.parse(observedAt);

  const openCommitments = Object.values(state.commitments)
    .filter((commitment) => commitment.status === "open")
    .sort(byDueDate);

  return {
    observedAt,
    activeGoals: Object.values(state.goals).filter((goal) => goal.status === "active"),
    openCommitments,
    overdueCommitments: openCommitments.filter((commitment) => (
      commitment.dueAt !== undefined && Date.parse(commitment.dueAt) < now
    )),
    dueSoonCommitments: openCommitments.filter((commitment) => {
      if (commitment.dueAt === undefined) return false;
      const due = Date.parse(commitment.dueAt);
      return due >= now && due <= horizon;
    }),
    selfModel: Object.values(state.selfModel).filter((entry) => entry.status === "active"),
  };
}

function byDueDate(left: Commitment, right: Commitment): number {
  if (left.dueAt === undefined) return right.dueAt === undefined ? 0 : 1;
  if (right.dueAt === undefined) return -1;
  return left.dueAt.localeCompare(right.dueAt);
}
