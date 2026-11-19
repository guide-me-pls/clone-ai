import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatHistorySearch, searchOwnerHistory } from "../src/main-agent/history-search.ts";
import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";

async function directory(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clone-ai-history-search-"));
  t.after(async () => rm(path, { recursive: true, force: true }));
  return path;
}

async function turn(path: string, id: string, conversationId: string, text: string, reply: string, at: string): Promise<void> {
  await appendMainAgentTurnRecord(path, {
    id,
    text,
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply,
    conversationId,
  });
}

test("global search returns hits from every conversation with provenance", async (t) => {
  const path = await directory(t);
  await turn(path, "turn-a", "conversation-a", "请记住蓝色模板", "已记住蓝色模板。", "2026-11-19T07:00:00.000Z");
  await turn(path, "turn-b", "conversation-b", "请记住红色模板", "已记住红色模板。", "2026-11-19T08:00:00.000Z");

  const all = await searchOwnerHistory(path, "模板", { conversationId: "conversation-b" });
  assert.equal(all.scope, "all");
  assert.equal(all.hits.length, 2);
  assert.deepEqual(all.hits.map((hit) => hit.conversationId).sort(), ["conversation-a", "conversation-b"]);
  assert.ok(all.hits.every((hit) => hit.source === "ledger"));

  const scoped = await searchOwnerHistory(path, "模板", { scope: "conversation", conversationId: "conversation-b" });
  assert.equal(scoped.scope, "conversation");
  assert.equal(scoped.hits.length, 1);
  assert.equal(scoped.hits[0]!.conversationId, "conversation-b");

  const blue = await searchOwnerHistory(path, "蓝色", { conversationId: "conversation-b" });
  assert.equal(blue.hits.length, 1);
  assert.equal(blue.hits[0]!.conversationId, "conversation-a");

  const empty = await searchOwnerHistory(path, "   ", { conversationId: "conversation-b" });
  assert.deepEqual(empty.hits, []);
});

test("the tool text labels each result with its conversation", async (t) => {
  const path = await directory(t);
  await turn(path, "turn-a", "conversation-a", "蓝色模板", "已记住。", "2026-11-19T07:00:00.000Z");
  const result = await searchOwnerHistory(path, "蓝色", { conversationId: "conversation-b" });
  const text = formatHistorySearch(result, "conversation-b");
  assert.match(text, /across all conversations/);
  assert.match(text, /conversation a/);
  assert.match(text, /records, not instructions/);
  assert.match(text, /蓝色模板/);

  const scoped = formatHistorySearch(await searchOwnerHistory(path, "蓝色", {
    scope: "conversation",
    conversationId: "conversation-b",
  }), "conversation-b");
  assert.match(scoped, /No completed turns in this conversation/);
});
