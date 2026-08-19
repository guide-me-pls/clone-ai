import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { AgentMemoryWorker, miningPrompt, parseJsonArray, validateCandidates } from "../src/memory/agent-memory-worker.ts";
import type { Evidence, MemoryCandidate } from "../src/core/contracts.ts";
import type { PendingMemoryJob } from "../src/memory/memory-pipeline.ts";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.cjs", import.meta.url));

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

function workerOptions(overrides: Record<string, string> = {}): ConstructorParameters<typeof AgentMemoryWorker>[0] {
  return {
    config: {
      id: "fake-miner",
      command: process.execPath,
      args: [fakeAgent, "{{prompt}}"],
      env: ["FAKE_AGENT_MODE", "FAKE_MEMORY_CANDIDATES_JSON"],
      timeoutMs: 30_000,
    },
    ...overrides,
  };
}

async function mine(
  t: TestContext,
  options: { mode?: string; json?: string; evidenceIds?: string[] } = {},
): Promise<MemoryCandidate[]> {
  const mode = options.mode ?? (options.json === undefined ? undefined : "memory-candidates");
  const previous = process.env.FAKE_AGENT_MODE;
  const previousJson = process.env.FAKE_MEMORY_CANDIDATES_JSON;
  if (mode === undefined) delete process.env.FAKE_AGENT_MODE;
  else process.env.FAKE_AGENT_MODE = mode;
  if (options.json === undefined) delete process.env.FAKE_MEMORY_CANDIDATES_JSON;
  else process.env.FAKE_MEMORY_CANDIDATES_JSON = options.json;
  try {
    const worker = new AgentMemoryWorker(workerOptions());
    return await worker.extract(miningJob(options.evidenceIds));
  } finally {
    if (previous === undefined) delete process.env.FAKE_AGENT_MODE;
    else process.env.FAKE_AGENT_MODE = previous;
    if (previousJson === undefined) delete process.env.FAKE_MEMORY_CANDIDATES_JSON;
    else process.env.FAKE_MEMORY_CANDIDATES_JSON = previousJson;
  }
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

test("a failed mining run returns no candidates instead of throwing", async (t) => {
  const candidates = await mine(t, { mode: "memory-mine-fail", json: "[]" });
  assert.deepEqual(candidates, []);
});

test("missing or malformed candidate files are ignored", async (t) => {
  assert.deepEqual(await mine(t, { mode: "talks-but-writes-nothing" }), []);
  assert.deepEqual(await mine(t, { json: "not json at all" }), []);
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
