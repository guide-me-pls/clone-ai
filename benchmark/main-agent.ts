#!/usr/bin/env node
/**
 * Main Agent benchmark: the native loop on fixed prompts, model and an
 * isolated clone home.
 *
 * Each task cell runs N times (default 5) in a fresh temporary clone home, and
 * the report gives the median and p90 duration, median tokens and the pass
 * rate. Every individual run is kept alongside the aggregates. `--repeat 1`
 * restores a single-sample run. The runtime list is explicit: a new runtime is
 * added here only after it is registered and can start.
 *
 * 主 Agent 基准：原生循环在固定 Prompt、模型与隔离 clone home 上运行。
 *
 * 每个任务组合跑 N 次（默认 5），每次使用全新的临时 clone home；报告给出中位数与 p90
 * 耗时、中位 tokens 与通过率，并把每一次运行与聚合结果一起保留。`--repeat 1` 恢复单次
 * 运行。运行时列表是显式的：只有已注册且能启动的运行时才会被加进来。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMainAgentQuery } from "../src/application/run-main-query.ts";
import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";
import { requiredBenchmarkModel } from "./model-env.ts";
import { median, percentile } from "./stats.ts";

const resultsDirectory = join(fileURLToPath(new URL(".", import.meta.url)), "results");
const MODEL = requiredBenchmarkModel();
const BASE_URL = (process.env.CLONE_AI_NATIVE_BASE_URL ?? "http://127.0.0.1:3425").replace(/\/$/, "");

function repeatCount(): number {
  const index = process.argv.indexOf("--repeat");
  const raw = index >= 0 ? Number(process.argv[index + 1]) : 5;
  return Number.isFinite(raw) ? Math.min(20, Math.max(1, Math.trunc(raw))) : 5;
}

const REPEAT = repeatCount();

/**
 * Restrict the run to named task cells, e.g. `--only learned-folder-read`.
 * A behavior cell can then be measured before and after a prompt change
 * without paying for the whole table twice.
 * 只运行点名的任务格，例如 `--only learned-folder-read`。这样提示词改动前后的行为测量
 * 不必为整张表付两遍钱。
 */
function onlyFilter(): Set<string> | undefined {
  const index = process.argv.indexOf("--only");
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  if (raw === undefined) return undefined;
  const ids = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  return ids.length === 0 ? undefined : new Set(ids);
}

const ONLY = onlyFilter();

/**
 * A fixture outside the clone home: read_file refuses the clone home, so the
 * task must prove a read by absolute path, not a learned-folder search.
 * clone home 之外的测试文件：read_file 拒绝 clone home，因此任务必须证明按绝对路径
 * 读取，而不是搜索已知文件夹。
 */
const fixtureDirectory = await mkdtemp(join(tmpdir(), "clone-ai-main-fixture-"));
const fixturePath = join(fixtureDirectory, "named-file.md");
await writeFile(fixturePath, "BENCH_READ_MARKER_7Q2\n\nThis fixture exists so the read window and the quoted-data framing are exercised.\n", "utf8");
/**
 * The plan task names README.md, so it needs a workspace that actually has one.
 * Without it the agent either reads this repository's README (Spotlight) or
 * stops because the named file cannot be found — neither is the planning path
 * the cell is meant to measure.
 * 计划任务点名 README.md，因此需要一个真的含有该文件的工作区。没有它，Agent 会读本仓库
 * 的 README（Spotlight），或因为找不到点名文件而停下——两者都不是这个格要测的规划路径。
 */
