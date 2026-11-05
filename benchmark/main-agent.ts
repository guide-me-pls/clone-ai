#!/usr/bin/env node
/**
 * Main Agent comparison: the Pi runtime versus the native loop on the same
 * prompts, model and isolated clone home.
 *
 * Each task runs once per runtime in a fresh temporary clone home. The report
 * records duration, exact or session-derived tokens, tool calls, created runs
 * and whether the task's expectation held. This is a comparison, not a
 * statistical benchmark: one run per cell, and the model itself can vary.
 *
 * 主 Agent 对比：Pi 运行时与原生循环，在相同 Prompt、模型与隔离 clone home 上运行。
 *
 * 每个任务在每个运行时各跑一次，使用全新的临时 clone home。报告记录耗时、精确或会话
 * 推算的 tokens、工具调用、产生的 Run，以及任务预期是否成立。这是一次对比，不是统计
 * 基准：每格只跑一次，模型本身也会波动。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMainAgentQuery } from "../src/application/run-main-query.ts";
import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";

const resultsDirectory = join(fileURLToPath(new URL(".", import.meta.url)), "results");
const MODEL = process.env.CLONE_AI_BENCH_MAIN_MODEL ?? "360/google/gemini-4-argon";
const BASE_URL = (process.env.CLONE_AI_NATIVE_BASE_URL ?? "http://127.0.0.1:3425").replace(/\/$/, "");

type Runtime = "pi" | "native";
type Expectation = "direct" | "authority" | "plan";

interface MainAgentTask {
  id: string;
  prompt: string;
  expectation: Expectation;
}

const TASKS: MainAgentTask[] = [
  {
    id: "direct-answer",
    prompt: "请只回复两个字：收到。不要提案任何计划。",
    expectation: "direct",
  },
  {
    id: "authority-read",
    prompt: "我现在允许在哪些目录写入？请先查一下权限再回答。",
    expectation: "authority",
  },
  {
    id: "plan-proposal",
    prompt: "帮我把 README.md 总结成 out/summary.md。这是一个本地可逆任务，请提案一个计划，不要自己执行。",
    expectation: "plan",
  },
];

interface TaskResult {
  runtime: Runtime;
  taskId: string;
  expectation: Expectation;
  passed: boolean;
  durationMs: number;
  totalTokens: number;
  modelCalls: number;
  toolCalls: string[];
  runs: number;
  turnStatus?: string;
  replyLength: number;
  error?: string;
  journalEvents: number;
}

async function runOne(runtime: Runtime, task: MainAgentTask): Promise<TaskResult> {
  const directory = await mkdtemp(join(tmpdir(), `clone-ai-main-${runtime}-`));
  const saved = {
    runtime: process.env.CLONE_AI_MAIN_RUNTIME,
    model: process.env.CLONE_AI_NATIVE_MODEL,
    base: process.env.CLONE_AI_NATIVE_BASE_URL,
    mainModel: process.env.CLONE_AI_MAIN_MODEL,
  };
  try {
    await prepareCloneHome(resolveClonePaths({ dataDirectory: directory }));
    process.env.CLONE_AI_MAIN_MODEL = MODEL;
    if (runtime === "native") {
      process.env.CLONE_AI_MAIN_RUNTIME = "native";
      process.env.CLONE_AI_NATIVE_MODEL = MODEL;
      process.env.CLONE_AI_NATIVE_BASE_URL = BASE_URL;
    } else {
      process.env.CLONE_AI_MAIN_RUNTIME = "pi";
    }
    const started = Date.now();
    const result = await runMainAgentQuery(directory, task.prompt, {
      source: "companion",
      auditHome: join(directory, ".audit"),
    });
    const durationMs = Date.now() - started;
    const journal = createJournalStore(directory);
    let events: Awaited<ReturnType<typeof journal.list>> = [];
    try {
      events = await journal.list();
    } finally {
      (journal as { close?: () => void }).close?.();
    }
    const toolCalls = events
      .filter((event) => event.type === "agent.tool_started")
      .map((event) => String((event.payload as Record<string, unknown>).tool ?? ""));
    const usage = events.filter((event) => event.type === "usage.recorded");
    let totalTokens = 0;
    let modelCalls = 0;
    for (const event of usage) {
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.totalTokens === "number") totalTokens += payload.totalTokens;
      if (typeof payload.modelCalls === "number") modelCalls += payload.modelCalls;
    }
    const runs = events.filter((event) => event.type === "run.created").length;
    const turn = events.find((event) => event.type === "main_agent.turn_completed");
    const turnStatus = turn === undefined ? undefined : String((turn.payload as Record<string, unknown>).status ?? "");
    const passed = task.expectation === "direct"
      ? result.error === undefined && result.reply.trim().length > 0 && runs === 0
      : task.expectation === "authority"
        ? result.error === undefined && toolCalls.includes("get_authority")
        : runs > 0;
    return {
      runtime,
      taskId: task.id,
      expectation: task.expectation,
      passed,
      durationMs,
      totalTokens,
      modelCalls,
      toolCalls,
      runs,
      ...(turnStatus === undefined ? {} : { turnStatus }),
      replyLength: result.reply.length,
      ...(result.error === undefined ? {} : { error: result.error }),
      journalEvents: events.length,
    };
  } finally {
    if (saved.runtime === undefined) delete process.env.CLONE_AI_MAIN_RUNTIME;
    else process.env.CLONE_AI_MAIN_RUNTIME = saved.runtime;
    if (saved.model === undefined) delete process.env.CLONE_AI_NATIVE_MODEL;
    else process.env.CLONE_AI_NATIVE_MODEL = saved.model;
    if (saved.base === undefined) delete process.env.CLONE_AI_NATIVE_BASE_URL;
    else process.env.CLONE_AI_NATIVE_BASE_URL = saved.base;
    if (saved.mainModel === undefined) delete process.env.CLONE_AI_MAIN_MODEL;
    else process.env.CLONE_AI_MAIN_MODEL = saved.mainModel;
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

const records: TaskResult[] = [];
console.log(`Main Agent comparison: model=${MODEL} endpoint=${BASE_URL}`);
for (const task of TASKS) {
  for (const runtime of ["pi", "native"] as const) {
    const record = await runOne(runtime, task);
    records.push(record);
    console.log(
      `  ${task.id.padEnd(18)} ${runtime.padEnd(7)} ${record.passed ? "PASS" : "FAIL"} `
      + `${(record.durationMs / 1000).toFixed(1).padStart(6)}s `
      + `${String(record.totalTokens).padStart(6)} tok `
      + `tools=${record.toolCalls.length} runs=${record.runs}`
      + (record.error === undefined ? "" : `  error: ${record.error.slice(0, 160)}`),
    );
  }
}

const summary = {
  pi: { passed: records.filter((record) => record.runtime === "pi" && record.passed).length, total: TASKS.length },
  native: { passed: records.filter((record) => record.runtime === "native" && record.passed).length, total: TASKS.length },
};
console.log(`\nSummary: pi ${summary.pi.passed}/${summary.pi.total} · native ${summary.native.passed}/${summary.native.total}`);

const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const reportPath = join(resultsDirectory, `main-agent-${stamp}.json`);
await mkdir(resultsDirectory, { recursive: true });
await writeFile(reportPath, `${JSON.stringify({
  ranAt: new Date().toISOString(),
  model: MODEL,
  endpoint: BASE_URL,
  tasks: TASKS,
  records,
  summary,
}, null, 2)}\n`, "utf8");
console.log(`Report: ${reportPath}`);
process.exit(0);
