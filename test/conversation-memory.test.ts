import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { ConversationMemoryPipeline } from "../src/memory/conversation-memory-pipeline.ts";
import { ConversationMemoryWorker, conversationJobsFromEvents, conversationPrompt } from "../src/memory/conversation-memory-worker.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { pushRelevantMemories } from "../src/main-agent/memory-push.ts";
import { MdMemoryStore } from "../src/memory/md-memory-store.ts";
import { MemoryGovernance } from "../src/memory/memory-governance.ts";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.cjs", import.meta.url));

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-conversation-"));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, journal };
}

test("every owner turn gets its own request with evidence; assistant text is never evidence", async (t) => {
  const { journal } = await setup(t);
  const pipeline = new ConversationMemoryPipeline(journal, new MemoryPipeline(journal));
  await pipeline.record({
    session: "s1.jsonl",
    objective: "我以后周五不加班",
    turns: [
      { at: "2026-11-01T00:00:00Z", speaker: "user", text: "我以后周五不加班" },
      { at: "2026-11-01T00:00:01Z", speaker: "assistant", text: "好的，记住了" },
    ],
  });
  await pipeline.record({ session: "s1.jsonl", objective: "用蓝色模板", turns: [{ at: "2026-11-01T00:01:00Z", speaker: "user", text: "周报用蓝色模板" }] });

  const events = await journal.list();
  assert.equal(events.filter((event) => event.type === "memory.conversation.requested").length, 2);
  const evidence = events.filter((event) => event.type === "evidence.recorded");
  assert.deepEqual(evidence.map((event) => (event.payload as { summary: string }).summary), ["我以后周五不加班", "周报用蓝色模板"]);
  assert.equal(conversationJobsFromEvents(events).length, 2);
});

test("draining marks each batch extracted and is idempotent", async (t) => {
  const { journal } = await setup(t);
  const miner = new ConversationMemoryWorker();
  const pipeline = new ConversationMemoryPipeline(journal, new MemoryPipeline(journal, {
    extract: async () => [],
  }));
  await pipeline.record({ session: "s1.jsonl", objective: "我住杭州", turns: [{ at: "2026-11-01T00:00:00Z", speaker: "user", text: "我住杭州" }] });
  assert.deepEqual(await pipeline.processDue(), []);
  assert.equal((await journal.list()).filter((event) => event.type === "memory.conversation.extracted").length, 1);
  assert.deepEqual(await pipeline.processDue(), []);
  assert.ok(miner !== undefined);
});

test("the conversation prompt asks for durable owner statements and keeps the citation rules", () => {
  const prompt = conversationPrompt({
    run: { id: "r", taskId: "t", status: "completed", createdAt: "", updatedAt: "" },
    task: { id: "t", triggerId: "c", title: "c", objective: "c", acceptanceCriteria: [], createdAt: "" },
    evidence: [{ id: "e1", runId: "r", stepId: "s", kind: "observation", summary: "我住杭州", createdAt: "" }],
  });
  assert.match(prompt, /ordinary conversation/);
  assert.match(prompt, /Never invent/);
  assert.match(prompt, /e1: \[observation\] 我住杭州/);
});

test("a pushed memory reaches the Main Agent context and is journaled, and secrets stay out", async (t) => {
  const { directory, journal } = await setup(t);
  const store = new MdMemoryStore({ dataDirectory: directory });
  const governance = new MemoryGovernance({ journal, store });
  t.after(() => store.close());
  await governance.author({ summary: "周报使用蓝色模板并每周五提交" });
  await governance.author({ summary: "周报系统管理员密码是 hunter2", sensitivity: "secret" });

  const pushed = await pushRelevantMemories({ dataDirectory: directory, query: "这周周报怎么写", journal });
  assert.ok(pushed !== undefined);
  assert.match(pushed.text, /蓝色模板/);
  assert.doesNotMatch(pushed.text, /hunter2|密码/);
  const recalled = (await journal.list()).filter((event) => event.type === "memory.recalled");
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0]!.runId, "main-agent");
});
