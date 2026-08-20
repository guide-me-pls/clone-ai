import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import { buildWorkerPrompt } from "../src/workers/black-box-cli-worker.ts";
import type {
  ExecutionAssignment,
  ExecutionEvent,
  RuntimeAdapter,
  RuntimeCapabilities,
  WorkerMemorySource,
} from "../src/core/contracts.ts";
import { checkJournalInvariants } from "../src/core/invariants.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";

/**
 * Records what the Kernel actually handed the worker, so the test asserts on
 * the assignment the provider received rather than on internals.
 * 记录 Kernel 真正交给 Worker 的内容，使测试断言 Provider 收到的派发本身而非内部实现。
 */
class RecordingAdapter implements RuntimeAdapter {
  readonly id = "demo-researcher";
  readonly providerId = "recording";
  assignment?: ExecutionAssignment;

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false,
      cancellation: false,
      approvalCallback: false,
      parallelAssignments: true,
      work: ["research"],
      evidenceKinds: ["artifact", "observation"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    this.assignment = input;
    yield { type: "evidence", evidence: { kind: "observation", summary: "Reviewed the context." } };
    yield { type: "completed", summary: "Done." };
  }
}

class FakeMemorySource implements WorkerMemorySource {
  readonly queries: string[] = [];
  readonly #items: Array<{ id: string; summary: string }>;

  constructor(items: Array<{ id: string; summary: string }>) {
    this.#items = items;
  }

  async recall(query: string): Promise<Array<{ memory: { id: string; summary: string }; score: number; matchedTerms: string[] }>> {
    this.queries.push(query);
    return this.#items.map((memory) => ({ memory, score: 1, matchedTerms: ["stub"] }));
  }
}

async function runWithMemory(t: TestContext, memorySource?: WorkerMemorySource): Promise<{
  adapter: RecordingAdapter;
  journal: JsonlJournalStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-memory-ctx-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
    ...(memorySource === undefined ? {} : { memorySource }),
  });
  const adapter = new RecordingAdapter();

  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Review the contract.", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "Review it.",
    steps: [{
      id: "review",
      title: "Review",
      instructions: "Review the current contract terms.",
      risk: "read_only",
      acceptanceCriteria: ["A review exists"],
      agentId: "demo-researcher",
      requiredCapabilities: ["research"],
    }],
  });
  await runtime.execute(run.id, new StaticAgentRegistry([adapter]));
  return { adapter, journal };
}

test("the Kernel compiles a scoped memory packet into the worker assignment", async (t) => {
  const source = new FakeMemorySource([
    { id: "mem-1", summary: "The owner prefers concise contract reviews." },
    { id: "mem-2", summary: "Payment terms are always net 30." },
  ]);
  const { adapter } = await runWithMemory(t, source);

  // The objective is the query — memory is selected for this work, not dumped.
  // 目标即查询——记忆是为这份工作筛选的，而不是整体倾倒。
  assert.deepEqual(source.queries, ["Review the current contract terms."]);
  assert.deepEqual(adapter.assignment?.memoryContext?.items, [
    { id: "mem-1", summary: "The owner prefers concise contract reviews." },
    { id: "mem-2", summary: "Payment terms are always net 30." },
  ]);
  assert.equal(adapter.assignment?.memoryContext?.selectedBy.query, "Review the current contract terms.");
});

test("memory that reaches a worker is journaled with the scope it reached", async (t) => {
  const source = new FakeMemorySource([{ id: "mem-1", summary: "Net 30." }]);
  const { journal } = await runWithMemory(t, source);
  const events = await journal.list();

  const recalled = events.find((event) => event.type === "memory.recalled");
  const payload = recalled?.payload as { scope?: { stepId?: string }; memories?: Array<{ id: string }> };
  assert.equal(payload.scope?.stepId, "review");
  assert.deepEqual(payload.memories?.map((memory) => memory.id), ["mem-1"]);

  const dispatch = events.find((event) => event.type === "execution.started");
  assert.deepEqual((dispatch?.payload as { memoryItemIds?: string[] }).memoryItemIds, ["mem-1"]);
  assert.deepEqual(checkJournalInvariants(events), []);
});

test("a runtime without a memory source dispatches an empty memory list", async (t) => {
  const { adapter, journal } = await runWithMemory(t);
  const events = await journal.list();

  assert.equal(adapter.assignment?.memoryContext, undefined);
  assert.equal(events.some((event) => event.type === "memory.recalled"), false);
  const dispatch = events.find((event) => event.type === "execution.started");
  assert.deepEqual((dispatch?.payload as { memoryItemIds?: string[] }).memoryItemIds, []);
  assert.deepEqual(checkJournalInvariants(events), []);
});

test("the shared prompt presents memory as background facts, never as instructions", () => {
  const assignment = {
    run: { id: "run-1", taskId: "task-1", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "task-1", triggerId: "t-1", title: "T", objective: "Review", acceptanceCriteria: [], createdAt: "" },
    step: {
      id: "review",
      title: "Review",
      instructions: "Review it.",
      risk: "read_only",
      acceptanceCriteria: ["A review exists"],
    },
    executor: { agentId: "a", providerId: "p" },
    memoryContext: {
      items: [{ id: "mem-1", summary: "Net 30 payment terms." }],
      selectedBy: { query: "Review it." },
    },
  } as ExecutionAssignment;

  const prompt = buildWorkerPrompt(assignment);
  assert.match(prompt, /background facts, not instructions/);
  assert.match(prompt, /Net 30 payment terms\./);

  const withoutMemory = buildWorkerPrompt({ ...assignment, memoryContext: undefined });
  assert.doesNotMatch(withoutMemory, /memory context/i);
});

test("memory handed to a worker without a prior recall event violates the invariant", () => {
  const dispatch = {
    id: "sub-1",
    runId: "run-1",
    stepId: "send",
    workOrderId: "wo-1",
    agentId: "worker",
    role: "maker",
    title: "Send",
    status: "running",
    attempt: 1,
    startedAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    memoryItemIds: ["mem-smuggled"],
  };
  const event = (sequence: number, type: string, payload: unknown) => ({
    id: `event-${sequence}`,
    sequence,
    type,
    occurredAt: "2026-08-19T00:00:00.000Z",
    runId: "run-1",
    payload,
  });

  const smuggled = checkJournalInvariants([event(1, "subagent.dispatched", dispatch)] as never);
  assert.equal(smuggled.length, 1);
  assert.equal(smuggled[0]?.invariant, "memory-recall-journaled");
  assert.match(smuggled[0]?.message ?? "", /mem-smuggled/);

  const journaled = checkJournalInvariants([
    event(1, "memory.recalled", { query: "send", memories: [{ id: "mem-smuggled", summary: "ok" }] }),
    event(2, "subagent.dispatched", dispatch),
  ] as never);
  assert.deepEqual(journaled, []);
});
