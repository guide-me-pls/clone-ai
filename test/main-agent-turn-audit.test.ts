import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import {
  appendMainAgentTurnRecord,
  beginMainAgentTurn,
  finishMainAgentTurn,
  observeMainAgentSession,
  readMainAgentTurnRecords,
  recordContextCompaction,
  recordMainAgentTurnInterrupted,
  recordNativeToolCompleted,
  recordNativeToolStarted,
} from "../src/main-agent/turn-audit.ts";
import { recordPromptSnapshot } from "../src/main-agent/prompt-snapshot.ts";
import { loadTurnAudits, projectTurnAudits, searchTurnAudits } from "../src/audit/turn-audit.ts";

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
  // Only a started turn can be interrupted. 只有开始过的回合才能被中断。
  await beginMainAgentTurn({ dataDirectory: directory, text: "do the thing", source: "cli", turnId: "turn-x" });
  const first = await recordMainAgentTurnInterrupted(directory, {
    turnId: "turn-x",
    text: "do the thing",
    error: "client gave up",
  });
  assert.equal(first?.status, "interrupted");
  const second = await recordMainAgentTurnInterrupted(directory, {
    turnId: "turn-x",
    text: "do the thing",
    error: "client gave up again",
  });
  assert.equal(second?.error, "client gave up");

  const events = await journalEvents(directory);
  assert.equal(events.filter((event) => event.type === "main_agent.turn_completed").length, 1);
  assert.equal((await readMainAgentTurnRecords(directory)).length, 1);
  const turns = projectTurnAudits(events);
  assert.equal(turns[0]!.status, "interrupted");
});

test("an interruption for a turn that never started records nothing", async (t) => {
  const directory = await tempDir(t);
  const record = await recordMainAgentTurnInterrupted(directory, {
    turnId: "never-started",
    text: "do the thing",
    error: "client gave up",
  });
  assert.equal(record, undefined);
  assert.equal((await readMainAgentTurnRecords(directory)).length, 0);
});

test("a late interruption row cannot hide a completed reply", async (t) => {
  const directory = await tempDir(t);
  const at = new Date().toISOString();
  await appendMainAgentTurnRecord(directory, {
    id: "turn-race",
    text: "question",
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply: "the answer",
  });
  await appendMainAgentTurnRecord(directory, {
    id: "turn-race",
    text: "question",
    status: "interrupted",
    startedAt: at,
    completedAt: at,
    error: "late report",
  });
  const record = (await readMainAgentTurnRecords(directory))[0]!;
  assert.equal(record.status, "completed");
  assert.equal(record.reply, "the answer");
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

    const searched = await searchTurnAudits(journal, { limit: 2, query: "turn 1" });
    assert.equal(searched.total, 1, "the total counts matches across every turn");
    assert.equal(searched.turns[0]!.input, "turn 1");
    assert.equal((await searchTurnAudits(journal, { query: "reply 2" })).total, 1, "the reply is searchable");
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});

test("the same turn id in two conversations stays two records", async (t) => {
  const directory = await tempDir(t);
  const at = new Date().toISOString();
  await appendMainAgentTurnRecord(directory, {
    id: "shared-turn",
    text: "first task",
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply: "first reply",
    conversationId: "conversation-a",
  });
  await appendMainAgentTurnRecord(directory, {
    id: "shared-turn",
    text: "second task",
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply: "second reply",
    conversationId: "conversation-b",
  });
  const records = await readMainAgentTurnRecords(directory);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.conversationId).sort(), ["conversation-a", "conversation-b"]);
});

