import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  await t.test("policy denial is journaled, appealed and replayed", async () => {
    const journal = new JsonlJournalStore(join(directory, "policy.jsonl"));
    const store = new StandingPolicyStore(join(directory, "authority"), journal);
    await store.load();
    const policy = new AuthorityPolicyEngine({ config: () => store.snapshot(), home: directory });
    const runtime = new CloneRuntime({
      journal,
      policy,
      verifier: new EvidenceVerifier(),
      memory: new MemoryPipeline(journal),
      // The appeal answers DENY, so the run still fails and the reason is the
      // judge's — the new owner of a policy denial.
      // 上诉回答拒绝，因此 Run 仍然失败，理由是裁判的——Policy 拒绝的新归属。
      policyJudge: async () => ({ decision: "deny", reason: "The request does not justify a protected path." }),
    });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Write a file", payload: {} });
    const step = { id: "write", title: "Write", instructions: "Write the file", risk: "reversible_write" as const, acceptanceCriteria: ["file exists"], agentId: "draft-maker", requiredCapabilities: ["drafting"], scopes: [{ domain: "files" as const, resource: join(directory, ".ssh", "output.md"), access: "write" as const }] };
    await runtime.attachPlan(run.id, { summary: "Write a file", steps: [step] });
    const result = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.equal(result.status, "failed");
    const events = await journal.list();
    const decision = events.find((event) => event.type === "policy.decided" && event.runId === run.id);
    assert.match((decision?.payload as { decision?: { reason?: string } }).decision?.reason ?? "", /protected location that no policy can open/);
    const changed = events.filter((event) => event.runId === run.id && event.type === "run.status_changed").at(-1);
    assert.match((changed?.payload as { reason?: string }).reason ?? "", /AI judge denied/);
    assert.match(runtime.getRun(run.id).failureReason ?? "", /AI judge denied/);
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
    const data = join(directory, "query");
    // The default is 全部放行, which allows an unscoped write. Pin this case to
    // act_auto so the "name a target" denial is still what it tests.
    // 默认是「全部放行」，未声明目标的写入会被允许。把本用例钉在 act_auto，继续测试
    // "必须点名目标"的拒绝理由。
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "policies.json"), '{"version":1,"domains":{"files":"act_auto"},"policies":[]}\n', "utf8");
    const result = await runQuery(data, "Write a report", {}, undefined, {
      agents: createScriptedAgentRegistry(), workspacePath: directory,
      policyJudge: async () => ({ decision: "deny", reason: "The request does not name a target." }),
    });
    assert.equal(result.status, "failed");
    assert.match((result as typeof result & { failureReason?: string }).failureReason ?? "", /AI judge denied/);
  });
});
