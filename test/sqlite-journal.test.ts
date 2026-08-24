import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createScriptedAgentRegistry } from "./fixtures/scripted-adapter.ts";
import { checkJournalInvariants } from "../src/core/invariants.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { createJournalStore, migrateJsonlJournalToSqlite, SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";

/**
 * One after-hook closes every registered store before removing the directory:
 * on Windows an open SQLite handle makes the unlink fail with EBUSY.
 * 单个 after 钩子先关闭全部登记的 store 再删除目录：Windows 上未关闭的 SQLite 句柄
 * 会让 unlink 以 EBUSY 失败。
 */
async function tempDirectory(t: TestContext): Promise<{ directory: string; use: (store: SqliteJournalStore) => SqliteJournalStore }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-sqlite-"));
  const stores: SqliteJournalStore[] = [];
  t.after(async () => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // Already closed by the test body. 已在测试主体中关闭。
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, use: (store) => (stores.push(store), store) };
}

test("sqlite journal round-trips events with monotonic sequences across reopen", async (t) => {
  const { directory, use } = await tempDirectory(t);
  const path = join(directory, "journal.sqlite3");

  const first = new SqliteJournalStore(path);
  const eventA = await first.append({ type: "trigger.received", payload: { summary: "one" } });
  const eventB = await first.append({ type: "task.created", taskId: "task-1", payload: { title: "two" } });
  first.close();

  // A fresh connection must see everything and continue the sequence.
  // 新连接必须看到全部事件并延续 sequence。
  const second = use(new SqliteJournalStore(path));
  const eventC = await second.append({ type: "run.created", taskId: "task-1", runId: "run-1", payload: { id: "run-1" } });

  const events = await second.list();
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(events.map((event) => event.id), [eventA.id, eventB.id, eventC.id]);
  assert.deepEqual(events[1]?.payload, { title: "two" });
  assert.equal(events[2]?.runId, "run-1");
});

test("two connections on the same journal interleave writes without corruption", async (t) => {
  const { directory, use } = await tempDirectory(t);
  const path = join(directory, "journal.sqlite3");

  const writerA = use(new SqliteJournalStore(path));
  const writerB = use(new SqliteJournalStore(path));

  for (let index = 0; index < 5; index += 1) {
    await writerA.append({ type: "execution.progress", payload: { from: "A", index } });
    await writerB.append({ type: "execution.progress", payload: { from: "B", index } });
  }

  const events = await writerA.list();
  assert.equal(events.length, 10);
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
});

test("the runtime completes a supervised run on sqlite without any code changes", async (t) => {
  const { directory, use } = await tempDirectory(t);
  const journal = use(new SqliteJournalStore(join(directory, "journal.sqlite3")));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
  });

  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Prepare a local draft.", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "Prepare locally.",
    steps: [{
      id: "prepare",
      title: "Prepare draft",
      instructions: "Draft locally.",
      risk: "reversible_write",
      acceptanceCriteria: ["Draft exists"],
      subagents: [{
        id: "draft",
        agentId: "draft-maker",
        role: "maker",
        title: "Draft",
        objective: "Create the local draft.",
        inputs: [],
        requiredCapabilities: ["drafting", "filesystem_read", "filesystem_write"],
        expectedArtifacts: [{ id: "doc", kind: "artifact", description: "The draft.", required: true }],
        acceptanceCriteria: ["Draft exists"],
        risk: "reversible_write",
        budget: { maxDurationMs: 30_000, maxModelCalls: 4, maxToolCalls: 4, maxAttempts: 2 },
      }],
    }],
  });
  const result = await runtime.execute(run.id, createScriptedAgentRegistry());
  assert.equal(result.status, "completed");

  // A second runtime hydrated from the same file proves restart recovery.
  // 从同一文件重建的第二个 Runtime 证明重启恢复成立。
  const reopened = use(new SqliteJournalStore(join(directory, "journal.sqlite3")));
  const rehydrated = new CloneRuntime({
    journal: reopened,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(reopened),
  });
  await rehydrated.hydrate();
  assert.equal(rehydrated.getRun(run.id).status, "completed");
  assert.deepEqual(checkJournalInvariants(await reopened.list()), []);
});

