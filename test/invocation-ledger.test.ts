import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  beginInvocation,
  detectInvocationCaller,
  invocationLedgerPath,
  markInvocations,
  readInvocation,
  readInvocations,
  resolveInvocationAuditDirectory,
  searchInvocations,
} from "../src/audit/invocation-ledger.ts";

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-invocation-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the shared ledger survives an isolated CLONE_HOME", () => {
  const directory = resolveInvocationAuditDirectory({
    dataDirectory: "/private/tmp/isolated-clone-home",
    environment: { HOME: "/Users/owner", CLONE_HOME: "/private/tmp/isolated-clone-home" },
  });
  assert.equal(directory, "/Users/owner/.clone/audit");
  assert.equal(invocationLedgerPath({
    dataDirectory: "/private/tmp/isolated-clone-home",
    environment: { HOME: "/Users/owner", CLONE_HOME: "/private/tmp/isolated-clone-home" },
  }), "/Users/owner/.clone/audit/invocations.jsonl");
});

test("explicit audit home wins and tests stay isolated", () => {
  assert.equal(resolveInvocationAuditDirectory({
    dataDirectory: "/tmp/data",
    auditHome: "/tmp/shared",
    environment: { HOME: "/Users/owner" },
  }), "/tmp/shared/audit");
  assert.equal(resolveInvocationAuditDirectory({
    dataDirectory: "/tmp/data",
    environment: { HOME: "/Users/owner", NODE_TEST_CONTEXT: "child" },
  }), "/tmp/data/audit");
});

test("caller detection names codex and keeps its thread id", () => {
  assert.deepEqual(detectInvocationCaller({ CODEX_THREAD_ID: "thread-123" }), {
    kind: "codex",
    pid: process.pid,
    ppid: process.ppid,
    sessionId: "thread-123",
  });
  assert.equal(detectInvocationCaller({ CLONE_AI_CALLER: "claude-code", CLONE_AI_CALLER_SESSION: "s-1" }).kind, "claude-code");
});

