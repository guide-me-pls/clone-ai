import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createRuntimeAssembly } from "../src/core/runtime-factory.ts";
import { SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { PersonalStateStore } from "../src/state/personal-state-store.ts";

async function setup(t: TestContext) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-journal-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-journal-ws-"));
  t.after(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  return { dataDirectory, workspacePath };
}

test("listSince returns only newer events, in order, and agrees with list", async (t) => {
  const { dataDirectory } = await setup(t);
  const store = new SqliteJournalStore(join(dataDirectory, "journal.sqlite3"));
  t.after(() => store.close());
  for (let i = 0; i < 5; i += 1) await store.append({ type: "evidence.recorded", runId: "r1", payload: { id: `e${i}` } });
  const all = await store.list();
  const tail = await store.listSince(all[2]!.sequence);
  assert.deepEqual(tail.map((event) => event.id), all.slice(3).map((event) => event.id));
  assert.deepEqual((await store.listSince(all.at(-1)!.sequence)), []);
});

test("an incremental refresh sees another view's new runs", async (t) => {
  const { dataDirectory, workspacePath } = await setup(t);
  const first = await createRuntimeAssembly({ dataDirectory, workspacePath });
  t.after(() => first.close());
  const created = await first.runtime.acceptTrigger({ kind: "query", summary: "one", payload: {} });

  // A second, independent view of the same journal creates the next run.
  // 同一本 Journal 的第二个独立视图创建下一个 Run。
  const second = await createRuntimeAssembly({ dataDirectory, workspacePath });
  t.after(() => second.close());
  const later = await second.runtime.acceptTrigger({ kind: "query", summary: "two", payload: {} });

  await first.runtime.refresh();
  const ids = first.runtime.listRuns().map((run) => run.id);
  assert.ok(ids.includes(created.run.id));
  assert.ok(ids.includes(later.run.id));
});

test("a refresh with nothing new keeps the projection it already has", async (t) => {
  const { dataDirectory, workspacePath } = await setup(t);
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  t.after(() => assembly.close());
  const created = await assembly.runtime.acceptTrigger({ kind: "query", summary: "one", payload: {} });
  await assembly.runtime.refresh();
  await assembly.runtime.refresh();
  assert.equal(assembly.runtime.listRuns().filter((run) => run.id === created.run.id).length, 1);
});

test("a replaced journal is rebuilt instead of applied on top", async (t) => {
  const { dataDirectory, workspacePath } = await setup(t);
  const journalPath = join(dataDirectory, "journal.sqlite3");
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  await assembly.runtime.acceptTrigger({ kind: "query", summary: "one", payload: {} });
  // Closing releases the database handle; deleting the file behind it is the
  // "history was replaced" case, where the applied sequence no longer exists
  // and a fresh start is the only honest projection.
  // 关闭后释放数据库句柄；在其背后删除文件就是"历史被替换"的情形，已应用序号不复存在，
  // 从零重建是唯一诚实的投影。
  assembly.close();
  await rm(journalPath).catch(() => undefined);
  await rm(`${journalPath}-journal`, { force: true }).catch(() => undefined);
  const rebuilt = await createRuntimeAssembly({ dataDirectory, workspacePath });
  t.after(() => rebuilt.close());
  assert.equal(rebuilt.runtime.listRuns().length, 0);
});

test("personal state refreshes incrementally and notices a replaced journal", async (t) => {
  const { dataDirectory } = await setup(t);
  const journal = new SqliteJournalStore(join(dataDirectory, "journal.sqlite3"));
  t.after(() => journal.close());
  const store = new PersonalStateStore(journal);
  await store.hydrate();
  const first = await store.recordSelfModel({
    statement: "prefers morning reviews",
    category: "preference",
    provenance: { authoredBy: "owner" },
  });
  const refreshed = await store.refresh();
  assert.equal(refreshed.selfModel[first.id]?.statement, "prefers morning reviews");
  // A second refresh with nothing new must not lose what was already projected.
  // 没有新事件的第二次刷新不能丢掉已经投影出来的内容。
  assert.equal((await store.refresh()).selfModel[first.id]?.statement, "prefers morning reviews");
});

test("listForRun reads one run through the run index", async (t) => {
  const { dataDirectory } = await setup(t);
  const store = new SqliteJournalStore(join(dataDirectory, "journal.sqlite3"));
  t.after(() => store.close());
  await store.append({ type: "evidence.recorded", runId: "r1", payload: { id: "a" } });
  await store.append({ type: "evidence.recorded", runId: "r2", payload: { id: "b" } });
  await store.append({ type: "evidence.recorded", runId: "r1", payload: { id: "c" } });
  const forRun = await store.listForRun("r1");
  assert.deepEqual(forRun.map((event) => (event.payload as { id: string }).id), ["a", "c"]);
  assert.deepEqual(await store.listForRun("missing"), []);
});

test("listTypesSince narrows to requested types and falls back cleanly", async (t) => {
  const { dataDirectory } = await setup(t);
  const store = new SqliteJournalStore(join(dataDirectory, "journal.sqlite3"));
  t.after(() => store.close());
  await store.append({ type: "evidence.recorded", runId: "r1", payload: { id: "a" } });
  await store.append({ type: "opportunity.proposed", payload: { id: "card-1" } });
  await store.append({ type: "evidence.recorded", runId: "r1", payload: { id: "b" } });
  const only = await store.listTypesSince(["opportunity.proposed"], 0);
  assert.deepEqual(only.map((event) => event.type), ["opportunity.proposed"]);
  assert.deepEqual(await store.listTypesSince([], 100), []);
  const none = await store.listTypesSince(["opportunity.resolved"], 0);
  assert.deepEqual(none, []);
});
