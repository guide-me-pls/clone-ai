import { randomUUID } from "node:crypto";

import type { JournalStore } from "../core/journal.ts";
import {
  emptyPersonalState,
  type Commitment,
  type CommitmentKind,
  type Goal,
  type PersonalStateProjection,
  type SelfModelEntry,
  type Situation,
  type StateProvenance,
} from "./personal-state.ts";
import { compileSituation, projectPersonalState, type SituationOptions } from "./state-projector.ts";

/**
 * The only writer to the personal state plane.
 *
 * Every entry carries provenance, and the store refuses an entry a worker
 * merely asserted: an agent may propose, but authorship stays with the owner
 * or the runtime. This is the same rule that stops a worker self-certifying
 * evidence, applied to the twin's model of the person — the place where a
 * silent fabrication would do the most damage.
 *
 * 个人状态平面的唯一写入者。
 *
 * 每个条目都携带来源，且 Store 会拒绝仅由 Worker 主张的条目：Agent 可以提案，但作者身份
 * 始终属于所有者或 Runtime。这与"阻止 Worker 自证 Evidence"是同一条规则，只是被应用到
 * 分身对这个人的建模上——那里正是静默伪造危害最大的地方。
 */
export class PersonalStateStore {
  readonly #journal: JournalStore;
  #state: PersonalStateProjection = emptyPersonalState();
  #hydrated = false;

  constructor(journal: JournalStore) {
    this.#journal = journal;
  }

  async hydrate(force = false): Promise<PersonalStateProjection> {
    if (this.#hydrated && !force) return this.#state;
    this.#state = projectPersonalState(await this.#journal.list());
    this.#hydrated = true;
    return this.#state;
  }

  /** Re-reads the journal so a long-lived caller cannot serve a stale view. 重读 Journal，避免长生命周期调用方提供过期视图。 */
  async refresh(): Promise<PersonalStateProjection> {
    return this.hydrate(true);
  }

  async situation(options: SituationOptions = {}): Promise<Situation> {
    return compileSituation(await this.refresh(), options);
  }

  async recordSelfModel(input: {
    statement: string;
    category: SelfModelEntry["category"];
    provenance: StateProvenance;
  }): Promise<SelfModelEntry> {
    assertOwnerAuthored(input.provenance, "a self-model entry");
    const now = new Date().toISOString();
    const entry: SelfModelEntry = {
      id: randomUUID(),
      statement: assertNonEmpty(input.statement, "statement"),
      category: input.category,
      status: "active",
      provenance: input.provenance,
      createdAt: now,
      updatedAt: now,
    };
    await this.append("state.self_model.recorded", entry);
    return entry;
  }

  async recordGoal(input: {
    title: string;
    motivation?: string;
    targetDate?: string;
    provenance: StateProvenance;
  }): Promise<Goal> {
    assertOwnerAuthored(input.provenance, "a goal");
    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID(),
      title: assertNonEmpty(input.title, "title"),
      ...(input.motivation === undefined ? {} : { motivation: input.motivation }),
      ...(input.targetDate === undefined ? {} : { targetDate: assertInstant(input.targetDate, "targetDate") }),
      status: "active",
      provenance: input.provenance,
      createdAt: now,
      updatedAt: now,
    };
    await this.append("state.goal.recorded", goal);
    return goal;
  }

  async recordCommitment(input: {
    title: string;
    kind: CommitmentKind;
    dueAt?: string;
    everyDays?: number;
    goalId?: string;
    provenance: StateProvenance;
  }): Promise<Commitment> {
    assertOwnerAuthored(input.provenance, "a commitment");
    if (input.kind === "recurring" && input.everyDays === undefined) {
      throw new Error("A recurring commitment needs everyDays.");
    }
    if (input.everyDays !== undefined && (!Number.isInteger(input.everyDays) || input.everyDays < 1)) {
      throw new Error("everyDays must be a positive integer.");
    }
    const now = new Date().toISOString();
    const commitment: Commitment = {
      id: randomUUID(),
      title: assertNonEmpty(input.title, "title"),
      kind: input.kind,
      ...(input.dueAt === undefined ? {} : { dueAt: assertInstant(input.dueAt, "dueAt") }),
      ...(input.everyDays === undefined ? {} : { everyDays: input.everyDays }),
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      status: "open",
      provenance: input.provenance,
      createdAt: now,
      updatedAt: now,
    };
    await this.append("state.commitment.recorded", commitment);
    return commitment;
  }