test("the projection keys a turn by conversation, so two tasks never share dispatch", async (t) => {
  // Turn ids are caller-chosen and the ledger keeps a reused id in two
  // conversations as two rows. Keying the projection by turn id alone would
  // show one task's model, tools and snapshot under the other task's question.
  // 回合 id 由调用方选择，台账把两个对话中复用的 id 保留为两行。只按回合 id 投影，会在
  // 一个任务的问题下显示另一个任务的模型、工具与快照。
  const directory = await tempDir(t);
  const first = await beginMainAgentTurn({
    dataDirectory: directory, text: "first task", source: "companion", turnId: "shared", conversationId: "conversation-a", modelId: "model-a",
  });
  await recordNativeToolStarted(first, { toolCallId: "call-a", tool: "dispatch_task", inputSummary: "A" });
  await recordNativeToolCompleted(first, { toolCallId: "call-a", tool: "dispatch_task", isError: false, durationMs: 10 });
  await finishMainAgentTurn(first, { status: "completed", reply: "first reply" });
  const second = await beginMainAgentTurn({
    dataDirectory: directory, text: "second task", source: "companion", turnId: "shared", conversationId: "conversation-b", modelId: "model-b",
  });
  await recordNativeToolStarted(second, { toolCallId: "call-b", tool: "read_file", inputSummary: "B" });
  await recordNativeToolCompleted(second, { toolCallId: "call-b", tool: "read_file", isError: false, durationMs: 20 });
  await finishMainAgentTurn(second, { status: "completed", reply: "second reply" });

  const turns = projectTurnAudits(await journalEvents(directory));
  assert.equal(turns.length, 2);
  const byConversation = new Map(turns.map((turn) => [turn.conversationId, turn]));
  assert.equal(byConversation.get("conversation-a")!.input, "first task");
  assert.equal(byConversation.get("conversation-a")!.modelId, "model-a");
  assert.deepEqual(byConversation.get("conversation-a")!.toolCalls.map((call) => call.name), ["dispatch_task"]);
  assert.equal(byConversation.get("conversation-b")!.input, "second task");
  assert.equal(byConversation.get("conversation-b")!.modelId, "model-b");
  assert.deepEqual(byConversation.get("conversation-b")!.toolCalls.map((call) => call.name), ["read_file"]);
});

test("a reused turn id cannot erase a completed record", async (t) => {
  const directory = await tempDir(t);
  const first = await beginMainAgentTurn({
    dataDirectory: directory, text: "question", source: "companion", turnId: "retry", conversationId: "conversation-a",
  });
  await finishMainAgentTurn(first, { status: "completed", reply: "the answer" });
  // A retry that reuses the id starts a second attempt; the completed record
  // stays the record of the turn.
  // 复用该 id 的重试开始第二次尝试；已完成记录仍是该回合的记录。
  await beginMainAgentTurn({
    dataDirectory: directory, text: "question", source: "companion", turnId: "retry", conversationId: "conversation-a",
  });
  const turns = projectTurnAudits(await journalEvents(directory));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.status, "completed");
  assert.equal(turns[0]!.reply, "the answer");
});

test("a running turn already shows the tools it called", async (t) => {
  const directory = await tempDir(t);
  const turn = await beginMainAgentTurn({
    dataDirectory: directory, text: "派发一个任务", source: "companion", turnId: "running", conversationId: "conversation-a",
  });
  await recordNativeToolStarted(turn, { toolCallId: "call-1", tool: "dispatch_task", inputSummary: '{"objective":"整理"}' });
  const turns = projectTurnAudits(await journalEvents(directory));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.status, "started");
  assert.equal(turns[0]!.toolCalls.length, 1);
  assert.equal(turns[0]!.toolCalls[0]!.name, "dispatch_task");
  assert.match(turns[0]!.toolCalls[0]!.inputSummary ?? "", /整理/);
  // The event names its conversation, so the projection can attach it even when
  // another conversation reuses the turn id.
  // 事件点名自己的对话，因此即使另一个对话复用了该回合 id，投影也能正确挂接。
  const started = (await journalEvents(directory)).find((event) => event.type === "agent.tool_started");
  assert.equal((started!.payload as Record<string, unknown>).conversationId, "conversation-a");
});

