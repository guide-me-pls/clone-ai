import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PlanStep, Run, Verifier, WorkPlan } from "../../src/core/contracts.ts";
import { CompositeVerifier, EvidenceVerifier } from "../../src/core/verification.ts";

test("verification distinguishes wrong type, unauthorized and missing paths without duplicate prefixes", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "verification-messages-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = join(parent, "workspace");
  const directory = join(workspace, "directory.txt");
  const outside = join(parent, "outside.txt");
  const missing = join(workspace, "missing.txt");
  await mkdir(directory, { recursive: true });
  await writeFile(outside, "existing file");

  const run: Run = { id: "run", taskId: "task", status: "verifying", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const step: PlanStep = {
    id: "step", title: "Deliverables", risk: "reversible_write",
    instructions: `File \`${directory}\` exists. File \`${outside}\` exists. File \`${missing}\` exists.`,
    acceptanceCriteria: [],
  };
  const plan: WorkPlan = { id: "plan", runId: run.id, summary: "Check files", steps: [step], createdAt: run.createdAt };
  const input = {
    run, plan,
    evidence: [{ id: "evidence", runId: run.id, stepId: step.id, kind: "observation" as const, summary: "Checked files", createdAt: run.createdAt }],
  };
  const evidenceVerifier = new EvidenceVerifier({ workspacePath: workspace });
  const passingStub: Verifier = { async verify() { return { runId: run.id, passed: true, summary: "Passed.", checkedEvidenceIds: [], createdAt: run.createdAt }; } };
  const evidenceResult = await evidenceVerifier.verify(input);
  const compositeResult = await new CompositeVerifier([evidenceVerifier, passingStub]).verify(input);

  assert.equal(evidenceResult.passed, false);
  assert.equal(compositeResult.passed, false);
  assert.deepEqual({
    directory: evidenceResult.summary.includes(`"${directory}" is a directory, not a promised file`),
    outside: evidenceResult.summary.includes(`"${outside}" is outside the roots this step may verify`),
    missing: evidenceResult.summary.includes(`"${missing}" was promised but does not exist on disk`),
    prefixes: (compositeResult.summary.match(/Verification failed\./gi) ?? []).length,
  }, { directory: true, outside: true, missing: true, prefixes: 1 }, `Evidence: ${evidenceResult.summary}\nComposite: ${compositeResult.summary}`);
});
