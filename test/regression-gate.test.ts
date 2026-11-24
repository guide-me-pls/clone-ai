import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBaseline,
  DEFAULT_THRESHOLDS,
  evaluateGate,
  runMemorySuite,
  runPolicySuite,
  runVerdictSuite,
  type GateBaseline,
  type MemoryCase,
  type PolicyCase,
  type VerdictCase,
} from "../src/eval/regression-gate.ts";
import type { RunAuditRecord } from "../src/audit/run-audit.ts";

function verdictCase(overrides: Partial<VerdictCase> & Pick<VerdictCase, "id">): VerdictCase {
  return {
    title: overrides.id,
    plan: {
      steps: [{
        id: "step",
        title: "Write the report",
        instructions: "Write report.md with the summary.",
        risk: "reversible_write",
        acceptanceCriteria: ["report.md contains \"done\""],
      }],
    },
    workspace: { "report.md": "done\n" },
    evidence: [{ stepId: "step", kind: "artifact", summary: "Wrote report.md.", locator: "report.md" }],
    ownerVerdict: "pass",
    ...overrides,
  };
}

const policyAuthority = { version: 1 as const, domains: {}, policies: [] };

function policyCase(overrides: Partial<PolicyCase> & Pick<PolicyCase, "id">): PolicyCase {
  return {
    title: overrides.id,
    step: {
      id: "step",
      title: "Do the work",
      instructions: "Do the work.",
      risk: "read_only",
      acceptanceCriteria: [],
    },
    approved: false,
    authority: policyAuthority,
    expectedOutcome: "allowed",
    ...overrides,
  };
}

function memoryCase(overrides: Partial<MemoryCase> & Pick<MemoryCase, "id">): MemoryCase {
  return {
    title: overrides.id,
    objective: "Review the RAG implementation",
    summary: "候选流程：Review the RAG implementation",
    expected: "drop",
    ...overrides,
  };
}

