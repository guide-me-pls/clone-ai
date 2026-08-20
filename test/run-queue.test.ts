import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { RunQueueConsumer } from "../src/application/run-queue.ts";
import { GovernedMemorySource, MdMemoryStore } from "../src/memory/md-memory-store.ts";
import { MemoryGovernance } from "../src/memory/memory-governance.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import type { ExecutionAssignment, ExecutionEvent, MemoryCandidate, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";

class ScriptedWorker implements RuntimeAdapter {
  readonly id = "worker";
  readonly providerId = "scripted";
  calls = 0;

  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true, work: ["research"], evidenceKinds: ["artifact"] };
  }

  async *execute(_input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    this.calls += 1;
    yield { type: "evidence", evidence: { kind: "artifact", summary: "did the work", locator: "out/result.md" } };
    yield { type: "completed", summary: "done" };
  }
}

async function kernel(t: TestContext): Promise<{ runtime: CloneRuntime; journal: JsonlJournalStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-queue-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
  });
  await runtime.hydrate();
  return { runtime, journal, directory };
}

test("a queued run is executed by the consumer, not left claiming progress", async (t) => {
  const { runtime } = await kernel(t);
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Do the work", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "One step",
    steps: [{
      id: "s1", title: "Work", instructions: "Do it", risk: "read_only",
      acceptanceCriteria: ["done"], agentId: "worker", requiredCapabilities: ["research"],
    }],
  });
  assert.equal(runtime.getRun(run.id).status, "queued", "the plan is accepted but nothing has run yet");

  const worker = new ScriptedWorker();
  const consumer = new RunQueueConsumer({
    runtime,
    registry: async () => new StaticAgentRegistry([worker]),
  });
  const started = await consumer.tick();
  assert.deepEqual(started, [run.id]);

  // The consumer dispatches asynchronously; wait for the run to settle.
  // 消费者异步派发；等待 Run 落定。
  for (let attempt = 0; attempt < 50 && runtime.getRun(run.id).status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(runtime.getRun(run.id).status, "completed");
  assert.equal(worker.calls, 1);
});

test("the consumer never double-dispatches a run and leaves approvals alone", async (t) => {
  const { runtime } = await kernel(t);
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "External work", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "Needs approval",
    steps: [{
      id: "s1", title: "Send", instructions: "Send it", risk: "external_side_effect",
      acceptanceCriteria: ["receipt"], agentId: "worker", requiredCapabilities: ["research"],
    }],
  });

  const worker = new ScriptedWorker();
  const consumer = new RunQueueConsumer({ runtime, registry: async () => new StaticAgentRegistry([worker]) });
  await consumer.tick();
  for (let attempt = 0; attempt < 50 && runtime.getRun(run.id).status === "queued"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Policy stops external work at approval; the consumer must not push past it.
  // 策略在审批处拦住外部工作；消费者不得越过它。
  assert.equal(runtime.getRun(run.id).status, "waiting_approval");

  const second = await consumer.tick();
  assert.deepEqual(second, [], "a run waiting for approval is not queued work");
});

test("recall serves promoted memories only, never raw candidates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-recall-"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const governance = new MemoryGovernance({ journal, store });
  const source = new GovernedMemorySource(directory);

  // A mined candidate exists in the journal but was never promoted.
  // 一条提炼出的候选存在于 Journal，但从未被提升。
  await journal.append({
    type: "evidence.recorded",
    runId: "run-1",
    payload: { id: "ev-1", runId: "run-1", stepId: "s", kind: "artifact", summary: "e", createdAt: new Date().toISOString() },
  });
  const candidate: MemoryCandidate = {
    id: "c-1", runId: "run-1", sourceEvidenceIds: ["ev-1"],
    summary: "候选：发布前必须完成风险评审", confidence: "high", status: "proposed",
    createdAt: new Date().toISOString(), type: "preference",
  };
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate });

  assert.deepEqual(await source.recall("发布 风险 评审", "run-2"), [], "an unpromoted candidate must not reach a worker");

  // After the owner promotes it, recall serves it.
  // 所有者提升之后，召回才会提供它。
  await governance.promote(candidate);
  const matches = await source.recall("发布 风险 评审", "run-2");
  assert.equal(matches.length, 1);
  assert.match(matches[0]!.memory.summary, /风险评审/);
});

test("work created by another process is picked up after a refresh", async (t) => {
  // The Main Agent proposes through its own Runtime instance; the consumer runs
  // on a different one. Without replaying the journal the consumer would never
  // see the run — the GUI would claim progress while nothing executed.
  // Main Agent 通过它自己的 Runtime 实例提案；消费者跑在另一个实例上。不重放 Journal
  // 的话，消费者永远看不到这个 Run——GUI 会宣称正在推进，而实际什么都没执行。
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-cross-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journalPath = join(directory, "journal.jsonl");

  const proposer = new CloneRuntime({
    journal: new JsonlJournalStore(journalPath),
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(new JsonlJournalStore(journalPath)),
  });
  await proposer.hydrate();

  const consumerRuntime = new CloneRuntime({
    journal: new JsonlJournalStore(journalPath),
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(new JsonlJournalStore(journalPath)),
  });
  await consumerRuntime.hydrate();
  assert.equal(consumerRuntime.listRuns().length, 0, "the consumer starts with an empty projection");

  const { run } = await proposer.acceptTrigger({ kind: "query", summary: "Cross-process work", payload: {} });
  await proposer.attachPlan(run.id, {
    summary: "One step",
    steps: [{
      id: "s1", title: "Work", instructions: "Do it", risk: "read_only",
      acceptanceCriteria: ["done"], agentId: "worker", requiredCapabilities: ["research"],
    }],
  });

  const worker = new ScriptedWorker();
  const consumer = new RunQueueConsumer({ runtime: consumerRuntime, registry: async () => new StaticAgentRegistry([worker]) });
  const started = await consumer.tick();

  assert.deepEqual(started, [run.id], "the consumer must see work created elsewhere");
  for (let attempt = 0; attempt < 50 && worker.calls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(worker.calls, 1);
});
