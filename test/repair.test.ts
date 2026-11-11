import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { compareHashes, failingAssertions, hashFiles, listRegressionTests, stageAll, stageRepair, stagedDeletionCount, verifyRegressionGreen, verifyRegressionRed } from "../src/repair/gates.ts";
import { createRepairWorktree, removeRepairWorktree, runCommand, type CommandRunner } from "../src/repair/worktree.ts";
import { keepWorktree, repairPlan, runRepairLane, withCaseNames } from "../src/repair/repair-lane.ts";
import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";

const execFileAsync = promisify(execFile);

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * A runner for the nested test invocations. Node sets NODE_TEST_CONTEXT in a
 * test process; an inherited value changes how a child `node --test` reports
 * itself, so the same stripping the repository's other spawning tests do is
 * required here for the red check to see the real exit status.
 * 用于嵌套测试调用的执行器。Node 在测试进程中会设置 NODE_TEST_CONTEXT；被继承的值会改变子进程
 * `node --test` 的汇报方式，因此这里必须像仓库中其他 spawn 测试一样清除它，红色检查才能看到真实退出码。
 */
const nestedRun: CommandRunner = (command, args, cwd) => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_OPTIONS;
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolvePromise({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (status) => resolvePromise({ status: status ?? 1, stdout, stderr }));
  });
};

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout;
}

async function initRepo(t: TestContext): Promise<string> {
  const repo = await tempDir(t, "clone-repair-repo-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "test"), { recursive: true });
  await writeFile(join(repo, ".gitignore"), ".claude/worktrees/\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({
    name: "repair-lab",
    private: true,
    type: "module",
    scripts: { test: "node --experimental-strip-types --test test/*.test.ts test/regression/*.test.ts" },
  }));
  await writeFile(join(repo, "src", "bug.ts"), "export function answer(): number { return 1; }\n");
  await writeFile(join(repo, "src", "authority-placeholder.ts"), "export const boundary = 'original';\n");
  await writeFile(join(repo, "test", "base.test.ts"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('base', () => assert.equal(1, 1));\n");
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "lab@example.com"], repo);
  await git(["config", "user.name", "Lab"], repo);
  await git(["add", "."], repo);
  await git(["commit", "-qm", "initial"], repo);
  return repo;
}

test("the red check counts failing assertions rather than trusting an exit code", () => {
  assert.equal(failingAssertions("# tests 1\n# pass 0\n# fail 1\n"), 1);
  assert.equal(failingAssertions("ℹ fail 2\nℹ pass 0\n"), 2);
  assert.equal(failingAssertions("something broke before the runner started"), 0);
});

