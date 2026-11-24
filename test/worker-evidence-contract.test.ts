import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentModelRequest, AgentModelResponse } from "../src/agent/loop.ts";
import { runQuery } from "../src/application/run-query.ts";
import type { ExecutionAssignment, ExecutionEvent, SubagentWorkOrder } from "../src/core/contracts.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { buildInstructions, NativeAgentWorker, type NativeModelClient } from "../src/workers/native-agent-worker.ts";
import { fileTools } from "../src/workers/native-worker-factory.ts";

async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-evidence-contract-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function assignment(
  path: string,
  risk: ExecutionAssignment["step"]["risk"] = "read_only",
  workOrder?: SubagentWorkOrder,
): ExecutionAssignment {
  return {
    run: { id: "run-1", taskId: "task-1", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "task-1", triggerId: "t", title: "t", objective: "do the work", acceptanceCriteria: [], createdAt: "" },
    step: { id: "s1", title: "s1", instructions: "Do the work.", risk, acceptanceCriteria: ["work done"] },
    ...(workOrder === undefined ? {} : { workOrder }),
    executor: { agentId: "native", providerId: "native" },
    workspacePath: path,
  };
}

function fakeClient(responses: AgentModelResponse[]): NativeModelClient {
  let index = 0;
  return {
    async complete(_request: AgentModelRequest) {
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next === undefined) throw new Error("No scripted response.");
      return next;
    },
  };
}

function workOrder(kind: "artifact" | "observation", risk: SubagentWorkOrder["risk"] = "read_only"): SubagentWorkOrder {
  return {
    id: "research",
    agentId: "context-researcher",
    role: "researcher",
    title: "Research",
    objective: "Read the note.",
    inputs: [{ name: "request", description: "The owner's request.", required: true }],
    requiredCapabilities: ["research", "filesystem_read"],
    expectedArtifacts: [{
      id: "context-note",
      kind,
      description: "A context note recorded from the files the worker read.",
      required: true,
      locatorRequired: true,
    }],
    acceptanceCriteria: ["note recorded"],
    risk,
    budget: { maxDurationMs: 60_000, maxToolCalls: 20, maxAttempts: 1 },
  };
}

test("a read-only work order cannot require artifact evidence, but observation is accepted", async (t) => {
  const directory = await workspace(t);
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
  });
  const attach = async (order: SubagentWorkOrder) => {
    const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "contract", payload: {} });
    return runtime.attachPlan(run.id, {
      summary: "one child",
      steps: [{
        id: "prepare",
        title: "Prepare",
        instructions: "Prepare.",
        risk: "reversible_write",
        acceptanceCriteria: ["done"],
        subagents: [order],
      }],
    });
  };

  await assert.rejects(attach(workOrder("artifact")), /read_only but requires artifact evidence/);
  const accepted = await attach(workOrder("observation"));
  assert.equal(accepted.steps[0]?.risk, "reversible_write");
  assert.equal(accepted.steps[0]?.subagents?.[0]?.expectedArtifacts[0]?.kind, "observation");
});

test("a successful read records observation evidence with the read path", async (t) => {
  const directory = await workspace(t);
  await writeFile(join(directory, "README.md"), "hello", "utf8");
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: fileTools(),
    createClient: () => fakeClient([
      { content: null, toolCalls: [{ id: "r", name: "read_file", arguments: JSON.stringify({ path: "README.md" }) }] },
      { content: "read it", toolCalls: [] },
    ]),
  });
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute(assignment(directory))) events.push(event);

  const evidence = events.filter((event) => event.type === "evidence").map((event) => event.evidence);
  assert.ok(evidence.some((item) => item.kind === "observation" && item.locator === "README.md"));
  assert.equal(events.some((event) => event.type === "completed"), true);
});

test("a write after a read upgrades the path to artifact evidence", async (t) => {
  const directory = await workspace(t);
  await writeFile(join(directory, "README.md"), "hello", "utf8");
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: fileTools(),
    createClient: () => fakeClient([
      {
        content: null,
        toolCalls: [
          { id: "r", name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
          { id: "w", name: "write_file", arguments: JSON.stringify({ path: "README.md", content: "hello" }) },
        ],
      },
      { content: "wrote it", toolCalls: [] },
    ]),
  });
  const base = assignment(directory, "reversible_write");
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute({
    ...base,
    step: { ...base.step, scopes: [{ domain: "files", resource: directory, access: "write" }] },
  })) events.push(event);

  const evidence = events.filter((event) => event.type === "evidence").map((event) => event.evidence);
  assert.ok(
    evidence.some((item) => item.kind === "artifact" && item.locator === "README.md"),
    `a write must win over an earlier read, got ${JSON.stringify(evidence)}`,
  );
});

test("a read-only work order never receives a write tool, even inside a writable step", async (t) => {
  const directory = await workspace(t);
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: fileTools(),
    createClient: () => fakeClient([
      { content: null, toolCalls: [{ id: "w", name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "no" }) }] },
      { content: "refused", toolCalls: [] },
    ]),
  });
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute(assignment(directory, "reversible_write", workOrder("observation")))) events.push(event);

  await assert.rejects(access(join(directory, "out.txt")), /ENOENT/);
  assert.equal(events.some((event) => event.type === "completed"), true);
});

test("the worker is told the required evidence contract", () => {
  const artifact = buildInstructions(assignment("/tmp/ws", "reversible_write", workOrder("artifact", "reversible_write")), []);
  assert.match(artifact, /Required evidence contract/);
  assert.match(artifact, /context-note \[artifact, durable locator required\]/);

  const observation = buildInstructions(assignment("/tmp/ws", "read_only", workOrder("observation")), []);
  assert.match(observation, /context-note \[observation, durable locator required\]/);
});

test("a Kernel-rejected plan closes its run instead of freezing in planning", async (t) => {
  const directory = await workspace(t);
  await assert.rejects(
    runQuery(directory, "Research one fact and write a report to out/report.md.", {}, undefined, {
      workspacePath: directory,
      planner: {
        async plan() {
          return {
            summary: "A read-only order with an impossible contract.",
            steps: [{
              id: "prepare",
              title: "Prepare",
              instructions: "Prepare.",
              risk: "reversible_write" as const,
              acceptanceCriteria: ["done"],
              subagents: [workOrder("artifact")],
            }],
          };
        },
      },
    }),
    /read_only but requires artifact evidence/,
  );

  const journal = createJournalStore(directory);
  try {
    const failed = (await journal.list()).find((event) => (
      event.type === "run.status_changed" && (event.payload as { status?: string }).status === "failed"
    ));
    assert.ok(failed, "the rejected plan must fail its run, not leave it planning");
    assert.match((failed.payload as { reason?: string }).reason ?? "", /planning failed: .*read_only but requires artifact evidence/);
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});
