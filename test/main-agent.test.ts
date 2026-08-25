import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { CloneRuntime } from "../src/core/runtime.ts";
import type { PlanStep } from "../src/core/contracts.ts";
import {
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
  assert.match(result.refused ?? "", /not on record/);
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

test("the Main Agent conversation continues across working directories", async (t) => {
  // The bug this pins: Pi filters recent sessions by cwd when a custom session
  // directory is used, so running clone-ai from another folder used to start a
  // blank conversation and the owner's history looked lost.
  // 这条测试钉住的缺陷：使用自定义会话目录时 Pi 会按 cwd 过滤最近会话，因此从另一个
  // 目录运行 clone-ai 会开出空白对话，所有者的历史看起来"丢了"。
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-session-"));
  const otherCwd = await mkdtemp(join(tmpdir(), "clone-ai-cwd-b-"));
  t.after(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  });

  // Seed a conversation recorded from one directory.
  // 用某个目录记录一段已有对话作为种子。
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionDirectory = join(dataDirectory, "pi-sessions", "main-agent");
  const seeded = SessionManager.create(process.cwd(), sessionDirectory);
  seeded.appendMessage({ role: "user", content: "记住：我偏好先跑测试再提交。", timestamp: Date.now() });
  // Pi only writes the file once an assistant turn exists, so a realistic seed
  // needs both sides of the exchange.
  // Pi 只有在出现 assistant 回合后才落盘，因此真实的种子需要包含一问一答。
  seeded.appendMessage({ role: "assistant", content: [{ type: "text", text: "记住了。" }], timestamp: Date.now(), api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" });
  const seededFile = seeded.getSessionFile();
  assert.ok(seededFile !== undefined);

  // Starting from a different directory must continue that same file.
  // 从另一个目录启动，必须续上同一个文件。
  const { continueOwnerConversation } = await import("../src/main-agent/session.ts");
  const continued = await continueOwnerConversation(dataDirectory);
  assert.equal(continued.getSessionFile(), seededFile, "a different working directory must continue the same conversation");
});

test("resume points both the CLI and the GUI at the chosen conversation", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-resume-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionDirectory = join(dataDirectory, "pi-sessions", "main-agent");

  const seed = (text: string): string => {
    const manager = SessionManager.create(process.cwd(), sessionDirectory);
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now(),
      api: "test", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
    });
    return manager.getSessionFile()!;
  };
  const older = seed("第一段对话");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const newer = seed("第二段对话");

  const { continueOwnerConversation, listOwnerConversations, writeCurrentSessionPointer } = await import("../src/main-agent/session.ts");
  // Default: the newest conversation continues.
  // 默认续最新的那段对话。
  assert.equal((await continueOwnerConversation(dataDirectory)).getSessionFile(), newer);

  // Resume the older one: every later entry point must follow the pointer.
  // 恢复较早那段：之后所有入口都必须跟随该指针。
  const rows = await listOwnerConversations(dataDirectory);
  assert.equal(rows.length, 2);
  await writeCurrentSessionPointer(sessionDirectory, older);
  assert.equal((await continueOwnerConversation(dataDirectory)).getSessionFile(), older);

  // A second caller (the GUI) lands in the same conversation as the CLI.
  // 第二个调用方（GUI）与 CLI 落在同一段对话。
  assert.equal((await continueOwnerConversation(dataDirectory)).getSessionFile(), older);
});

test("a pointer to a conversation that never materialised falls back to real history", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-pointer-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionDirectory = join(dataDirectory, "pi-sessions", "main-agent");
  const manager = SessionManager.create(process.cwd(), sessionDirectory);
  manager.appendMessage({ role: "user", content: "真实历史", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now(),
    api: "test", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
  });
  const real = manager.getSessionFile()!;

  const { continueOwnerConversation, writeCurrentSessionPointer } = await import("../src/main-agent/session.ts");
  await writeCurrentSessionPointer(sessionDirectory, join(sessionDirectory, "never-written.jsonl"));

  assert.equal((await continueOwnerConversation(dataDirectory)).getSessionFile(), real);
});