  async updateCommitmentStatus(id: string, status: Commitment["status"]): Promise<void> {
    await this.requireCommitment(id);
    await this.append("state.commitment.updated", { id, status, updatedAt: new Date().toISOString() });
  }

  /**
   * The reconcile loop's only write: settles what a completed run did to a
   * commitment. Marking met closes a one-shot obligation; advancing moves a
   * recurring one to its next occurrence so "every Friday" keeps meaning every
   * Friday. The source run is carried in the payload so a replayed journal
   * shows not only that the commitment moved, but which piece of work moved it.
   *
   * 收敛环唯一的写入：结算一次已完成的 Run 对某个承诺做了什么。标记 met 关闭一次性
   * 义务；推进把周期性义务移到下一次，使“每周五”持续意味着每一个周五。来源 Run 随
   * 载荷携带，因此重放 Journal 不仅能看到承诺移动了，还能看到是哪件工作移动了它。
   */
  async settleCommitment(input: {
    id: string;
    outcome: "met" | "missed";
    reason: string;
    sourceRunId?: string;
    /** For recurring commitments: the next occurrence. 周期性承诺的下一次时间。 */
    dueAt?: string;
  }): Promise<Commitment> {
    const commitment = await this.requireCommitment(input.id);
    const now = new Date().toISOString();
    const next: Commitment = input.dueAt === undefined
      ? { ...commitment, status: "met", updatedAt: now }
      : { ...commitment, dueAt: input.dueAt, status: "open", updatedAt: now };
    await this.append("state.commitment.updated", {
      id: input.id,
      ...(next.status === "met" ? { status: "met" } : {}),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      outcome: input.outcome,
      reason: input.reason,
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
      settledAt: now,
    });
    return next;
  }

  async updateGoalStatus(id: string, status: Goal["status"]): Promise<void> {
    const state = await this.refresh();
    if (state.goals[id] === undefined) throw new Error(`Goal ${id} does not exist.`);
    await this.append("state.goal.updated", { id, status, updatedAt: new Date().toISOString() });
  }

  /** Correction, not deletion: the record of having believed it survives. 这是纠正而非删除：曾经如此认为的记录得以保留。 */
  async archiveSelfModel(id: string): Promise<void> {
    const state = await this.refresh();
    if (state.selfModel[id] === undefined) throw new Error(`Self-model entry ${id} does not exist.`);
    await this.append("state.self_model.archived", { id });
  }

  private async requireCommitment(id: string): Promise<Commitment> {
    const state = await this.refresh();
    const commitment = state.commitments[id];
    if (commitment === undefined) throw new Error(`Commitment ${id} does not exist.`);
    return commitment;
  }

  private async append(type: Parameters<JournalStore["append"]>[0]["type"], payload: unknown): Promise<void> {
    await this.#journal.append({ type, payload });
    this.#hydrated = false;
  }
}

/**
 * A worker may be named as the proposer, but never as the author. Without this
 * the twin's self-knowledge would be writable by whatever CLI last ran.
 * Worker 可以被记为提案者，但绝不能是作者。没有这条，分身的自我认知就会被"最后运行过的
 * 那个 CLI"随意改写。
 */
function assertOwnerAuthored(provenance: StateProvenance, what: string): void {
  if (provenance.authoredBy !== "owner" && provenance.authoredBy !== "runtime") {
    throw new Error(`Only the owner or the runtime may author ${what}.`);
  }
}

function assertNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty.`);
  return trimmed;
}

function assertInstant(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO instant.`);
  return value;
}
