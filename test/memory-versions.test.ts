/**
 * Memory versioning and undo: what a memory said before each change.
 *
 * The store could already recover a half-applied mutation, but a landed change
 * left no trace of the state it replaced. The tests below pin the properties an
 * owner relies on: an edit is undoable, the undo is journaled as a reversal, a
 * second undo takes back the change before the first, and history is bounded.
 *
 * 记忆版本与撤销：每次变更之前它说的是什么。
 *
 * Store 本来就能恢复半途的暂存，但已落地的变更没有留下它替换掉的任何痕迹。下面的测试钉住所有者
 * 依赖的性质：编辑可撤销、撤销以回退的形式入账、第二次撤销撤回更早的那次、历史有界。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { JsonlJournalStore } from "../src/core/journal.ts";
import { MdMemoryStore } from "../src/memory/md-memory-store.ts";
import { MAX_MEMORY_VERSIONS } from "../src/memory/memory-versions.ts";
import { MemoryGovernance } from "../src/memory/memory-governance.ts";

async function setup(t: TestContext): Promise<{ governance: MemoryGovernance; journal: JsonlJournalStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-versions-"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { governance: new MemoryGovernance({ journal, store }), journal, directory };
}

test("an owner's edit can be undone, and the undo is journaled as a reversal", async (t) => {
  const { governance, journal } = await setup(t);
  const memory = await governance.author({ summary: "初始摘要", content: "初始正文" });
  assert.equal((await governance.versions(memory.id)).length, 0, "a first write has no previous state to keep");

  await governance.update(memory.id, { summary: "改过的摘要", content: "改过的正文" });
  const versions = await governance.versions(memory.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.entry.summary, "初始摘要");
  assert.equal(versions[0]!.change, "memory.updated");

  const { memory: restored, restored: version } = await governance.undo(memory.id);
  assert.equal(restored.summary, "初始摘要");
  assert.equal(restored.content, "初始正文");
  assert.equal(version.entry.summary, "初始摘要");

  const events = await journal.list();
  const undoEvent = events.find((event) => event.type === "memory.updated"
    && (event.payload as { source?: string }).source === "undo");
  assert.ok(undoEvent !== undefined, "the undo must be an auditable event, not a silent write");
  assert.equal((undoEvent.payload as { restoredVersion?: string }).restoredVersion, version.id);
});

test("a second undo takes back the change before the first", async (t) => {
  const { governance } = await setup(t);
  const memory = await governance.author({ summary: "第一版" });
  await governance.update(memory.id, { summary: "第二版" });
  await governance.update(memory.id, { summary: "第三版" });

  assert.equal((await governance.undo(memory.id)).memory.summary, "第二版");
  assert.equal((await governance.undo(memory.id)).memory.summary, "第一版");
  // History is not erased by an undo: the undo's own row stays as a consumed
  // version, so the audit still shows every state the memory passed through.
  // 撤销不会抹掉历史：撤销自身那行作为已消费版本留下，因此审计仍能看到记忆经过的每个状态。
  const versions = await governance.versions(memory.id);
  assert.equal(versions.length, 4);
  assert.ok(versions.every((version) => version.consumedAt !== undefined));
});

test("archiving is undoable and restores the active status", async (t) => {
  const { governance } = await setup(t);
  const memory = await governance.author({ summary: "会被归档的记忆" });
  await governance.archive(memory.id, "manual");
  assert.equal((await governance.versions(memory.id))[0]!.change, "memory.archived:manual");

  const { memory: restored } = await governance.undo(memory.id);
  assert.equal(restored.status, "active");
});

test("undo on a memory with no recorded change is refused, not invented", async (t) => {
  const { governance } = await setup(t);
  const memory = await governance.author({ summary: "从未被改过" });
  await assert.rejects(() => governance.undo(memory.id), /no recorded change/);
  await assert.rejects(() => governance.undo("mem-does-not-exist"), /no recorded change/);
});

test("history is bounded to the newest versions", async (t) => {
  const { governance } = await setup(t);
  const memory = await governance.author({ summary: "版本 0 号内容" });
  for (let index = 1; index <= MAX_MEMORY_VERSIONS + 5; index += 1) {
    await governance.update(memory.id, { summary: `版本 ${index} 号内容` });
  }
  const versions = await governance.versions(memory.id);
  assert.equal(versions.length, MAX_MEMORY_VERSIONS);
  // The newest version is the state just before the last edit.
  // 最新版本就是最后一次编辑之前的状态。
  assert.equal(versions[0]!.entry.summary, `版本 ${MAX_MEMORY_VERSIONS + 4} 号内容`);
});
