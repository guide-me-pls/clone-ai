import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { PlanStep } from "../src/core/contracts.ts";
import {
  createKernelRuntime,
  installWorkerAgent,
  proposePlanToKernel,
  recallMemories,
  requestApprovalInfo,
  runStatusInfo,
} from "../src/main-agent/tools/kernel-tools.ts";

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

test("install_agent reports an already-installed worker without touching npm", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-install-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const result = await installWorkerAgent(directory, "unknown-agent");
  assert.equal(result.installed, false);
  assert.match(result.error ?? "", /No worker is registered/);
});

test("install_agent refuses to guess installers for unknown providers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-install-2-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  // A user-declared provider without an automatic installer must be refused
  // with a precise reason, not attempted via npm.
  // 没有自动安装器的用户声明 Provider 必须带着精确原因被拒绝，而不是尝试 npm。
  const fs = await import("node:fs/promises");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, "providers.json"), JSON.stringify({
    providers: [{ id: "my-agent", command: "my-agent", args: ["run", "{{prompt}}"] }],
  }), "utf8");

  const result = await installWorkerAgent(directory, "my-agent");
  assert.equal(result.installed, false);
  assert.match(result.error ?? "", /no automatic installer/);
});

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

test("an empty plan proposal is rejected with feedback and its run is closed", async (t) => {
  const { runtime } = await tempKernel(t);
  const result = await proposePlanToKernel(runtime, { summary: "Empty plan", steps: [] });

  assert.equal(result.accepted, false);
  assert.ok(result.runId);
  assert.equal(result.planId, undefined);
  assert.match(result.error ?? "", /at least one step/);
  // A rejected proposal must not linger as if it were still planning.
  // 被拒绝的提案不能伪装成仍在规划中。
  assert.equal(result.runStatus, "failed");
  assert.equal(runtime.getRun(result.runId!).status, "failed");
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

test("the Main Agent conversation continues across working directories", async (t) => {
  // The bug this pins: Pi filters recent sessions by cwd when a custom session
  // directory is used, so running clone-ai from another folder used to start a
  // blank conversation and the owner's history looked lost.
  // 这条测试钉住的缺陷：使用自定义会话目录时 Pi 会按 cwd 过滤最近会话，因此从另一个
  // 目录运行 clone-ai 会开出空白对话，所有者的历史看起来"丢了"。
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-session-"));
  const firstCwd = await mkdtemp(join(tmpdir(), "clone-ai-cwd-a-"));
  const secondCwd = await mkdtemp(join(tmpdir(), "clone-ai-cwd-b-"));
  t.after(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(firstCwd, { recursive: true, force: true });
    await rm(secondCwd, { recursive: true, force: true });
  });

  const { createMainAgentSession } = await import("../src/main-agent/session.ts");
  const first = await createMainAgentSession({ dataDirectory, cwd: firstCwd });
  const firstId = first.session.sessionManager.sessionPath;
  first.session.dispose();

  const second = await createMainAgentSession({ dataDirectory, cwd: secondCwd });
  const secondId = second.session.sessionManager.sessionPath;
  second.session.dispose();

  assert.equal(secondId, firstId, "a different working directory must continue the same conversation");
});
