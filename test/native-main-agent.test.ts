import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import {
  isNativeMainAgentSelected,
  readNativeMainAgentEndpoint,
  runNativeMainAgentTurn,
} from "../src/main-agent/native-runtime.ts";
import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("the native main agent runs tools, streams the reply and audits the turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-native-main-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    calls += 1;
    if (calls === 1) {
      return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_authority", arguments: "{}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: "All " } }] },
      { choices: [{ delta: { content: "set." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } },
    ]);
  }) as unknown as typeof fetch;

  const deltas: string[] = [];
  const result = await runNativeMainAgentTurn({
    dataDirectory: directory,
    text: "What am I allowed to do?",
    source: "cli",
    endpoint: { baseUrl: "http://gateway", model: "test-model" },
    fetchImpl,
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.error, undefined);
  assert.equal(result.reply, "All set.");
  assert.deepEqual(deltas, ["All ", "set."]);
  assert.equal(bodies.length, 2);
  const first = bodies[0] as { tools?: Array<{ function: { name: string } }> };
  assert.ok(first.tools?.some((tool) => tool.function.name === "get_authority"));
  const second = bodies[1] as { messages: Array<{ role: string; content?: string }> };
  assert.ok(second.messages.some((message) => message.role === "tool" && String(message.content).length > 0));

  const journal = createJournalStore(directory);
  try {
    const events = await journal.list();
    const started = events.find((event) => event.type === "main_agent.turn_started");
    const completed = events.find((event) => event.type === "main_agent.turn_completed");
    const toolStarted = events.find((event) => event.type === "agent.tool_started");
    const toolCompleted = events.find((event) => event.type === "agent.tool_completed");
    const usage = events.find((event) => event.type === "usage.recorded");
    const snapshot = events.find((event) => event.type === "main_agent.prompt_snapshot");
    assert.ok(started && completed && toolStarted && toolCompleted && usage && snapshot);
    assert.equal((started.payload as Record<string, unknown>).source, "cli");
    assert.equal((completed.payload as Record<string, unknown>).status, "completed");
    assert.equal((toolStarted.payload as Record<string, unknown>).tool, "get_authority");
    assert.equal((toolCompleted.payload as Record<string, unknown>).isError, false);
    const usagePayload = usage.payload as Record<string, unknown>;
    assert.equal(usagePayload.source, "main-agent");
    assert.equal(usagePayload.totalTokens, 36);
    assert.equal(usagePayload.modelCalls, 2);
    assert.equal((completed.payload as Record<string, unknown>).reply, "All set.");
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});

test("the native main agent includes prior turns from the ledger", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-native-history-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await appendMainAgentTurnRecord(directory, {
    id: "old-turn",
    text: "Remember the blue template.",
    status: "completed",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date(Date.now() - 30_000).toISOString(),
    reply: "Noted.",
  });
  let body: { messages: Array<{ role: string; content?: string }> } | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content?: string }> };
    return sseResponse([
      { choices: [{ delta: { content: "Sure." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
  }) as unknown as typeof fetch;
  const result = await runNativeMainAgentTurn({
    dataDirectory: directory,
    text: "Which template?",
    source: "cli",
    endpoint: { baseUrl: "http://gateway", model: "m" },
    fetchImpl,
  });
  assert.equal(result.reply, "Sure.");
  assert.ok(body?.messages.some((message) => message.role === "user" && String(message.content).includes("blue template")));
  assert.ok(body?.messages.some((message) => message.role === "assistant" && message.content === "Noted."));
});

test("the native flag and endpoint are explicit", () => {
  assert.equal(isNativeMainAgentSelected({ CLONE_AI_MAIN_RUNTIME: "native" }), true);
  assert.equal(isNativeMainAgentSelected({}), false);
  const missing = readNativeMainAgentEndpoint({});
  assert.equal(missing.endpoint, undefined);
  assert.deepEqual(missing.missing, ["CLONE_AI_NATIVE_BASE_URL", "CLONE_AI_NATIVE_MODEL"]);
  const configured = readNativeMainAgentEndpoint({ CLONE_AI_NATIVE_MODEL: "m", CLONE_AI_NATIVE_BASE_URL: "http://x/" });
  assert.equal(configured.endpoint?.baseUrl, "http://x");
  assert.equal(configured.endpoint?.model, "m");
});

test("a long transcript is compacted deterministically, keeping the newest turns verbatim", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-native-compact-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const long = "x".repeat(800);
  for (let index = 0; index < 20; index += 1) {
    await appendMainAgentTurnRecord(directory, {
      id: `turn-${index}`,
      text: `question ${index} ${long}`,
      status: "completed",
      startedAt: new Date(Date.now() - (20 - index) * 60_000).toISOString(),
      completedAt: new Date(Date.now() - (20 - index) * 60_000 + 1_000).toISOString(),
      reply: `answer ${index} ${long}`,
    });
  }
  let body: { messages: Array<{ role: string; content?: string }> } | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content?: string }> };
    return sseResponse([
      { choices: [{ delta: { content: "OK." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
  }) as unknown as typeof fetch;
  const result = await runNativeMainAgentTurn({
    dataDirectory: directory,
    text: "newest question",
    source: "cli",
    endpoint: { baseUrl: "http://gateway", model: "m" },
    fetchImpl,
    historyChars: 4_000,
  });
  assert.equal(result.reply, "OK.");
  const messages = body?.messages ?? [];
  assert.ok(messages.some((message) => message.role === "system" && String(message.content).includes("compacted deterministically")));
  const userMessages = messages.filter((message) => message.role === "user");
  assert.ok(userMessages.length < 20);
  assert.ok(userMessages.some((message) => String(message.content).startsWith("question 19 ")));
});
