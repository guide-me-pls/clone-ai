import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Evidence, PlanStep, Run, WorkPlan } from "../src/core/contracts.ts";
import { CompositeVerifier, createDefaultVerifier, EvidenceVerifier, extractFileExpectations } from "../src/core/verification.ts";
import { DiffFileVerifier, TestCommandVerifier, mentionsTests } from "../src/core/verifier-plugins.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import type { ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function planFor(steps: PlanStep[]): WorkPlan {
  return {
    id: "plan-1",
    runId: "run-1",
    summary: "Check verification.",
    steps,
    createdAt: "2026-09-08T00:00:00.000Z",
  };
}

function run(): Run {
  return { id: "run-1", taskId: "task-1", status: "verifying", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:01.000Z" };
}

test("implementation identifiers do not become missing file expectations", async (t) => {
  const directory = await tempDir(t, "clone-ai-verifier-identifiers-");
  const criterion = "Use `fs.rename`, `os.tmpdir`, `consumed-traces.json`, and `REPORT_DIR/consumed-traces.json` as implementation identifiers.";
  const step: PlanStep = { id: "repair", title: "Repair", instructions: "Implement the repair.", risk: "reversible_write", acceptanceCriteria: [criterion] };
  assert.deepEqual(extractFileExpectations(step), []);
  const result = await new EvidenceVerifier({ workspacePath: directory }).verify({
    run: run(), plan: planFor([step]),
    evidence: [{ id: "ev", runId: "run-1", stepId: "repair", kind: "observation", summary: "Implemented.", createdAt: new Date().toISOString() }],
  });
  assert.equal(result.passed, false);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.unverifiedCriteria, [`Repair: ${criterion}`]);
  assert.doesNotMatch(result.summary, /does not exist on disk|could not be located/);
});

test("file expectations distinguish paths and explicit root-level deliverables from code", () => {
  const step: PlanStep = {
    id: "files", title: "Files", risk: "reversible_write",
    instructions: "Review docs/nightly-rsi.md, test/foo.test.ts and src/core/runtime.ts. Inspect consumed-traces.json.",
    acceptanceCriteria: [
      "文件 weekly-report.md 存在",
      "Create README.md",
      "Use REPORT_DIR/consumed-traces.json and __DIR__/state.json.",
      "Use `https://example.com/docs/reference.md`, `foo(docs/call.ts)`, `fs.rename`, `os.tmpdir` and `${REPORT_DIR}/state.json`.",
      "Create output.bin and call `foo(docs/argument.ts)`.",
      "File creation is described. consumed-traces.json is an implementation reference.",
      "Inspect lib\\runtime.ts.",
    ],
  };
  assert.deepEqual(extractFileExpectations(step).map((item) => item.path), [
    "docs/nightly-rsi.md", "test/foo.test.ts", "src/core/runtime.ts",
    "weekly-report.md", "README.md", "lib\\runtime.ts",
  ]);
});

test("a path a plan says not to claim is not a promised file", () => {
  // The Forbidden City benchmark caught this: a step that honestly says "do not
  // claim out/video.mp4 exists" was failed for the missing MP4.
  // 故宫基准发现了这一点：诚实写明"不要声称 out/video.mp4 已生成"的步骤因缺少 MP4 被判失败。
  const zh: PlanStep = {
    id: "zh", title: "Publish", risk: "reversible_write",
    instructions: "交付 index.html 与 render.mjs，但本执行器不能渲染，因此不要声称 out/video.mp4 已生成。",
    acceptanceCriteria: ["交付物齐全"],
  };
  assert.deepEqual(extractFileExpectations(zh).map((item) => item.path), ["index.html", "render.mjs"]);
  const en: PlanStep = {
    id: "en", title: "Publish", risk: "reversible_write",
    instructions: "Deliver index.html. Do not claim out/video.mp4 exists; the worker cannot render.",
    acceptanceCriteria: ["Deliverables present"],
  };
  // "Deliver" is not a file-intent word, so this sentence yields no deliverable;
  // what matters is that the negated MP4 does not become one either.
  // "Deliver" 不是文件意图词，本句本就不产出交付物；关键是其中的否定 MP4 也不会变成交付物。
  assert.deepEqual(extractFileExpectations(en).map((item) => item.path), []);
  // A prohibition on one path must not hide a real deliverable named after it.
  // 对一个路径的禁止不能掩盖其后真正点名的交付物。
  const mixed: PlanStep = {
    id: "mixed", title: "Publish", risk: "reversible_write",
    instructions: "Do not claim out/video.mp4 exists. Write out/summary.md instead.",
    acceptanceCriteria: ["out/summary.md is non-empty"],
  };
  assert.deepEqual(extractFileExpectations(mixed).map((item) => item.path), ["out/summary.md"]);
});

