import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlJournalStore } from "../../src/core/journal.ts";
import { DefaultPolicyEngine } from "../../src/core/policy.ts";
import { CloneRuntime } from "../../src/core/runtime.ts";
import { EvidenceVerifier } from "../../src/core/verification.ts";
import { MemoryPipeline } from "../../src/memory/memory-pipeline.ts";
import { NativeAgentWorker } from "../../src/workers/native-agent-worker.ts";
import { StaticAgentRegistry } from "../../src/workers/static-worker-registry.ts";

test("a direct answer supplies evidence without relaxing the gate for other steps", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "direct-answer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
    workspacePath: directory,
  });
  const worker = new NativeAgentWorker({
    id: "direct-responder",
    label: "Direct responder",
    workCapabilities: ["direct_response", "research"],
    tools: [],
    createClient: () => ({ complete: async () => ({ content: "收到", toolCalls: [] }) }),
  });
  const agents = new StaticAgentRegistry([worker]);

  async function runStep(capability: string, stepId: string) {
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "只回答两个字：收到", payload: {} });
    await runtime.attachPlan(run.id, {
      summary: "Respond to the request",
      steps: [{
        id: stepId,
        agentId: worker.id,
        requiredCapabilities: [capability],
        title: "Respond",
        instructions: "只回答两个字：收到",
        risk: "read_only",
        acceptanceCriteria: ["The response answers the request"],
      }],
    });
    return { run, result: await runtime.execute(run.id, agents) };
  }

  const ordinary = await runStep("research", "ordinary");
  assert.equal(ordinary.result.status, "failed");
  assert.match(ordinary.result.run.failureReason ?? "", /without evidence/i);

  const direct = await runStep("direct_response", "direct-response");
  assert.equal(direct.result.status, "waiting_review");
  const evidence = (await journal.list()).filter((event) => event.runId === direct.run.id && event.type === "evidence.recorded");
  assert.equal(evidence.length, 1);
  const row = evidence[0]!.payload as { kind: string; summary: string; locator: string; stepId: string };
  assert.equal(row.kind, "observation");
  assert.equal(row.stepId, "direct-response");
  assert.match(row.summary, /收到/);
  assert.ok(row.summary.length <= 8000);
  assert.ok(row.locator.includes("direct-response"));
});
