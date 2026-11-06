#!/usr/bin/env node
/**
 * Main Agent comparison: the Pi runtime versus the native loop on the same
 * prompts, model and isolated clone home.
 *
 * Each task/runtime cell runs N times (default 5) in a fresh temporary clone
 * home, and the report gives the median and p90 duration, median tokens and the
 * pass rate. Every individual run is kept alongside the aggregates. `--repeat 1`
 * restores a single-sample run.
 *
 * 主 Agent 对比：Pi 运行时与原生循环，在相同 Prompt、模型与隔离 clone home 上运行。
 *
 * 每个任务/运行时组合跑 N 次（默认 5），每次使用全新的临时 clone home；报告给出中位数
 * 与 p90 耗时、中位 tokens 与通过率，并把每一次运行与聚合结果一起保留。`--repeat 1`
 * 恢复单次运行。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMainAgentQuery } from "../src/application/run-main-query.ts";
import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { median, percentile } from "./stats.ts";

const resultsDirectory = join(fileURLToPath(new URL(".", import.meta.url)), "results");
const MODEL = process.env.CLONE_AI_BENCH_MAIN_MODEL ?? "360/google/gemini-4-argon";
const BASE_URL = (process.env.CLONE_AI_NATIVE_BASE_URL ?? "http://127.0.0.1:3425").replace(/\/$/, "");

function repeatCount(): number {
  const index = process.argv.indexOf("--repeat");
  const raw = index >= 0 ? Number(process.argv[index + 1]) : 5;
  return Number.isFinite(raw) ? Math.min(20, Math.max(1, Math.trunc(raw))) : 5;
}

const REPEAT = repeatCount();

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
    let result: Awaited<ReturnType<typeof runMainAgentQuery>>;
    try {
      result = await runMainAgentQuery(directory, task.prompt, {
        source: "companion",
        auditHome: join(directory, ".audit"),
      });
    } catch (error: unknown) {
      // One bad cell must not abort the whole report: a model absent from a
      // runtime's catalog is a data point, not a reason to lose the other runs.
      // 一个坏格不能中断整份报告：模型不在某个运行时的目录里是一个数据点，
      // 不是丢掉其他运行的理由。
      return {
        runtime,
        taskId: task.id,
        expectation: task.expectation,
        passed: false,
        durationMs: Date.now() - started,
        totalTokens: 0,
        modelCalls: 0,
        toolCalls: [],
        runs: 0,
        replyLength: 0,
        error: error instanceof Error ? error.message : String(error),
        journalEvents: 0,
      };
    }
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

interface CellAggregate {
  runtime: Runtime;
  taskId: string;
  expectation: Expectation;
  samples: number;
  passed: number;
  passRate: number;
  medianDurationMs: number | null;
  p90DurationMs: number | null;
  medianTokens: number | null;
  medianModelCalls: number | null;
}

function aggregateCell(results: readonly TaskResult[]): CellAggregate {
  const passed = results.filter((result) => result.passed).length;
  return {
    runtime: results[0]!.runtime,
    taskId: results[0]!.taskId,
    expectation: results[0]!.expectation,
    samples: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    medianDurationMs: median(results.map((result) => result.durationMs)),
    p90DurationMs: percentile(results.map((result) => result.durationMs), 90),
    medianTokens: median(results.map((result) => result.totalTokens)),
    medianModelCalls: median(results.map((result) => result.modelCalls)),
  };
}

const records: TaskResult[] = [];
const cells: CellAggregate[] = [];
console.log(`Main Agent comparison: model=${MODEL} endpoint=${BASE_URL} repeat=${REPEAT}`);
for (const task of TASKS) {
  for (const runtime of ["pi", "native"] as const) {
    const samples: TaskResult[] = [];
    for (let index = 0; index < REPEAT; index += 1) {
      const record = await runOne(runtime, task);
      samples.push(record);
      records.push(record);
      console.log(
        `  ${task.id.padEnd(18)} ${runtime.padEnd(7)} ${String(index + 1).padStart(2)}/${REPEAT} ${record.passed ? "PASS" : "FAIL"} `
        + `${(record.durationMs / 1000).toFixed(1).padStart(6)}s `
        + `${String(record.totalTokens).padStart(6)} tok `
        + `tools=${record.toolCalls.length} runs=${record.runs}`
        + (record.error === undefined ? "" : `  error: ${record.error.slice(0, 120)}`),
      );
    }
    const cell = aggregateCell(samples);
    cells.push(cell);
    console.log(
      `  ${"".padEnd(18)} ${runtime.padEnd(7)} median ${((cell.medianDurationMs ?? 0) / 1000).toFixed(1)}s `
      + `p90 ${((cell.p90DurationMs ?? 0) / 1000).toFixed(1)}s `
      + `${cell.medianTokens ?? 0} tok  pass ${cell.passed}/${cell.samples}`,
    );
  }
}

console.log("\nCell summary:");
console.log("task              runtime  pass   median    p90   median tokens");
for (const cell of cells) {
  console.log(
    `${cell.taskId.padEnd(18)}${cell.runtime.padEnd(9)}${`${cell.passed}/${cell.samples}`.padEnd(7)}`
    + `${`${((cell.medianDurationMs ?? 0) / 1000).toFixed(1)}s`.padStart(8)} `
    + `${`${((cell.p90DurationMs ?? 0) / 1000).toFixed(1)}s`.padStart(7)} `
    + `${String(cell.medianTokens ?? 0).padStart(8)}`,
  );
}

const summary = {
  repeat: REPEAT,
  pi: {
    passed: records.filter((record) => record.runtime === "pi" && record.passed).length,
    samples: records.filter((record) => record.runtime === "pi").length,
  },
  native: {
    passed: records.filter((record) => record.runtime === "native" && record.passed).length,
    samples: records.filter((record) => record.runtime === "native").length,
  },
};
console.log(`\nSummary: pi ${summary.pi.passed}/${summary.pi.samples} · native ${summary.native.passed}/${summary.native.samples}`);

const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const reportPath = join(resultsDirectory, `main-agent-${stamp}.json`);
await mkdir(resultsDirectory, { recursive: true });
await writeFile(reportPath, `${JSON.stringify({
  ranAt: new Date().toISOString(),
  model: MODEL,
  endpoint: BASE_URL,
  repeat: REPEAT,
  tasks: TASKS,
  records,
  cells,
  summary,
}, null, 2)}\n`, "utf8");
console.log(`Report: ${reportPath}`);
process.exit(0);
