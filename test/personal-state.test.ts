import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { JsonlJournalStore } from "../src/core/journal.ts";
import { PersonalStateStore } from "../src/state/personal-state-store.ts";
import { compileSituation, projectPersonalState } from "../src/state/state-projector.ts";

async function store(t: TestContext): Promise<{ store: PersonalStateStore; journal: JsonlJournalStore }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-state-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  return { store: new PersonalStateStore(journal), journal };
}

const OWNER = { authoredBy: "owner" as const };

test("the owner can add, correct, and archive self-model entries", async (t) => {
  const { store: state } = await store(t);

  const entry = await state.recordSelfModel({
    statement: "发布前必须完成风险评审",
    category: "boundary",
    provenance: OWNER,
  });
  assert.equal(entry.status, "active");

  let projection = await state.refresh();
  assert.equal(Object.keys(projection.selfModel).length, 1);

  await state.archiveSelfModel(entry.id);
  projection = await state.refresh();
  // Correction, not deletion: the entry survives with its history intact.
  // 纠正而非删除：条目连同其历史一起保留下来。
  assert.equal(projection.selfModel[entry.id]?.status, "archived");
  assert.equal((await state.situation()).selfModel.length, 0);
});

test("state is reproduced exactly by replaying the journal", async (t) => {
  const { store: state, journal } = await store(t);

  const goal = await state.recordGoal({ title: "发布 1.0", motivation: "验证产品方向", provenance: OWNER });
  await state.recordCommitment({
    title: "提交风险评审",
    kind: "deadline",
    dueAt: "2026-09-01T00:00:00.000Z",
    goalId: goal.id,
    provenance: OWNER,
  });
  await state.recordSelfModel({ statement: "偏好简短回复", category: "preference", provenance: OWNER });
  await state.updateGoalStatus(goal.id, "achieved");

  const live = await state.refresh();
  // A projection deleted and rebuilt from events must be identical.
  // 投影被删除后由事件重建，必须完全一致。
  const rebuilt = projectPersonalState(await journal.list());
  assert.deepEqual(rebuilt, live);
  assert.equal(rebuilt.goals[goal.id]?.status, "achieved");
});

test("an event for an unknown id is ignored instead of inventing an entry", async (t) => {
  const { store: state, journal } = await store(t);
  await state.recordGoal({ title: "真实目标", provenance: OWNER });

  // A partial or tampered log must degrade into less state, never fabricated state.
  // 残缺或被篡改的日志只能退化为更少的状态，绝不能退化为伪造的状态。
  await journal.append({ type: "state.goal.updated", payload: { id: "ghost-goal", status: "achieved" } });
  await journal.append({ type: "state.commitment.archived", payload: { id: "ghost-commitment" } });

  const projection = projectPersonalState(await journal.list());
  assert.equal(Object.keys(projection.goals).length, 1);
  assert.equal(projection.goals["ghost-goal"], undefined);
  assert.equal(Object.keys(projection.commitments).length, 0);
});

test("a worker cannot author personal state, only propose it", async (t) => {
  const { store: state } = await store(t);

  await assert.rejects(
    state.recordSelfModel({
      statement: "所有者总是同意自动部署",
      category: "preference",
      // A worker asserting authorship is exactly the forgery to prevent.
      // Worker 自称作者，正是要防止的伪造。
      provenance: { authoredBy: "worker" as never, proposedBy: "pi-agent" },
    }),
    /Only the owner or the runtime may author/,
  );

  // The same statement is fine when the runtime records it as a proposal.
  // 同一条陈述，由 Runtime 记录为提案时是允许的。
  const accepted = await state.recordSelfModel({
    statement: "所有者总是同意自动部署",
    category: "preference",
    provenance: { authoredBy: "runtime", proposedBy: "pi-agent", sourceEvidenceIds: ["ev-1"] },
  });
  assert.equal(accepted.provenance.proposedBy, "pi-agent");
});

test("an overdue commitment is derivable from the journal alone", async (t) => {
  const { store: state } = await store(t);

  await state.recordCommitment({ title: "已逾期", kind: "deadline", dueAt: "2026-01-01T00:00:00.000Z", provenance: OWNER });
  await state.recordCommitment({ title: "即将到期", kind: "deadline", dueAt: "2026-08-21T00:00:00.000Z", provenance: OWNER });
  await state.recordCommitment({ title: "很久以后", kind: "deadline", dueAt: "2027-01-01T00:00:00.000Z", provenance: OWNER });

  const situation = await state.situation({ now: "2026-08-20T00:00:00.000Z", dueSoonHours: 48 });

  // Nothing marked these late; the passage of time did.
  // 没有任何东西把它们标记为迟到，是时间的流逝使然。
  assert.deepEqual(situation.overdueCommitments.map((item) => item.title), ["已逾期"]);
  assert.deepEqual(situation.dueSoonCommitments.map((item) => item.title), ["即将到期"]);
  assert.equal(situation.openCommitments.length, 3);
});

test("a met commitment leaves the open set without being deleted", async (t) => {
  const { store: state } = await store(t);
  const commitment = await state.recordCommitment({
    title: "周报",
    kind: "recurring",
    everyDays: 7,
    dueAt: "2026-08-19T00:00:00.000Z",
    provenance: OWNER,
  });

  await state.updateCommitmentStatus(commitment.id, "met");
  const situation = await state.situation({ now: "2026-08-20T00:00:00.000Z" });

  assert.equal(situation.openCommitments.length, 0);
  assert.equal(situation.overdueCommitments.length, 0);
  const projection = await state.refresh();
  assert.equal(projection.commitments[commitment.id]?.status, "met");
});

test("invalid state input is refused before it reaches the journal", async (t) => {
  const { store: state, journal } = await store(t);

  await assert.rejects(state.recordGoal({ title: "   ", provenance: OWNER }), /must not be empty/);
  await assert.rejects(
    state.recordCommitment({ title: "x", kind: "deadline", dueAt: "not-a-date", provenance: OWNER }),
    /must be an ISO instant/,
  );
  await assert.rejects(
    state.recordCommitment({ title: "x", kind: "recurring", provenance: OWNER }),
    /needs everyDays/,
  );
  await assert.rejects(state.updateGoalStatus("ghost", "achieved"), /does not exist/);

  assert.equal((await journal.list()).length, 0, "nothing invalid may be journaled");
});

test("a situation is compiled on demand and never served stale", async (t) => {
  const { store: state, journal } = await store(t);
  await state.recordGoal({ title: "第一个目标", provenance: OWNER });
  assert.equal((await state.situation()).activeGoals.length, 1);

  // Another writer appends directly, as a second process would.
  // 另一个写入方直接追加事件，模拟第二个进程的行为。
  await journal.append({
    type: "state.goal.recorded",
    payload: {
      id: "goal-external", title: "外部写入的目标", status: "active",
      provenance: { authoredBy: "owner" }, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
    },
  });

  assert.equal((await state.situation()).activeGoals.length, 2, "a cached view would have missed the second writer");
});

test("the projector is idempotent across repeated replay", async (t) => {
  const { store: state, journal } = await store(t);
  await state.recordGoal({ title: "目标", provenance: OWNER });
  await state.recordCommitment({ title: "承诺", kind: "promise", provenance: OWNER });

  const events = await journal.list();
  const once = projectPersonalState(events);
  const twice = projectPersonalState(events, once);

  assert.deepEqual(twice, once);
  assert.deepEqual(compileSituation(twice, { now: "2026-08-20T00:00:00.000Z" }).activeGoals.length, 1);
});