test("migration preserves the history exactly and refuses invalid or non-empty targets", async (t) => {
  const { directory, use } = await tempDirectory(t);
  const jsonlPath = join(directory, "journal.jsonl");

  // Produce a real, valid history through the actual runtime.
  // 用真实 Runtime 产出一段真实、合法的历史。
  const jsonl = new JsonlJournalStore(jsonlPath);
  const runtime = new CloneRuntime({
    journal: jsonl,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(jsonl),
  });
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Migrate me.", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "One research step.",
    steps: [{
      id: "research",
      title: "Research",
      instructions: "Research locally.",
      risk: "read_only",
      acceptanceCriteria: ["Note exists"],
      agentId: "demo-researcher",
      requiredCapabilities: ["research"],
    }],
  });

  const sqlitePath = join(directory, "journal.sqlite3");
  const { migrated } = await migrateJsonlJournalToSqlite({ jsonlPath, sqlitePath });
  const source = await jsonl.list();
  assert.equal(migrated, source.length);

  const store = use(new SqliteJournalStore(sqlitePath));
  // Migration preserves the persisted form: in-memory objects may carry
  // explicit undefined properties that JSON serialization never stores.
  // 迁移保留的是持久化形态：内存对象可能带有显式 undefined 属性，而 JSON 序列化
  // 从不存储它们。
  assert.deepEqual(await store.list(), JSON.parse(JSON.stringify(source)));

  // The sequence continues after the migrated tail.
  // sequence 在迁移的尾部之后继续。
  const next = await store.append({ type: "execution.progress", payload: { note: "post-migration" } });
  assert.equal(next.sequence, source.length + 1);

  // A non-empty target must be refused.
  // 非空目标必须被拒绝。
  await assert.rejects(
    migrateJsonlJournalToSqlite({ jsonlPath, sqlitePath }),
    /already contains events/,
  );
});

test("migration stops when the source history violates an invariant", async (t) => {
  const { directory } = await tempDirectory(t);
  const jsonlPath = join(directory, "journal.jsonl");
  const jsonl = new JsonlJournalStore(jsonlPath);
  await jsonl.append({
    type: "subagent.completed",
    runId: "run-1",
    payload: { workOrderId: "forged", summary: "Done without evidence." },
  });

  await assert.rejects(
    migrateJsonlJournalToSqlite({ jsonlPath, sqlitePath: join(directory, "journal.sqlite3") }),
    /evidence-before-completion/,
  );
});

test("a legacy jsonl home is imported automatically on first open", async (t) => {
  const { directory } = await tempDirectory(t);
  const jsonl = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const seeded = await jsonl.append({ type: "trigger.received", payload: { summary: "history" } });

  // The store every entry point builds through — the same seam the daemon
  // uses — must see the imported past, and continue numbering after it.
  // 所有入口共同经过的那个 store 构造 seam 必须看到导入的历史，并在其后延续编号。
  const store = createJournalStore(directory);
  try {
    const events = await store.list();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, seeded.id);
    const next = await store.append({ type: "trigger.received", payload: { summary: "new" } });
    assert.equal(next.sequence, 2);
  } finally {
    (store as { close?: () => void }).close?.();
  }
});

test("duplicate sequences from the multi-process bug are renumbered on import", async (t) => {
  const { directory } = await tempDirectory(t);
  // Two daemons each counted from 1: the exact failure the claim-based store
  // now prevents, written by hand the way it appeared in real homes.
  // 两个 daemon 各自从 1 开始计数：正是领取机制现在阻止的那种故障，按真实用户家里
  // 出现的样子手写出来。
  await writeFile(join(directory, "journal.jsonl"), [
    JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", type: "trigger.received", sequence: 1, occurredAt: "2025-01-01T00:00:00.000Z", payload: { summary: "a" } }),
    JSON.stringify({ id: "22222222-2222-2222-2222-222222222222", type: "trigger.received", sequence: 1, occurredAt: "2025-01-01T00:00:01.000Z", payload: { summary: "b" } }),
  ].join("\n") + "\n", "utf8");

  const store = createJournalStore(directory);
  try {
    const events = await store.list();
    assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
    assert.deepEqual(events.map((event) => event.payload), [{ summary: "a" }, { summary: "b" }]);
  } finally {
    (store as { close?: () => void }).close?.();
  }
});

