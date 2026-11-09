import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AgentMemoryWorker, miningPrompt, parseJsonArray, validateCandidates } from "../src/memory/agent-memory-worker.ts";
import type { Evidence, MemoryCandidate } from "../src/core/contracts.ts";
import type { PendingMemoryJob } from "../src/memory/memory-pipeline.ts";


function miningJob(evidenceIds: string[] = ["ev-1", "ev-2"]): PendingMemoryJob {
  const createdAt = "2026-08-19T00:00:00.000Z";
  const evidence: Evidence[] = evidenceIds.map((id, index) => ({
    id,
    runId: "run-1",
    stepId: "step-1",
    producedBy: "worker",
    kind: "artifact",
    summary: `Evidence ${index + 1} summary: the deliverable was produced.`,
    locator: `out/file-${index + 1}.md`,
    createdAt,
  }));
  return {
    run: { id: "run-1", taskId: "task-1", status: "completed", createdAt, updatedAt: createdAt },
    task: { id: "task-1", triggerId: "trigger-1", title: "Build the report", objective: "Build a release report", acceptanceCriteria: [], createdAt },
    evidence,
  };
}

function workerOptions(overrides: { complete?: (prompt: string) => Promise<string>; maxCandidates?: number } = {}): ConstructorParameters<typeof AgentMemoryWorker>[0] {
  return { complete: overrides.complete ?? (async () => "[]"), ...(overrides.maxCandidates === undefined ? {} : { maxCandidates: overrides.maxCandidates }) };
}

async function mine(
  t: TestContext,
  options: { mode?: "fail" | "empty"; json?: string; evidenceIds?: string[]; maxCandidates?: number } = {},
): Promise<MemoryCandidate[]> {
  const worker = new AgentMemoryWorker(workerOptions({
    ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }),
    complete: async () => {
      if (options.mode === "fail") throw new Error("endpoint unreachable");
      if (options.mode === "empty") return "";
      return options.json ?? "[]";
    },
  }));
  return await worker.extract(miningJob(options.evidenceIds));
}

test("the mining prompt lists evidence as the only input facts", () => {
  const prompt = miningPrompt(miningJob());
  assert.match(prompt, /ev-1: \[artifact\]/);
  assert.match(prompt, /Never invent an id/);
  assert.match(prompt, /out\/candidates.json/);
});