test("a step that expects a test run still needs test evidence", () => {
  const step = (instructions: string, acceptanceCriteria: string[] = []): PlanStep =>
    ({ id: "t", title: "Test", risk: "reversible_write", instructions, acceptanceCriteria });
  // A real run request, in either language, is still a test step.
  // 真正的运行请求，中英文都仍算测试步骤。
  assert.equal(mentionsTests(step("Fix the parser.", ["npm test passes"])), true);
  assert.equal(mentionsTests(step("修复后运行测试并记录结果。")), true);
  assert.equal(mentionsTests(step("Run `node --test tests/` and record the result.")), true);
  // Naming tests/ as a deliverable, or saying the tests were not run, is not.
  // 把 tests/ 列为交付物、或声明测试未运行，则不算。
  assert.equal(mentionsTests(step("交付 index.html、src/ 模块、render.mjs、tests/ 与 README。")), false);
  assert.equal(mentionsTests(step("README 列出未执行的测试与渲染。")), false);
  assert.equal(mentionsTests(step("测试由所有者执行，不要声称已运行。")), false);
});

test("an external_side_effect step without a receipt locator cannot pass", async () => {
  const verifier = new EvidenceVerifier();
  const result = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "send",
      title: "Send mail",
      instructions: "Send the update.",
      risk: "external_side_effect",
      acceptanceCriteria: ["Delivery receipt exists"],
    }]),
    evidence: [{
      id: "ev-1", runId: "run-1", stepId: "send", kind: "artifact",
      summary: "I sent it.", createdAt: "2026-09-08T00:00:01.000Z",
    }],
  });
  assert.equal(result.passed, false);
  assert.match(result.summary, /receipt with a locator/);
});

test("a receipt alone does not prove an uncheckable acceptance criterion", async () => {
  const verifier = new EvidenceVerifier();
  const result = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "send",
      title: "Send mail",
      instructions: "Send the update.",
      risk: "external_side_effect",
      acceptanceCriteria: ["Delivery receipt exists"],
    }]),
    evidence: [{
      id: "ev-1", runId: "run-1", stepId: "send", kind: "receipt", locator: "mail://sent/1",
      summary: "Delivered.", createdAt: "2026-09-08T00:00:01.000Z",
    }],
  });
  assert.equal(result.passed, false);
  assert.equal(result.needsReview, true);
  assert.ok(result.unverifiedCriteria?.length);
});

test("uncheckable result quality requires a human review before completion", async (t) => {
  const directory = await tempDir(t, "clone-ai-review-");
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
  });
  const { run: created } = await runtime.acceptTrigger({ kind: "query", summary: "整理一份个人简报", payload: {} });
  await runtime.attachPlan(created.id, {
    summary: "整理简报",
    steps: [{
      id: "briefing", title: "个人简报", instructions: "整理今天的任务", risk: "read_only",
      acceptanceCriteria: ["内容准确且相关"], agentId: "reviewer", requiredCapabilities: ["review"],
    }],
  });
  const result = await runtime.execute(created.id, new StaticAgentRegistry([new ObservationAdapter()]));
  assert.equal(result.status, "waiting_review");
  assert.equal(result.verification?.passed, false);
  assert.equal(result.verification?.needsReview, true);
  assert.ok(result.verification?.unverifiedCriteria?.some((criterion) => criterion.includes("内容准确且相关")));
  assert.equal((await journal.list()).some((event) => event.type === "memory.candidate.requested"), false);

  const accepted = await runtime.reviewVerification(created.id, "accept");
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.verification?.passed, true);
  assert.equal(accepted.verification?.reviewedBy, "owner");
  const events = await journal.list();
  assert.equal(events.filter((event) => event.type === "memory.candidate.requested").length, 1);
  await assert.rejects(runtime.reviewVerification(created.id, "accept"), /not waiting for review/);
});

test("a failed review commit leaves neither a false approval nor a completed run", async (t) => {
  const directory = await tempDir(t, "clone-ai-review-atomic-");
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
  const { run: created } = await runtime.acceptTrigger({ kind: "query", summary: "整理简报", payload: {} });
  await runtime.attachPlan(created.id, {
    summary: "简报",
    steps: [{ id: "brief", title: "简报", instructions: "整理简报", risk: "read_only", acceptanceCriteria: ["内容准确"], agentId: "reviewer", requiredCapabilities: ["review"] }],
  });
  assert.equal((await runtime.execute(created.id, new StaticAgentRegistry([new ObservationAdapter()]))).status, "waiting_review");
  const before = (await journal.list()).length;
  const original = journal.appendBatch.bind(journal);
  journal.appendBatch = async () => { throw new Error("simulated atomic commit failure"); };
  await assert.rejects(runtime.reviewVerification(created.id, "accept"), /simulated atomic commit failure/);
  assert.equal(runtime.getRun(created.id).status, "waiting_review");
  assert.equal((await journal.list()).length, before);
  journal.appendBatch = original;
  assert.equal((await runtime.reviewVerification(created.id, "accept")).status, "completed");
});

