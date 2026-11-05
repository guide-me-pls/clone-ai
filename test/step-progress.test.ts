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
import type { ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";

class ProgressAdapter implements RuntimeAdapter {
  readonly id = "progress";
  readonly providerId = "demo";
  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: false, work: ["research"], evidenceKinds: ["observation"] };
  }
  async *execute(): AsyncIterable<ExecutionEvent> {
    yield { type: "progress", message: "reading files" };
    yield { type: "evidence", evidence: { kind: "observation", summary: "read them" } };
    yield { type: "completed", summary: "done" };
  }
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
  return { runtime };
}

test("a run reports which step is in progress and what it last said", async (t) => {
  const { runtime } = await setup(t);
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "work", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "two steps",
    steps: [
      { id: "first", title: "first", instructions: "do first", risk: "read_only", acceptanceCriteria: ["done"], agentId: "progress", requiredCapabilities: ["research"] },
      { id: "second", title: "second", instructions: "do second", risk: "read_only", acceptanceCriteria: ["done"], agentId: "progress", requiredCapabilities: ["research"] },
    ],
  });
  const before = runtime.getRunProgress(run.id);
  assert.equal(before.steps.length, 2);

  await runtime.execute(run.id, new StaticAgentRegistry([new ProgressAdapter()]));

  const after = runtime.getRunProgress(run.id);
  const first = after.steps.find((step) => step.stepId === "first")!;
  assert.equal(first.completed, true);
  assert.equal(first.lastMessage, "reading files");
  assert.equal(after.steps.every((step) => step.completed), true);
});
