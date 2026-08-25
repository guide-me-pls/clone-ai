/**
 * The reconcile loop's edge semantics.
 *
 * The golden path proves the happy convergence — work lands, the obligation
 * advances. These tests hold the edges the reviewer's controller framing
 * demands: a week nothing ran still moves forward (recorded as missed, not
 * hidden), an artifact deleted after verification does not count as satisfied,
 * a one-shot obligation closes instead of advancing, and the whole pass is
 * safe to run from anywhere, any number of times.
 *
 * 收敛环的边界语义。
 *
 * 黄金路径证明了顺利的收敛——工作落地、义务推进。这里守住 Controller 框架所要求的
 * 边界：什么都没跑的一周仍然向前走（记为错过而不是藏起来）、验证之后被删掉的产物
 * 不算被满足、一次性义务关闭而不是推进、整趟扫描从任何地方跑多少次都安全。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { PersonalStateStore } from "../src/state/personal-state-store.ts";
import { reconcileCommitments } from "../src/state/commitment-reconciler.ts";

async function home(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-reconcile-"));
  t.after(async () => {
    const journal = createJournalStore(directory);
    (journal as { close?: () => void }).close?.();
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function commit(dataDirectory: string, input: Parameters<PersonalStateStore["recordCommitment"]>[0]): Promise<string> {
  const journal = createJournalStore(dataDirectory);
  try {
    const store = new PersonalStateStore(journal);
    return (await store.recordCommitment(input)).id;
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

async function readCommitment(dataDirectory: string, id: string) {
  const journal = createJournalStore(dataDirectory);
  try {
    return (await new PersonalStateStore(journal).refresh()).commitments[id];
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

/** A run that completed, verified, and served a commitment — the minimal journal shape. 一次完成、验证、并服务某承诺的 Run——最小 Journal 形状。 */
async function seedServingRun(
  dataDirectory: string,
  input: { commitmentId: string; runId: string; artifactPath?: string; passed?: boolean },
): Promise<void> {
  const journal = createJournalStore(dataDirectory);
  try {
    await journal.append({ type: "task.created", taskId: `task-${input.runId}`, payload: { id: `task-${input.runId}` } });
    await journal.append({ type: "run.created", taskId: `task-${input.runId}`, runId: input.runId, payload: { id: input.runId } });
    await journal.append({
      type: "plan.created", taskId: `task-${input.runId}`, runId: input.runId,
      payload: { id: `plan-${input.runId}`, runId: input.runId, summary: "serves", steps: [], servesCommitmentId: input.commitmentId },
    });
    await journal.append({ type: "run.status_changed", taskId: `task-${input.runId}`, runId: input.runId, payload: { status: "queued" } });
    await journal.append({ type: "run.status_changed", taskId: `task-${input.runId}`, runId: input.runId, payload: { status: "running" } });
    await journal.append({ type: "run.status_changed", taskId: `task-${input.runId}`, runId: input.runId, payload: { status: "completed" } });
    if (input.artifactPath !== undefined) {
      await journal.append({
        type: "evidence.recorded", taskId: `task-${input.runId}`, runId: input.runId,
        payload: { id: `ev-${input.runId}`, kind: "artifact", summary: "report", locator: input.artifactPath },
      });
    }
    await journal.append({
      type: "verification.completed", runId: input.runId,
      payload: { runId: input.runId, passed: input.passed ?? true, summary: "verified", checkedEvidenceIds: [], createdAt: new Date().toISOString() },
    });
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

test("a missed week advances the recurrence and says so", async (t) => {
  const dataDirectory = await home(t);
  const twoFridaysAgo = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();
  const id = await commit(dataDirectory, {
    title: "每周五写周报",
    kind: "recurring",
    everyDays: 7,
    dueAt: twoFridaysAgo,
    provenance: { authoredBy: "owner" },
  });

  const journal = createJournalStore(dataDirectory);
  try {
    const pass = await reconcileCommitments(journal);
    assert.equal(pass.length, 1);
    assert.equal(pass[0]?.outcome, "missed");
    assert.equal(pass[0]?.commitmentId, id);

    const after = await readCommitment(dataDirectory, id);
    // Two weeks stale converges in one pass: the next occurrence is the next
    // future Friday, not two ticks away.
    // 迟了两周一次扫描追平：下一次出现是下一个未来的周五，而不是还差两次 tick。
    const ahead = Date.parse(after.dueAt!) - Date.now();
    assert.ok(ahead > 0 && ahead <= 7 * 24 * 3_600_000, `the recurrence must point at the next future Friday (got ${ahead / 3_600_000}h ahead)`);
    assert.equal(after.status, "open");

    // The miss is recorded in the journal, not just moved past.
    // 错过被记入 Journal，而不只是被翻篇。
    const events = await journal.list();
    const settlement = events.find((event) => event.type === "state.commitment.updated");
    assert.equal((settlement?.payload as { outcome?: string }).outcome, "missed");

    // Second pass: nothing left to do.
    // 第二趟：无事可做。
    assert.deepEqual(await reconcileCommitments(journal), []);
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});

test("an artifact deleted after verification does not satisfy the commitment", async (t) => {
  const dataDirectory = await home(t);
  const workspace = await mkdtemp(join(tmpdir(), "clone-reconcile-ws-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const report = join(workspace, "weekly-report.md");
  await writeFile(report, "# 周报\n\n本周进展：……\n", "utf8");

  const id = await commit(dataDirectory, {
    title: "每周五写周报",
    kind: "recurring",
    everyDays: 7,
    dueAt: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString(),
    provenance: { authoredBy: "owner" },
  });
  await seedServingRun(dataDirectory, { commitmentId: id, runId: "run-1", artifactPath: report });

  // The controller re-observes: the verifier passed at completion time, but
  // the file is gone now. "Done once" is not "satisfied".
  // 控制器再观察：验证器在完成时刻通过了，但文件现在已经不在。“做过一次”不等于
  // “被满足”。
  await rm(report, { force: true });

  const journal = createJournalStore(dataDirectory);
  try {
    const pass = await reconcileCommitments(journal);
    assert.equal(pass[0]?.outcome, "artifact-gone");
    const after = await readCommitment(dataDirectory, id);
    assert.equal(after.status, "open", "the obligation stays open when the promised artifact vanished");
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});

test("a one-shot obligation closes as met instead of advancing", async (t) => {
  const dataDirectory = await home(t);
  const workspace = await mkdtemp(join(tmpdir(), "clone-reconcile-ws-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const contract = join(workspace, "contract.md");
  await writeFile(contract, "合同草案……\n", "utf8");

  const id = await commit(dataDirectory, {
    title: "周四前发出合同草案",
    kind: "deadline",
    dueAt: new Date(Date.now() + 2 * 24 * 3_600_000).toISOString(),
    provenance: { authoredBy: "owner" },
  });
  await seedServingRun(dataDirectory, { commitmentId: id, runId: "run-2", artifactPath: contract });

  const journal = createJournalStore(dataDirectory);
  try {
    const pass = await reconcileCommitments(journal);
    assert.equal(pass[0]?.outcome, "met");
    assert.equal(pass[0]?.dueAt, undefined, "a deadline has no next occurrence to advance to");
    const after = await readCommitment(dataDirectory, id);
    assert.equal(after.status, "met");
    // An overdue situation for a met commitment would be noise.
    // 已满足的承诺再出现在逾期情境里就是噪声。
    assert.equal((await new PersonalStateStore(journal).situation()).overdueCommitments.length, 0);
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});

test("an unverified run never settles the commitment it served", async (t) => {
  const dataDirectory = await home(t);
  const id = await commit(dataDirectory, {
    title: "每周五写周报",
    kind: "recurring",
    everyDays: 7,
    dueAt: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    provenance: { authoredBy: "owner" },
  });
  // Completed but verification failed: the work happened, the proof did not.
  // 完成但验证失败：工作发生了，证明没有。
  await seedServingRun(dataDirectory, { commitmentId: id, runId: "run-3", passed: false });

  const journal = createJournalStore(dataDirectory);
  try {
    const pass = await reconcileCommitments(journal);
    // The unverified run leaves the occurrence unsatisfied: the missed branch
    // advances it, with the miss on record.
    // 未验证的 Run 让该次周期未被满足：missed 分支推进它，错过入账。
    assert.equal(pass[0]?.outcome, "missed");
    assert.ok(!pass.some((item) => item.outcome === "met" && item.sourceRunId === "run-3"));
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});
