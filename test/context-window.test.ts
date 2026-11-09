import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "../src/agent/loop.ts";
import {
  COMPACTION_PREAMBLE,
  compactTranscript,
  compressForSummary,
  contextLevels,
  contextPressure,
  estimateChars,
} from "../src/main-agent/context-window.ts";

const levels = contextLevels({ contextWindow: 200_000, maxOutputTokens: 20_000 });

test("context levels derive from the window, output reserve, and fraction", () => {
  // effective = 200k - 20k = 180k; compact = min(180k * 0.8, 180k - 13k) = 144k.
  // 有效窗口 = 200k - 20k = 180k；压缩线 = min(180k * 0.8, 180k - 13k) = 144k。
  assert.equal(levels.effectiveWindow, 180_000);
  assert.equal(levels.compactAt, 144_000);
  assert.equal(levels.warnAt, 124_000);
  assert.equal(levels.blockedAt, 177_000);
});

test("a small window still gets positive levels", () => {
  const small = contextLevels({ contextWindow: 8_000, maxOutputTokens: 20_000 });
  assert.equal(small.effectiveWindow, 1);
  assert.ok(small.compactAt >= 1 && small.warnAt >= 1 && small.blockedAt >= 1);
});

test("pressure classifies against the three levels", () => {
  assert.equal(contextPressure(1_000, levels), "normal");
  assert.equal(contextPressure(124_000, levels), "warn");
  assert.equal(contextPressure(144_000, levels), "compact");
  assert.equal(contextPressure(177_000, levels), "blocked");
});

test("compaction keeps the system prompt and the newest messages verbatim", () => {
  const messages: AgentMessage[] = [{ role: "system", content: "system" }];
  for (let index = 0; index < 20; index += 1) {
    messages.push({ role: "user", content: `question ${index} ${"x".repeat(400)}` });
    messages.push({ role: "assistant", content: `answer ${index} ${"y".repeat(400)}` });
  }
  const outcome = compactTranscript(messages, { estimatedTokens: 4_000 });
  assert.equal(outcome.messages[0]!.role, "system");
  assert.equal(outcome.messages[0]!.content, "system");
  assert.ok(outcome.messages.some((message) => typeof message.content === "string" && message.content.includes("compacted deterministically")));
  const last = outcome.messages[outcome.messages.length - 1]!;
  assert.match(String(last.content), /answer 19/);
  assert.ok(outcome.droppedMessages > 0);
  assert.equal(outcome.keptMessages, outcome.messages.length - 2);
});

test("compaction preserves the current turn when told to, even without a system prompt", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: `old ${"x".repeat(2_000)}` },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "current question" },
  ];
  const outcome = compactTranscript(messages, {
    estimatedTokens: 100,
    keepTailTokens: 1,
    preserveLast: 1,
  });
  assert.equal(outcome.messages.at(-1)?.content, "current question");
  assert.match(String(outcome.messages[0]?.content), /compacted deterministically/);
});

test("summaries are bounded and redact nothing incorrectly", () => {
  const messages: AgentMessage[] = [{ role: "system", content: "s" }];
  for (let index = 0; index < 50; index += 1) {
    messages.push({ role: "user", content: `line ${index} ${"z".repeat(1_000)}` });
  }
  const outcome = compactTranscript(messages, { estimatedTokens: 200, summaryChars: 500, excerptChars: 100 });
  assert.ok(outcome.summary.length <= 500 + COMPACTION_PREAMBLE.length + 2);
  assert.ok(outcome.summary.split("\n").length <= 52);
});

test("the summary collapses whitespace and caps each excerpt", () => {
  const message: AgentMessage = { role: "user", content: `a\n\n  b   ${"c".repeat(200)}` };
  const text = compressForSummary(message, 50);
  assert.ok(text.length <= 50);
  assert.equal(text.includes("\n"), false);
});

test("the char estimate covers text, images, and tool arguments", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    { role: "assistant", content: null, toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a"}' }] },
  ];
  assert.ok(estimateChars(messages) >= 5 + 26 + 9 + 12);
});