const fixtureWorkspace = await mkdtemp(join(tmpdir(), "clone-ai-main-workspace-"));
await writeFile(join(fixtureWorkspace, "README.md"), "# Fixture project\n\nBENCH_PLAN_README\n", "utf8");
/**
 * A folder the twin learns through the turn ledger, outside both the clone
 * home and the real home. The task prompts name no path, so resolving
 * `learned-file.md` proves the learned-folder path rather than Spotlight or the
 * workspace. `/var/folders` is not indexed by Spotlight, and the direct
 * learned-root join runs before Spotlight anyway.
 * 分身通过回合台账学到的文件夹，位于 clone home 与真实 home 之外。任务提示词不给路径，
 * 因此解析 `learned-file.md` 证明走的是已知文件夹路径，而不是 Spotlight 或工作区。
 * `/var/folders` 不进入 Spotlight 索引，而且直接拼接已知根发生在 Spotlight 之前。
 */
const learnedFixture = await mkdtemp(join(tmpdir(), "clone-ai-main-learned-"));
await writeFile(join(learnedFixture, "learned-file.md"), "BENCH_LEARNED_MARKER_9K4\n\nThis file is reachable only through a learned folder.\n", "utf8");

type Runtime = "native";
type Expectation = "direct" | "authority" | "plan" | "read" | "learned-read" | "learned-trivial" | "learned-continuation";

interface TaskSeed {
  /** A folder taught in another conversation, so it is learned but absent from this turn's history. 在另一个对话中教会的文件夹：已学会，但不在本回合历史里。 */
  folder?: string;
  /** A completed earlier turn in the main conversation whose texts name no absolute path. 主对话中更早的一条已完成回合，其文本不含绝对路径。 */
  previous?: { text: string; reply: string };
}

interface MainAgentTask {
  id: string;
  prompt: string;
  expectation: Expectation;
  seed?: TaskSeed;
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
  {
    id: "named-file-read",
    prompt: "读取文件 {fixture}，只回复它的第一行内容。不要提案计划，也不要修改任何文件。",
    expectation: "read",
  },
  {
    id: "learned-folder-read",
    prompt: "读取我项目里的 learned-file.md，只回复它的第一行内容。不要提案计划，也不要修改任何文件。",
    expectation: "learned-read",
    seed: { folder: learnedFixture },
  },
  {
    id: "learned-folder-trivial",
    prompt: "请只回复两个字：收到。不要提案任何计划，也不要调用任何工具。",
    expectation: "learned-trivial",
    seed: { folder: learnedFixture },
  },
  {
    id: "learned-folder-continuation",
    prompt: "继续，把刚才那个弄完。",
    expectation: "learned-continuation",
    seed: {
      folder: learnedFixture,
      previous: {
        text: "整理那个学习文件夹里的资料，先看看有什么。",
        reply: "看过了，里面有学习材料。需要我整理成清单吗？",
      },
    },
  },
];