test("a failed mechanical check cannot be accepted as an unverified result", async (t) => {
  const directory = await tempDir(t, "clone-ai-review-failure-");
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier({ workspacePath: directory }), memory: new MemoryPipeline(journal) });
  const { run: created } = await runtime.acceptTrigger({ kind: "query", summary: "生成报告", payload: {} });
  await runtime.attachPlan(created.id, {
    summary: "生成报告",
    steps: [{ id: "briefing", title: "报告", instructions: "写入 `missing.md`", risk: "read_only", acceptanceCriteria: ["内容准确"], agentId: "reviewer", requiredCapabilities: ["review"] }],
  });
  const result = await runtime.execute(created.id, new StaticAgentRegistry([new ObservationAdapter()]));
  assert.equal(result.status, "failed");
  await assert.rejects(runtime.reviewVerification(created.id, "accept"), /not waiting for review/);
});

test("file verification cannot read outside the authorized workspace or through a symlink", async (t) => {
  const root = await tempDir(t, "clone-ai-verifier-path-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const secret = join(root, "outside.txt");
  await writeFile(secret, "private test text", "utf8");
  if (process.platform !== "win32") await symlink(secret, join(workspace, "link.txt"));
  const verifier = new EvidenceVerifier({ workspacePath: workspace });
  const paths = [secret, "nested/../../outside.txt", ...(process.platform === "win32" ? [] : ["link.txt"])];
  for (const path of paths) {
    const result = await verifier.verify({
      run: run(),
      plan: planFor([{ id: "read", title: "Read", instructions: `Check \`${path}\``, risk: "read_only", acceptanceCriteria: [`File ${path} exists`] }]),
      evidence: [{ id: "ev", runId: "run-1", stepId: "read", kind: "observation", summary: "reported", locator: secret, createdAt: new Date().toISOString() }],
    });
    assert.equal(result.passed, false, path);
    assert.equal(result.needsReview, undefined, path);
  }
});

test("a write step's declared scope is a verification root outside the workspace", async (t) => {
  const root = await tempDir(t, "clone-ai-scoped-write-");
  const workspace = join(root, "workspace");
  const project = join(root, "project");
  await mkdir(workspace);
  await mkdir(project);
  const file = join(project, "out.md");
  await writeFile(file, "done\n", "utf8");
  const step: PlanStep = {
    id: "write", title: "Write", risk: "reversible_write",
    instructions: `Write \`${file}\``,
    acceptanceCriteria: [`File ${file} exists`],
    scopes: [{ domain: "files", resource: project, access: "write" }],
  };
  const evidence: Evidence[] = [{ id: "ev", runId: "run-1", stepId: "write", kind: "observation", summary: "wrote it", createdAt: new Date().toISOString() }];
  const scoped = await new EvidenceVerifier({ workspacePath: workspace }).verify({ run: run(), plan: planFor([step]), evidence });
  assert.equal(scoped.passed, true, scoped.summary);

  // Without the scope the same path is still outside every authorized root.
  // 没有 Scope 时，同一路径仍在所有授权根之外。
  const unscoped = await new EvidenceVerifier({ workspacePath: workspace }).verify({
    run: run(), plan: planFor([{ ...step, scopes: undefined }]), evidence,
  });
  assert.equal(unscoped.passed, false);
  assert.match(unscoped.summary, /outside the roots this step may verify|protected/i);
});

test("the Kernel does not mark an external step completed when the adapter only produced an artifact", async (t) => {
  const directory = await tempDir(t, "clone-ai-ext-");
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
  });
  const { run: created } = await runtime.acceptTrigger({ kind: "query", summary: "Send it.", payload: {} });
  await runtime.attachPlan(created.id, {
    summary: "Send after approval.",
    steps: [{
      id: "send",
      title: "Send",
      instructions: "Send the already-approved update.",
      risk: "external_side_effect",
      acceptanceCriteria: ["Delivery receipt exists"],
      agentId: "external-operator",
      requiredCapabilities: ["external_action"],
    }],
  });
  await runtime.grantApproval(created.id, "send");
  const result = await runtime.execute(created.id, new StaticAgentRegistry([new ArtifactOnlyExternalAdapter()]));
  assert.equal(result.status, "failed");
  assert.equal(runtime.getRun(created.id).status, "failed");
  assert.equal(result.verification?.passed, false);
  assert.match(result.verification?.summary ?? "", /receipt with a locator/);
});