test("a turn exposes how its context was assembled and which runs it spawned", async (t) => {
  // The conversation log shows the prompt materials, compactions and spawned
  // runs next to the reply; the projection is where those separate events join
  // their turn. Without it the desktop log can only show the reply.
  // 对话日志在回复旁显示提示词材料、压缩与派生的 Run；这些独立事件在投影处挂到所属回合。
  // 没有投影，桌面日志只能显示回复。
  const directory = await tempDir(t);
  const turn = await beginMainAgentTurn({
    dataDirectory: directory,
    text: "整理架构文档",
    source: "companion",
    conversationId: "conversation-a",
    modelId: "test-model",
    provider: "native",
    effort: "high",
  });
  await recordContextCompaction(turn, {
    estimatedTokens: 90_000,
    compactAt: 80_000,
    droppedMessages: 12,
    keptMessages: 3,
    summary: "前面的对话压成一段摘要。",
  });
  await recordPromptSnapshot(directory, {
    charter: "charter",
    charterVersion: 2,
    briefing: "简报",
    systemPrompt: "system",
    tools: [{ name: "dispatch_task" }, { name: "read_file" }],
    modelId: "test-model",
    provider: "native",
    effort: "high",
  }, { turnId: turn.turnId });
  await finishMainAgentTurn(turn, { status: "completed", reply: "已整理。", spawnedRunIds: ["run-1"] });

  const turns = projectTurnAudits(await journalEvents(directory));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.conversationId, "conversation-a");
  assert.equal(turns[0]!.compactions.length, 1);
  assert.equal(turns[0]!.compactions[0]!.droppedMessages, 12);
  assert.equal(turns[0]!.compactions[0]!.keptMessages, 3);
  assert.equal(turns[0]!.compactions[0]!.summary, "前面的对话压成一段摘要。");
  // The journal event carries no `at`; the compaction is stamped with the
  // event's own occurrence time, not whenever the log was read.
  // Journal 事件不带 `at`；压缩时间取事件发生时间，而不是读取日志的时间。
  assert.ok(Number.isFinite(Date.parse(turns[0]!.compactions[0]!.at)));
  assert.equal(turns[0]!.snapshot?.charterVersion, 2);
  assert.equal(turns[0]!.snapshot?.materialHash?.length, 64);
  assert.deepEqual(turns[0]!.snapshot?.toolNames, ["dispatch_task", "read_file"]);
  assert.deepEqual(turns[0]!.spawnedRunIds, ["run-1"]);
  // The conversation id is searchable, so the audit view can scope by task.
  // 对话 id 可搜索，审计视图因此能按任务限定范围。
  const journal = createJournalStore(directory);
  try {
    const scoped = await searchTurnAudits(journal, { query: "conversation-a" });
    assert.equal(scoped.total, 1);
    // The prompt snapshot is part of the turn's visible fields: its material
    // hash and tool table are what a "did the prompt change?" search needs.
    // 提示词快照是回合的可见字段：材料哈希与工具表正是"提示词变了吗"搜索所需要的。
    const material = await searchTurnAudits(journal, { query: turns[0]!.snapshot!.materialHash.slice(0, 12) });
    assert.equal(material.total, 1);
    assert.equal((await searchTurnAudits(journal, { query: "read_file" })).total, 1);
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});

test("the audit shows the runs a turn dispatched and the history it was given", async (t) => {
  const directory = await tempDir(t);
  const turn = await beginMainAgentTurn({
    dataDirectory: directory,
    text: "做两件事",
    source: "cli",
    turnId: "turn-runs",
    historyMessages: 4,
    historyTurns: 2,
  });
  await finishMainAgentTurn(turn, { status: "completed", reply: "已派发", spawnedRunIds: ["run-1"] });
  const journal = createJournalStore(directory);
  try {
    await journal.append({ type: "task.created", taskId: "task-1", payload: { id: "task-1", title: "发布周报" } });
    await journal.append({ type: "run.created", taskId: "task-1", runId: "run-1", payload: { id: "run-1", status: "planning" } });
    await journal.append({ type: "plan.created", taskId: "task-1", runId: "run-1", payload: { summary: "发布", steps: [{ id: "send", title: "发送" }, { id: "check", title: "核对" }] } });
    await journal.append({ type: "run.status_changed", taskId: "task-1", runId: "run-1", payload: { status: "waiting_approval" } });
  } finally {
    (journal as { close?: () => void }).close?.();
  }
  const projected = projectTurnAudits(await journalEvents(directory)).find((turnAudit) => turnAudit.turnId === "turn-runs");
  assert.ok(projected);
  assert.equal(projected.historyMessages, 4);
  assert.equal(projected.historyTurns, 2);
  assert.deepEqual(projected.runs, [{ id: "run-1", title: "发布周报", status: "waiting_approval", steps: ["发送", "核对"] }]);
});

test("the audit keeps the prompt materials and the briefing flag", async (t) => {
  const directory = await tempDir(t);
  const turn = await beginMainAgentTurn({
    dataDirectory: directory,
    text: "检查",
    source: "cli",
    turnId: "turn-snapshot",
  });
  await recordPromptSnapshot(directory, {
    charter: "charter",
    charterVersion: 2,
    briefing: "今天有一项承诺到期",
    instructions: "follow the rules",
    instructionSources: [{ path: "AGENTS.md", bytes: 10, imports: [] }],
    instructionWarnings: ["README.md was ignored"],
    systemPrompt: "system",
    tools: [{ name: "get_authority", label: "Authority", description: "read", parameters: {} }],
    modelId: "m",
    provider: "native",
  }, { turnId: "turn-snapshot" });
  await finishMainAgentTurn(turn, { status: "completed", reply: "ok" });
  const projected = projectTurnAudits(await journalEvents(directory)).find((turnAudit) => turnAudit.turnId === "turn-snapshot");
  assert.ok(projected?.snapshot);
  assert.deepEqual(projected.snapshot.instructionSources, ["AGENTS.md"]);
  assert.deepEqual(projected.snapshot.instructionWarnings, ["README.md was ignored"]);
  assert.equal(projected.snapshot.hasBriefing, true);
  assert.deepEqual(projected.snapshot.toolNames, ["get_authority"]);
});
