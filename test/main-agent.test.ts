import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { PlanStep } from "../src/core/contracts.ts";
import {
  createKernelRuntime,
  proposePlanToKernel,
  recallMemories,
  requestApprovalInfo,
  runStatusInfo,
} from "../src/main-agent/kernel-tools.ts";

function reviewStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "review-step",
    title: "Review the contract",
    instructions: "Review the current work order contract.",
    risk: "read_only",
    acceptanceCriteria: ["Review exists"],
    agentId: "demo-researcher",
    requiredCapabilities: ["research"],
    ...overrides,
  };
}

async function tempKernel(t: TestContext): Promise<{ directory: string; runtime: Awaited<ReturnType<typeof createKernelRuntime>> }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-main-agent-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, runtime: await createKernelRuntime(directory) };
}

test("a valid plan proposal is accepted, journaled, and returns run/plan ids", async (t) => {
  const { runtime } = await tempKernel(t);
  const result = await proposePlanToKernel(runtime, {
    summary: "Review the contract",
    steps: [reviewStep()],
  });

  assert.equal(result.accepted, true);
  assert.ok(result.runId);
  assert.ok(result.planId);
  assert.equal(result.runStatus, "queued");
});

test("an empty plan proposal is rejected with feedback and no plan id", async (t) => {
  const { runtime } = await tempKernel(t);
  const result = await proposePlanToKernel(runtime, { summary: "Empty plan", steps: [] });

  assert.equal(result.accepted, false);
  assert.ok(result.runId);
  assert.equal(result.planId, undefined);
  assert.match(result.error ?? "", /at least one step/);
});

test("duplicate step ids are rejected before anything is persisted", async (t) => {
  const { runtime } = await tempKernel(t);
  const result = await proposePlanToKernel(runtime, {
    summary: "Duplicate ids",
    steps: [reviewStep(), reviewStep({ title: "Different title but same id" })],
  });

  assert.equal(result.accepted, false);
  assert.match(result.error ?? "", /unique/);
});

test("an invalid risk class is rejected", async (t) => {
  const { runtime } = await tempKernel(t);
  const result = await proposePlanToKernel(runtime, {
    summary: "Bad risk",
    steps: [reviewStep({ risk: "not-a-risk" as PlanStep["risk"] })],
  });

  assert.equal(result.accepted, false);
  assert.match(result.error ?? "", /invalid risk class/);
});

test("a step without an executor or subagents is rejected", async (t) => {
  const { runtime } = await tempKernel(t);
  const result = await proposePlanToKernel(runtime, {
    summary: "No executor",
    steps: [{ ...reviewStep(), agentId: undefined, requiredCapabilities: undefined }],
  });

  assert.equal(result.accepted, false);
  assert.match(result.error ?? "", /exactly one executor or one subagent group/);
});

test("request_approval reports the run state without granting anything", async (t) => {
  const { runtime } = await tempKernel(t);
  const proposed = await proposePlanToKernel(runtime, { summary: "Review", steps: [reviewStep()] });
  assert.ok(proposed.runId);

  const text = await requestApprovalInfo(runtime, proposed.runId);
  assert.match(text, new RegExp(proposed.runId));
  assert.match(text, /queued/);

  const missing = await requestApprovalInfo(runtime, "run-does-not-exist");
  assert.match(missing, /not found/);
});

test("recall_memory returns no matches on an empty store", async (t) => {
  const { directory } = await tempKernel(t);
  const text = await recallMemories(directory, "anything");
  assert.equal(text, "No matching memories.");
});

test("get_run_status summarizes a run from the Kernel projection", async (t) => {
  const { runtime } = await tempKernel(t);
  const proposed = await proposePlanToKernel(runtime, { summary: "Review", steps: [reviewStep()] });
  assert.ok(proposed.runId);
  assert.ok(proposed.planId);

  const text = await runStatusInfo(runtime, proposed.runId);
  assert.match(text, new RegExp(proposed.runId));
  assert.match(text, /queued/);
  assert.match(text, new RegExp(proposed.planId ?? ""));

  const missing = await runStatusInfo(runtime, "run-does-not-exist");
  assert.match(missing, /not found/);
});