test("a mining worker extracts and validates real candidates", async (t) => {
  const candidates = await mine(t, {
    json: JSON.stringify([
      {
        type: "preference",
        summary: "用户偏好：发布前必须完成风险评审",
        confidence: "high",
        sensitivity: "private",
        sourceEvidenceIds: ["ev-1", "ev-2"],
      },
    ]),
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.type, "preference");
  assert.equal(candidates[0]?.confidence, "high");
  assert.equal(candidates[0]?.sensitivity, "private");
  assert.deepEqual(candidates[0]?.sourceEvidenceIds, ["ev-1", "ev-2"]);
  assert.equal(candidates[0]?.status, "proposed");
});

test("hallucinated evidence ids are dropped", async (t) => {
  const candidates = await mine(t, {
    json: JSON.stringify([
      {
        type: "fact",
        summary: "这是基于真实证据的总结",
        confidence: "high",
        sourceEvidenceIds: ["ev-1", "ghost-id"],
      },
      {
        type: "fact",
        summary: "完全编造的候选",
        confidence: "high",
        sourceEvidenceIds: ["ghost-id"],
      },
    ]),
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.sourceEvidenceIds, ["ev-1"]);
});

test("invalid types, empty summaries, and unknown classes never become candidates", async (t) => {
  const candidates = await mine(t, {
    json: JSON.stringify([
      { type: "gossip", summary: "非法类型", confidence: "high", sourceEvidenceIds: ["ev-1"] },
      { type: "fact", summary: "x", confidence: "high", sourceEvidenceIds: ["ev-1"] },
      { type: "fact", summary: "合法摘要", confidence: "certain", sourceEvidenceIds: ["ev-1"] },
      { type: "fact", summary: "没有引用的候选", confidence: "high", sourceEvidenceIds: [] },
    ]),
  });

  assert.deepEqual(candidates, []);
});

test("markdown-fenced JSON is parsed", async (t) => {
  const candidates = await mine(t, {
    json: "```json\n[{\"type\":\"decision\",\"summary\":\"决定：采用黑盒边界\",\"confidence\":\"medium\",\"sourceEvidenceIds\":[\"ev-1\"]}]\n```\n",
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.type, "decision");
});

test("a failed mining run is reported so the pipeline can retry it", async (t) => {
  await assert.rejects(mine(t, { mode: "fail" }), /memory mining failed/i);
});

test("missing or malformed candidate files are reported as extraction failures", async (t) => {
  await assert.rejects(mine(t, { mode: "empty" }), /did not produce/i);
  await assert.rejects(mine(t, { json: "not json at all" }), /invalid JSON/i);
});

test("the default miner fails clearly when the endpoint is not configured", async () => {
  const worker = new AgentMemoryWorker();
  const previous = { model: process.env.CLONE_AI_NATIVE_MODEL, base: process.env.CLONE_AI_NATIVE_BASE_URL };
  delete process.env.CLONE_AI_NATIVE_MODEL;
  delete process.env.CLONE_AI_NATIVE_BASE_URL;
  try {
    await assert.rejects(worker.extract(miningJob()), /memory mining failed.*endpoint is not configured/i);
  } finally {
    if (previous.model !== undefined) process.env.CLONE_AI_NATIVE_MODEL = previous.model;
    if (previous.base !== undefined) process.env.CLONE_AI_NATIVE_BASE_URL = previous.base;
  }
});

test("candidates are capped per task", async (t) => {
  const candidates = await mine(t, {
    json: JSON.stringify([
      { type: "fact", summary: "第一条", confidence: "high", sourceEvidenceIds: ["ev-1"] },
      { type: "fact", summary: "第二条", confidence: "high", sourceEvidenceIds: ["ev-1"] },
      { type: "fact", summary: "第三条", confidence: "high", sourceEvidenceIds: ["ev-1"] },
      { type: "fact", summary: "第四条", confidence: "high", sourceEvidenceIds: ["ev-1"] },
    ]),
  });

  assert.equal(candidates.length, 3);
});

test("parseJsonArray tolerates trailing prose and empty input", () => {
  assert.equal(parseJsonArray("[1,2] then some prose")?.[0], 1);
  assert.equal((parseJsonArray("```\n[{\"a\":1}]\n```")?.[0] as { a?: number })?.a, 1);
  assert.equal(parseJsonArray(""), undefined);
  assert.equal(parseJsonArray("{\"not\":\"array\"}"), undefined);
});

test("mining keeps a future expiresAt and drops a past or invalid one", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const source = JSON.stringify([
    { type: "fact", summary: "Release freeze lasts until the end of the month.", confidence: "medium", sourceEvidenceIds: ["ev-1"], expiresAt: future },
    { type: "fact", summary: "The report template lives in docs/templates.", confidence: "medium", sourceEvidenceIds: ["ev-1"], expiresAt: "2020-01-01T00:00:00Z" },
    { type: "fact", summary: "The staging URL is the shared preview host.", confidence: "medium", sourceEvidenceIds: ["ev-1"], expiresAt: "soon" },
  ]);
  const [first, second, third] = validateCandidates(source, miningJob(), 5);
  assert.equal(first?.expiresAt, future);
  assert.equal(second?.expiresAt, undefined);
  assert.equal(third?.expiresAt, undefined);
});

test("a failed run is mined for lessons, a completed run is not", () => {
  assert.match(miningPrompt({ ...miningJob(), outcome: "failed" }), /FAILED/);
  assert.doesNotMatch(miningPrompt(miningJob()), /FAILED/);
  assert.match(miningPrompt(miningJob()), /expiresAt/);
});
