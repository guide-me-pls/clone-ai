/**
 * Regression: token-aware compaction must be reachable from a production turn.
 *
 * Trace audit-ctx-1: every product surface calls runNativeMainAgentTurn without
 * `contextWindow`, so the token thresholds never run and a long transcript is
 * silently truncated by the character budget with no compaction recorded.
 *
 * The turn below is invoked exactly the way the product invokes it (no
 * `contextWindow`), with a transcript that is well past the compact level of the
 * runtime's own default window. A token-aware turn journals
 * `main_agent.context_compacted`; the dead path journals nothing.
 
 *
 * 回归：按 token 的压缩必须能从生产回合到达。调用方不传窗口时，压缩也必须运行并留下记录。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJournalStore } from "../../src/core/sqlite-journal.ts";
import { runNativeMainAgentTurn } from "../../src/main-agent/native-runtime.ts";
import { appendMainAgentTurnRecord } from "../../src/main-agent/turn-audit.ts";

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("a production Main Agent turn records context compaction without an explicit contextWindow", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-audit-ctx-1-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const bodies: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as { messages: Array<{ role: string; content?: unknown }> });
    return sseResponse([
      { choices: [{ delta: { content: "Noted." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      // The provider reports what it charged; the calibrator learns from it.
      // Provider 报告它收取的用量；标定器据此学习。
      { choices: [], usage: { prompt_tokens: 91_000, completion_tokens: 2, total_tokens: 91_002 } },
    ]);
  }) as unknown as typeof fetch;

  // A long *history* with a normal current turn: 12 prior turns of 15k
  // characters is ~90k estimated tokens, past the default 128k window's compact
  // level (86,400) and below its blocked level (105,000). A current turn that
  // is itself over the window cannot be compacted — the tail is the message —
  // so the case must exercise history, which is what compaction can drop.
  // 长「历史」加正常的当前问题：约 360k 字符的历史约 90k token，越过默认 128k 窗口的压缩线
  // （86,400）而不到阻断线（105,000）。当前一轮本身超过窗口时无法压缩——尾部就是这条消息——
  // 因此用例必须针对历史，那才是压缩能丢弃的部分。
  // 12 turns x 2 messages x 12k characters = 288k characters, which the
  // conservative bootstrap ratio (3.15 chars/token) reads as ~91k tokens:
  // past the 128k window's compact level (86,400) and below its blocked level.
  // 12 轮 x 2 条 x 12k 字符 = 288k 字符，保守的引导比例（3.15 字符/token）读作约 91k token：
  // 越过 128k 窗口的压缩线（86,400），低于阻断线。
  const filler = "x".repeat(12_000);
  for (let index = 0; index < 12; index += 1) {
    await appendMainAgentTurnRecord(directory, {
      id: `prior-${index}`,
      text: `question ${index} ${filler}`,
      status: "completed",
      startedAt: new Date(Date.now() - (12 - index) * 60_000).toISOString(),
      completedAt: new Date(Date.now() - (12 - index) * 60_000 + 1_000).toISOString(),
      reply: `answer ${index} ${filler}`,
    });
  }
  const longText = "Summarize this log.";

  const result = await runNativeMainAgentTurn({
    dataDirectory: directory,
    text: longText,
    source: "companion",
    endpoint: { baseUrl: "http://gateway", model: "test-model" },
    fetchImpl,
  });

  assert.equal(result.reply, "Noted.");
  assert.equal(bodies.length, 1, "the turn must still reach the model");

  const journal = createJournalStore(directory);
  try {
    const events = await journal.list();
    const compacted = events.filter((event) => event.type === "main_agent.context_compacted");
    assert.equal(
      compacted.length > 0,
      true,
      `a turn past the compact level must journal main_agent.context_compacted, saw: ${events.map((event) => event.type).join(", ")}`,
    );
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});