interface TaskResult {
  runtime: Runtime;
  taskId: string;
  expectation: Expectation;
  prompt: string;
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
    // The seed teaches a folder in a separate conversation, so the current
    // turn's history does not contain the absolute path. This is what makes
    // the continuation cell hard: the path exists only in the learned set.
    // 种子里用一个单独的对话教会文件夹，因此本回合历史不含绝对路径。这正是续做格
    // 之所以困难的地方：路径只存在于已学会的集合里。
    if (task.seed?.folder !== undefined) {
      await appendMainAgentTurnRecord(directory, {
        id: `seed-lesson-${task.id}`,
        text: `整理 ${task.seed.folder} 里的资料。`,
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:05.000Z",
        conversationId: "seed-folder-lesson",
        reply: "好。",
      });
    }
    if (task.seed?.previous !== undefined) {
      await appendMainAgentTurnRecord(directory, {
        id: `seed-previous-${task.id}`,
        text: task.seed.previous.text,
        status: "completed",
        startedAt: "2026-01-02T00:00:00.000Z",
        completedAt: "2026-01-02T00:00:05.000Z",
        conversationId: "main-agent-conversation",
        reply: task.seed.previous.reply,
      });
    }
    process.env.CLONE_AI_MAIN_MODEL = MODEL;
    process.env.CLONE_AI_MAIN_RUNTIME = "native";
    process.env.CLONE_AI_NATIVE_MODEL = MODEL;
    process.env.CLONE_AI_NATIVE_BASE_URL = BASE_URL;
    const started = Date.now();
    const prompt = task.prompt.replaceAll("{fixture}", fixturePath);
    let result: Awaited<ReturnType<typeof runMainAgentQuery>>;
    try {
      result = await runMainAgentQuery(directory, prompt, {
        source: "companion",
        auditHome: join(directory, ".audit"),
        ...(task.id === "plan-proposal" ? { workspacePath: fixtureWorkspace } : {}),
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
        prompt,
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
    const passed = (() => {
      switch (task.expectation) {
        case "direct":
          return result.error === undefined && result.reply.trim().length > 0 && runs === 0;
        case "authority":
          return result.error === undefined && toolCalls.includes("get_authority");
        case "read":
          return result.error === undefined && toolCalls.includes("read_file") && result.reply.includes("BENCH_READ_MARKER_7Q2");
        case "learned-read":
          // The prompt names no path: the file can only be found through the
          // learned folder, so a correct first line proves that path works.
          // 提示词不给路径：文件只能通过已学会的文件夹找到，因此正确读出第一行证明该路径有效。
          return result.error === undefined && toolCalls.includes("read_file") && result.reply.includes("BENCH_LEARNED_MARKER_9K4");
        case "learned-trivial": {
          // The README incident: a trivial turn must not act on a learned
          // folder it merely happens to know about.
          // README 事故：琐碎回合不得因为"恰好知道"某个文件夹就对它采取行动。
          const folderTools = ["read_file", "recent_file_changes", "daily_workspace_digest", "get_situation"];
          return result.error === undefined && result.reply.trim().length > 0 && runs === 0
            && !toolCalls.some((tool) => folderTools.includes(tool));
        }
        case "learned-continuation":
          // Pass when the model resolves the folder on demand (or names it),
          // not when it stalls on an open-ended "which folder?".
          // 通过条件：模型按需解析出文件夹（或直接说出路径），而不是卡在开放式的"哪个文件夹？"。
          return result.error === undefined
            && (toolCalls.includes("get_situation") || toolCalls.includes("recent_file_changes") || result.reply.includes(learnedFixture));
        default:
          return runs > 0;
      }
    })();
    return {
      runtime,
      taskId: task.id,
      expectation: task.expectation,
      prompt,
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
const selectedTasks = ONLY === undefined ? TASKS : TASKS.filter((task) => ONLY.has(task.id));
if (selectedTasks.length === 0) {
  console.error(`No task matches --only ${[...(ONLY ?? [])].join(",")}; known ids: ${TASKS.map((task) => task.id).join(", ")}`);
  process.exit(2);
}
console.log(`Main Agent comparison: model=${MODEL} endpoint=${BASE_URL} repeat=${REPEAT}`);
for (const task of selectedTasks) {
  for (const runtime of ["native"] as const) {
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
  native: {
    passed: records.filter((record) => record.runtime === "native" && record.passed).length,
    samples: records.filter((record) => record.runtime === "native").length,
  },
};
console.log(`\nSummary: native ${summary.native.passed}/${summary.native.samples}`);

const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const reportPath = join(resultsDirectory, `main-agent-${stamp}.json`);
await mkdir(resultsDirectory, { recursive: true });
await writeFile(reportPath, `${JSON.stringify({
  ranAt: new Date().toISOString(),
  model: MODEL,
  endpoint: BASE_URL,
  repeat: REPEAT,
  tasks: selectedTasks,
  records,
  cells,
  summary,
}, null, 2)}\n`, "utf8");
console.log(`Report: ${reportPath}`);
await rm(fixtureDirectory, { recursive: true, force: true }).catch(() => undefined);
await rm(fixtureWorkspace, { recursive: true, force: true }).catch(() => undefined);
await rm(learnedFixture, { recursive: true, force: true }).catch(() => undefined);
process.exit(0);