test("a test command plugin actually runs the named command", async (t) => {
  const workspace = await tempDir(t, "clone-ai-testcmd-");
  const verifier = new TestCommandVerifier({
    workspacePath: workspace,
    timeoutMs: 8_000,
    approvedCommands: [["node", "-e", "process.exit(0)"], ["node", "-e", "process.exit(2)"]],
  });
  const passing = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "tests",
      title: "Run tests",
      instructions: "Execute the suite. test command: node -e process.exit(0)",
      risk: "read_only",
      acceptanceCriteria: ["tests pass"],
    }]),
    evidence: [],
  });
  assert.equal(passing.passed, true);

  const failing = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "tests",
      title: "Run tests",
      instructions: "Execute the suite. test command: node -e process.exit(2)",
      risk: "read_only",
      acceptanceCriteria: ["tests pass"],
    }]),
    evidence: [],
  });
  assert.equal(failing.passed, false);
  assert.match(failing.summary, /exited 2/);
});

test("a plan cannot authorize its own test command", async (t) => {
  const workspace = await tempDir(t, "clone-ai-verifier-command-");
  let called = false;
  const verifier = new TestCommandVerifier({
    workspacePath: workspace,
    runner: async () => { called = true; return { code: 0, output: "" }; },
  });
  const result = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "tests", title: "Tests", instructions: "test command: node -e process.exit(0)",
      risk: "read_only", acceptanceCriteria: ["tests pass"],
    }]),
    evidence: [],
  });
  assert.equal(called, false);
  assert.equal(result.passed, false);
  assert.equal(result.needsReview, true);
});

test("a test step without a command still requires test evidence with a locator", async () => {
  const verifier = new TestCommandVerifier();
  const result = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "tests",
      title: "Run tests",
      instructions: "跑测试 and report the result.",
      risk: "read_only",
      acceptanceCriteria: ["tests pass"],
    }]),
    evidence: [{
      id: "ev-1", runId: "run-1", stepId: "tests", kind: "observation",
      summary: "all good", createdAt: "2026-09-08T00:00:01.000Z",
    }],
  });
  assert.equal(result.passed, false);
  assert.match(result.summary, /test evidence with a locator/);
});

test("a diff plugin reads the unified diff instead of trusting prose", async (t) => {
  const workspace = await tempDir(t, "clone-ai-diff-");
  await mkdir(join(workspace, "out"), { recursive: true });
  await writeFile(join(workspace, "out", "change.diff"), "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n+hello\n", "utf8");
  const verifier = new DiffFileVerifier({ workspacePath: workspace });
  const evidence: Evidence[] = [{
    id: "ev-diff", runId: "run-1", stepId: "review", kind: "artifact",
    summary: "Looks fine.", locator: "out/change.diff", createdAt: "2026-09-08T00:00:01.000Z",
  }];
  const passing = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "review",
      title: "Review the diff",
      instructions: "Read the unified diff and confirm the change.",
      risk: "read_only",
      acceptanceCriteria: ["diff is reviewed"],
    }]),
    evidence,
  });
  assert.equal(passing.passed, true);

  const missing = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "review",
      title: "Review the diff",
      instructions: "Read the unified diff.",
      risk: "read_only",
      acceptanceCriteria: ["diff is reviewed"],
    }]),
    evidence: [],
  });
  assert.equal(missing.passed, false);
  assert.match(missing.summary, /\.diff \/ \.patch locator/);
});

test("createDefaultVerifier keeps the receipt gate in front of plugins", async () => {
  const verifier = createDefaultVerifier();
  const result = await verifier.verify({
    run: run(),
    plan: planFor([{
      id: "send",
      title: "Send",
      instructions: "Send it.",
      risk: "external_side_effect",
      acceptanceCriteria: ["receipt exists"],
    }]),
    evidence: [{
      id: "ev-1", runId: "run-1", stepId: "send", kind: "observation",
      summary: "done", createdAt: "2026-09-08T00:00:01.000Z",
    }],
  });
  assert.equal(result.passed, false);
  assert.match(result.summary, /receipt with a locator/);
  assert.ok(verifier instanceof CompositeVerifier);
});

class ArtifactOnlyExternalAdapter implements RuntimeAdapter {
  readonly id = "external-operator";
  readonly providerId = "demo";

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false,
      cancellation: false,
      approvalCallback: false,
      parallelAssignments: true,
      work: ["external_action"],
      evidenceKinds: ["artifact", "observation"],
    };
  }

  async *execute(): AsyncIterable<ExecutionEvent> {
    yield { type: "evidence", evidence: { kind: "artifact", summary: "Pretended to send.", locator: "demo://nope" } };
    yield { type: "completed", summary: "Done." };
  }
}

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
