import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import type { ExecutionEvent, RuntimeAdapter, RuntimeCapabilities, SubagentWorkOrder } from "../src/core/contracts.ts";

/** A worker that reports whatever it is told, so the Kernel's counting is what is under test. 报告指定事件的 Worker，使被测的只是 Kernel 的计数。 */
class ReportingAdapter implements RuntimeAdapter {
  readonly id = "reporter";
  readonly providerId = "demo";
  readonly #script: (toolCalls: number, modelCalls: number) => ExecutionEvent[];
  constructor(script: (toolCalls: number, modelCalls: number) => ExecutionEvent[]) {
    this.#script = script;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: false, work: ["research"], evidenceKinds: ["observation"] };
  }

  async *execute(): AsyncIterable<ExecutionEvent> {
    for (const event of this.#script(0, 0)) yield event;
  }
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
  return { journal, runtime };
}

function order(budget: Partial<SubagentWorkOrder["budget"]>): SubagentWorkOrder {
  return {
    id: "work", role: "researcher", title: "work", objective: "do it",
    inputs: [], requiredCapabilities: ["research"],
    expectedArtifacts: [{ id: "note", kind: "artifact", description: "out/note.md", required: true }],
    acceptanceCriteria: ["a note exists"], risk: "read_only",
    budget: { maxDurationMs: 10_000, maxAttempts: 1, ...budget },
  };
}

async function run(t: TestContext, budget: Partial<SubagentWorkOrder["budget"]>, events: ExecutionEvent[]) {
  const { runtime } = await setup(t);
  const { run: created } = await runtime.acceptTrigger({ kind: "query", summary: "work", payload: {} });
  await runtime.attachPlan(created.id, {
    summary: "work",
    steps: [{ id: "s1", title: "work", instructions: "do it", risk: "read_only", acceptanceCriteria: ["done"], subagents: [order(budget)] }],
  });
  return runtime.execute(created.id, new StaticAgentRegistry([new ReportingAdapter(() => events)]));
}

test("exceeding the tool-call budget fails the run with a budget category", async (t) => {
  const result = await run(t, { maxToolCalls: 2 }, [
    { type: "tool_started", toolCallId: "1", tool: "read_file" },
    { type: "tool_completed", toolCallId: "1", tool: "read_file", isError: false },
    { type: "tool_started", toolCallId: "2", tool: "read_file" },
    { type: "tool_started", toolCallId: "3", tool: "read_file" },
    { type: "evidence", evidence: { kind: "observation", summary: "done" } },
    { type: "completed", summary: "done" },
  ]);
  assert.equal(result.status, "failed");
  assert.match(result.run.failureReason ?? "", /Tool call budget exceeded/);
});

test("exceeding the model-call budget fails the run", async (t) => {
  const result = await run(t, { maxModelCalls: 1 }, [
    { type: "model_call" },
    { type: "model_call" },
    { type: "evidence", evidence: { kind: "observation", summary: "done" } },
    { type: "completed", summary: "done" },
  ]);
  assert.equal(result.status, "failed");
  assert.match(result.run.failureReason ?? "", /Model call budget exceeded/);
});

test("staying inside the budget does not stop the step", async (t) => {
  const result = await run(t, { maxToolCalls: 3, maxModelCalls: 3 }, [
    { type: "model_call" },
    { type: "tool_started", toolCallId: "1", tool: "read_file" },
    { type: "tool_completed", toolCallId: "1", tool: "read_file", isError: false },
    { type: "evidence", evidence: { kind: "observation", summary: "done" } },
    { type: "completed", summary: "done" },
  ]);
  // The step must get past the budget check; it may still fail its artifact
  // contract, which is a different concern.
  // 该步骤必须越过预算检查；它仍可能因产物契约失败，那是另一回事。
  assert.doesNotMatch(result.run.failureReason ?? "", /budget exceeded/);
});