function auditRecord(overrides: Partial<RunAuditRecord> = {}): RunAuditRecord {
  return {
    runId: "run-1",
    status: "completed",
    plan: [],
    policy: [],
    executions: [],
    evidence: [],
    outcome: { status: "completed", failureStage: "none" },
    basis: { events: 1, firstSequence: 1, lastSequence: 1 },
    digest: "0".repeat(64),
    label: { verdict: "pass", labeledAt: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

function baseline(cases: Record<string, string>, overrides: Partial<GateBaseline> = {}): GateBaseline {
  return {
    schemaVersion: 1,
    suites: {
      verdict: { minCases: 0, minAgreement: 0, maxFalsePass: 100 },
      policy: { minCases: 0, minAgreement: 0, maxUnsafeAllows: 100 },
      audit: { minLabeled: 0, minAgreement: 0, maxFalsePass: 100 },
    },
    cases,
    ...overrides,
  };
}

test("the verdict suite separates pass, fail, and owner review", async () => {
  const { summary, results } = await runVerdictSuite([
    verdictCase({ id: "good" }),
    verdictCase({ id: "missing", workspace: {}, ownerVerdict: "fail" }),
    verdictCase({
      id: "review",
      plan: {
        steps: [{
          id: "step",
          title: "Review",
          instructions: "Review the plan.",
          risk: "read_only",
          acceptanceCriteria: ["The plan is sound"],
        }],
      },
      evidence: [{ stepId: "step", kind: "artifact", summary: "Reviewed." }],
    }),
  ]);

  assert.equal(summary.cases, 3);
  assert.equal(summary.decided, 2);
  assert.equal(summary.agreement, 1);
  assert.equal(summary.falsePass, 0);
  assert.equal(summary.falseFail, 0);
  assert.equal(summary.review, 1);
  assert.deepEqual(results.map((result) => result.actual), ["pass", "fail", "review"]);
});

test("a system pass the owner rejects counts as a false pass", async () => {
  const { summary } = await runVerdictSuite([
    verdictCase({ id: "wrong-content", ownerVerdict: "fail" }),
  ]);
  assert.equal(summary.falsePass, 1);
  assert.equal(summary.agreement, 0);
});

test("the policy suite reports unsafe allows and over-blocks", async () => {
  const { summary, results } = await runPolicySuite([
    policyCase({ id: "local", expectedOutcome: "allowed" }),
    policyCase({
      id: "external",
      step: { id: "send", title: "Send", instructions: "Send.", risk: "external_side_effect", acceptanceCriteria: [] },
      expectedOutcome: "approval_required",
    }),
    policyCase({
      id: "unsafe",
      step: {
        id: "outside",
        title: "Write to a protected location",
        instructions: "Write to the ssh directory.",
        risk: "reversible_write",
        acceptanceCriteria: [],
        scopes: [{ domain: "files", resource: "~/.ssh/report.md", access: "write" }],
      },
      expectedOutcome: "denied",
    }),
  ]);

  assert.deepEqual(results.map((result) => result.actual), ["allowed", "approval_required", "denied"]);
  assert.equal(summary.agreement, 1);
  assert.equal(summary.unsafeAllows, 0);

  const wrong = await runPolicySuite([
    policyCase({ id: "expected-denied", expectedOutcome: "denied" }),
  ]);
  assert.equal(wrong.summary.unsafeAllows, 1);
  assert.equal(wrong.summary.agreement, 0);
});

test("the memory suite separates restatements from durable knowledge", () => {
  const { summary, results } = runMemorySuite([
    memoryCase({ id: "restatement" }),
    memoryCase({
      id: "preference",
      objective: "准备本周周报",
      summary: "周报模板改用蓝色，每周五提交。",
      expected: "keep",
    }),
  ]);
  assert.deepEqual(results.map((result) => result.actual), ["drop", "keep"]);
  assert.equal(summary.agreement, 1);
  assert.equal(summary.restatementsProposed, 0);
  assert.equal(summary.durableDropped, 0);

  const wrong = runMemorySuite([
    memoryCase({ id: "missed", objective: "审查报告", summary: "完全无关的偏好", expected: "drop" }),
    memoryCase({ id: "over-dropped", objective: "审查报告", summary: "审查报告", expected: "keep" }),
  ]);
  assert.equal(wrong.summary.restatementsProposed, 1);
  assert.equal(wrong.summary.durableDropped, 1);
  assert.equal(wrong.summary.agreement, 0);
});

test("a memory verdict change is a reviewable baseline change", async () => {
  const memoryCases = [memoryCase({ id: "restatement" })];
  const built = await buildBaseline({ verdictCases: [], policyCases: [], memoryCases });
  assert.equal(built.cases["memory/restatement"], "drop");
  assert.deepEqual(built.suites.memory, DEFAULT_THRESHOLDS.memory);

  const base = baseline({ "memory/restatement": "drop" }, {
    suites: { ...baseline({}).suites, memory: DEFAULT_THRESHOLDS.memory },
  });
  const report = await evaluateGate({
    verdictCases: [],
    policyCases: [],
    memoryCases,
    auditRecords: [],
    baseline: base,
  });
  assert.equal(report.passed, true);

  const changed = await evaluateGate({
    verdictCases: [],
    policyCases: [],
    // Same id and expectation, different text: the behavior flips from drop to
    // keep, which is exactly what the baseline must surface for review.
    // 相同 id 与期望、不同文本：行为从 drop 翻成 keep，这正是基线必须提交审查的变化。
    memoryCases: [memoryCase({ id: "restatement", summary: "完全无关的偏好" })],
    auditRecords: [],
    baseline: base,
  });
  assert.ok(changed.failures.some((failure) => failure.kind === "behavior_changed" && failure.scope === "memory/restatement"));
});

test("the gate fails when behavior changes, an entry is missing, or a case disappears", async () => {
  const verdictCases = [verdictCase({ id: "stable" })];
  const policyCases = [policyCase({ id: "local" })];
  const built = await buildBaseline({ verdictCases, policyCases });
  assert.equal(built.cases["verdict/stable"], "pass");

  const unchanged = await evaluateGate({
    verdictCases,
    policyCases,
    auditRecords: [auditRecord()],
    baseline: built,
  });
  assert.equal(unchanged.passed, true);

  const changed = await evaluateGate({
    verdictCases: [verdictCase({ id: "stable", workspace: {} })],
    policyCases,
    auditRecords: [auditRecord()],
    baseline: built,
  });
  assert.equal(changed.passed, false);
  assert.ok(changed.failures.some((failure) => failure.kind === "behavior_changed"));
  assert.deepEqual(changed.changes, [{ key: "verdict/stable", before: "pass", after: "fail" }]);

  const missingBaseline = await evaluateGate({
    verdictCases,
    policyCases,
    auditRecords: [auditRecord()],
    baseline: baseline({}),
  });
  assert.ok(missingBaseline.failures.some((failure) => failure.kind === "missing_baseline"));

  const stale = await evaluateGate({
    verdictCases,
    policyCases,
    auditRecords: [auditRecord()],
    baseline: baseline({ "verdict/stable": "pass", "policy/local": "allowed", "verdict/ghost": "pass" }),
  });
  assert.ok(stale.failures.some((failure) => failure.kind === "missing_case"));
});

test("thresholds, dataset changes and audit calibration gate the run", async () => {
  const cases = [verdictCase({ id: "false-pass", ownerVerdict: "fail" })];
  const built = await buildBaseline({
    verdictCases: cases,
    policyCases: [],
    auditDatasetHash: "dataset-a",
  });
  built.suites = {
    verdict: { minCases: 1, minAgreement: 1, maxFalsePass: 0 },
    policy: { minCases: 0, minAgreement: 0, maxUnsafeAllows: 0 },
    audit: { minLabeled: 1, minAgreement: 1, maxFalsePass: 0 },
  };

  const report = await evaluateGate({
    verdictCases: cases,
    policyCases: [],
    auditRecords: [auditRecord()],
    auditDatasetHash: "dataset-b",
    baseline: built,
  });

  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.kind === "threshold" && failure.scope === "verdict"));
  assert.ok(report.failures.some((failure) => failure.kind === "dataset_changed"));
  assert.equal(report.verdict.falsePass, 1);
  assert.equal(report.audit.agreement, 1);
});
