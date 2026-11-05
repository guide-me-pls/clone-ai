#!/usr/bin/env node
/**
 * Long-conversation validation for the native Main Agent.
 *
 * Seeds a long transcript with one needle in the oldest turn, forces
 * deterministic compaction with a small history budget, and runs one real turn.
 * It checks that the compacted summary reached the endpoint, that the newest
 * turns stayed verbatim, and whether the model can still answer from the
 * summary. The captured request body is recorded so "the summary was sent" is
 * evidence, not a guess.
 *
 * 原生主 Agent 的长对话验证。
 *
 * 在最早一轮埋一个针，写入一段长对话记录，用很小的历史预算强制确定性压缩，再跑一轮真实
 * 对话。它检查压缩摘要是否到达端点、最新轮次是否保持原文，以及模型是否仍能依据摘要回答。
 * 捕获的请求体会被记录，因此"摘要确实发送了"是证据，不是猜测。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";
import { runNativeMainAgentTurn } from "../src/main-agent/native-runtime.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";

const resultsDirectory = join(fileURLToPath(new URL(".", import.meta.url)), "results");
const MODEL = process.env.CLONE_AI_BENCH_MAIN_MODEL ?? "360/anthropic/claude-sonnet-5-5";
const BASE_URL = (process.env.CLONE_AI_NATIVE_BASE_URL ?? "http://127.0.0.1:3425").replace(/\/$/, "");
const HISTORY_CHARS = Number(process.env.CLONE_AI_BENCH_HISTORY_CHARS ?? 4_000);
const SEEDED_TURNS = 24;

interface CapturedBody {
  messages: Array<{ role: string; content?: string }>;
}

const directory = await mkdtemp(join(tmpdir(), "clone-ai-native-long-"));
try {
  await prepareCloneHome(resolveClonePaths({ dataDirectory: directory }));
  const now = Date.now();
  for (let index = 0; index < SEEDED_TURNS; index += 1) {
    const opening = index === 0
      ? "项目代号是 BLUE-FALCON。这是一条必须记住的约定。"
      : `讨论的第 ${index} 个细节。`;
    await appendMainAgentTurnRecord(directory, {
      id: `seed-${index}`,
      text: `${opening} ${"背景信息。".repeat(80)}`,
      status: "completed",
      startedAt: new Date(now - (SEEDED_TURNS - index) * 60_000).toISOString(),
      completedAt: new Date(now - (SEEDED_TURNS - index) * 60_000 + 1_000).toISOString(),
      reply: `已记录第 ${index} 项。${"说明。".repeat(80)}`,
    });
  }

  let captured: CapturedBody | undefined;
  const realFetch = fetch;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}")) as CapturedBody;
    return realFetch(url, init);
  }) as typeof fetch;

  const result = await runNativeMainAgentTurn({
    dataDirectory: directory,
    text: "我们之前约定的项目代号是什么？请只回答代号。",
    source: "cli",
    endpoint: { baseUrl: BASE_URL, model: MODEL },
    fetchImpl,
    historyChars: HISTORY_CHARS,
    historyTurns: 30,
  });

  const messages = captured?.messages ?? [];
  const summary = messages.find((message) => message.role === "system" && String(message.content).includes("compacted deterministically"));
  const userMessages = messages.filter((message) => message.role === "user");
  const checks = {
    summaryPresent: summary !== undefined,
    summaryHasNeedle: summary !== undefined && String(summary.content).includes("BLUE-FALCON"),
    newestTurnVerbatim: userMessages.some((message) => String(message.content).startsWith(`讨论的第 ${SEEDED_TURNS - 1} 个细节`)),
    replyHasNeedle: result.reply.includes("BLUE-FALCON"),
    noError: result.error === undefined,
  };

  const journal = createJournalStore(directory);
  let totalTokens = 0;
  let modelCalls = 0;
  try {
    const events = await journal.list();
    for (const event of events) {
      if (event.type !== "usage.recorded") continue;
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.totalTokens === "number") totalTokens += payload.totalTokens;
      if (typeof payload.modelCalls === "number") modelCalls += payload.modelCalls;
    }
  } finally {
    (journal as { close?: () => void }).close?.();
  }

  console.log(`Native long-context validation: model=${MODEL} endpoint=${BASE_URL} historyChars=${HISTORY_CHARS} seededTurns=${SEEDED_TURNS}`);
  console.log(`  messages=${messages.length} userMessages=${userMessages.length} summaryChars=${summary === undefined ? 0 : String(summary.content).length}`);
  console.log(`  reply=${JSON.stringify(result.reply.slice(0, 300))}`);
  console.log(`  checks=${JSON.stringify(checks)} tokens=${totalTokens} modelCalls=${modelCalls}`);

  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const reportPath = join(resultsDirectory, `native-main-long-context-${stamp}.json`);
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    ranAt: new Date().toISOString(),
    model: MODEL,
    endpoint: BASE_URL,
    historyChars: HISTORY_CHARS,
    seededTurns: SEEDED_TURNS,
    messages: messages.length,
    userMessages: userMessages.length,
    messageRoles: messages.map((message) => message.role),
    summaryPreview: summary === undefined ? null : String(summary.content).slice(0, 800),
    reply: result.reply,
    totalTokens,
    modelCalls,
    checks,
    reportPath,
  }, null, 2)}\n`, "utf8");
  console.log(`Report: ${reportPath}`);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
} finally {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
