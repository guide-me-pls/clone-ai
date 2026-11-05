import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  beginInvocation,
  detectInvocationCaller,
  invocationLedgerPath,
  readInvocation,
  readInvocations,
  resolveInvocationAuditDirectory,
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
