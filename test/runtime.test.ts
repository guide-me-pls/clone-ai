import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDemoAgentRegistry } from "../src/adapters/demo-adapter.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";

test("a supervisor coordinates child agents, resumes after approval, and preserves the child record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-runtime-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const journalPath = join(directory, "journal.jsonl");
  const journal = new JsonlJournalStore(journalPath);
  const memory = new MemoryPipeline(journal);
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory });

  const { run } = await runtime.acceptTrigger({
    kind: "schedule",
    summary: "Prepare tomorrow's meeting and send the approved agenda.",
    payload: { calendarEventId: "meeting-1" },
  });
  await runtime.attachPlan(run.id, {
    summary: "Prepare with child work orders, then send after approval.",
    steps: [
      {
        id: "prepare",
        title: "Prepare agenda",
        instructions: "Create a local agenda draft.",
        risk: "reversible_write",
        acceptanceCriteria: ["Agenda draft exists"],
        subagents: [
          {
            id: "research",
            agentId: "context-researcher",
            role: "researcher",
            title: "Research meeting context",
            objective: "Find the local context for the meeting.",
            acceptanceCriteria: ["Context note exists"],
          },
          {
            id: "draft",
            agentId: "draft-maker",
            role: "maker",
            title: "Draft agenda",
            objective: "Create the local agenda draft.",
            acceptanceCriteria: ["Draft exists"],
          },
          {
            id: "review",
            agentId: "evidence-reviewer",
            role: "reviewer",
            title: "Review evidence",
            objective: "Review the research and draft evidence.",
            acceptanceCriteria: ["Review exists"],
            dependsOn: ["research", "draft"],
          },
        ],
      },
      {
        id: "send",
        agentId: "external-operator",
        title: "Send agenda",
        instructions: "Send the agenda to attendees.",
        risk: "external_side_effect",
        acceptanceCriteria: ["Delivery receipt exists"],
      },
    ],
  });

  const agents = createDemoAgentRegistry();
  const firstAttempt = await runtime.execute(run.id, agents);
  assert.equal(firstAttempt.status, "waiting_approval");
  assert.equal(firstAttempt.run.activeStepId, "send");
  assert.deepEqual(
    runtime.getSubagentsForRun(run.id).map((subagent) => [subagent.workOrderId, subagent.status]),
    [["research", "completed"], ["draft", "completed"], ["review", "completed"]],
  );

  await runtime.grantApproval(run.id, "send");
  const secondAttempt = await runtime.execute(run.id, agents);
  assert.equal(secondAttempt.status, "completed");
  assert.equal(secondAttempt.verification?.passed, true);

  const candidates = await memory.processNext();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.status, "proposed");

  const recoveredJournal = new JsonlJournalStore(journalPath);
  const recoveredMemory = new MemoryPipeline(recoveredJournal);
  const recoveredRuntime = new CloneRuntime({
    journal: recoveredJournal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: recoveredMemory,
  });
  await recoveredRuntime.hydrate();
  assert.equal(recoveredRuntime.getRun(run.id).status, "completed");
  assert.equal(recoveredRuntime.getSubagentsForRun(run.id).length, 3);

  const eventTypes = await recoveredRuntime.getEventsForRun(run.id);
  assert.ok(eventTypes.includes("subagent.dispatched"));
  assert.ok(eventTypes.includes("subagent.completed"));
  assert.deepEqual(eventTypes.slice(-3), [
    "run.status_changed",
    "memory.candidate.requested",
    "memory.candidate.proposed",
  ]);
});
