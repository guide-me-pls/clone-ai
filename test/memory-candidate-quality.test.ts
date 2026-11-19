/**
 * Candidate quality: a finished task's objective is not a memory.
 *
 * The first version of task mining copied the objective into a candidate for
 * every completed run ("候选流程：<objective>"). The owner's journal showed
 * seven of seven candidates were that copy; this file pins the replacement
 * contract: no miner means no candidate, and any worker that restates its task
 * is refused at the pipeline boundary.
 *
 * 候选质量：已完成任务的目标不是记忆。
 *
 * 第一版任务提炼会为每个已完成 Run 把目标复制成候选（“候选流程：<目标>”）。所有者的
 * Journal 显示七条候选全是这种复制；本文件钉住替代契约：没有提炼器就没有候选，任何
 * 复述任务的 Worker 都会在流水线边界被拒绝。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Evidence, MemoryCandidate, Run, Task } from "../src/core/contracts.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { createRuntimeAssembly } from "../src/core/runtime-factory.ts";
import { MemoryGovernance } from "../src/memory/memory-governance.ts";
import { hasDurableMemoryText, isTaskRestatement, restatesTaskObjective } from "../src/memory/memory-hygiene.ts";
import { MemoryPipeline, type MemoryWorker } from "../src/memory/memory-pipeline.ts";
import { MdMemoryStore } from "../src/memory/md-memory-store.ts";

const OBJECTIVE = "只读审查 knowledge-base 项目的 RAG 实现，优先复用已有审查结果并给出可验证的优化建议。";
const DURABLE = "发布前先跑完整测试；这次跳过测试导致了一次回归。";
const CREATED_AT = "2026-11-18T00:00:00.000Z";

function candidate(id: string, summary: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id,
    runId: "run-1",
    sourceEvidenceIds: ["ev-1"],
    summary,
    confidence: "high",
    status: "proposed",
    createdAt: CREATED_AT,
    type: "procedure",
    ...overrides,
  };
}

async function setup(t: TestContext): Promise<{ journal: JsonlJournalStore; run: Run; task: Task; evidence: Evidence }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-candidate-quality-"));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const task: Task = {
    id: "task-1",
    triggerId: "trigger-1",
    title: "Review the RAG project",
    objective: OBJECTIVE,
    acceptanceCriteria: [],
    createdAt: CREATED_AT,
  };
  const run: Run = { id: "run-1", taskId: task.id, status: "completed", createdAt: CREATED_AT, updatedAt: CREATED_AT };
  const evidence: Evidence = {
    id: "ev-1",
    runId: run.id,
    stepId: "step-1",
    producedBy: "worker",
    kind: "observation",
    summary: "审查完成，给出三条建议。",
    createdAt: CREATED_AT,
  };
  await journal.append({ type: "task.created", taskId: task.id, payload: task });
  await journal.append({ type: "run.created", runId: run.id, taskId: task.id, payload: run });
  await journal.append({ type: "evidence.recorded", runId: run.id, taskId: task.id, payload: evidence });
  return { journal, run, task, evidence };
}

test("a candidate that only restates its task is recognised across templates and spacing", () => {
  assert.equal(restatesTaskObjective(`候选流程：${OBJECTIVE}`, OBJECTIVE), true);
  assert.equal(restatesTaskObjective(`候选流程: ${OBJECTIVE}`, OBJECTIVE), true);
  assert.equal(restatesTaskObjective(`流程：${OBJECTIVE}`, OBJECTIVE), true);
  assert.equal(restatesTaskObjective(OBJECTIVE, OBJECTIVE), true);
  // Full-width spaces, missing punctuation, and case folding do not hide it.
  // 全角空格、缺少标点与大小写折叠都藏不住它。
  assert.equal(restatesTaskObjective("只读审查　knowledge-base 项目 的 RAG 实现 优先复用已有审查结果并给出可验证的优化建议", OBJECTIVE), true);
  assert.equal(restatesTaskObjective("Candidate procedure: Review the RAG implementation.", "Review the RAG implementation"), true);
  assert.equal(restatesTaskObjective("Conversation with the owner", "Conversation with the owner"), true);
  // Decoration and locale-sensitive casing are folded before the comparison.
  // 装饰与区域敏感的大小写会在比较前折叠。
  assert.equal(restatesTaskObjective("**候选流程：** 审查报告", "审查报告"), true);
  assert.equal(restatesTaskObjective("- 流程：审查报告", "审查报告"), true);
  assert.equal(restatesTaskObjective("候选流程：流程：审查报告", "审查报告"), true);
  assert.equal(restatesTaskObjective("候选流程是：审查报告", "审查报告"), true);
  assert.equal(restatesTaskObjective("审查报告（流程）", "审查报告"), true);
  assert.equal(restatesTaskObjective("审查报告（流程）。", "审查报告"), true);
  assert.equal(restatesTaskObjective("Review the RAG implementation — procedure.", "Review the RAG implementation"), true);
  assert.equal(restatesTaskObjective("审查报告✅️", "审查报告"), true);
  assert.equal(restatesTaskObjective("审查​报告", "审查报告"), true);
  assert.equal(restatesTaskObjective("FİLE review", "file review"), true);
});

test("a typed statement equal to a first-person objective stays for review", () => {
  const objective = "我以后周五不加班";
  assert.equal(isTaskRestatement({ summary: objective, type: "preference" }, objective), false);
  assert.equal(isTaskRestatement({ summary: objective, type: "fact" }, objective), false);
  assert.equal(isTaskRestatement({ summary: objective, type: "procedure" }, objective), true);
  assert.equal(isTaskRestatement({ summary: objective }, objective), true);
});

test("punctuation and emoji alone are not a memory", () => {
  assert.equal(hasDurableMemoryText("。。。"), false);
  assert.equal(hasDurableMemoryText("🎉🎉"), false);
  assert.equal(hasDurableMemoryText("周报模板用蓝色"), true);
});

test("a standing statement that merely mentions the task is not a restatement", () => {
  assert.equal(restatesTaskObjective(DURABLE, OBJECTIVE), false);
  assert.equal(restatesTaskObjective("周报模板改用蓝色，每周五提交。", "准备本周周报"), false);
  // A short objective must not make containment look like a restatement.
  // 短目标不能让“包含”看起来像复述。
  assert.equal(restatesTaskObjective("周报模板用蓝色", "周报"), false);
  assert.equal(restatesTaskObjective("", OBJECTIVE), false);
  assert.equal(restatesTaskObjective("任意摘要", ""), false);
  // Token-internal symbols are meaningful, not punctuation to delete.
  // 词内部的符号有意义，不是可删除的标点。
  assert.equal(restatesTaskObjective("学习 C", "学习 C++"), false);
  assert.equal(restatesTaskObjective("升级到 v12", "升级到 v1.2"), false);
});

test("a finished task with no configured miner proposes nothing", async (t) => {
  const { journal, run, task, evidence } = await setup(t);
  const pipeline = new MemoryPipeline(journal);
  await pipeline.request(run, task, [evidence]);

  assert.deepEqual(await pipeline.processNext(), []);
  const events = await journal.list();
  assert.equal(events.filter((event) => event.type === "memory.candidate.proposed").length, 0);
  const extracted = events.find((event) => event.type === "memory.candidate.extracted");
  assert.deepEqual(extracted?.payload, { count: 0, outcome: "completed" });
});

test("the pipeline drops a miner's restatement and keeps a durable statement", async (t) => {
  const { journal, run, task, evidence } = await setup(t);
  const worker: MemoryWorker = {
    async extract() {
      return [
        candidate("c-restatement", `候选流程：${OBJECTIVE}`),
        // A typed preference equal to the objective is not refused: the owner
        // may have stated exactly what the task asked for.
        // 等于目标的有类型偏好不会被拒绝：所有者可能原样说出了任务要求的事。
        candidate("c-preference", OBJECTIVE, { type: "preference" }),
        candidate("c-durable", DURABLE),
      ];
    },
  };
  const pipeline = new MemoryPipeline(journal, worker);
  await pipeline.request(run, task, [evidence]);

  const proposed = await pipeline.processNext();
  assert.deepEqual(proposed.map((item) => item.id), ["c-preference", "c-durable"]);
  const extracted = (await journal.list()).find((event) => event.type === "memory.candidate.extracted");
  const payload = extracted?.payload as {
    count: number;
    droppedRestatements: number;
    droppedCandidates: Array<{ id: string; summary: string }>;
  };
  assert.equal(payload.count, 2);
  assert.equal(payload.droppedRestatements, 1);
  assert.deepEqual(payload.droppedCandidates.map((item) => item.id), ["c-restatement"]);
  assert.match(payload.droppedCandidates[0]!.summary, /候选流程/);
});

test("a failed run's lesson must cite evidence of the failure", async (t) => {
  const { journal, run, task, evidence } = await setup(t);
  const failure: Evidence = {
    ...evidence,
    id: "ev-failure",
    summary: "npm test failed: 2 assertions in test/release.test.ts",
  };
  await journal.append({ type: "evidence.recorded", runId: run.id, taskId: task.id, payload: failure });
  const worker: MemoryWorker = {
    async extract() {
      return [
        // Cites only the successful observation: no cause to support the lesson.
        // 只引用成功的观察：没有可支撑教训的原因。
        candidate("c-ungrounded", "下次应先直接读取 README.md，而不是列出目录。", { sourceEvidenceIds: ["ev-1"] }),
        // A failure line exists, but this candidate cites the successful line.
        // 失败行存在，但这条候选引用的是成功行。
        candidate("c-cites-success", DURABLE, { sourceEvidenceIds: ["ev-1"] }),
        candidate("c-grounded", DURABLE, { sourceEvidenceIds: ["ev-failure"] }),
        // The rule gates lessons, not a durable preference the owner stated.
        // 规则只约束教训，不约束所有者声明的持久偏好。
        candidate("c-preference", "以后所有报告默认使用简体中文。", { type: "preference", sourceEvidenceIds: ["ev-1"] }),
      ];
    },
  };
  const pipeline = new MemoryPipeline(journal, worker);
  await pipeline.request(run, task, [evidence, failure], "failed");

  const proposed = await pipeline.processNext();
  assert.deepEqual(proposed.map((item) => item.id), ["c-grounded", "c-preference"]);
  const payload = (await journal.list()).find((event) => event.type === "memory.candidate.extracted")?.payload as {
    count: number;
    droppedUngroundedFailureLessons: number;
    droppedCandidates: Array<{ id: string; reason: string }>;
  };
  assert.equal(payload.count, 2);
  assert.equal(payload.droppedUngroundedFailureLessons, 2);
  assert.deepEqual(payload.droppedCandidates.map((item) => [item.id, item.reason]), [
    ["c-ungrounded", "ungrounded_failure_lesson"],
    ["c-cites-success", "ungrounded_failure_lesson"],
  ]);
});

test("a failed run with no failing evidence yields no lesson", async (t) => {
  const { journal, run, task, evidence } = await setup(t);
  const worker: MemoryWorker = {
    async extract() {
      return [candidate("c-guess", "下次应先确认文件存在。", { sourceEvidenceIds: ["ev-1"] })];
    },
  };
  const pipeline = new MemoryPipeline(journal, worker);
  await pipeline.request(run, task, [evidence], "failed");

  assert.deepEqual(await pipeline.processNext(), []);
  const payload = (await journal.list()).find((event) => event.type === "memory.candidate.extracted")?.payload as {
    count: number;
    droppedUngroundedFailureLessons: number;
  };
  assert.equal(payload.count, 0);
  assert.equal(payload.droppedUngroundedFailureLessons, 1);
});

test("mining mode all selects the real miner instead of the no-op default", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-candidate-mode-"));
  const previous = {
    mode: process.env.CLONE_AI_MEMORY_MINING,
    model: process.env.CLONE_AI_NATIVE_MODEL,
    base: process.env.CLONE_AI_NATIVE_BASE_URL,
    key: process.env.CLONE_AI_NATIVE_API_KEY,
  };
  process.env.CLONE_AI_MEMORY_MINING = "all";
  delete process.env.CLONE_AI_NATIVE_MODEL;
  delete process.env.CLONE_AI_NATIVE_BASE_URL;
  delete process.env.CLONE_AI_NATIVE_API_KEY;
  let assembly: Awaited<ReturnType<typeof createRuntimeAssembly>> | undefined;
  try {
    assembly = await createRuntimeAssembly({ dataDirectory: directory, workspacePath: directory });
    const task: Task = {
      id: "task-mode",
      triggerId: "trigger-mode",
      title: "Review",
      objective: OBJECTIVE,
      acceptanceCriteria: [],
      createdAt: CREATED_AT,
    };
    const run: Run = { id: "run-mode", taskId: task.id, status: "completed", createdAt: CREATED_AT, updatedAt: CREATED_AT };
    const evidence: Evidence = {
      id: "ev-mode",
      runId: run.id,
      stepId: "step-1",
      producedBy: "worker",
      kind: "observation",
      summary: "done",
      createdAt: CREATED_AT,
    };
    await assembly.memory.request(run, task, [evidence]);
    // A real miner without an endpoint fails the job and keeps it pending; the
    // no-op default would instead return [] and mark it extracted. That
    // difference is the proof that `all` selected the real miner.
    // 没有端点的真实提炼器会让任务失败并保持待处理；空默认则会返回 [] 并标记为已提炼。
    // 这个差异正是 `all` 选中真实提炼器的证明。
    await assert.rejects(assembly.memory.processNext(), /memory mining failed.*endpoint is not configured/i);
    assert.equal(assembly.memory.hasPending(), true);
  } finally {
    assembly?.close();
    restoreEnvironment("CLONE_AI_MEMORY_MINING", previous.mode);
    restoreEnvironment("CLONE_AI_NATIVE_MODEL", previous.model);
    restoreEnvironment("CLONE_AI_NATIVE_BASE_URL", previous.base);
    restoreEnvironment("CLONE_AI_NATIVE_API_KEY", previous.key);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("legacy objective restatements are retired with a journaled reason, once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-candidate-cleanup-"));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const governance = new MemoryGovernance({ journal, store });
  const task: Task = {
    id: "task-1",
    triggerId: "trigger-1",
    title: "Review the RAG project",
    objective: OBJECTIVE,
    acceptanceCriteria: [],
    createdAt: CREATED_AT,
  };
  const run: Run = { id: "run-1", taskId: task.id, status: "completed", createdAt: CREATED_AT, updatedAt: CREATED_AT };
  await journal.append({ type: "task.created", taskId: task.id, payload: task });
  await journal.append({ type: "run.created", runId: run.id, taskId: task.id, payload: run });
  await journal.append({ type: "memory.candidate.proposed", runId: run.id, payload: candidate("c-legacy", `候选流程：${OBJECTIVE}`) });
  await journal.append({ type: "memory.candidate.proposed", runId: run.id, payload: candidate("c-real", DURABLE) });
  // A typed preference that happens to equal the objective is not a legacy
  // work-order copy and must survive the automatic cleanup.
  // 恰好等于目标的有类型偏好不是遗留工作单复制，必须挺过自动清理。
  await journal.append({
    type: "memory.candidate.proposed",
    runId: run.id,
    payload: candidate("c-preference", OBJECTIVE, { type: "preference" }),
  });
  // An orphan must survive: without a task event there is nothing to compare,
  // and guessing would delete a candidate the owner may still want.
  // 孤儿候选必须保留：没有任务事件就没有可比对象，靠猜会删掉所有者可能仍想要的候选。
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-orphan",
    payload: candidate("c-orphan", OBJECTIVE, { runId: "run-orphan" }),
  });

  assert.deepEqual(await governance.rejectRestatedCandidates(), ["c-legacy"]);
  assert.deepEqual((await governance.pendingCandidates()).map((item) => item.id).sort(), ["c-orphan", "c-preference", "c-real"]);
  const rejection = (await journal.list()).find((event) => event.type === "memory.candidate.rejected");
  assert.equal((rejection?.payload as { candidateId?: string }).candidateId, "c-legacy");
  assert.match(String((rejection?.payload as { reason?: string }).reason), /restate/i);

  // Idempotent: a second pass has nothing left to reject.
  // 幂等：第二次扫描没有可拒绝的候选。
  assert.deepEqual(await governance.rejectRestatedCandidates(), []);
});
