import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Evidence, MemoryCandidate, Run, Task } from "../src/core/contracts.ts";
import { SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { MemoryPipeline, type MemoryWorker } from "../src/memory/memory-pipeline.ts";

async function setup(t: TestContext): Promise<{ first: SqliteJournalStore; second: SqliteJournalStore; lockPath: string; run: Run; task: Task; evidence: Evidence }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-memory-pipeline-"));
  const path = join(directory, "journal.sqlite3");
  const first = new SqliteJournalStore(path);
  const second = new SqliteJournalStore(path);
  t.after(async () => { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const createdAt = new Date().toISOString();
  const run: Run = { id: "run-1", taskId: "task-1", status: "completed", createdAt, updatedAt: createdAt };
  const task: Task = { id: "task-1", triggerId: "trigger-1", title: "task", objective: "prepare a report", acceptanceCriteria: [], createdAt };
  const evidence: Evidence = { id: "ev-1", runId: run.id, stepId: "s", producedBy: "worker", kind: "observation", summary: "result", createdAt };
  await first.append({ type: "task.created", taskId: task.id, payload: task });
  await first.append({ type: "run.created", runId: run.id, taskId: task.id, payload: run });
  await first.append({ type: "evidence.recorded", runId: run.id, taskId: task.id, payload: evidence });
  return { first, second, lockPath: join(directory, "memory-mining"), run, task, evidence };
}

function candidate(): MemoryCandidate {
  return { id: "candidate-1", runId: "run-1", sourceEvidenceIds: ["ev-1"], summary: "记忆候选内容", confidence: "high", status: "proposed", createdAt: new Date().toISOString() };
}

test("two memory pipelines cannot extract the same job concurrently", { timeout: 10_000 }, async (t) => {
  const { first, second, lockPath, run, task, evidence } = await setup(t);
  let calls = 0;
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const worker: MemoryWorker = { async extract() { calls += 1; started(); await wait; return [candidate()]; } };
  const one = new MemoryPipeline(first, worker, { lockPath });
  const two = new MemoryPipeline(second, worker, { lockPath });
  await one.request(run, task, [evidence]);
  await two.rebuild();
  const processing = one.processNext();
  await entered;
  const competing = two.processNext();
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await Promise.all([processing, competing]);
  assert.equal(calls, 1);
  assert.equal((await first.list()).filter((event) => event.type === "memory.candidate.proposed").length, 1);
});

test("a failed extraction keeps its job available for retry", async (t) => {
  const { first, lockPath, run, task, evidence } = await setup(t);
  let calls = 0;
  const worker: MemoryWorker = { async extract() { if (++calls === 1) throw new Error("temporary extraction failure"); return [candidate()]; } };
  const pipeline = new MemoryPipeline(first, worker, { lockPath });
  await pipeline.request(run, task, [evidence]);
  await assert.rejects(pipeline.processNext(), /temporary extraction failure/);
  assert.equal((await pipeline.processNext()).length, 1);
  assert.equal((await first.list()).filter((event) => event.type === "memory.candidate.proposed").length, 1);
});

test("an extraction with no candidates is not repeated after a rebuild", async (t) => {
  const { first, lockPath, run, task, evidence } = await setup(t);
  let calls = 0;
  const pipeline = new MemoryPipeline(first, { async extract() { calls += 1; return []; } }, { lockPath });
  await pipeline.request(run, task, [evidence]);
  assert.deepEqual(await pipeline.processNext(), []);
  await pipeline.rebuild();
  assert.deepEqual(await pipeline.processNext(), []);
  assert.equal(calls, 1);
});

test("candidate publication is atomic and retryable when a journal batch fails", async (t) => {
  const { first, lockPath, run, task, evidence } = await setup(t);
  const pipeline = new MemoryPipeline(first, { async extract() { return [candidate()]; } }, { lockPath });
  await pipeline.request(run, task, [evidence]);
  const original = first.appendBatch.bind(first);
  first.appendBatch = async () => { throw new Error("simulated batch failure"); };
  await assert.rejects(pipeline.processNext(), /simulated batch failure/);
  assert.equal((await first.list()).filter((event) => event.type === "memory.candidate.proposed").length, 0);
  first.appendBatch = original;
  assert.equal((await pipeline.processNext()).length, 1);
  assert.equal((await first.list()).filter((event) => event.type === "memory.candidate.proposed").length, 1);
});

test("a request can process its own memory job instead of an older run's job", async (t) => {
  const { first, lockPath, run, task, evidence } = await setup(t);
  const pipeline = new MemoryPipeline(first, { async extract(job) { return [{ ...candidate(), id: `candidate-${job.run.id}`, runId: job.run.id, sourceEvidenceIds: job.evidence.map((item) => item.id) }]; } }, { lockPath });
  await pipeline.request(run, task, [evidence]);
  const secondRun = { ...run, id: "run-2" };
  const secondEvidence = { ...evidence, id: "ev-2", runId: secondRun.id };
  await pipeline.request(secondRun, task, [secondEvidence]);
  const processed = await pipeline.processNext(secondRun.id);
  assert.equal(processed[0]?.runId, secondRun.id);
  assert.equal((await first.list()).find((event) => event.type === "memory.candidate.proposed")?.runId, secondRun.id);
  assert.equal(pipeline.hasPending(), true);
});
