import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createDemoAgentRegistry } from "../src/adapters/demo-adapter.ts";
import { checkJournalInvariants } from "../src/core/invariants.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { migrateJsonlJournalToSqlite, SqliteJournalStore } from "../src/core/sqlite-journal.ts";
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
        // Already closed by the test body.
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
  const result = await runtime.execute(run.id, createDemoAgentRegistry());
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
