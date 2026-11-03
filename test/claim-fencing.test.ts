import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunQueueConsumer } from "../src/application/run-queue.ts";
import type { ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";

test("a consumer cancels its worker when lease renewal fails", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-lease-loss-"));
  const journal = new SqliteJournalStore(join(directory, "journal.sqlite3"));
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
  const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "test lease loss", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "test",
    steps: [{ id: "s", title: "work", instructions: "work", risk: "read_only", acceptanceCriteria: ["result"], agentId: "worker", requiredCapabilities: ["review"] }],
  });
  let cancelled = false;
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const worker: RuntimeAdapter = {
    id: "worker", providerId: "fake",
    async capabilities(): Promise<RuntimeCapabilities> { return { resume: false, cancellation: true, approvalCallback: false, parallelAssignments: true, work: ["review"], evidenceKinds: ["observation"] }; },
    async *execute(): AsyncIterable<ExecutionEvent> { yield { type: "session_started", sessionId: "session-1" }; started(); await wait; yield { type: "completed", summary: "done" }; },
    async cancel() { cancelled = true; release(); },
  };
  journal.renewClaim = async () => false;
  const consumer = new RunQueueConsumer({ runtime, journal, leaseMs: 3_000, registry: async () => new StaticAgentRegistry([worker]) });
  await consumer.tick();
  await entered;
  for (let i = 0; i < 30 && !cancelled; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!cancelled) release();
  await consumer.stop();
  assert.equal(cancelled, true);
  assert.equal((await journal.list()).some((event) => event.type === "verification.completed"), false);
});

test("orphan recovery cannot overwrite a run claimed by another executor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-recovery-race-"));
  const journal = new SqliteJournalStore(join(directory, "journal.sqlite3"));
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
  const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "recovery race", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "test",
    steps: [{ id: "s", title: "work", instructions: "work", risk: "read_only", acceptanceCriteria: ["result"], agentId: "worker", requiredCapabilities: ["review"] }],
  });
  await journal.append({ type: "run.status_changed", taskId: run.taskId, runId: run.id, payload: { status: "running", activeStepId: "s" } });
  await runtime.refresh();
  await journal.claimRun({ runId: run.id, ownerId: "old", leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const original = journal.claimRun.bind(journal);
  journal.claimRun = async (input) => {
    if (input.ownerId.startsWith("recovery-")) await original({ ...input, ownerId: "new-owner" });
    return original(input);
  };
  assert.deepEqual(await runtime.recoverOrphanedRuns(), []);
  assert.equal((await journal.list()).filter((event) => event.type === "run.status_changed" && (event.payload as { status?: string }).status === "queued").length, 1);
});

test("an interrupted worker without a replay-safety guarantee is not automatically rerun", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-unsafe-recovery-"));
  const journal = new SqliteJournalStore(join(directory, "journal.sqlite3"));
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
  const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "unsafe interruption", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "test",
    steps: [{ id: "s", title: "work", instructions: "work", risk: "read_only", acceptanceCriteria: ["result"], agentId: "worker", requiredCapabilities: ["review"] }],
  });
  await journal.append({ type: "run.status_changed", taskId: run.taskId, runId: run.id, payload: { status: "running", activeStepId: "s" } });
  await journal.append({ type: "execution.started", taskId: run.taskId, runId: run.id, payload: { stepId: "s", retrySafeAfterInterruption: false } });
  await runtime.refresh();
  const recovered = await runtime.recoverOrphanedRuns();
  assert.equal(recovered[0]?.action, "failed");
  assert.match(recovered[0]?.reason ?? "", /side effect|replay|retry/i);
  assert.equal(runtime.getRun(run.id).status, "failed");
});

test("cancelling from another runtime fences a worker that finishes before its next heartbeat", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-cancel-race-"));
  const path = join(directory, "journal.sqlite3");
  const journal = new SqliteJournalStore(path);
  const otherJournal = new SqliteJournalStore(path);
  t.after(async () => { journal.close(); otherJournal.close(); await rm(directory, { recursive: true, force: true }); });
  const makeRuntime = (store: SqliteJournalStore): CloneRuntime => new CloneRuntime({
    journal: store, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(store),
  });
  const runtime = makeRuntime(journal);
  const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "cancel an active worker", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "test",
    steps: [{ id: "s", title: "work", instructions: "work", risk: "read_only", acceptanceCriteria: ["result"], agentId: "worker", requiredCapabilities: ["review"] }],
  });
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const worker: RuntimeAdapter = {
    id: "worker", providerId: "fake",
    async capabilities(): Promise<RuntimeCapabilities> { return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true, work: ["review"], evidenceKinds: ["observation"] }; },
    async *execute(): AsyncIterable<ExecutionEvent> {
      yield { type: "session_started", sessionId: "session-1" };
      started();
      await wait;
      yield { type: "evidence", evidence: { kind: "observation", summary: "finished after cancellation" } };
      yield { type: "completed", summary: "done" };
    },
  };
  const consumer = new RunQueueConsumer({ runtime, journal, leaseMs: 60_000, registry: async () => new StaticAgentRegistry([worker]) });
  await consumer.tick();
  await entered;
  const other = makeRuntime(otherJournal);
  await other.cancel(run.id, new StaticAgentRegistry([]));
  release();
  await consumer.stop();
  const events = await journal.list();
  const cancellation = events.findIndex((event) => event.type === "run.status_changed" && (event.payload as { status?: string }).status === "cancelled");
  assert.ok(cancellation >= 0);
  assert.equal(events.slice(cancellation + 1).some((event) => event.runId === run.id), false);
  await other.refresh();
  assert.equal(other.getRun(run.id).status, "cancelled");
});

