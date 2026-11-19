import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthorityPolicyEngine } from "../../src/authority/policy-engine.ts";
import { StandingPolicyStore } from "../../src/authority/standing-policy-store.ts";
import { runQuery } from "../../src/application/run-query.ts";
import type { ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../../src/core/contracts.ts";
import { JsonlJournalStore } from "../../src/core/journal.ts";
import { DefaultPolicyEngine } from "../../src/core/policy.ts";
import { CloneRuntime } from "../../src/core/runtime.ts";
import { EvidenceVerifier } from "../../src/core/verification.ts";
import { runStatusInfo } from "../../src/main-agent/tools/kernel-tools.ts";
import { MemoryPipeline } from "../../src/memory/memory-pipeline.ts";
import { StaticAgentRegistry } from "../../src/workers/static-worker-registry.ts";
import { createScriptedAgentRegistry } from "../fixtures/scripted-adapter.ts";

class ObservationAdapter implements RuntimeAdapter {
  readonly id = "reviewer";
  readonly providerId = "demo";
  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true, work: ["review"], evidenceKinds: ["observation"] };
  }
  async *execute(): AsyncIterable<ExecutionEvent> {
    yield { type: "evidence", evidence: { kind: "observation", summary: "A result was produced." } };
    yield { type: "completed", summary: "Done." };
  }
}

test("failed runs surface their policy or verification reason to readers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-failure-reason-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await t.test("policy denial is journaled and replayed", async () => {
    const journal = new JsonlJournalStore(join(directory, "policy.jsonl"));
    const store = new StandingPolicyStore(join(directory, "authority"), journal);
    await store.load();
    const policy = new AuthorityPolicyEngine({ config: () => store.snapshot(), home: directory });
    const runtime = new CloneRuntime({ journal, policy, verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Write a file", payload: {} });
    const step = { id: "write", title: "Write", instructions: "Write the file", risk: "reversible_write" as const, acceptanceCriteria: ["file exists"], agentId: "draft-maker", requiredCapabilities: ["drafting"], scopes: [{ domain: "files" as const, resource: join(directory, "output.md"), access: "write" as const }] };
    await runtime.attachPlan(run.id, { summary: "Write a file", steps: [step] });
    const result = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.equal(result.status, "failed");
    const reason = "The files domain is observe-only; raise its autonomy to allow write.";
    const events = await journal.list();
    const changed = events.filter((event) => event.runId === run.id && event.type === "run.status_changed").at(-1);
    assert.match((changed?.payload as { reason?: string }).reason ?? "", /The files domain is observe-only; raise its autonomy to allow write\./);
    assert.ok(runtime.getRun(run.id).failureReason?.includes(reason));
  });

  await t.test("verification failure reaches replay and status information", async (t) => {
    const journal = new JsonlJournalStore(join(directory, "verification.jsonl"));
    const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier({ workspacePath: directory }), memory: new MemoryPipeline(journal) });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "生成报告", payload: {} });
    await runtime.attachPlan(run.id, { summary: "生成报告", steps: [{ id: "briefing", title: "报告", instructions: "写入 `missing.md`", risk: "read_only", acceptanceCriteria: ["内容准确"], agentId: "reviewer", requiredCapabilities: ["review"] }] });
    const result = await runtime.execute(run.id, new StaticAgentRegistry([new ObservationAdapter()]));
    assert.equal(result.status, "failed");
    assert.equal(result.verification?.passed, false);
    assert.match(result.verification?.summary ?? "", /promised but does not exist|Verification failed/i);
    await t.test("replay carries the verification summary", () => {
      assert.equal(runtime.getRun(run.id).failureReason, result.verification!.summary.slice(0, 500));
    });
    await t.test("status reader shows the failure", async () => {
      assert.match(await runStatusInfo(runtime, run.id), /Failure:.*(?:promised but does not exist|Verification failed)/i);
    });
  });

  await t.test("runQuery returns the denied write reason", async () => {
    const result = await runQuery(join(directory, "query"), "Write a report", {}, undefined, {
      agents: createScriptedAgentRegistry(), workspacePath: directory,
    });
    assert.equal(result.status, "failed");
    assert.match((result as typeof result & { failureReason?: string }).failureReason ?? "", /names no write scope/);
  });
});
