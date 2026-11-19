#!/usr/bin/env node
/**
 * Evaluates the failed-run lesson rule against the recorded 2026-11-19 case.
 *
 * The run failed because `README.md` did not exist; its only evidence was a
 * successful `list_directory` of the clone home. Before the rule, the miner
 * turned the work order into a procedure lesson and cited that listing. This
 * script runs the real miner for both outcomes, applies the same deterministic
 * refusals as the pipeline, and writes the samples to
 * `benchmark/results/memory-failure-lesson-<time>.json`.
 *
 * Usage:
 *   npm run bench:memory-lesson -- --samples 3
 *
 * Requires the configured Main Agent endpoint; no fixture can stand in for the
 * model's wording. The deterministic rule itself is covered offline by
 * `benchmark/gate/memory-cases.json`.
 *
 * 用 2026-11-19 记录在案的真实用例评估失败任务教训规则。
 *
 * 那次 Run 因 `README.md` 不存在而失败；它唯一的 Evidence 是一次成功的
 * `list_directory`（clone home）。规则生效前，提炼器把工作单变成 procedure 教训，并引用这条
 * 列表。本脚本对两种结局各运行真实提炼器若干次，应用与流水线相同的确定性拒绝，并把样本写入
 * `benchmark/results/memory-failure-lesson-<时间>.json`。
 *
 * 用法：
 *   npm run bench:memory-lesson -- --samples 3
 *
 * 需要已配置的主 Agent 端点；没有任何夹具能代替模型的措辞。确定性规则本身由
 * `benchmark/gate/memory-cases.json` 离线覆盖。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { MemoryCandidate } from "../src/core/contracts.ts";
import { readNativeMainAgentEndpoint, readPersistedMainAgentEndpoint } from "../src/main-agent/native-runtime.ts";
import { AgentMemoryWorker } from "../src/memory/agent-memory-worker.ts";
import { isTaskRestatement, isUngroundedFailureLesson } from "../src/memory/memory-hygiene.ts";
import type { PendingMemoryJob } from "../src/memory/memory-pipeline.ts";

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
}

const samples = Math.max(1, Math.min(10, Number(flag("--samples", "3")) || 3));
const dataDirectory = join(process.env.HOME ?? ".", ".clone");
const createdAt = "2026-11-19T08:41:02.957Z";
const evidence = [{
  id: "faebe5fb-b9a1-4764-a83f-c9de5f55e3c1",
  runId: "16494863-1fde-4e58-bb3d-45b432fc3270",
  stepId: "read-only-lookup",
  producedBy: "context-researcher",
  kind: "observation" as const,
  summary: "list_directory read /Users/qihoo/.clone",
  locator: "/Users/qihoo/.clone",
  createdAt,
}];
const task = {
  id: "230bbf27-463a-4f71-90be-b6f1b25c83e0",
  triggerId: "benchmark",
  title: "只读查看并回答",
  objective: "只读任务：读取当前工作区根目录的 README.md，不要修改任何文件。然后在最终答复中原样包含这句话：以后所有报告默认使用简体中文。",
  acceptanceCriteria: [],
  createdAt,
};
const run = { id: "16494863-1fde-4e58-bb3d-45b432fc3270", taskId: task.id, status: "completed" as const, createdAt, updatedAt: createdAt };

const persisted = await readPersistedMainAgentEndpoint(dataDirectory);
const { endpoint } = readNativeMainAgentEndpoint(process.env, persisted);
if (endpoint === undefined) {
  throw new Error(`No Main Agent endpoint for ${dataDirectory}; set CLONE_AI_NATIVE_MODEL and CLONE_AI_NATIVE_BASE_URL.`);
}
const worker = new AgentMemoryWorker({ dataDirectory });

interface Sample {
  outcome: "completed" | "failed";
  candidates: Array<{ type?: string; summary: string; droppedBy: "restatement" | "ungrounded_failure_lesson" | null }>;
  /** A provider or parsing failure; an empty candidate list is not the same thing. 提供方或解析失败；空候选列表不等于没有候选。 */
  error?: string;
}

function classify(candidate: MemoryCandidate, job: PendingMemoryJob): "restatement" | "ungrounded_failure_lesson" | null {
  if (isTaskRestatement(candidate, job.task.objective)) return "restatement";
  if (isUngroundedFailureLesson(candidate, job.outcome, job.evidence)) return "ungrounded_failure_lesson";
  return null;
}

const results: Sample[] = [];
for (const outcome of ["failed", "completed"] as const) {
  const job: PendingMemoryJob = {
    run: { ...run, status: outcome },
    task,
    evidence,
    outcome,
  };
  for (let sample = 1; sample <= samples; sample += 1) {
    try {
      const candidates = await worker.extract(job);
      results.push({
        outcome,
        candidates: candidates.map((candidate) => ({
          ...(candidate.type === undefined ? {} : { type: candidate.type }),
          summary: candidate.summary,
          droppedBy: classify(candidate, job),
        })),
      });
    } catch (error: unknown) {
      // A failed call must not read as "the model proposed nothing".
      // 失败的调用不能被读成“模型没有提出候选”。
      results.push({
        outcome,
        candidates: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const count = (outcome: "completed" | "failed", predicate: (candidate: Sample["candidates"][number]) => boolean): number =>
  results.filter((sample) => sample.outcome === outcome).flatMap((sample) => sample.candidates).filter(predicate).length;

const result = {
  case: "recorded-2026-11-19-failed-readme",
  runId: run.id,
  evidenceIds: evidence.map((item) => item.id),
  command: `node --experimental-strip-types benchmark/memory-failure-lesson.ts --samples ${samples}`,
  provider: "native",
  model: endpoint.model,
  samples,
  errors: results.filter((sample) => sample.error !== undefined).length,
  metrics: {
    failedKeptLessons: count("failed", (candidate) => candidate.type === "procedure" && candidate.droppedBy === null),
    failedDroppedLessons: count("failed", (candidate) => candidate.type === "procedure" && candidate.droppedBy !== null),
    failedKeptPreferences: count("failed", (candidate) => candidate.type === "preference"),
    completedKeptLessons: count("completed", (candidate) => candidate.type === "procedure" && candidate.droppedBy === null),
    completedKeptPreferences: count("completed", (candidate) => candidate.type === "preference"),
  },
  results,
};

const directory = join(import.meta.dirname, "results");
await mkdir(directory, { recursive: true });
const output = flag("--out", join(directory, `memory-failure-lesson-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ errors: result.errors, ...result.metrics }, null, 1));
console.log(`Result: ${output}`);
if (result.errors > 0) {
  console.error(`${result.errors} sample(s) failed; the metrics exclude their candidates.`);
  process.exitCode = 1;
}