/**
 * The two repair gates that are not the Kernel's job.
 *
 * A repair Run is ordinary Kernel work: plan, dispatch, evidence, verification,
 * journal. But two things a repair must prove cannot be a plan step, because
 * the step's worker is the very thing being checked:
 *
 *  - the regression test must fail *before* the fix exists. A worker reports
 *    what it wrote, not whether the test is red; the application runs the test
 *    and records the exit status as the fact.
 *  - the test files must not change between the red run and the fix. The
 *    application hashes them, and after the fix hashes them again.
 *
 * Both are here so the gates are testable without a worker, a model, or a real
 * test suite: the runner is injected.
 *
 * 修复中不属于 Kernel 职责的两道闸门。
 *
 * 修复 Run 是普通的 Kernel 工作：计划、派发、证据、验证、Journal。但修复必须证明的两件事
 * 不能做成计划步骤，因为步骤的 Worker 恰恰是被检查的对象：
 *
 *  - 回归测试必须在修复存在*之前*失败。Worker 报告自己写了什么，而不会报告测试是否红；
 *    由应用运行测试，并把退出码作为事实记录下来。
 *  - 测试文件在红色运行与修复之间不得改变。应用先哈希，修复后再哈希一次。
 *
 * 两者都放在这里，因此闸门无需 Worker、模型或真实测试套件即可测试：执行器是注入的。
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CommandRunner } from "./worktree.ts";

export interface RegressionTestRun {
  files: readonly string[];
  status: number;
  stdout: string;
  stderr: string;
}

export interface RedCheckResult {
  /** True only when tests exist and at least one of them failed. 仅当存在测试且至少一个失败时为真。 */
  red: boolean;
  tests: readonly string[];
  detail: string;
  run?: RegressionTestRun;
}

/** New regression test files under test/regression, as repository-relative paths. test/regression 下新的回归测试文件，仓库相对路径。 */
export async function listRegressionTests(workspace: string): Promise<string[]> {
  const directory = join(workspace, "test", "regression");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.mts") || name.endsWith(".test.js"))
    .sort()
    .map((name) => `test/regression/${name}`);
}

/**
 * Runs the new tests and decides whether they are red.
 *
 * A test runner that crashes, times out, or finds no test is *not* a
 * reproduction: treating a nonzero exit as "red" would let a broken import or a
 * missing file satisfy the gate while proving nothing about the bug. So the
 * output must also show a failing assertion (`# fail N`, N > 0, from node:test).
 * 运行新测试并判定是否为红。
 *
 * 运行器崩溃、超时或找不到测试都*不*算复现：把非零退出码当作"红"，会让一个坏掉的 import
 * 或缺失的文件通过闸门，却对 Bug 什么也没证明。因此输出还必须显示失败的断言
 * （node:test 的 `# fail N`，N > 0）。
 */
