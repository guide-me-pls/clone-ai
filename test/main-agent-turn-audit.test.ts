import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import {
  beginMainAgentTurn,
  finishMainAgentTurn,
  observeMainAgentSession,
  readMainAgentTurnRecords,
  recordMainAgentTurnInterrupted,
} from "../src/main-agent/turn-audit.ts";
import { loadTurnAudits, projectTurnAudits } from "../src/audit/turn-audit.ts";

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-turn-audit-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeSession(): { subscribe(callback: (event: unknown) => void): () => void; emit(event: unknown): void } {
  let listener: ((event: unknown) => void) | undefined;
  return {
    subscribe(callback) {
      listener = callback;
      return () => { listener = undefined; };
    },
    emit(event) {
      listener?.(event);
    },
  };
}

async function journalEvents(directory: string) {
  const journal = createJournalStore(directory);
  try {
    return await journal.list();
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

test("a turn records input, tools, reply, usage and the ledger, with PII redacted", async (t) => {
  const directory = await tempDir(t);
  const session = fakeSession();
  const turn = await beginMainAgentTurn({
    dataDirectory: directory,
    text: "Email owner@example.com about the deploy token ghp_abcdefghijklmnopqrstuvwxyz",
    source: "cli",
    modelId: "test-model",
    provider: "test",
    effort: "medium",
  });
  observeMainAgentSession(session, turn);
  session.emit({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "propose_work_plan",
    args: { summary: "deploy", token: "ghp_abcdefghijklmnopqrstuvwxyz" },
  });
  session.emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "propose_work_plan",
    result: { accepted: true },
    isError: false,
  });
  await finishMainAgentTurn(turn, {
    status: "completed",
    reply: "Done, owner@example.com.",
    usage: { source: "main-agent", turnId: turn.turnId, durationMs: 12, totalTokens: 5 },
    spawnedRunIds: ["run-1"],
  });

  const events = await journalEvents(directory);
  const started = events.find((event) => event.type === "main_agent.turn_started");
  const toolStarted = events.find((event) => event.type === "agent.tool_started");
  const toolCompleted = events.find((event) => event.type === "agent.tool_completed");
  const completed = events.find((event) => event.type === "main_agent.turn_completed");
  assert.ok(started && toolStarted && toolCompleted && completed);

  const startedPayload = started.payload as Record<string, unknown>;
  assert.equal(startedPayload.turnId, turn.turnId);
  assert.equal(startedPayload.source, "cli");
  assert.equal(startedPayload.modelId, "test-model");
  assert.match(String(startedPayload.input), /redacted/);
  assert.equal(String(startedPayload.input).includes("owner@example.com"), false);
  assert.equal(String(startedPayload.input).includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);

  const toolPayload = toolStarted.payload as Record<string, unknown>;
  assert.equal(toolPayload.turnId, turn.turnId);
  assert.equal(toolPayload.tool, "propose_work_plan");
  assert.equal(String(toolPayload.inputSummary).includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);

  const completedPayload = completed.payload as Record<string, unknown>;
  assert.equal(completedPayload.status, "completed");
  assert.match(String(completedPayload.reply), /redacted/);
  assert.deepEqual(completedPayload.spawnedRunIds, ["run-1"]);
  assert.equal((completedPayload.toolCalls as unknown[]).length, 1);
  assert.equal((completedPayload.usage as Record<string, unknown>).totalTokens, 5);

  const turns = projectTurnAudits(events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.status, "completed");
  assert.equal(turns[0]!.source, "cli");
  assert.equal(turns[0]!.toolCalls[0]!.name, "propose_work_plan");
  assert.equal(turns[0]!.toolCalls[0]!.isError, false);
  assert.equal(typeof turns[0]!.toolCalls[0]!.durationMs, "number");
  assert.deepEqual(turns[0]!.spawnedRunIds, ["run-1"]);

  const ledger = await readMainAgentTurnRecords(directory);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.status, "completed");
  assert.equal(ledger[0]!.id, turn.turnId);
  assert.match(ledger[0]!.reply ?? "", /Done/);
});

test("a failed turn is visible with its error and no invented reply", async (t) => {
  const directory = await tempDir(t);
  const turn = await beginMainAgentTurn({ dataDirectory: directory, text: "do the thing", source: "main-cli" });
  await finishMainAgentTurn(turn, { status: "failed", error: "model unavailable" });

  const turns = projectTurnAudits(await journalEvents(directory));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.status, "failed");
  assert.equal(turns[0]!.error, "model unavailable");
  assert.equal(turns[0]!.reply, void 0);
  assert.equal((await readMainAgentTurnRecords(directory))[0]!.status, "failed");
});

test("an interrupted turn closes the journal record once", async (t) => {
  const directory = await tempDir(t);
  const first = await recordMainAgentTurnInterrupted(directory, {
    turnId: "turn-x",
    text: "do the thing",
    error: "client gave up",
  });
  assert.equal(first.status, "interrupted");
  const second = await recordMainAgentTurnInterrupted(directory, {
    turnId: "turn-x",
    text: "do the thing",
    error: "client gave up again",
  });
  assert.equal(second.error, "client gave up");

  const events = await journalEvents(directory);
  assert.equal(events.filter((event) => event.type === "main_agent.turn_completed").length, 1);
  assert.equal((await readMainAgentTurnRecords(directory)).length, 1);
  const turns = projectTurnAudits(events);
  assert.equal(turns[0]!.status, "interrupted");
});

test("loading turns is newest first and bounded", async (t) => {
  const directory = await tempDir(t);
  for (let index = 0; index < 3; index += 1) {
    const turn = await beginMainAgentTurn({ dataDirectory: directory, text: `turn ${index}`, source: "companion" });
    await finishMainAgentTurn(turn, { status: "completed", reply: `reply ${index}` });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const journal = createJournalStore(directory);
  try {
    const turns = await loadTurnAudits(journal, { limit: 2 });
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.input, "turn 2");
    assert.equal(turns[1]!.input, "turn 1");
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});