test("a crash before any assertion is not a reproduction, and a green suite is refused", async (t) => {
  const workspace = await tempDir(t, "clone-red-");
  await mkdir(join(workspace, "test", "regression"), { recursive: true });

  const missing = await verifyRegressionRed({ workspace });
  assert.equal(missing.red, false);
  assert.match(missing.detail, /no files under test\/regression/);

  await writeFile(join(workspace, "test", "regression", "crash.test.ts"), "throw new Error('import failed');\n");
  const crashed = await verifyRegressionRed({ workspace, run: nestedRun });
  assert.equal(crashed.red, false, "a nonzero exit without a failing assertion must not satisfy the gate");
  assert.match(crashed.detail, /without an assertion error/);

  await rm(join(workspace, "test", "regression", "crash.test.ts"));
  await writeFile(join(workspace, "test", "regression", "green.test.ts"), "import test from 'node:test';\ntest('green', () => {});\n");
  const green = await verifyRegressionRed({ workspace, run: nestedRun });
  assert.equal(green.red, false);
  assert.match(green.detail, /pass without a fix/);

  await rm(join(workspace, "test", "regression", "green.test.ts"));
  await writeFile(join(workspace, "test", "regression", "red.test.ts"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red', () => assert.equal(1, 2));\n");
  const red = await verifyRegressionRed({ workspace, run: nestedRun });
  assert.equal(red.red, true);
  assert.equal(red.run?.status, 1);
});

test("hashes are per path, and deleting or adding a test is a change", async (t) => {
  const workspace = await tempDir(t, "clone-hash-");
  await mkdir(join(workspace, "test", "regression"), { recursive: true });
  await writeFile(join(workspace, "test", "regression", "a.test.ts"), "a\n");
  await writeFile(join(workspace, "test", "regression", "b.test.ts"), "b\n");
  const before = await hashFiles(workspace, await listRegressionTests(workspace));
  assert.deepEqual(Object.keys(before), ["test/regression/a.test.ts", "test/regression/b.test.ts"]);

  await writeFile(join(workspace, "test", "regression", "b.test.ts"), "changed\n");
  const edited = compareHashes(before, await hashFiles(workspace, await listRegressionTests(workspace)));
  assert.equal(edited.unchanged, false);
  assert.deepEqual(edited.changed, ["test/regression/b.test.ts"]);

  await rm(join(workspace, "test", "regression", "a.test.ts"));
  const deleted = compareHashes(before, await hashFiles(workspace, await listRegressionTests(workspace)));
  assert.deepEqual(deleted.removed, ["test/regression/a.test.ts"], "a deleted test is a change, not an unchanged file");

  await writeFile(join(workspace, "test", "regression", "c.test.ts"), "c\n");
  const added = compareHashes(before, await hashFiles(workspace, await listRegressionTests(workspace)));
  assert.deepEqual(added.added, ["test/regression/c.test.ts"]);
});

test("the worktree is isolated: writes there never reach the served checkout", async (t) => {
  const repo = await initRepo(t);
  const before = await readFile(join(repo, "src", "bug.ts"), "utf8");
  const worktree = await createRepairWorktree({ repo, stamp: "20260101T0101", run: runCommand });
  t.after(() => removeRepairWorktree(worktree, runCommand));

  assert.notEqual(worktree.path, repo);
  assert.equal(worktree.branch, "rsi/auto-fix-20260101T0101");
  await writeFile(join(worktree.path, "src", "bug.ts"), "export function answer(): number { return 2; }\n");
  assert.equal(await readFile(join(repo, "src", "bug.ts"), "utf8"), before, "the serving checkout must be untouched");
  const status = await git(["status", "--porcelain"], repo);
  assert.equal(status.trim(), "", "no tracked or untracked change in the serving checkout");
});

test("a worktree path that already exists is refused before git runs", async (t) => {
  const repo = await initRepo(t);
  const calls: string[] = [];
  const spy: CommandRunner = async (command, args, cwd) => {
    calls.push(`${command} ${args.join(" ")}`);
    return runCommand(command, args, cwd);
  };
  await mkdir(join(repo, ".claude", "worktrees", "rsi-2026"), { recursive: true });
  await assert.rejects(
    createRepairWorktree({ repo, stamp: "2026", run: spy }),
    /already exists/,
  );
  assert.equal(calls.some((line) => line.startsWith("git worktree add")), false);
});

test("a directory that is not the git root cannot be the repair base", async (t) => {
  const repo = await initRepo(t);
  const nested = join(repo, "src");
  await assert.rejects(createRepairWorktree({ repo: nested, stamp: "nested", run: runCommand }), /not the git root/);
});

test("the staged protected-path gate sees the fix, not the base", async (t) => {
  const repo = await initRepo(t);
  const worktree = await createRepairWorktree({ repo, stamp: "20260101T0102", run: runCommand });
  t.after(() => removeRepairWorktree(worktree, runCommand));
  await mkdir(join(worktree.path, "src", "authority"), { recursive: true });
  await writeFile(join(worktree.path, "src", "authority", "policy.ts"), "export const boundary = 'mutated';\n");
  const staged = await stageAll(worktree.path, runCommand);
  assert.deepEqual(staged.paths, ["src/authority/policy.ts"], "staging must reveal what a commit would carry");
  const { protectedPathViolations } = await import("../scripts/nightly-rsi-policy.mjs") as { protectedPathViolations: (paths: readonly string[]) => string[] };
  assert.deepEqual(protectedPathViolations(staged.paths), ["src/authority/policy.ts"]);
});

test("the plan puts the red check between the test phase and the fix phase", () => {
  const steps = repairPlan({
    traces: [{ schemaVersion: 1, id: "r1", runId: "r1", capturedAt: "", kind: "explicit", signals: [], title: "bug", plan: [], executions: [], evidence: [], tail: [] }],
    agentId: "draft-maker",
    dependenciesLinked: true,
  });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((step) => step.id), ["write-regression-test", "fix-production-code"]);
  for (const step of steps) {
    assert.equal(step.risk, "reversible_write");
    assert.deepEqual(step.requiredCapabilities, ["filesystem_write"]);
    assert.equal(step.agentId, "draft-maker");
  }
  assert.match(steps[0]!.instructions, /test\/regression/);
  // The working agent writes the trade-off entry before the run; the fix worker
  // is told not to spend its budget on documentation. The test plugin note below
  // explains why the word "test" is avoided in acceptance text.
  // 取舍条目由工作的 Agent 在运行前写好；修复 Worker 被告知不要把预算花在文档上。下面的测试
  // 插件说明解释了验收文本为何避免 "test" 一词。
  assert.match(steps[1]!.instructions, /trade-off entry was written by the working agent/);
  assert.match(steps[1]!.instructions, /no shell tool/);
  // The phase-1 wording must steer a model with a small round budget: write the
  // reproduction first, and never leave a probe that passes as the only file.
  // 第一阶段的措辞必须能引导轮次预算有限的模型：先写复现，且绝不能只留下一个会通过的探针。
  assert.match(steps[0]!.instructions, /before doing broad exploration/);
  assert.match(steps[0]!.instructions, /do not leave diagnostic, probe or scratch files/);
  // The test plugin treats the words "test"/"npm test" as a contract; a black
  // box worker cannot report test evidence, so the acceptance text must not
  // claim that contract. The lane enforces it instead.
  // 测试插件把 "test"/"npm test" 当作契约；黑盒 Worker 无法报告测试证据，因此验收文本不能声称该契约，
  // 由通道自己执行它。
  for (const step of steps) {
    for (const criterion of step.acceptanceCriteria) {
      assert.doesNotMatch(criterion, /\btests?\b|npm test/i, `acceptance criterion must not demand test evidence: ${criterion}`);
    }
  }
});

test("the lane reports no work when no trace is pending, and a dry run creates nothing", async (t) => {
  const repo = await initRepo(t);
  const data = await tempDir(t, "clone-repair-data-");
  const idle = await runRepairLane({ dataDirectory: data, repo, run: runCommand, log: () => undefined });
  assert.equal(idle.status, "no-traces");

  await mkdir(join(data, "failed-traces"), { recursive: true });
  await writeFile(join(data, "failed-traces", "r1.json"), JSON.stringify({ runId: "r1", title: "bug" }));
  const dry = await runRepairLane({ dataDirectory: data, repo, dryRun: true, run: runCommand, log: () => undefined });
  assert.equal(dry.status, "dry-run");
  assert.deepEqual(dry.traces, ["r1"]);
  const trees = await git(["worktree", "list", "--porcelain"], repo);
  assert.equal(trees.includes("rsi-"), false, "a dry run must not create a worktree");
});


/**
 * A fake repair worker. It receives the same ExecutionAssignment a real one
 * would, writes through its own workspace (the isolated worktree), and yields
 * the artifact evidence the Kernel needs to accept the step. Its script decides
 * what "phase 1" and "phase 2" produce, so every gate below is exercised by the
 * lane's own checks rather than by a model.
 * 假修复 Worker。它收到真实 Worker 同样的 ExecutionAssignment，经自己的工作区（隔离 worktree）写入，
 * 并交出 Kernel 接受该步骤所需的 artifact 证据。脚本决定"第一阶段""第二阶段"产出什么，因此下面每道
 * 闸门都由通道自身的检查来验证，而不是由模型验证。
 */
class FakeRepairWorker implements RuntimeAdapter {
  readonly id = "fake-repairer";
  readonly providerId = "fake";
  readonly #script: Array<(workspace: string, stepId: string) => Promise<Array<{ path: string; content: string }>>>;
  readonly #events: string[] = [];

  constructor(script: Array<(workspace: string, stepId: string) => Promise<Array<{ path: string; content: string }>>>) {
    this.#script = script;
  }

  get phases(): string[] {
    return [...this.#events];
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false,
      cancellation: false,
      approvalCallback: false,
      parallelAssignments: false,
      work: ["filesystem_read", "filesystem_write", "drafting"],
      evidenceKinds: ["artifact", "observation"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    const workspace = input.workspacePath ?? process.cwd();
    const phase = this.#script.shift();
    if (phase === undefined) throw new Error("the fake worker was dispatched more times than it has phases");
    this.#events.push(input.step.id);
    const files = await phase(workspace, input.step.id);
    for (const file of files) {
      await mkdir(join(workspace, file.path, ".."), { recursive: true });
      await writeFile(join(workspace, file.path), file.content, "utf8");
      yield { type: "evidence", evidence: { kind: "artifact", summary: `wrote ${file.path}`, locator: file.path } };
    }
    yield { type: "completed", summary: `phase ${input.step.id} done` };
  }
}

const RED_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../../src/bug.ts';\ntest('reproduces the bug', () => assert.equal(answer(), 2));\n";
const FIXED_SOURCE = "export function answer(): number { return 2; }\n";

async function seedLane(t: TestContext): Promise<string> {
  const data = await tempDir(t, "clone-repair-home-");
  await mkdir(join(data, "failed-traces"), { recursive: true });
  await writeFile(join(data, "failed-traces", "trace-1.json"), JSON.stringify({
    schemaVersion: 1, id: "trace-1", runId: "trace-1", capturedAt: "2026-01-01T00:00:00.000Z",
    kind: "explicit", signals: [], title: "answer() returns the wrong number", plan: [], executions: [], evidence: [], tail: [],
  }));
  return data;
}

function laneOptions(data: string, repo: string, worker: RuntimeAdapter) {
  return {
    dataDirectory: data,
    repo,
    registry: new StaticAgentRegistry([worker]),
    run: nestedRun,
    keep: true,
    log: () => {},
  };
}

test("the post-fix check requires the hashed cases to pass, not just the suite", async (t) => {
  const workspace = await tempDir(t, "clone-green-");
  await mkdir(join(workspace, "test", "regression"), { recursive: true });
  const missing = await verifyRegressionGreen({ workspace, run: nestedRun });
  assert.equal(missing.green, false);
  assert.match(missing.detail, /no regression files/);

  await writeFile(join(workspace, "test", "regression", "red.test.ts"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red', () => assert.equal(1, 2));\n");
  const stillRed = await verifyRegressionGreen({ workspace, run: nestedRun });
  assert.equal(stillRed.green, false);
  assert.match(stillRed.detail, /still fail/);
  assert.equal(stillRed.run?.status, 1);

  await writeFile(join(workspace, "test", "regression", "red.test.ts"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('green', () => assert.equal(1, 1));\n");
  const green = await verifyRegressionGreen({ workspace, run: nestedRun });
  assert.equal(green.green, true);
  assert.equal(green.run?.status, 0);
});

test("staging a repair keeps tracked changes and regression cases, and drops scratch files", async (t) => {
  const repo = await initRepo(t);
  const worktree = await createRepairWorktree({ repo, stamp: "20260101T0103", run: runCommand });
  t.after(() => removeRepairWorktree(worktree, runCommand));
  await writeFile(join(worktree.path, "src", "bug.ts"), "export function answer(): number { return 2; }\n");
  await mkdir(join(worktree.path, "test", "regression"), { recursive: true });
  await writeFile(join(worktree.path, "test", "regression", "bug.test.ts"), "// regression\n");
  await mkdir(join(worktree.path, ".probe"), { recursive: true });
  await writeFile(join(worktree.path, ".probe", "junk.txt"), "scratch\n");
  await writeFile(join(worktree.path, "node_modules"), "a symlink or file must not be committed\n");

  const staged = await stageRepair(worktree.path, runCommand);
  assert.deepEqual(staged.paths.sort(), ["src/bug.ts", "test/regression/bug.test.ts"]);
  const cached = await git(["diff", "--cached", "--name-only"], worktree.path);
  assert.doesNotMatch(cached, /node_modules|\.probe/);
});

test("a fix phase that changes nothing is refused because the case stays red", async (t) => {
  const repo = await initRepo(t);
  const data = await seedLane(t);
  const worker = new FakeRepairWorker([
    async () => [{ path: "test/regression/bug.test.ts", content: RED_TEST }],
    // A "fix" that touches an unrelated file but leaves the bug: the case still
    // fails, so the lane must not call it fixed. The extra file keeps the Run
    // from ending for lack of evidence.
    // “修复”改了一个无关文件但没修 Bug：用例仍然失败，通道不得称其为 fixed。额外文件让 Run
    // 不因缺少证据而结束。
    async () => [{ path: "src/notes.ts", content: "// no fix applied\n" }],
  ]);
  const report = await runRepairLane(laneOptions(data, repo, worker));
  if (report.worktree !== undefined) t.after(() => removeRepairWorktree({ path: report.worktree!, branch: report.branch ?? "", repo, base: "main" }, runCommand));

  assert.equal(report.status, "failed");
  assert.equal(report.failedGate, "regression-still-red");
  assert.equal(report.regressionAfter?.green, false);
  assert.equal(Number((await git(["rev-list", "--count", "main.." + (report.branch ?? "main")], repo)).trim()), 0, "no commit on a no-op fix");
});

test("staged deletions are counted per path, and test cases do not hide a rewrite", async (t) => {
  const repo = await initRepo(t);
  const worktree = await createRepairWorktree({ repo, stamp: "20260101T0104", run: runCommand });
  t.after(() => removeRepairWorktree(worktree, runCommand));
  const lines = Array.from({ length: 100 }, (_, index) => `// filler ${index + 1}`).join("\n");
  await writeFile(join(worktree.path, "src", "filler.ts"), lines);
  await git(["add", "src/filler.ts"], worktree.path);
  await git(["commit", "-qm", "filler"], worktree.path);

  // A whole-file rewrite that keeps the case green still deletes production lines.
  // 让用例保持绿色的整文件重写仍然会删除生产行。
  await writeFile(join(worktree.path, "src", "filler.ts"), "// one line remains\n");
  await mkdir(join(worktree.path, "test", "regression"), { recursive: true });
  await writeFile(join(worktree.path, "test", "regression", "case.test.ts"), "// case\n");
  await stageRepair(worktree.path, runCommand);
  const after = await stagedDeletionCount(worktree.path, runCommand);
  assert.equal(after.production, 100);
  assert.deepEqual(after.paths.filter((entry) => entry.deleted > 0), [{ path: "src/filler.ts", deleted: 100 }], "test cases must not be counted as production deletions");
});

test("a fix that deletes most of a production file is refused as a rewrite", async (t) => {
  const repo = await initRepo(t);
  const data = await seedLane(t);
  const filler = Array.from({ length: 100 }, (_, index) => `// filler ${index + 1}`).join("\n");
  await writeFile(join(repo, "src", "filler.ts"), `${filler}\n`);
  await git(["add", "src/filler.ts"], repo);
  await git(["commit", "-qm", "add filler"], repo);
  const worker = new FakeRepairWorker([
    async () => [{ path: "test/regression/bug.test.ts", content: RED_TEST }],
    async () => [
      { path: "src/bug.ts", content: FIXED_SOURCE },
      { path: "src/filler.ts", content: "// one line remains\n" },
    ],
  ]);
  const report = await runRepairLane(laneOptions(data, repo, worker));
  if (report.worktree !== undefined) t.after(() => removeRepairWorktree({ path: report.worktree!, branch: report.branch ?? "", repo, base: "main" }, runCommand));

  assert.equal(report.status, "failed");
  assert.equal(report.failedGate, "fix-too-large");
  assert.match(report.error ?? "", /src\/filler\.ts \(-100\)/);
  assert.equal(Number((await git(["rev-list", "--count", "main.." + (report.branch ?? "main")], repo)).trim()), 0, "no commit on a rewrite");
});

test("a full repair: phase 1 red is verified by the lane, the fix is committed, and the checkout is untouched", async (t) => {
  const repo = await initRepo(t);
  const data = await seedLane(t);
  const before = await readFile(join(repo, "src", "bug.ts"), "utf8");
  const worker = new FakeRepairWorker([
    async () => [{ path: "test/regression/bug.test.ts", content: RED_TEST }],
    async () => [{ path: "src/bug.ts", content: FIXED_SOURCE }],
  ]);
  const report = await runRepairLane(laneOptions(data, repo, worker));
  if (report.worktree !== undefined) t.after(() => removeRepairWorktree({ path: report.worktree!, branch: report.branch ?? "", repo, base: "main" }, runCommand));

  assert.equal(report.status, "fixed", report.error);
  assert.deepEqual(worker.phases, ["write-regression-test", "fix-production-code"], "the test phase must run before the fix phase");
  assert.equal(report.evalBefore?.red, true);
  assert.equal(report.evalBefore?.exitStatus, 1);
  assert.equal(report.regressionAfter?.green, true, report.regressionAfter?.detail);
  assert.equal(report.evalAfter?.tests.status, 0, report.evalAfter?.tests.tail);
  assert.equal(report.evalAfter?.typecheck.status, 0, report.evalAfter?.typecheck.tail);
  assert.deepEqual(report.changed, ["src/bug.ts", "test/regression/bug.test.ts"]);
  assert.equal(await readFile(join(repo, "src", "bug.ts"), "utf8"), before, "the served checkout keeps its old source");
  const branchFiles = await git(["show", "--name-only", "--format=", report.branch ?? "HEAD"], repo);
  assert.match(branchFiles, /^src\/bug\.ts$/m);
  assert.match(branchFiles, /^test\/regression\/bug\.test\.ts$/m);
  assert.doesNotMatch(branchFiles, /\.rsi\//, "trace files must never be committed");
  // The trace is consumed only because the repair finished.
  // 只有修复成功完成，轨迹才会被消费。
  const state = JSON.parse(await readFile(join(data, "rsi", "consumed-traces.json"), "utf8")) as { traces: Record<string, { branch: string }> };
  assert.equal(state.traces["trace-1"]?.branch, report.branch);
});

test("a regression case that already passes stops the lane before the fix phase", async (t) => {
  const repo = await initRepo(t);
  const data = await seedLane(t);
  const worker = new FakeRepairWorker([
    async () => [{ path: "test/regression/passes.test.ts", content: "import test from 'node:test';\ntest('passes', () => {});\n" }],
    async () => [{ path: "src/bug.ts", content: FIXED_SOURCE }],
  ]);
  const report = await runRepairLane(laneOptions(data, repo, worker));
  if (report.worktree !== undefined) t.after(() => removeRepairWorktree({ path: report.worktree!, branch: report.branch ?? "", repo, base: "main" }, runCommand));

  assert.equal(report.status, "failed");
  assert.equal(report.failedGate, "not-red");
  assert.equal(report.evalBefore?.red, false);
  assert.deepEqual(worker.phases, ["write-regression-test"], "the fix phase must never start when the case is not red");
  assert.equal(Number((await git(["rev-list", "--count", "main.." + (report.branch ?? "main")], repo)).trim()), 0, "no commit on a rejected repair");
});

test("a fix that rewrites the regression case is rejected by the hash gate", async (t) => {
  const repo = await initRepo(t);
  const data = await seedLane(t);
  const worker = new FakeRepairWorker([
    async () => [{ path: "test/regression/bug.test.ts", content: RED_TEST }],
    async () => [
      { path: "src/bug.ts", content: FIXED_SOURCE },
      // A repair that edits its own reproduction would turn a bug into a green lie.
      // 修改自己复现用例的"修复"会把 Bug 变成一句绿色的谎言。
      { path: "test/regression/bug.test.ts", content: RED_TEST.replace("2));", "1));") },
    ],
  ]);
  const report = await runRepairLane(laneOptions(data, repo, worker));
  if (report.worktree !== undefined) t.after(() => removeRepairWorktree({ path: report.worktree!, branch: report.branch ?? "", repo, base: "main" }, runCommand));

  assert.equal(report.status, "failed");
  assert.equal(report.failedGate, "tests-modified");
  assert.match(report.error ?? "", /test\/regression\/bug\.test\.ts/);
  assert.equal(Number((await git(["rev-list", "--count", "main.." + (report.branch ?? "main")], repo)).trim()), 0);
});

test("a fix that touches a protected path is refused before the commit", async (t) => {
  const repo = await initRepo(t);
  const data = await seedLane(t);
  const worker = new FakeRepairWorker([
    async () => [{ path: "test/regression/bug.test.ts", content: RED_TEST }],
    async () => [
      { path: "src/bug.ts", content: FIXED_SOURCE },
      { path: "src/authority/policy.ts", content: "export const boundary = 'mutated by the repair';\n" },
    ],
  ]);
  const report = await runRepairLane(laneOptions(data, repo, worker));
  if (report.worktree !== undefined) t.after(() => removeRepairWorktree({ path: report.worktree!, branch: report.branch ?? "", repo, base: "main" }, runCommand));

  assert.equal(report.status, "failed");
  assert.equal(report.failedGate, "protected-path");
  assert.match(report.error ?? "", /src\/authority\/policy\.ts/);
  assert.equal(Number((await git(["rev-list", "--count", "main.." + (report.branch ?? "main")], repo)).trim()), 0, "the reject branch must carry no repair commit");
});

test("a worker that fails its step ends the lane without a commit", async (t) => {
  const repo = await initRepo(t);
  const data = await seedLane(t);
  const failing: RuntimeAdapter = {
    id: "broken",
    providerId: "fake",
    async capabilities() {
      return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: false, work: ["filesystem_write"], evidenceKinds: ["artifact"] };
    },
    async *execute() {
      yield { type: "failed" as const, message: "the model gave up" };
    },
  };
  const report = await runRepairLane(laneOptions(data, repo, failing));
  if (report.worktree !== undefined) t.after(() => removeRepairWorktree({ path: report.worktree!, branch: report.branch ?? "", repo, base: "main" }, runCommand));

  assert.equal(report.status, "failed");
  assert.equal(report.failedGate, "kernel");
  assert.equal(Number((await git(["rev-list", "--count", "main.." + (report.branch ?? "main")], repo)).trim()), 0);
  const state = await readFile(join(data, "rsi", "consumed-traces.json"), "utf8").catch(() => "");
  assert.equal(state, "", "a failed repair must leave the trace eligible");
});


test("only a run that stopped at a gate keeps its worktree for inspection", () => {
  assert.equal(keepWorktree(false), true, "a failed repair must survive so the owner can read it");
  assert.equal(keepWorktree(true), false, "a fixed repair's worktree is disposable");
  assert.equal(keepWorktree(true, true), true, "--keep overrides both");
  assert.equal(keepWorktree(false, true), true);
});

test("a repair that cannot find a configured worker fails before any plan is accepted", async (t) => {
  const repo = await initRepo(t);
  const data = await tempDir(t, "clone-repair-nodeps-");
  await mkdir(join(data, "failed-traces"), { recursive: true });
  await writeFile(join(data, "failed-traces", "r1.json"), JSON.stringify({ runId: "r1", title: "bug" }));
  // No settings.json and no worker CLIs installed in the sandbox: the lane must
  // stop with a report, not claim a fix.
  // 沙箱里没有 settings.json、也没有 Worker CLI：通道必须带着报告停下，而不是声称修复了。
  const report = await runRepairLane({
    dataDirectory: data,
    repo,
    run: runCommand,
    keep: true,
    agentId: "does-not-exist",
    log: () => {},
  });
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /No enabled worker "does-not-exist"/);
  assert.equal(report.runId, void 0, "no Run is accepted when the executor is missing");
  const written = JSON.parse(await readFile(report.reportPath, "utf8")) as { status: string };
  assert.equal(written.status, "failed");
  if (report.worktree !== undefined) await removeRepairWorktree({ path: report.worktree, branch: report.branch ?? "", repo, base: "main" }, runCommand);
});

test("the repair prompts name the files in the trace and tell the model to stop", () => {
  // A run on 2026-11-11 spent 24 and 32 rounds re-discovering the file the trace
  // already named, and never reached the fix. Both halves are contract now.
  // 2026-11-11 的运行花了 24 与 32 轮重复发现轨迹已经点名的文件，始终没到修复阶段。
  // 这两半现在都是契约。
  const traces = [{
    schemaVersion: 1 as const,
    id: "t1",
    runId: "t1",
    capturedAt: new Date().toISOString(),
    kind: "explicit" as const,
    signals: ["audit"],
    title: "token compaction unreachable",
    request: "contextWindow is never passed",
    failure: { stage: "audit", reason: "runNativeMainAgentTurn is called from src/application/run-main-query.ts without contextWindow" },
    plan: [],
    executions: [],
    evidence: [{ kind: "observation", summary: "src/main-agent/native-runtime.ts spreads contextWindow only when present" }],
    tail: [],
  }];
  const steps = repairPlan({ traces, agentId: "worker", dependenciesLinked: true });
  const testText = steps[0]!.instructions;
  const fixText = steps[1]!.instructions;
  assert.match(testText, /src\/application\/run-main-query\.ts/, "the test phase names the file from the trace");
  assert.match(testText, /then STOP/, "the test phase tells the model to stop after one write");
  assert.match(testText, /Do not read the docs\/ tree/, "docs are excluded explicitly");
  assert.match(fixText, /src\/main-agent\/native-runtime\.ts/, "the fix phase names the file from the evidence");
  assert.match(fixText, /do not explore the docs\/ tree/);
});

test("the fix phase is told only about the case this repair created", () => {
  // test/regression also holds earlier repairs' cases. Handing all of them to
  // the model aimed a context-window fix at apps/desktop/ui/app.js.
  // test/regression 里还有更早修复的用例。把它们全部交给模型，曾让一次上下文修复去改 app.js。
  const step = repairPlan({ traces: [traceFixture()], agentId: "w", dependenciesLinked: true })[1]!;
  const scoped = withCaseNames(step, ["test/regression/this-repair.test.ts"]);
  assert.match(scoped.instructions, /^This repair's regression case: test\/regression\/this-repair\.test\.ts\./);
  assert.match(scoped.instructions, /do not read them and do not fix them/);
  assert.equal(scoped.id, step.id);
});

function traceFixture() {
  return {
    schemaVersion: 1 as const, id: "t", runId: "t", capturedAt: new Date().toISOString(),
    kind: "explicit" as const, signals: ["audit"], title: "x", plan: [], executions: [], evidence: [], tail: [],
  };
}
