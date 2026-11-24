/**
 * The daily digest answers a day from durable records: the ledger, the
 * journal, work updates, the turn ledger and Git. It must merge them, refuse
 * protected locations, and say when a day has no ledger coverage instead of
 * presenting mtimes as a complete record.
 *
 * 每日摘要用持久记录回答一天：台账、Journal、工作更新、回合台账与 Git。它必须合并
 * 这些来源、拒绝受保护位置，并在某天没有台账覆盖时如实说明，而不是把 mtime 当完整记录。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { appendWorkUpdate } from "../src/main-agent/work-updates.ts";
import { collectDailyDigest, dailyWorkspaceDigestTool } from "../src/main-agent/tools/daily-digest.ts";
import { captureWorkspaceFolder, recordWorkspaceEvent } from "../src/main-agent/workspace-ledger.ts";

async function sandbox(t: TestContext): Promise<{ home: string; dataDirectory: string; work: string }> {
  const home = await mkdtemp(join(tmpdir(), "clone-digest-home-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-digest-data-"));
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { home, dataDirectory, work };
}

test("a day digest merges ledger diffs, turns, runs, verification and memory writes", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  const started = new Date();
  await writeFile(join(canonical, "plan.md"), "第一行\n第二行\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, now: started, force: true });
  await writeFile(join(canonical, "plan.md"), "第一行\n改过的第二行\n第三行\n", "utf8");
  await captureWorkspaceFolder({
    dataDirectory,
    folder: canonical,
    home,
    now: new Date(started.getTime() + 60_000),
    force: true,
  });

  const journal = createJournalStore(dataDirectory);
  try {
    await journal.append({ type: "verification.completed", payload: { passed: true, summary: "验证通过" } });
    await journal.append({ type: "memory.authored", payload: { memoryId: "mem-1", summary: "所有者喜欢先写取舍" } });
  } finally {
    (journal as { close?: () => void }).close?.();
  }
  await appendWorkUpdate(dataDirectory, {
    id: "update-1",
    runId: "run-1",
    title: "整理工作信息",
    status: "completed",
    summary: "完成 2 个步骤",
    at: new Date().toISOString(),
    evidenceCount: 1,
  });
  await writeFile(join(dataDirectory, "main-agent-turns.jsonl"), `${JSON.stringify({
    id: "turn-1",
    text: "整理今天的工作信息",
    status: "completed",
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    reply: "已整理。",
  })}\n`, "utf8");

  const text = await collectDailyDigest({ dataDirectory, home }, { date: "today", path: canonical });
  assert.match(text, /## Workspace changes/);
  assert.match(text, /plan\.md/);
  assert.match(text, /^-第二行$/m, "the content diff is rendered, not only the file name");
  assert.match(text, /^\+改过的第二行$/m);
  assert.match(text, /^\+第三行$/m);
  assert.match(text, /## Twin activity/);
  assert.match(text, /Turns: 1 completed/);
  assert.match(text, /整理工作信息/);
  assert.match(text, /Runs: 1 completed/);
  assert.match(text, /完成 2 个步骤/);
  assert.match(text, /Verification: 1 passed/);
  assert.match(text, /验证通过/);
  assert.match(text, /Memory documents: 1 written or changed/);
  assert.match(text, /mem-1/);
  assert.match(text, /所有者喜欢先写取舍/);
  assert.match(text, /## Coverage/);
});

test("a day with no ledger coverage falls back to mtimes and says so", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "today.md"), "today\n", "utf8");
  const text = await collectDailyDigest({ dataDirectory, home }, { date: "today", path: canonical });
  assert.match(text, /no ledger capture covers/i);
  assert.match(text, /mtime only; no content baseline/);
  assert.match(text, /today\.md/);
});

test("the digest merges watcher operations and reports filtered noise", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "notes.md"), "notes\n", "utf8");
  await writeFile(join(canonical, ".DS_Store"), "junk", "utf8");
  await writeFile(join(canonical, "debug.log"), "junk\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  await recordWorkspaceEvent({
    dataDirectory,
    folder: canonical,
    event: { at: new Date().toISOString(), path: "scratch.md", kind: "created" },
  });

  const text = await collectDailyDigest({ dataDirectory, home }, { date: "today", path: canonical });
  assert.match(text, /Operations \(watcher\): 1 recorded/);
  assert.match(text, /scratch\.md/);
  assert.match(text, /generated or gitignored path\(s\) were skipped by the noise filter/);
  assert.doesNotMatch(text, /\.DS_Store/);
  assert.doesNotMatch(text, /debug\.log/);
});

test("a protected folder is refused before any read", async (t) => {
  const { home, dataDirectory } = await sandbox(t);
  const secret = join(home, ".ssh");
  await mkdir(secret, { recursive: true });
  await writeFile(join(secret, "config"), "Host *", "utf8");
  const text = await collectDailyDigest({ dataDirectory, home }, { path: secret });
  assert.match(text, /protected location/);
});

test("a day before the ledger baseline falls back instead of claiming no changes", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(10, 0, 0, 0);
  await writeFile(join(canonical, "before-ledger.md"), "old\n", "utf8");
  await utimes(join(canonical, "before-ledger.md"), yesterday, yesterday);
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });

  const text = await collectDailyDigest({ dataDirectory, home }, { date: "yesterday", path: canonical });
  assert.match(text, /no ledger capture covers/i);
  assert.match(text, /before-ledger\.md/);
  assert.doesNotMatch(text, /ledger covers this folder but recorded no changes/);
});

test("a past day excludes files whose mtime falls after its end", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  const now = new Date(2026, 10, 24, 12, 0, 0);
  const dayBefore = new Date(2026, 10, 23, 10, 0, 0);
  await writeFile(join(canonical, "yesterday.md"), "yesterday\n", "utf8");
  await utimes(join(canonical, "yesterday.md"), dayBefore, dayBefore);
  await writeFile(join(canonical, "today.md"), "today\n", "utf8");
  await utimes(join(canonical, "today.md"), now, now);

  const text = await collectDailyDigest({ dataDirectory, home, now: () => now }, { date: "2026-11-23", path: canonical });
  assert.match(text, /yesterday\.md/);
  assert.doesNotMatch(text, /today\.md/, "a file modified after the day's end is not part of that day");
});

test("a file path is refused as a folder", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const file = join(work, "readme.md");
  await writeFile(file, "readme\n", "utf8");
  const text = await collectDailyDigest({ dataDirectory, home }, { path: file });
  assert.match(text, /This path is a file, not a folder/);
});

test("the tool wrapper exposes the day and folder arguments", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "note.md"), "note\n", "utf8");
  const tool = dailyWorkspaceDigestTool({ dataDirectory, home });
  assert.equal(tool.name, "daily_workspace_digest");
  const result = await tool.execute("call-1", { date: "today", path: canonical, includeDiffs: false });
  assert.match(result.content[0]?.text ?? "", /note\.md/);
});
