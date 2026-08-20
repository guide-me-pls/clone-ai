/**
 * The personal state plane: what the twin knows about its owner.
 *
 * Every type here is a projection of journal events, never a mutable record.
 * That is the whole point — a worker, a model, or a bug can propose a change,
 * but the state itself is only ever rebuilt by replaying what the owner
 * actually approved. Delete the projection and it comes back identical;
 * delete the journal and nothing can reconstruct it.
 *
 * 个人状态平面：分身对其所有者的认知。
 *
 * 这里的每个类型都是 Journal 事件的投影，绝不是可变记录。这正是要点所在——Worker、模型
 * 或某个 Bug 都可以提出变更，但状态本身只能通过重放所有者真正批准过的事件重建。删掉投影
 * 它会一模一样地回来；删掉 Journal 则没有任何东西能重建它。
 */

export type StateEntryStatus = "active" | "archived";

export interface StateProvenance {
  /** Who asserted this. A worker may only ever be "proposed_by". 谁主张了它；Worker 只能出现在 proposed_by 位置。 */
  authoredBy: "owner" | "runtime";
  proposedBy?: string;
  sourceEvidenceIds?: readonly string[];
  sourceRunId?: string;
}

export interface SelfModelEntry {
  id: string;
  /** A stable preference, value, working habit, or explicit boundary. 稳定的偏好、价值观、工作习惯或明确边界。 */
  statement: string;
  category: "preference" | "value" | "habit" | "boundary";
  status: StateEntryStatus;
  provenance: StateProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: string;
  title: string;
  /** Why this matters to the owner, in their framing. 用所有者自己的说法解释它为何重要。 */
  motivation?: string;
  status: "active" | "achieved" | "abandoned" | "archived";
  targetDate?: string;
  provenance: StateProvenance;
  createdAt: string;
  updatedAt: string;
}

export type CommitmentKind = "deadline" | "appointment" | "recurring" | "promise";

export interface Commitment {
  id: string;
  title: string;
  kind: CommitmentKind;
  /** ISO instant the obligation comes due. 该义务到期的 ISO 时刻。 */
  dueAt?: string;
  /** Recurrence in days, for kind = "recurring". 周期天数，用于 kind = "recurring"。 */
  everyDays?: number;
  goalId?: string;
  status: "open" | "met" | "missed" | "cancelled";
  provenance: StateProvenance;
  createdAt: string;
  updatedAt: string;
}

/**
 * A time-bounded read of the state plane. It is derived on demand and never
 * stored: a stale situation is worse than none, because it would let the twin
 * act on a world that has moved on.
 * 对状态平面的有时间边界的读取。它按需推导且从不存储：过期的 Situation 比没有更糟，
 * 因为那会让分身依据一个已经改变的世界行动。
 */
export interface Situation {
  observedAt: string;
  activeGoals: readonly Goal[];
  openCommitments: readonly Commitment[];
  overdueCommitments: readonly Commitment[];
  dueSoonCommitments: readonly Commitment[];
  selfModel: readonly SelfModelEntry[];
}

export interface PersonalStateProjection {
  selfModel: Record<string, SelfModelEntry>;
  goals: Record<string, Goal>;
  commitments: Record<string, Commitment>;
  lastAppliedSequence: number;
}

export type PersonalStateEventType =
  | "state.self_model.recorded"
  | "state.self_model.updated"
  | "state.self_model.archived"
  | "state.goal.recorded"
  | "state.goal.updated"
  | "state.goal.archived"
  | "state.commitment.recorded"
  | "state.commitment.updated"
  | "state.commitment.archived";

export function emptyPersonalState(): PersonalStateProjection {
  return { selfModel: {}, goals: {}, commitments: {}, lastAppliedSequence: 0 };
}
