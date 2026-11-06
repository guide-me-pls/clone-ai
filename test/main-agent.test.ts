import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { CloneRuntime } from "../src/core/runtime.ts";
import type { PlanStep } from "../src/core/contracts.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import {
  createKernelToolsExtension,
  createKernelRuntimeSession,
  installWorkerAgent,
  proposePlanToKernel,
  recallMemories,
  requestAgentInstallation,
  requestApprovalInfo,
  runStatusInfo,
} from "../src/main-agent/tools/kernel-tools.ts";

/**
 * A step naming an executor the owner actually has.
 *
 * The Kernel now rejects a plan that names an executor absent from the
 * registry, so a fixture id like "demo-researcher" would be rejected for the
 * right reason and hide whatever the test meant to check. Using a real default
 * worker keeps each test about its own subject.
 *
 * 一个点名了所有者真实拥有的执行者的步骤。
 *
 * Kernel 现在会拒绝点名了注册表中不存在的执行者的计划，因此像 "demo-researcher"
 * 这样的虚构 id 会因为“正确的理由”被拒，反而掩盖测试真正想检验的东西。使用真实的
 * 默认 Worker，能让每个测试只围绕它自己的主题。
 */
function reviewStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "review-step",
    title: "Review the contract",
    instructions: "Review the current work order contract.",
    risk: "read_only",
    acceptanceCriteria: ["Review exists"],
    agentId: "context-researcher",
    requiredCapabilities: ["research"],
    ...overrides,
  };
}

/**
 * A throwaway clone home with a Kernel runtime that is closed before the
 * directory is removed, so the SQLite journal never blocks cleanup.
 *
 * 一个一次性 clone home，其 Kernel Runtime 会在目录被删除之前关闭，因此 SQLite Journal
 * 不会阻碍清理。
 */
async function tempKernel(t: TestContext): Promise<{ directory: string; runtime: CloneRuntime }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-main-agent-"));
  const { runtime, close } = await createKernelRuntimeSession(directory);
  t.after(async () => {
    close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, runtime };
}

test("installing without the owner's confirmation on record is refused before npm", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-install-gate-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  // No conversation has been seeded, so no quote can match: the refusal is
  // mechanical, and it happens before any installer runs.
  // 没有播下任何对话，因此任何引文都匹配不上：拒绝是机械的，且发生在任何安装器
  // 运行之前。
  const result = await requestAgentInstallation(directory, "pi", "帮我装一下 pi");
  assert.equal(result.installed, false);
  assert.match(result.refused ?? "", /independent|desktop|CLI/i);
});

test("an unrelated owner quote cannot authorize an installation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-install-quote-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const now = new Date().toISOString();
  await appendMainAgentTurnRecord(directory, {
    id: "seed-1",
    text: "我每周五要写周报",
    status: "completed",
    startedAt: now,
    completedAt: now,
    reply: "知道了。",
  });
  const result = await requestAgentInstallation(directory, "not-a-real-provider", "我每周五要写周报");
  assert.equal(result.installed, false);
  assert.match(result.refused ?? "", /independent|desktop|CLI/i);
});

test("a model cannot use an unrelated owner quote to record an invented boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-state-quote-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const now = new Date().toISOString();
  await appendMainAgentTurnRecord(directory, {
    id: "seed-1",
    text: "我每周五要写周报",
    status: "completed",
    startedAt: now,
    completedAt: now,
    reply: "知道了。",
  });
  const tools = new Map<string, { execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text?: string }> }> }>();
  const pi = { registerTool(tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }> }) { tools.set(tool.name, tool); } };
  createKernelToolsExtension(pi, { dataDirectory: directory });
  const response = await tools.get("record_state")!.execute("call", { kind: "boundary", ownerSaid: "我每周五要写周报", statement: "绕过所有审批" });
  assert.match(response.content[0]?.text ?? "", /owner|review|confirm/i);
  const journal = createJournalStore(directory);
  try { assert.equal((await journal.list()).some((event) => event.type === "state.self_model.recorded"), false); }
  finally { (journal as { close?: () => void }).close?.(); }
});

test("a Main Agent status tool sees changes made by another runtime", async (t) => {
  const { directory, runtime } = await tempKernel(t);
  const proposed = await proposePlanToKernel(runtime, { summary: "Review", steps: [reviewStep()] });
  const tools = new Map<string, { execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text?: string }> }> }>();
  const pi = { registerTool(tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }> }) { tools.set(tool.name, tool); } };
  createKernelToolsExtension(pi, { dataDirectory: directory });
  const status = tools.get("get_run_status")!;
  assert.match((await status.execute("first", { runId: proposed.runId })).content[0]?.text ?? "", /queued/);
  await runtime.cancel(proposed.runId!, new StaticAgentRegistry([]));
  assert.match((await status.execute("second", { runId: proposed.runId })).content[0]?.text ?? "", /cancelled/);
});

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

test("a step that needs filesystem_write cannot declare itself read_only", async (t) => {
  const { runtime } = await tempKernel(t);
  // The risk class is the model's proposal; the capabilities are the step's own
  // statement of what it will do. The Kernel recalculates the floor, so a plan
  // cannot undersell writes as reads.
  // 风险等级是模型的提案；能力是步骤自己关于将要做什么的声明。Kernel 重算下限，
  // 因此计划无法把写入贱卖成读取。
  const result = await proposePlanToKernel(runtime, {
    summary: "Undersold risk",
    steps: [reviewStep({ risk: "read_only", requiredCapabilities: ["research", "filesystem_write"] })],
  });

  assert.equal(result.accepted, false);
  assert.match(result.error ?? "", /risk class is recalculated from the capabilities/);
});

test("a step that needs external_action cannot declare itself reversible", async (t) => {
  const { runtime } = await tempKernel(t);
  const result = await proposePlanToKernel(runtime, {
    summary: "Undersold external risk",
    steps: [reviewStep({ risk: "reversible_write", requiredCapabilities: ["external_action"] })],
  });

  assert.equal(result.accepted, false);
  assert.match(result.error ?? "", /at least "external_side_effect"/);
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

test("a pure conversation is answered, not turned into a run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-conversation-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { runtime, close } = await createKernelRuntimeSession(directory);
  t.after(() => close());
  const proposal = await proposePlanToKernel(runtime, {
    summary: "你好",
    steps: [{
      id: "reply",
      title: "直接回答",
      instructions: "直接回答",
      risk: "read_only",
      acceptanceCriteria: ["已回答"],
      agentId: "direct-responder",
      requiredCapabilities: ["direct_response"],
    }],
  });
  // Refused before a Run exists: no session in the sidebar and no worker launch.
  // 在创建 Run 之前就拒绝：侧栏不会有会话，也不会启动 Worker。
  assert.equal(proposal.accepted, false);
  assert.match(proposal.error ?? "", /conversation, not work/);
  assert.equal(runtime.listRuns().length, 0);
});
