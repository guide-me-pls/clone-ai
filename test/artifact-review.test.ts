/**
 * An artifact-contract gap is a decision, not a dead failure. A completed
 * worker with observation evidence but no promised artifact either gets a
 * model judge's accept or waits for the owner; the owner's accept completes the
 * run and reject fails it. These checks use a deterministic adapter, so no
 * model or network is involved.
 *
 * 产物合同缺口是一个决定，而不是死掉的失败。完成的 Worker 只有观察证据、没有承诺的产物时，
 * 要么得到模型裁判的接受，要么等待所有者；所有者接受则 Run 完成，拒绝则失败。这些检查使用
 * 确定性 Adapter，不涉及模型或网络。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ArtifactJudgeInput, ArtifactJudgeResult } from "../src/core/artifact-judge.ts";
import type { ExecutionEvent, RuntimeAdapter, RuntimeCapabilities, VerificationResult, Verifier } from "../src/core/contracts.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";

/** A worker that reads a file and answers, but never writes the promised artifact. 只读文件并回答、从不写承诺产物的 Worker。 */
class ObservationOnlyAdapter implements RuntimeAdapter {
  readonly id = "researcher";
  readonly providerId = "demo";

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false,
      cancellation: false,
      approvalCallback: false,
      parallelAssignments: true,
      work: ["research"],
      evidenceKinds: ["observation"],
    };
  }

  async *execute(): AsyncIterable<ExecutionEvent> {
    yield {
      type: "evidence",
      evidence: { kind: "observation", summary: "read_file read README.md", locator: "README.md" },
    };
    yield { type: "completed", summary: "The project is a local personal agent." };
  }
}

async function runOnce(
  t: { after: (fn: () => Promise<void>) => void },
  judge?: (input: ArtifactJudgeInput) => Promise<ArtifactJudgeResult>,
) {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-artifact-review-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  // The run-level verifier is not the subject here: these checks stop before
  // it, or use it only to show the accepted run closes.
  // Run 级验证器不是本测试的主体：这些检查在它之前停下，或只用它证明被接受的 Run 会结束。
  const verifier: Verifier = {
    async verify({ run, evidence }): Promise<VerificationResult> {
      return {
        runId: run.id,
        passed: true,
        summary: "The test verifier accepts every step.",
        checkedEvidenceIds: evidence.map((item) => item.id),
        createdAt: new Date().toISOString(),
      };
    },
  };
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier,
    memory: new MemoryPipeline(journal),
    ...(judge === undefined ? {} : { artifactJudge: judge }),
  });
  const { run } = await runtime.acceptTrigger({
    kind: "query",
    summary: "Read the README and summarize it.",
    payload: {},
  });
  await runtime.attachPlan(run.id, {
    summary: "Read the README.",
    steps: [{
      id: "read",
      title: "Read the README",
      instructions: "Read README.md and write the summary to summary.md.",
      risk: "reversible_write",
      acceptanceCriteria: ["The summary is written"],
      subagents: [{
        id: "summary",
        agentId: "researcher",
        role: "researcher",
        title: "Summarize the README",
        objective: "Read README.md and write the summary to summary.md.",
        inputs: [],
        requiredCapabilities: ["research"],
        expectedArtifacts: [{
          id: "summary-file",
          kind: "artifact",
          description: "summary.md",
          required: true,
        }],
        acceptanceCriteria: ["A summary is returned"],
        risk: "reversible_write",
        budget: { maxDurationMs: 60_000, maxModelCalls: 10, maxToolCalls: 20, maxAttempts: 1 },
      }],
    }],
  });
  const result = await runtime.execute(run.id, new StaticAgentRegistry([new ObservationOnlyAdapter()]));
  return { runtime, journal, run, result };
}

test("a missing artifact with observation evidence waits for the owner instead of failing", async (t) => {
  const { runtime, journal, run, result } = await runOnce(t);
  assert.equal(result.status, "waiting_review");
  assert.equal(result.verification?.needsReview, true);
  assert.deepEqual(result.verification?.unverifiedCriteria, ["summary.md"]);

  const verified = (await journal.list()).filter((event) => event.type === "subagent.verified").at(-1);
  const payload = verified?.payload as { needsReview?: boolean; passed?: boolean } | undefined;
  assert.equal(payload?.needsReview, true);
  assert.equal(payload?.passed, false);

  const accepted = await runtime.reviewVerification(run.id, "accept");
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.verification?.reviewedBy, "owner");
});

test("the owner can reject the same review", async (t) => {
  const { runtime, run, result } = await runOnce(t, async () => ({
    decision: "review",
    reason: "The file is the deliverable.",
  }));
  assert.equal(result.status, "waiting_review");
  const rejected = await runtime.reviewVerification(run.id, "reject");
  assert.equal(rejected.status, "failed");
});

test("a judge that accepts the evidence lets the run complete and records the deviation", async (t) => {
  let seen: ArtifactJudgeInput | undefined;
  const { journal, result } = await runOnce(t, async (input) => {
    seen = input;
    return { decision: "accept", reason: "The answer is in the observation." };
  });
  assert.equal(result.status, "completed");
  assert.equal(seen?.completion, "The project is a local personal agent.");
  assert.equal(seen?.missing[0]?.id, "summary-file");

  const verified = (await journal.list()).filter((event) => event.type === "subagent.verified").at(-1);
  const payload = verified?.payload as { passed?: boolean; judgedBy?: string; deviatedArtifacts?: string[] } | undefined;
  assert.equal(payload?.passed, true);
  assert.equal(payload?.judgedBy, "model");
  assert.deepEqual(payload?.deviatedArtifacts, ["summary-file"]);
});