test("a call writes its prompt, reply, model and Run ids to the shared ledger", async (t) => {
  const directory = await tempDir(t);
  const auditHome = join(directory, "shared");
  const handle = await beginInvocation({
    prompt: "请整理今天的任务，联系 owner@example.com",
    surface: "cli",
    workspacePath: "/tmp/workspace",
    dataDirectory: "/tmp/isolated-home",
    caller: { kind: "codex", sessionId: "thread-1" },
    auditHome,
    environment: { HOME: directory },
  });
  handle.note({ modelId: "magpie/deepseek", provider: "magpie", effort: "high", sessionFile: "/tmp/session.jsonl" });
  await handle.complete({
    reply: "已完成。",
    newRuns: [{ id: "run-1", status: "completed" }],
  });

  const records = await readInvocations({ dataDirectory: "/tmp/isolated-home", auditHome, limit: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "completed");
  assert.equal(records[0]?.caller.kind, "codex");
  assert.equal(records[0]?.surface, "cli");
  assert.equal(records[0]?.modelId, "magpie/deepseek");
  assert.equal(records[0]?.effort, "high");
  assert.equal(records[0]?.reply, "已完成。");
  assert.deepEqual(records[0]?.newRuns, [{ id: "run-1", status: "completed" }]);
  assert.doesNotMatch(records[0]?.prompt ?? "", /owner@example\.com/);
  assert.deepEqual(await readInvocation(handle.id, { dataDirectory: "/tmp/isolated-home", auditHome }), records[0]);
});

test("a failed invocation is recorded without inventing a reply", async (t) => {
  const directory = await tempDir(t);
  const auditHome = join(directory, "shared");
  const handle = await beginInvocation({
    prompt: "do the work",
    surface: "desktop",
    workspacePath: "/tmp/workspace",
    dataDirectory: "/tmp/isolated-home",
    auditHome,
    environment: { HOME: directory },
  });
  await handle.fail(new Error("model unavailable"));
  const [record] = await readInvocations({ dataDirectory: "/tmp/isolated-home", auditHome });
  assert.equal(record?.status, "failed");
  assert.equal(record?.reply, undefined);
  assert.match(record?.error ?? "", /model unavailable/);
});

test("a start without an end remains visible as running", async (t) => {
  const directory = await tempDir(t);
  const auditHome = join(directory, "shared");
  await beginInvocation({
    prompt: "interrupted turn",
    surface: "main",
    workspacePath: "/tmp/workspace",
    dataDirectory: "/tmp/isolated-home",
    auditHome,
    environment: { HOME: directory },
  });
  const [record] = await readInvocations({ dataDirectory: "/tmp/isolated-home", auditHome });
  assert.equal(record?.status, "running");
  assert.equal(record?.endedAt, undefined);
});

test("deleting an invocation hides it, keeps the ledger append-only, and can be restored", async (t) => {
  const directory = await tempDir(t);
  const auditHome = join(directory, "shared");
  const location = { dataDirectory: "/tmp/isolated-home", auditHome };

  const kept = await beginInvocation({
    prompt: "保留这次调用",
    surface: "cli",
    workspacePath: "/tmp/workspace",
    dataDirectory: "/tmp/isolated-home",
    auditHome,
    environment: { HOME: directory },
  });
  await kept.complete({ reply: "保留的回复" });
  const hidden = await beginInvocation({
    prompt: "删掉这次调用",
    surface: "desktop",
    workspacePath: "/tmp/workspace",
    dataDirectory: "/tmp/isolated-home",
    auditHome,
    environment: { HOME: directory },
  });
  await hidden.complete({ reply: "将被隐藏的回复" });

  assert.equal(await markInvocations(location, [hidden.id], true), 1);
  const visible = await readInvocations(location);
  assert.deepEqual(visible.map((record) => record.id), [kept.id]);
  assert.equal(visible[0]?.deleted, undefined);

  const withDeleted = await searchInvocations({ ...location, includeDeleted: true });
  assert.equal(withDeleted.total, 2);
  assert.equal(withDeleted.records.find((record) => record.id === hidden.id)?.deleted, true);
  assert.equal((await readInvocation(hidden.id, location))?.deleted, true);

  // The original lines stay: a deletion is one more append, not a rewrite.
  // 原始行仍在：删除只是多追加一行，而不是重写文件。
  const raw = await readFile(invocationLedgerPath(location), "utf8");
  assert.match(raw, /删掉这次调用/);
  assert.equal(raw.trim().split("\n").length, 5, "two starts + two completions + one tombstone");

  assert.equal(await markInvocations(location, [hidden.id], false), 1);
  const restored = await readInvocations(location);
  assert.equal(restored.length, 2);
  assert.equal(restored.find((record) => record.id === hidden.id)?.deleted, undefined);

  // Bulk delete deduplicates ids, ignores blanks, and a bulk restore brings all of them back.
  // 批量删除会去重、忽略空值，批量恢复能把它们全部找回。
  assert.equal(await markInvocations(location, [kept.id, hidden.id, hidden.id, "  "], true), 2);
  assert.equal((await readInvocations(location)).length, 0);
  assert.equal((await searchInvocations({ ...location, includeDeleted: true })).total, 2);
  assert.equal(await markInvocations(location, [kept.id, hidden.id], false), 2);
  assert.equal((await readInvocations(location)).length, 2);
});

test("the ledger search matches prompts, replies, callers, models and Run ids", async (t) => {
  const directory = await tempDir(t);
  const auditHome = join(directory, "shared");
  const location = { dataDirectory: "/tmp/isolated-home", auditHome };

  const meeting = await beginInvocation({
    prompt: "整理今天的会议记录",
    surface: "cli",
    workspacePath: "/Users/owner/notes",
    dataDirectory: "/tmp/isolated-home",
    caller: { kind: "claude-code", sessionId: "claude-session-1" },
    auditHome,
    environment: { HOME: directory },
  });
  meeting.note({ modelId: "deepseek-v4.1", provider: "magpie" });
  await meeting.complete({ reply: "会议记录已整理。", newRuns: [{ id: "run-meeting-42", status: "completed" }] });

  const palace = await beginInvocation({
    prompt: "重建故宫 3D 模型",
    surface: "desktop",
    workspacePath: "/Users/owner/work",
    dataDirectory: "/tmp/isolated-home",
    caller: { kind: "codex", sessionId: "codex-thread-9" },
    auditHome,
    environment: { HOME: directory },
  });
  palace.note({ modelId: "gpt-6.1-terra", provider: "openai" });
  await palace.complete({ reply: "模型已完成。", newRuns: [{ id: "run-palace-7", status: "completed" }] });

  const ids = async (query: string): Promise<string[]> =>
    (await searchInvocations({ ...location, query })).records.map((record) => record.id);

  assert.deepEqual(await ids("会议"), [meeting.id]);
  assert.deepEqual(await ids("已整理"), [meeting.id]);
  assert.deepEqual(await ids("run-meeting-42"), [meeting.id]);
  assert.deepEqual(await ids("claude-code"), [meeting.id]);
  assert.deepEqual(await ids("deepseek-v4.1"), [meeting.id]);
  assert.deepEqual(await ids("codex"), [palace.id]);
  assert.deepEqual(await ids("gpt-6.1-terra"), [palace.id]);
  assert.deepEqual(await ids("run-palace-7"), [palace.id]);
  assert.deepEqual(await ids("nothing-matches-this"), []);

  const limited = await searchInvocations({ ...location, limit: 1 });
  assert.equal(limited.records.length, 1);
  assert.equal(limited.total, 2, "total counts matches before the limit");
});

test("a record older than the list limit is readable by id, and stale ids are not a change", async (t) => {
  const directory = await tempDir(t);
  const auditHome = join(directory, "shared");
  const location = { dataDirectory: "/tmp/isolated-home", auditHome };
  const base = Date.parse("2026-11-18T00:00:00.000Z");
  const lines = Array.from({ length: 520 }, (_, index) => {
    const at = new Date(base + index * 1000).toISOString();
    return [
      JSON.stringify({ schemaVersion: 1, phase: "started", id: `id-${index}`, at, caller: { kind: "cli", pid: 1 }, surface: "cli", prompt: index === 1 ? "hidden-only-record" : `record ${index}`, workspacePath: "/tmp", dataDirectory: "/tmp" }),
      JSON.stringify({ schemaVersion: 1, phase: "completed", id: `id-${index}`, at, reply: "ok" }),
    ].join("\n");
  }).join("\n") + "\n";
  await mkdir(dirname(invocationLedgerPath(location)), { recursive: true });
  await writeFile(invocationLedgerPath(location), lines);

  const page = await searchInvocations({ ...location, limit: 500 });
  assert.equal(page.total, 520);
  assert.equal(page.records.length, 500);
  assert.equal(page.records.at(-1)?.id, "id-20", "the page stops at the newest 500");
  assert.equal((await readInvocation("id-0", location))?.prompt, "record 0", "the oldest record is reachable by id");

  assert.equal(await markInvocations(location, [" id-0 "], true), 1, "ids are trimmed before they are marked");
  assert.equal((await searchInvocations({ ...location, limit: 500 })).total, 519);
  assert.equal(await markInvocations(location, ["missing-id", "A".repeat(500)], true), 0, "unknown or oversized ids change nothing");
  assert.equal((await searchInvocations({ ...location, limit: 500 })).total, 519);
  assert.equal(await markInvocations(location, ["id-0"], false), 1);

  // A hidden-only match is reported, so the UI can say why the list is empty.
  // 仅有隐藏命中的情况会被报告，界面才能解释列表为什么为空。
  await markInvocations(location, ["id-1"], true);
  const hiddenOnly = await searchInvocations({ ...location, query: "hidden-only-record", limit: 500 });
  assert.equal(hiddenOnly.total, 0);
  assert.equal(hiddenOnly.hidden, 1);
  assert.equal((await searchInvocations({ ...location, query: "hidden-only-record", includeDeleted: true, limit: 500 })).hidden, 0);
});

test("malformed ledger lines are ignored instead of throwing or inventing a completion", async (t) => {
  const directory = await tempDir(t);
  const auditHome = join(directory, "shared");
  const location = { dataDirectory: "/tmp/isolated-home", auditHome };
  const at = "2026-11-18T00:00:00.000Z";
  const lines = [
    "null",
    JSON.stringify({ schemaVersion: 1, phase: "started", id: "no-kind", at, caller: null, surface: "cli", prompt: "p", workspacePath: "/tmp", dataDirectory: "/tmp" }),
    JSON.stringify({ schemaVersion: 1, phase: "started", id: "bad-date", at: "garbage", caller: { kind: "cli", pid: 1 }, surface: "cli", prompt: "p", workspacePath: "/tmp", dataDirectory: "/tmp" }),
    JSON.stringify({ schemaVersion: 1, phase: "started", id: "ok", at, caller: { kind: "cli", pid: 1 }, surface: "cli", prompt: "meeting notes", workspacePath: "/tmp", dataDirectory: "/tmp" }),
    JSON.stringify({ schemaVersion: 1, phase: "complete", id: "ok", at: "2026-11-18T00:00:05.000Z", reply: "typo phase" }),
  ].join("\n") + "\n";
  await mkdir(dirname(invocationLedgerPath(location)), { recursive: true });
  await writeFile(invocationLedgerPath(location), lines);

  const all = await searchInvocations({ ...location, limit: 500 });
  assert.deepEqual(all.records.map((record) => record.id), ["ok"]);
  assert.equal(all.records[0]?.status, "running", "an unknown phase must not close the record");
  assert.equal(all.records[0]?.endedAt, undefined);
  // A search must not throw on a record whose caller is missing.
  // 搜索不能因为缺少调用者的记录而抛错。
  assert.equal((await searchInvocations({ ...location, query: "meeting" })).total, 1);
});