export async function verifyRegressionRed(input: {
  workspace: string;
  run?: CommandRunner;
  /** Command used to run the tests; defaults to node --test. 运行测试的命令；默认 node --test。 */
  command?: (files: readonly string[]) => readonly string[];
}): Promise<RedCheckResult> {
  const run = input.run;
  const tests = await listRegressionTests(input.workspace);
  if (tests.length === 0) {
    return { red: false, tests, detail: "phase 1 produced no files under test/regression/" };
  }
  if (run === undefined) {
    return { red: false, tests, detail: "no command runner was configured for the red check" };
  }
  const command = input.command?.(tests) ?? ["node", "--experimental-strip-types", "--test", ...tests];
  const [binary, ...args] = command;
  if (binary === undefined) return { red: false, tests, detail: "the configured red check command is empty" };
  const result = await run(binary, args, input.workspace);
  const failures = failingAssertions(result.stdout) + failingAssertions(result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  const testRun: RegressionTestRun = { files: tests, status: result.status, stdout: result.stdout, stderr: result.stderr };
  if (result.status === 0) {
    return { red: false, tests, detail: "the new regression cases pass without a fix; refusing to continue (not a reproduction)", run: testRun };
  }
  if (failures === 0) {
    return {
      red: false,
      tests,
      detail: `the case runner exited ${result.status} without reporting a failing case; a crash is not a reproduction`,
      run: testRun,
    };
  }
  // node:test also counts a file that throws at import time as one failed case,
  // so a syntax error or a missing module looks exactly like a real failure in
  // the counters. Requiring a node:assert assertion error separates the two.
  // node:test 也把一个在 import 时就抛出的文件算作一个失败用例，因此语法错误或缺失模块在计数上
  // 与真实失败一模一样。要求出现 node:assert 的断言错误，即可把两者分开。
  if (!/AssertionError/.test(output)) {
    return {
      red: false,
      tests,
      detail: "the new cases failed without an assertion error, which is a crash rather than a reproduction",
      run: testRun,
    };
  }
  return { red: true, tests, detail: `${failures} failing assertion(s) across ${tests.length} test file(s)`, run: testRun };
}

/** Sums `# fail N` counters reported by node:test. 汇总 node:test 报告的 `# fail N` 计数。 */
export function failingAssertions(output: string): number {
  let total = 0;
  for (const match of output.matchAll(/^\s*(?:ℹ|#)\s*fail\s+(\d+)\s*$/gm)) total += Number(match[1] ?? 0);
  return total;
}

/**
 * SHA-256 per file. Keys are repository-relative paths so a hash comparison
 * cannot pass merely because the files were reordered.
 * 每个文件的 SHA-256。键是仓库相对路径，因此哈希比较不会仅因为文件顺序变化而通过。
 */
export async function hashFiles(workspace: string, files: readonly string[]): Promise<Record<string, string>> {
  const sorted = [...files].sort();
  const hashes: Record<string, string> = {};
  for (const file of sorted) {
    hashes[file] = createHash("sha256").update(await readFile(join(workspace, file))).digest("hex");
  }
  return hashes;
}

export interface HashComparison {
  unchanged: boolean;
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Compares the hashes taken before and after the fix.
 *
 * Removal counts as a change: a fix that deletes the regression test is exactly
 * the failure the hash gate exists to catch, and a map-diff that only looked at
 * shared keys would miss it.
 * 比较修复前后的哈希。
 *
 * 删除也算变更：删除回归测试的"修复"正是哈希闸门要抓的失败，只看共同键的 map diff 会漏掉它。
 */
export function compareHashes(before: Record<string, string>, after: Record<string, string>): HashComparison {
  const added = Object.keys(after).filter((file) => before[file] === undefined);
  const removed = Object.keys(before).filter((file) => after[file] === undefined);
  const changed = Object.keys(before).filter((file) => after[file] !== undefined && after[file] !== before[file]);
  return { unchanged: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed };
}

export interface GreenCheckResult {
  /** True only when every regression file passed and the runner exited zero. 仅当所有回归文件通过且运行器退出码为零时为真。 */
  green: boolean;
  tests: readonly string[];
  detail: string;
  run?: RegressionTestRun;
}

/**
 * Runs the hashed regression cases again after the fix.
 *
 * The red check proves the case reproduces the bug *before* the fix. Without a
 * second run the lane only knows the top-level suite passed — and in this
 * repository `npm test` does not include `test/regression/`, so a run that
 * changed no production code at all was reported as fixed (observed in
 * `d8c54037`, 2026-11-06). A green run here is the fact that the recorded
 * failure is gone.
 * 修复后再次运行已哈希的回归用例。
 *
 * 红色检查只证明修复前用例复现了 Bug。没有第二次运行，通道只知道顶层套件通过——而在本仓库
 * `npm test` 不包含 `test/regression/`，于是一个完全没有改动生产代码的运行也会被报成 fixed
 * （2026-11-06 的 `d8c54037` 就是实例）。这里的绿色运行才是"记录的失败已消失"的事实。
 */
export async function verifyRegressionGreen(input: {
  workspace: string;
  run?: CommandRunner;
  /** Command used to run the tests; defaults to node --test. 运行测试的命令；默认 node --test。 */
  command?: (files: readonly string[]) => readonly string[];
}): Promise<GreenCheckResult> {
  const tests = await listRegressionTests(input.workspace);
  if (tests.length === 0) {
    return { green: false, tests, detail: "no regression files exist under test/regression/ to re-run" };
  }
  if (input.run === undefined) {
    return { green: false, tests, detail: "no command runner was configured for the post-fix check" };
  }
  const command = input.command?.(tests) ?? ["node", "--experimental-strip-types", "--test", ...tests];
  const [binary, ...args] = command;
  if (binary === undefined) return { green: false, tests, detail: "the configured post-fix command is empty" };
  const result = await input.run(binary, args, input.workspace);
  const output = `${result.stdout}\n${result.stderr}`;
  const testRun: RegressionTestRun = { files: tests, status: result.status, stdout: result.stdout, stderr: result.stderr };
  if (result.status !== 0) {
    const failures = failingAssertions(output);
    return {
      green: false,
      tests,
      detail: failures > 0
        ? `the regression cases still fail: ${failures} failing assertion(s)`
        : `the regression case runner exited ${result.status} after the fix`,
      run: testRun,
    };
  }
  return { green: true, tests, detail: `${tests.length} regression file(s) pass after the fix`, run: testRun };
}

/** `git` output as repository-relative paths, NUL-separated so spaces are safe. git 输出解析为仓库相对路径；NUL 分隔，路径含空格也安全。 */
export function stagedPathsFrom(output: string): string[] {
  return output
    .split("\0")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\.\//, ""));
}

/**
 * Stages everything and returns the staged paths plus the diff stat.
 *
 * The staged diff is what a commit would carry, which is the only meaningful
 * moment to check protected paths: `main...HEAD` before the commit compares
 * base with itself and is always empty.
 * 暂存全部内容，返回已暂存路径与差异统计。
 *
 * 已暂存差异才是提交会携带的内容，也是检查保护路径唯一有意义的时刻：提交前比较
 * `main...HEAD` 等于拿基线和自己比，永远为空。
 */
export async function stageAll(workspace: string, run: CommandRunner): Promise<{ paths: string[]; stat: string }> {
  const added = await run("git", ["add", "-A"], workspace);
  if (added.status !== 0) throw new Error(`git add failed: ${added.stderr.trim()}`);
  const staged = await run("git", ["diff", "--cached", "--name-only", "-z"], workspace);
  if (staged.status !== 0) throw new Error(`git diff --cached failed: ${staged.stderr.trim()}`);
  const stat = await run("git", ["diff", "--cached", "--stat"], workspace);
  return { paths: stagedPathsFrom(staged.stdout), stat: stat.stdout.trim() };
}

/**
 * Stages what a repair may carry, then removes the runtime scratch that is not
 * part of the fix.
 *
 * `git add -A` alone also picks up the `node_modules` symlink the lane links
 * for the test runner and any scratch files a worker wrote. In `.gitignore` the
 * entry is `node_modules/`, which does not match a symlink, and `.probe/` files
 * are not ignored at all; a real repair committed both (observed in `d8c54037`,
 * 2026-11-06). Dropping *all* untracked paths instead would silently omit a new
 * production file — including a new protected file, which the protected-path
 * gate must see and refuse. So everything is staged and only the known runtime
 * scratch is unstaged; a stray file with another name still reaches the diff,
 * where the report and the owner can see it.
 * 暂存修复可以携带的内容，然后移除不属于修复的运行期临时物。
 *
 * 只用 `git add -A` 还会带走通道为测试运行器链接的 `node_modules` 符号链接，以及 Worker 写下的
 * 临时文件。`.gitignore` 里写的是 `node_modules/`，匹配不到符号链接，而 `.probe/` 完全没有被忽略；
 * 一次真实修复把两者都提交了（2026-11-06 的 `d8c54037`）。反过来丢弃所有未跟踪路径也不行：它会
 * 悄悄漏掉新的生产文件——包括新的受保护文件，而保护路径闸门必须看到并拒绝它。因此这里暂存全部，
 * 只把已知的运行期临时物取消暂存；其他名字的杂散文件仍会进入差异，报告与所有者能看到。
 */
export async function stageRepair(workspace: string, run: CommandRunner): Promise<{ paths: string[]; stat: string }> {
  const added = await run("git", ["add", "-A"], workspace);
  if (added.status !== 0) throw new Error(`git add failed: ${added.stderr.trim()}`);
  const first = await run("git", ["diff", "--cached", "--name-only", "-z"], workspace);
  if (first.status !== 0) throw new Error(`git diff --cached failed: ${first.stderr.trim()}`);
  const scratch = stagedPathsFrom(first.stdout).filter(isRuntimeScratch);
  if (scratch.length > 0) {
    // Unstage the scratch; it stays on disk but cannot enter the commit.
    // 取消暂存临时物；它仍留在磁盘上，但无法进入提交。
    const reset = await run("git", ["reset", "-q", "HEAD", "--", ...scratch], workspace);
    if (reset.status !== 0) throw new Error(`git reset failed: ${reset.stderr.trim()}`);
  }
  const staged = await run("git", ["diff", "--cached", "--name-only", "-z"], workspace);
  if (staged.status !== 0) throw new Error(`git diff --cached failed: ${staged.stderr.trim()}`);
  const stat = await run("git", ["diff", "--cached", "--stat"], workspace);
  return { paths: stagedPathsFrom(staged.stdout), stat: stat.stdout.trim() };
}

/** Paths the repair itself creates or links; never part of a fix. 修复自身创建或链接的路径；绝不是修复的一部分。 */
export function isRuntimeScratch(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  return normalized === "node_modules"
    || normalized.startsWith("node_modules/")
    || normalized === ".probe"
    || normalized.startsWith(".probe/")
    || normalized === ".rsi"
    || normalized.startsWith(".rsi/")
    || normalized === ".clone"
    || normalized.startsWith(".clone/")
    || normalized === ".work-orders"
    || normalized.startsWith(".work-orders/")
    || normalized.startsWith(".verification-baseline")
    || /\.(?:log|tmp)$/.test(normalized);
}

/** Commit the staged fix with the trace ids in the body. 提交已暂存的修复，轨迹 id 写在正文里。 */
export async function commitRepair(workspace: string, run: CommandRunner, input: { traceIds: readonly string[]; tests: readonly string[] }): Promise<string> {
  const message = [
    `fix(rsi): resolve ${input.traceIds.length} failed trace(s)`,
    "",
    `Traces: ${input.traceIds.join(", ")}`,
    `Regression tests: ${input.tests.join(", ")}`,
    "",
    "Produced by `clone-ai repair` as a Kernel Run. The regression tests were verified",
    "red before the fix and hashed, and the hashes were verified unchanged after it.",
    "Merging is the owner's decision.",
  ].join("\n");
  const result = await run("git", ["commit", "-m", message], workspace);
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr.trim()}`);
  const head = await run("git", ["rev-parse", "HEAD"], workspace);
  return head.stdout.trim();
}
