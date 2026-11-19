/**
 * recent_file_changes answers "what changed today" deterministically.
 *
 * The tool must find files whose content changed without needing a model or a
 * worker Run, must refuse a protected location, and must report a repository's
 * uncommitted changes alongside the file list.
 *
 * recent_file_changes 确定性地回答"今天改了什么"。
 *
 * 工具必须无需模型或 Worker Run 就找到内容发生变化的文件，必须拒绝受保护位置，并且
 * 在文件清单旁报告仓库的未提交改动。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { collectFolderReport, parseSince, recentFileChangesTool } from "../src/main-agent/tools/recent-changes.ts";

const exec = promisify(execFile);

async function sandbox(t: TestContext): Promise<{ home: string; dataDirectory: string; work: string }> {
  const home = await mkdtemp(join(tmpdir(), "clone-changes-home-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-changes-data-"));
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { home, dataDirectory, work };
}

test("today means local midnight, and the other accepted cutoffs parse", () => {
  const now = new Date("2026-11-19T13:05:00.000+08:00");
  const today = parseSince("today", now);
  assert.equal(today.getFullYear(), 2026);
  assert.equal(today.getMonth(), 10);
  assert.equal(today.getDate(), 19);
  assert.equal(today.getHours(), 0);
  assert.equal(today.getMinutes(), 0);
  assert.equal(parseSince("24h", now).getTime(), now.getTime() - 24 * 3_600_000);
  assert.equal(parseSince(undefined, now).getTime(), today.getTime());
  assert.throws(() => parseSince("nonsense", now), /Unrecognized since value/);
});

test("a changed file reaches the report through the bounded walk", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const first = join(work, "auth.py");
  const second = join(work, "docs", "feishu.md");
  await mkdir(join(work, "docs"), { recursive: true });
  await writeFile(first, "print('a')", "utf8");
  await writeFile(second, "# 飞书", "utf8");
  const now = new Date();
  await utimes(first, now, now);
  await utimes(second, now, now);

  // "24h" is older than local midnight, so the Spotlight branch is skipped and
  // the test exercises the walk that runs when Spotlight is unavailable.
  // "24h" 早于本地午夜，因此跳过 Spotlight 分支，测试实际走 Spotlight 不可用时的遍历。
  const report = await collectFolderReport(work, {
    since: new Date(now.getTime() - 24 * 3_600_000),
    limit: 10,
    home,
    now,
  });
  assert.equal(report.error, undefined);
  assert.equal(report.totalFiles, 2);
  assert.deepEqual(new Set(report.files.map((file) => file.path)), new Set([await realpath(first), await realpath(second)]));

  const tool = recentFileChangesTool({ dataDirectory, workspacePath: work, home, now: () => now });
  const result = await tool.execute("call-1", { since: "24h" });
  const text = result.content.map((part) => part.text ?? "").join("\n");
  assert.match(text, /Files whose content changed: 2/);
  assert.match(text, /auth\.py/);
  assert.match(text, /docs\/feishu\.md/);
});

test("a protected location is refused before any read", async (t) => {
  const { home, dataDirectory } = await sandbox(t);
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "config"), "Host *", "utf8");
  const report = await collectFolderReport(join(home, ".ssh"), {
    since: new Date(Date.now() - 24 * 3_600_000),
    limit: 10,
    home,
  });
  assert.equal(report.error, "This is a protected location; no read is allowed.");
  assert.equal(report.totalFiles, 0);
  const tool = recentFileChangesTool({ dataDirectory, home });
  const result = await tool.execute("call-2", { path: join(home, ".ssh") });
  assert.match(result.content[0]?.text ?? "", /protected location/);
});

test("a repository reports uncommitted changes and commits since the cutoff", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const repo = join(work, "knowledge_base");
  await mkdir(repo, { recursive: true });
  try {
    await exec("git", ["init", "-q", repo]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", repo, "config", "user.name", "test"]);
  } catch {
    t.skip("git is not available");
    return;
  }
  await writeFile(join(repo, "README.md"), "# 知识库", "utf8");
  await exec("git", ["-C", repo, "add", "README.md"]);
  await exec("git", ["-C", repo, "commit", "-q", "-m", "first"]);
  await writeFile(join(repo, "README.md"), "# 知识库\n\n改动", "utf8");

  const report = await collectFolderReport(work, {
    since: new Date(Date.now() - 24 * 3_600_000),
    limit: 20,
    home,
  });
  assert.equal(report.repos.length, 1);
  const repository = report.repos[0];
  assert.ok(repository?.branch);
  assert.ok(repository?.status.some((line) => line.includes("README.md")));
  assert.ok(repository?.commits.some((commit) => commit.subject === "first"));
  const text = recentFileChangesTool({ dataDirectory, workspacePath: work, home })
    .execute("call-3", { since: "24h" });
  assert.match((await text).content[0]?.text ?? "", /uncommitted change/);
});