test("an empty sqlite beside a populated jsonl still imports, a populated one never", async (t) => {
  const { directory, use } = await tempDirectory(t);
  // The broken-default window: an empty SQLite file created next to a real
  // JSONL history. There is nothing in it to lose, so the import proceeds.
  // 默认值切换的窗口期：空 SQLite 文件与真实 JSONL 历史并存。里面没有可丢失的东西，
  // 因此导入照常进行。
  const empty = use(new SqliteJournalStore(join(directory, "journal.sqlite3")));
  empty.close();
  await writeFile(join(directory, "journal.jsonl"),
    JSON.stringify({ id: "33333333-3333-3333-3333-333333333333", type: "trigger.received", sequence: 1, occurredAt: "2025-02-01T00:00:00.000Z", payload: { summary: "rescued" } }) + "\n", "utf8");

  const imported = createJournalStore(directory);
  try {
    const events = await imported.list();
    assert.equal(events.length, 1);
    assert.equal((events[0]?.payload as { summary?: string }).summary, "rescued");
  } finally {
    (imported as { close?: () => void }).close?.();
  }

  // Once the SQLite journal holds real events of its own, the JSONL past is
  // no longer merged in: diverged histories are the owner's call, not boot
  // code's. 一旦 SQLite Journal 里已有自己的真实事件，就不再并入 JSONL 的过去：
  // 分叉的历史由所有者决断，而不是启动代码。
  const diverged = createJournalStore(directory);
  try {
    await diverged.append({ type: "trigger.received", payload: { summary: "diverged" } });
  } finally {
    (diverged as { close?: () => void }).close?.();
  }
  await writeFile(join(directory, "journal.jsonl"),
    JSON.stringify({ id: "44444444-4444-4444-4444-444444444444", type: "trigger.received", sequence: 9, occurredAt: "2025-03-01T00:00:00.000Z", payload: { summary: "late jsonl write" } }) + "\n", "utf8");

  const settled = createJournalStore(directory);
  try {
    const events = await settled.list();
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => (event.payload as { summary?: string }).summary !== "late jsonl write"));
  } finally {
    (settled as { close?: () => void }).close?.();
  }
});

test("only one of two processes can claim a run, and the loser is told", async (t) => {
  const { directory, use } = await tempDirectory(t);
  const path = join(directory, "journal.sqlite3");

  // Two store instances over one file are two processes: a GUI daemon and a
  // CLI that happen to run at the same time. Each holds its own view of the
  // world; only the transaction can decide between them.
  // 同一文件上的两个 Store 实例就是两个进程：恰好同时运行的 GUI Daemon 与 CLI。
  // 各自持有自己的世界观；只有事务能在两者之间做出裁决。
  const daemon = use(new SqliteJournalStore(path));
  const cli = use(new SqliteJournalStore(path));

  const byDaemon = await daemon.claimRun({ runId: "run-1", ownerId: "daemon", leaseMs: 60_000 });
  assert.ok(byDaemon !== undefined, "the first claimer wins");
  assert.equal(byDaemon.attempt, 1);

  const byCli = await cli.claimRun({ runId: "run-1", ownerId: "cli", leaseMs: 60_000 });
  assert.equal(byCli, undefined, "a live lease cannot be taken by a second process");

  // The same owner re-claiming (a reconnect) keeps the attempt count flat.
  // 同一所有者重连再领取时，attempt 不应递增。
  const reconnected = await daemon.claimRun({ runId: "run-1", ownerId: "daemon", leaseMs: 60_000 });
  assert.ok(reconnected !== undefined);
  assert.equal(reconnected.attempt, 1);
});

test("a lease that expired is stealable, and stealing is visible in the attempt count", async (t) => {
  const { directory, use } = await tempDirectory(t);
  const store = use(new SqliteJournalStore(join(directory, "journal.sqlite3")));

  // A consumer killed mid-run holds a lease it will never renew. The work must
  // not strand, so the lease expires — and the takeover is counted, because a
  // run that keeps killing its owners is a signal, not noise.
  // 被中途杀掉的消费者握着一个永远不会再续期的租约。工作不能因此搁浅，所以租约会
  // 过期——且接管被计数，因为反复弄死持有者的 Run 是信号，不是噪声。
  await store.claimRun({ runId: "run-2", ownerId: "crashed", leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const takeover = await store.claimRun({ runId: "run-2", ownerId: "successor", leaseMs: 60_000 });
  assert.ok(takeover !== undefined, "an expired lease is stealable");
  assert.equal(takeover.attempt, 2, "stealing bumps the attempt count");

  assert.equal(await store.renewClaim({ runId: "run-2", ownerId: "crashed", leaseMs: 60_000 }), false);
  assert.equal(await store.renewClaim({ runId: "run-2", ownerId: "successor", leaseMs: 60_000 }), true);

  await store.releaseClaim({ runId: "run-2", ownerId: "successor" });
  const reclaimed = await store.claimRun({ runId: "run-2", ownerId: "successor", leaseMs: 60_000 });
  assert.ok(reclaimed !== undefined);
  assert.equal(reclaimed.attempt, 2, "release-and-reclaim by the same owner is not a new attempt");
});
