import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDemoAgentRegistry } from "../src/adapters/demo-adapter.ts";
import { checkJournalInvariants, assertJournalInvariants } from "../src/core/invariants.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import type { JournalEvent } from "../src/core/contracts.ts";

// A real end-to-end run — child work orders, an approval gate, an external
// step, and verified completion — must produce a history with zero
// violations. If this fails, either the runtime or the invariants are wrong,
// and both answers matter.
// 一次真实端到端运行——子工作单、审批闸门、外部步骤、验证后完成——必须产出零违规的历史。
// 若失败，要么 Runtime 错了要么不变量错了，两个答案都重要。
test("a real supervised run produces a journal with zero invariant violations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-invariants-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const memory = new MemoryPipeline(journal);
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory });

  const { run } = await runtime.acceptTrigger({
    kind: "query",
    summary: "Prepare and send the weekly update.",
    payload: {},
  });
  await runtime.attachPlan(run.id, {
    summary: "Prepare locally, then send after approval.",
    steps: [
      {
        id: "prepare",
        title: "Prepare update",
        instructions: "Draft the update locally.",
        risk: "reversible_write",
        acceptanceCriteria: ["Draft exists"],
        subagents: [{
          id: "draft",
          agentId: "draft-maker",
          role: "maker",
          title: "Draft update",
          objective: "Create the local update draft.",
          inputs: [],
          requiredCapabilities: ["drafting", "filesystem_read", "filesystem_write"],
          expectedArtifacts: [{ id: "draft-doc", kind: "artifact", description: "The draft.", required: true }],
          acceptanceCriteria: ["Draft exists"],
          risk: "reversible_write",
          budget: { maxDurationMs: 30_000, maxModelCalls: 4, maxToolCalls: 4, maxAttempts: 2 },
        }],
      },
      {
        id: "send",
        agentId: "external-operator",
        requiredCapabilities: ["external_action"],
        title: "Send update",
        instructions: "Send the update.",
        risk: "external_side_effect",
        acceptanceCriteria: ["Delivery receipt exists"],
      },
    ],
  });

  const agents = createDemoAgentRegistry();
  const firstAttempt = await runtime.execute(run.id, agents);
  assert.equal(firstAttempt.status, "waiting_approval");
  await runtime.grantApproval(run.id, "send");
  const secondAttempt = await runtime.execute(run.id, agents);
  assert.equal(secondAttempt.status, "completed");

  const violations = checkJournalInvariants(await journal.list());
  assert.deepEqual(violations, []);
});

test("a completion without evidence violates evidence-before-completion", () => {
  const events = [
    event(1, "subagent.completed", { workOrderId: "forged", summary: "Done." }),
  ];

  const violations = checkJournalInvariants(events);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.invariant, "evidence-before-completion");
  assert.throws(() => assertJournalInvariants(events), /evidence-before-completion/);
});

test("an external step that starts without approval violates the approval invariant", () => {
  const plan = {
    id: "plan-1",
    runId: "run-1",
    createdAt: "2026-08-18T00:00:00.000Z",
    summary: "Send something external.",
    steps: [{
      id: "send",
      title: "Send",
      instructions: "Send it.",
      risk: "external_side_effect",
      acceptanceCriteria: ["Receipt exists"],
    }],
  };
  const unauthorized = [
    event(1, "plan.created", plan),
    event(2, "execution.started", { stepId: "send", adapterId: "external-operator", providerId: "demo" }),
  ];
  const authorized = [
    event(1, "plan.created", plan),
    event(2, "approval.granted", { id: "a-1", runId: "run-1", stepId: "send", grantedAt: "2026-08-18T00:00:01.000Z", grantedBy: "user" }),
    event(3, "execution.started", { stepId: "send", adapterId: "external-operator", providerId: "demo" }),
  ];

  const violations = checkJournalInvariants(unauthorized);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.invariant, "approval-before-external-execution");
  assert.deepEqual(checkJournalInvariants(authorized), []);
});

test("a run completed without passed verification violates the verification invariant", () => {
  const withoutVerification = [
    event(1, "run.status_changed", { status: "completed" }),
  ];
  const withVerification = [
    event(1, "verification.completed", { runId: "run-1", passed: true, summary: "ok", checkedEvidenceIds: [], createdAt: "2026-08-18T00:00:00.000Z" }),
    event(2, "run.status_changed", { status: "completed" }),
  ];
  const withFailedVerification = [
    event(1, "verification.completed", { runId: "run-1", passed: false, summary: "missing evidence", checkedEvidenceIds: [], createdAt: "2026-08-18T00:00:00.000Z" }),
    event(2, "run.status_changed", { status: "completed" }),
  ];

  assert.equal(checkJournalInvariants(withoutVerification)[0]?.invariant, "verification-before-run-completion");
  assert.deepEqual(checkJournalInvariants(withVerification), []);
  assert.equal(checkJournalInvariants(withFailedVerification)[0]?.invariant, "verification-before-run-completion");
});

function event(sequence: number, type: JournalEvent["type"], payload: unknown): JournalEvent {
  return {
    id: `event-${sequence}`,
    sequence,
    type,
    occurredAt: "2026-08-18T00:00:00.000Z",
    runId: "run-1",
    payload,
  };
}
