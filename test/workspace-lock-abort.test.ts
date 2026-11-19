import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { Evidence, Run, Task } from "../src/core/contracts.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { WorkspaceExecutionLock } from "../src/core/workspace-lock.ts";
import { ConversationMemoryPipeline } from "../src/memory/conversation-memory-pipeline.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface HeldLock {
  release(): void;
}

async function holdLock(lockPath: string): Promise<HeldLock> {
  const directory = join(lockPath, ".clone");
  await mkdir(directory, { recursive: true });
  const holder = new DatabaseSync(join(directory, "workspace-execution.sqlite3"));
  holder.exec("BEGIN IMMEDIATE");
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      holder.exec("ROLLBACK");
      holder.close();
    },
  };
}

async function outcomeOf<T>(promise: Promise<T>, timeoutMs: number): Promise<T | Error | "timeout"> {
  return await Promise.race([
    promise.then((value) => value, (error: unknown) => error instanceof Error ? error : new Error(String(error))),
    delay(timeoutMs).then(() => "timeout" as const),
  ]);
}

/**
 * Shutdown aborts the *wait* for the extraction lock, not an operation that
 * already holds it. These are the focused cases behind the server-level
 * readiness test: a wait that outlives the holder, a queued waiter that must
 * not wedge the queue, and the pipeline path a scheduled run uses.
 * 关停中止的是对提炼锁的*等待*，不是已经持有锁的操作。这些是服务器级就绪测试背后的聚焦用例：
 * 比持有者更久的等待、不得卡住队列的排队者，以及定时任务使用的流水线路径。
 */
test("an explicit lock file stays outside the workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-lock-file-ws-"));
  const lockDirectory = await mkdtemp(join(tmpdir(), "clone-ai-lock-file-db-"));
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(lockDirectory, { recursive: true, force: true });
  });
  const lockFile = join(lockDirectory, "workspace-execution.sqlite3");
  const lock = new WorkspaceExecutionLock();

  const result = await lock.run(workspace, async () => "ran", { lockFile });

  assert.equal(result, "ran");
  assert.equal(existsSync(lockFile), true);
  assert.equal(existsSync(join(workspace, ".clone")), false);
});

test("a lock wait aborts before the holder releases, and the lock stays usable", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-lock-abort-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const holder = await holdLock(workspace);
  const controller = new AbortController();
  const lock = new WorkspaceExecutionLock();
  const waiting = lock.run(workspace, async () => "ran", { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);

  const outcome = await outcomeOf(waiting, 1_000);
  assert.notEqual(outcome, "timeout", "the lock wait did not abort while the holder still held the lock");
  assert.ok(outcome instanceof Error, "the aborted wait must reject");
  assert.equal(outcome.name, "AbortError");

  holder.release();
  assert.equal(await lock.run(workspace, async () => "next"), "next");
});

test("an aborted queued caller rejects promptly without blocking the next waiter", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-lock-queue-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const lock = new WorkspaceExecutionLock();
  let releaseHolder: (() => void) | undefined;
  let enteredHolder: (() => void) | undefined;
  const holderEntered = new Promise<void>((resolve) => { enteredHolder = resolve; });
  const holder = lock.run(workspace, async () => {
    enteredHolder?.();
    await new Promise<void>((resolve) => { releaseHolder = resolve; });
    return "holder";
  });
  await holderEntered;

  const controller = new AbortController();
  const queued = lock.run(workspace, async () => "queued", { signal: controller.signal });
  await delay(50);
  controller.abort();
  const outcome = await outcomeOf(queued, 500);
  assert.notEqual(outcome, "timeout", "the queued caller did not abort until the in-process holder released");
  assert.ok(outcome instanceof Error);
  assert.equal(outcome.name, "AbortError");

  releaseHolder?.();
  await holder;
  assert.equal(await lock.run(workspace, async () => "next"), "next", "the aborted queue entry wedged the next waiter");
});

test("a pipeline extraction wait aborts before the holder releases", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-pipeline-abort-"));
  const lockPath = join(directory, "memory-extraction-lock");
  const journal = createJournalStore(directory);
  t.after(async () => {
    (journal as { close?: () => void }).close?.();
    await rm(directory, { recursive: true, force: true });
  });
  const holder = await holdLock(lockPath);
  const pipeline = new MemoryPipeline(journal, { extract: async () => [] }, { lockPath });
  pipeline.enqueue({ id: "run-abort" } as Run, { id: "task-abort", objective: "abort" } as Task, []);

  const controller = new AbortController();
  const waiting = pipeline.processNext(undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const outcome = await outcomeOf(waiting, 1_000);
  assert.notEqual(outcome, "timeout", "the pipeline wait did not abort while the extraction lock was held");
  assert.ok(outcome instanceof Error);
  assert.equal(outcome.name, "AbortError");

  holder.release();
  assert.deepEqual(await pipeline.processNext(undefined, {}), [], "the job stays pending and is still processable");
});

test("a conversation drain aborts its extraction wait on shutdown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-conversation-abort-"));
  const lockPath = join(directory, "memory-extraction-lock");
  const journal = createJournalStore(directory);
  t.after(async () => {
    (journal as { close?: () => void }).close?.();
    await rm(directory, { recursive: true, force: true });
  });
  const createdAt = new Date().toISOString();
  const runId = "conversation:probe:00000001";
  await journal.append({
    type: "memory.conversation.requested",
    runId,
    payload: { session: "probe", taskObjective: "probe" },
  });
  await journal.append({
    type: "evidence.recorded",
    runId,
    payload: {
      id: "conv:probe:1", runId, stepId: "conversation", producedBy: "owner", kind: "observation",
      summary: "I prefer concise answers.", locator: "probe#0", createdAt,
    } satisfies Evidence,
  });
  const conversation = new ConversationMemoryPipeline(
    journal,
    new MemoryPipeline(journal, { extract: async () => [] }, { lockPath }),
  );

  const holder = await holdLock(lockPath);
  const controller = new AbortController();
  const waiting = conversation.processDue({ signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const outcome = await outcomeOf(waiting, 1_000);
  assert.notEqual(outcome, "timeout", "the conversation drain did not abort while the extraction lock was held");
  assert.ok(outcome instanceof Error);
  assert.equal(outcome.name, "AbortError");
  holder.release();
});