import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { routeConversation } from "../src/main-agent/conversation-router.ts";
import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-route-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function turn(directory: string, id: string, conversationId: string, text: string, reply: string, at = "2026-11-19T08:00:00.000Z"): Promise<void> {
  await appendMainAgentTurnRecord(directory, {
    id,
    text,
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply,
    conversationId,
  });
}

const environment = {
  CLONE_AI_NATIVE_BASE_URL: "http://router",
  CLONE_AI_NATIVE_MODEL: "router-model",
};

function routerResponse(answer: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(answer) } }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function routedEvents(directory: string) {
  const journal = createJournalStore(directory);
  try {
    return (await journal.list()).filter((event) => event.type === "conversation.routed");
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

test("an explicit continuation reuses the selected conversation by rule", async (t) => {
  const directory = await tempDir(t);
  await turn(directory, "turn-a", "conversation-a", "整理报告", "已整理。");
  const route = await routeConversation({
    dataDirectory: directory,
    text: "继续刚才的报告",
    context: { kind: "conversation", id: "conversation-a" },
    environment,
    fetchImpl: (async () => { throw new Error("rules must not call the model"); }) as unknown as typeof fetch,
  });
  assert.equal(route.decision, "continue");
  assert.equal(route.conversationId, "conversation-a");
  assert.equal(route.source, "rule");
  assert.equal(route.candidateConversationId, "conversation-a");
  const events = await routedEvents(directory);
  assert.equal(events.length, 1);
  assert.equal((events[0]!.payload as { turnId: string }).turnId, route.turnId);
});

test("a new request with no continuation cue starts a new Main Agent", async (t) => {
  const directory = await tempDir(t);
  await turn(directory, "turn-a", "conversation-a", "整理报告", "已整理。");
  const route = await routeConversation({
    dataDirectory: directory,
    text: "帮我做一个完全不同的东西",
    environment,
    fetchImpl: (async () => { throw new Error("rules must not call the model"); }) as unknown as typeof fetch,
  });
  assert.equal(route.decision, "new");
  assert.equal(route.source, "rule");
  assert.match(route.conversationId, /^conversation-/);
  assert.notEqual(route.conversationId, "conversation-a");
});

test("a new-goal cue is not pulled into the selected conversation", async (t) => {
  const directory = await tempDir(t);
  await turn(directory, "turn-a", "conversation-a", "整理报告", "已整理。");
  const route = await routeConversation({
    dataDirectory: directory,
    text: "做一个新项目，和报告无关",
    context: { kind: "conversation", id: "conversation-a" },
    environment,
    fetchImpl: (async () => { throw new Error("rules must not call the model"); }) as unknown as typeof fetch,
  });
  assert.equal(route.decision, "new");
  assert.equal(route.source, "rule");
});

test("an ambiguous request asks the model and reuses the conversation", async (t) => {
  const directory = await tempDir(t);
  await turn(directory, "turn-a", "conversation-a", "整理报告", "已整理。");
  let body: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"continue\": true, \"reason\": \"same report\"}" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const route = await routeConversation({
    dataDirectory: directory,
    text: "把这个整理成一份简报",
    context: { kind: "conversation", id: "conversation-a" },
    environment,
    fetchImpl,
  });
  assert.equal(route.decision, "continue");
  assert.equal(route.conversationId, "conversation-a");
  assert.equal(route.source, "model");
  assert.equal(route.model, "router-model");
  assert.match(route.reason, /same report/);
  const messages = (body?.messages ?? []) as Array<{ role: string; content: string }>;
  assert.ok(messages.some((message) => message.content.includes("整理报告")));
});

test("the model can send an ambiguous request to a new Main Agent", async (t) => {
  const directory = await tempDir(t);
  await turn(directory, "turn-a", "conversation-a", "整理报告", "已整理。");
  const route = await routeConversation({
    dataDirectory: directory,
    text: "把这个整理成一份简报",
    context: { kind: "conversation", id: "conversation-a" },
    environment,
    fetchImpl: routerResponse({ continue: false, reason: "a different deliverable" }),
  });
  assert.equal(route.decision, "new");
  assert.equal(route.source, "model");
  assert.match(route.conversationId, /^conversation-/);
});

test("an unavailable router falls back to a new Main Agent", async (t) => {
  const directory = await tempDir(t);
  await turn(directory, "turn-a", "conversation-a", "整理报告", "已整理。");
  const route = await routeConversation({
    dataDirectory: directory,
    text: "把这个整理成一份简报",
    context: { kind: "conversation", id: "conversation-a" },
    environment,
    fetchImpl: (async () => { throw new Error("router offline"); }) as unknown as typeof fetch,
  });
  assert.equal(route.decision, "new");
  assert.equal(route.source, "fallback");
});

test("a continuation with no selected context uses the latest conversation", async (t) => {
  const directory = await tempDir(t);
  await turn(directory, "turn-old", "conversation-old", "旧的事", "完成。", "2026-11-19T07:00:00.000Z");
  await turn(directory, "turn-new", "conversation-new", "报告", "已整理。", "2026-11-19T08:00:00.000Z");
  const route = await routeConversation({
    dataDirectory: directory,
    text: "继续上次的",
    environment,
    fetchImpl: (async () => { throw new Error("rules must not call the model"); }) as unknown as typeof fetch,
  });
  assert.equal(route.decision, "continue");
  assert.equal(route.conversationId, "conversation-new");
});

test("a task context resolves to the conversation named in its trigger", async (t) => {
  const directory = await tempDir(t);
  await turn(directory, "turn-task", "conversation-task", "做一份报告", "已派发。");
  const journal = createJournalStore(directory);
  try {
    await journal.append({
      type: "trigger.received",
      payload: { id: "trigger-task", kind: "query", summary: "做一份报告", payload: { source: "main-agent", conversationId: "conversation-task" } },
    });
    await journal.append({ type: "task.created", taskId: "task-task", payload: { triggerId: "trigger-task" } });
    await journal.append({ type: "run.created", taskId: "task-task", runId: "run-task", payload: { status: "planning" } });
  } finally {
    (journal as { close?: () => void }).close?.();
  }
  const route = await routeConversation({
    dataDirectory: directory,
    text: "继续这个任务",
    context: { kind: "task", id: "run-task" },
    environment,
    fetchImpl: (async () => { throw new Error("rules must not call the model"); }) as unknown as typeof fetch,
  });
  assert.equal(route.decision, "continue");
  assert.equal(route.conversationId, "conversation-task");
});
