import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { clusterFailures, projectOutcomes, runVerdict, suggestLifecycle, wilson } from "../src/improvement/analysis.ts";
import { ImprovementService } from "../src/improvement/improvement-service.ts";
import { MemoryGovernance } from "../src/memory/memory-governance.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { MdMemoryStore } from "../src/memory/md-memory-store.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import type { RunAuditRecord } from "../src/audit/run-audit.ts";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-improvement-"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const governance = new MemoryGovernance({ journal, store });
  return { directory, store, journal, governance };
}

/** Appends a finished run, optionally recalling memories and carrying an owner label. 追加一个已结束的 Run，可选地召回记忆并带所有者标签。 */
async function finishedRun(journal: JsonlJournalStore, runId: string, status: "completed" | "failed", recalled: string[] = [], label?: "pass" | "fail"): Promise<void> {
  await journal.append({ type: "task.created", taskId: `t-${runId}`, payload: { id: `t-${runId}`, title: runId, objective: runId } });
  await journal.append({ type: "run.created", taskId: `t-${runId}`, runId, payload: { id: runId, taskId: `t-${runId}`, status: "created" } });
  if (recalled.length > 0) await journal.append({ type: "memory.recalled", runId, payload: { query: "q", memories: recalled.map((id) => ({ id })) } });
  await journal.append({ type: "run.status_changed", runId, payload: { status } });
  if (label !== undefined) await journal.append({ type: "audit.labeled", runId, payload: { verdict: label } });
}

test("an owner label outranks the system's verification", () => {
  assert.equal(runVerdict({ status: "completed", label: { verdict: "fail", labeledAt: "" } }), "bad");
  assert.equal(runVerdict({ status: "failed", label: { verdict: "pass", labeledAt: "" } }), "good");
  assert.equal(runVerdict({ status: "waiting_review" }), undefined);
});

test("wilson gives a wide interval for few samples and a narrow one for many", () => {
  const few = wilson(3, 3);
  const many = wilson(300, 300);
  assert.ok(few.lower < 0.6 && many.lower > 0.98);
});

test("outcomes are attributed per memory and unfinished runs are ignored", async (t) => {
  const { journal } = await setup(t);
  await finishedRun(journal, "r1", "completed", ["m1"]);
  await finishedRun(journal, "r2", "failed", ["m1"]);
  await finishedRun(journal, "r3", "completed", ["m1"], "fail");
  await journal.append({ type: "memory.recalled", runId: "r4", payload: { query: "q", memories: [{ id: "m1" }] } });
  const projection = projectOutcomes(await journal.list());
  assert.deepEqual(projection.usage.get("m1"), { memoryId: "m1", exposures: 3, good: 1, bad: 2, lastExposedAt: projection.usage.get("m1")!.lastExposedAt });
  assert.deepEqual(projection.runs, { total: 3, good: 1 });
});

test("lifecycle suggests retiring a memory whose runs end worse than the baseline and keeping one that ends better", async (t) => {
  const { journal } = await setup(t);
  for (let i = 0; i < 8; i += 1) await finishedRun(journal, `bad${i}`, "failed", ["harmful"]);
  for (let i = 0; i < 8; i += 1) await finishedRun(journal, `good${i}`, "completed", ["helpful"]);
  for (let i = 0; i < 8; i += 1) await finishedRun(journal, `plain${i}`, i < 4 ? "completed" : "failed");
  const memories = ["harmful", "helpful"].map((id) => ({ id, summary: id, status: "active" }));
  const suggestions = suggestLifecycle(projectOutcomes(await journal.list()), memories);
  assert.deepEqual(suggestions.map((item) => `${item.kind}:${item.target}`).sort(), ["reinforce:helpful", "retire:harmful"]);
});

test("lifecycle stays silent below the minimum number of exposures", async (t) => {
  const { journal } = await setup(t);
  for (let i = 0; i < 3; i += 1) await finishedRun(journal, `bad${i}`, "failed", ["m"]);
  for (let i = 0; i < 8; i += 1) await finishedRun(journal, `ok${i}`, "completed");
  assert.deepEqual(suggestLifecycle(projectOutcomes(await journal.list()), [{ id: "m", summary: "m", status: "active" }]), []);
});

function failedAudit(runId: string, signature: string): RunAuditRecord {
  return { runId, status: "failed", executions: [{ stepId: "s", progressEvents: 0, outcome: "failed", failure: { message: "x", category: "timeout", signature } }] } as unknown as RunAuditRecord;
}

test("a failure signature is a pattern only across enough different runs", () => {
  const audits = [failedAudit("a", "sig-1"), failedAudit("b", "sig-1"), failedAudit("c", "sig-1"), failedAudit("d", "sig-2"), failedAudit("d", "sig-2")];
  const found = clusterFailures(audits, () => "Raise the timeout.");
  assert.equal(found.length, 1);
  assert.match(found[0]!.proposedSummary!, /sig-1.*Raise the timeout/);
  assert.deepEqual(found[0]!.evidenceRunIds?.sort(), ["a", "b", "c"]);
});

test("the loop suggests, waits for the owner, applies once, and does not repeat a decided suggestion", async (t) => {
  const { journal, governance } = await setup(t);
  const harmful = await governance.author({ summary: "harmful habit that keeps failing" });
  for (let i = 0; i < 8; i += 1) await finishedRun(journal, `bad${i}`, "failed", [harmful.id]);
  for (let i = 0; i < 8; i += 1) await finishedRun(journal, `ok${i}`, "completed");
  const service = new ImprovementService({ journal, governance });

  const first = await service.sweep();
  assert.equal(first.suggested.length, 1);
  assert.equal((await service.sweep()).suggested.length, 0, "recomputing the same basis must not duplicate");
  assert.equal((await governance.list({ status: "active" })).length, 1, "nothing changes before the owner decides");

  await service.approve(first.suggested[0]!.id);
  assert.equal((await governance.list({ status: "active" })).length, 0);
  const archived = (await journal.list()).find((event) => event.type === "memory.archived");
  assert.equal((archived?.payload as { reason?: string }).reason, "retired");
  assert.deepEqual(await service.pending(), []);
  assert.equal((await service.sweep()).suggested.length, 0);
  await assert.rejects(() => service.approve(first.suggested[0]!.id), /already decided/);
});

test("dismissing a suggestion keeps it from coming back", async (t) => {
  const { journal, governance } = await setup(t);
  const harmful = await governance.author({ summary: "harmful habit" });
  for (let i = 0; i < 8; i += 1) await finishedRun(journal, `bad${i}`, "failed", [harmful.id]);
  for (let i = 0; i < 8; i += 1) await finishedRun(journal, `ok${i}`, "completed");
  const service = new ImprovementService({ journal, governance });
  const [suggestion] = (await service.sweep()).suggested;
  await service.dismiss(suggestion!.id);
  assert.equal((await service.sweep()).suggested.length, 0);
  assert.equal((await governance.list({ status: "active" })).length, 1);
});

test("a run the owner labels failed is mined for lessons even though it completed, once", async (t) => {
  const { journal, governance } = await setup(t);
  await finishedRun(journal, "r1", "completed", [], "fail");
  const pipeline = new MemoryPipeline(journal);
  const service = new ImprovementService({ journal, governance, pipeline });

  assert.deepEqual((await service.sweep()).lessonsRequested, ["r1"]);
  assert.deepEqual((await service.sweep()).lessonsRequested, []);
  const requested = (await journal.list()).filter((event) => event.type === "memory.candidate.requested");
  assert.equal((requested[0]!.payload as { outcome?: string }).outcome, "failed");
  assert.equal(pipeline.hasPending(), true);
});