test("cross-runtime cancellation asks the active worker to stop", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-cancel-signal-"));
  const path = join(directory, "journal.sqlite3");
  const journal = new SqliteJournalStore(path);
  const otherJournal = new SqliteJournalStore(path);
  t.after(async () => { journal.close(); otherJournal.close(); await rm(directory, { recursive: true, force: true }); });
  const makeRuntime = (store: SqliteJournalStore): CloneRuntime => new CloneRuntime({
    journal: store, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(store),
  });
  const runtime = makeRuntime(journal);
  const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "stop an active worker", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "test",
    steps: [{ id: "s", title: "work", instructions: "work", risk: "read_only", acceptanceCriteria: ["result"], agentId: "worker", requiredCapabilities: ["review"] }],
  });
  let release!: () => void;
  let started!: () => void;
  let cancelled = false;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const worker: RuntimeAdapter = {
    id: "worker", providerId: "fake",
    async capabilities(): Promise<RuntimeCapabilities> { return { resume: false, cancellation: true, approvalCallback: false, parallelAssignments: true, work: ["review"], evidenceKinds: ["observation"] }; },
    async *execute(): AsyncIterable<ExecutionEvent> { yield { type: "session_started", sessionId: "session-1" }; started(); await wait; },
    async cancel() { cancelled = true; release(); },
  };
  const consumer = new RunQueueConsumer({ runtime, journal, leaseMs: 3_000, registry: async () => new StaticAgentRegistry([worker]) });
  await consumer.tick();
  await entered;
  await makeRuntime(otherJournal).cancel(run.id, new StaticAgentRegistry([]));
  for (let i = 0; i < 30 && !cancelled; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!cancelled) release();
  await consumer.stop();
  assert.equal(cancelled, true);
});

test("cancelling during planning cannot be overwritten by a stale plan", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-cancel-planning-"));
  const path = join(directory, "journal.sqlite3");
  const journal = new SqliteJournalStore(path);
  const otherJournal = new SqliteJournalStore(path);
  t.after(async () => { journal.close(); otherJournal.close(); await rm(directory, { recursive: true, force: true }); });
  const makeRuntime = (store: SqliteJournalStore): CloneRuntime => new CloneRuntime({
    journal: store, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(store),
  });
  const planner = makeRuntime(journal);
  const { run } = await planner.acceptTrigger({ kind: "manual", summary: "cancel during planning", payload: {} });
  const other = makeRuntime(otherJournal);
  await other.cancel(run.id, new StaticAgentRegistry([]));
  await assert.rejects(planner.attachPlan(run.id, {
    summary: "stale plan",
    steps: [{ id: "s", title: "work", instructions: "work", risk: "read_only", acceptanceCriteria: ["result"], agentId: "worker", requiredCapabilities: ["review"] }],
  }), /status|cancel/i);
  await assert.rejects(planner.failRun(run.id, "stale planning failure"), /status|cancel/i);
  await other.refresh();
  assert.equal(other.getRun(run.id).status, "cancelled");
  assert.equal((await journal.list()).some((event) => event.runId === run.id && event.type === "plan.created"), false);
});

test("cancelling during verification leaves a replayable cancelled run", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-cancel-verification-"));
  const path = join(directory, "journal.sqlite3");
  const journal = new SqliteJournalStore(path);
  const otherJournal = new SqliteJournalStore(path);
  t.after(async () => { journal.close(); otherJournal.close(); await rm(directory, { recursive: true, force: true }); });
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const runtime = new CloneRuntime({
    journal, policy: new DefaultPolicyEngine(), memory: new MemoryPipeline(journal),
    verifier: { async verify(input) { started(); await wait; return { runId: input.run.id, passed: true, summary: "done", checkedEvidenceIds: [], createdAt: new Date().toISOString() }; } },
  });
  const other = new CloneRuntime({ journal: otherJournal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(otherJournal) });
  const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "cancel verification", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "test",
    steps: [{ id: "s", title: "work", instructions: "work", risk: "read_only", acceptanceCriteria: ["result"], agentId: "worker", requiredCapabilities: ["review"] }],
  });
  const worker: RuntimeAdapter = {
    id: "worker", providerId: "fake",
    async capabilities(): Promise<RuntimeCapabilities> { return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true, work: ["review"], evidenceKinds: ["observation"] }; },
    async *execute(): AsyncIterable<ExecutionEvent> { yield { type: "evidence", evidence: { kind: "observation", summary: "done" } }; yield { type: "completed", summary: "done" }; },
  };
  const consumer = new RunQueueConsumer({ runtime, journal, leaseMs: 60_000, registry: async () => new StaticAgentRegistry([worker]) });
  await consumer.tick();
  await entered;
  await other.refresh();
  assert.equal(other.getRun(run.id).status, "verifying");
  assert.equal((await other.cancel(run.id, new StaticAgentRegistry([]))).status, "cancelled");
  release();
  await consumer.stop();
  await other.refresh();
  assert.equal(other.getRun(run.id).status, "cancelled");
  assert.equal((await journal.list()).some((event) => event.runId === run.id && event.type === "verification.completed"), false);
});
