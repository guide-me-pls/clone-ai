import assert from "node:assert/strict";
import test from "node:test";

import { attachGatewayUsage, digestEvents, projectRunAudits, summarizeAudits } from "../src/audit/run-audit.ts";
import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FailingAdapter implements RuntimeAdapter {
  readonly id = "operator";
  readonly providerId = "pi";
  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true, work: ["general"], evidenceKinds: ["artifact", "observation"] };
  }
  async *execute(_input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    yield { type: "progress", message: "starting" };
    yield {
      type: "failed",
      message: "nonzero_exit: 400 could not connect to stream",
      report: { providerId: "pi", agentId: "operator", exitCode: 1, category: "nonzero_exit", detail: "400", signature: "nonzero exit 400", guidance: "" },
    };
  }
}

async function failedRun(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "clone-audit-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(dir, "journal.jsonl"));
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "do the thing", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "s",
    steps: [{ id: "s1", title: "work", instructions: "i", risk: "reversible_write", acceptanceCriteria: ["x"], agentId: "operator", requiredCapabilities: ["general"] }],
  });
  const result = await runtime.execute(run.id, new StaticAgentRegistry([new FailingAdapter()]));
  return { journal, run, result };
}

test("a failed step journals its reason and the audit names the stage, category and provider", async (t) => {
  const { journal, run, result } = await failedRun(t);
  assert.equal(result.status, "failed");
  const events = await journal.list();
  const failed = events.find((event) => event.type === "execution.failed");
  assert.ok(failed, "execution.failed must be journaled");

  const [record] = projectRunAudits(events);
  assert.equal(record!.runId, run.id);
  assert.equal(record!.outcome.failureStage, "execution");
  assert.equal(record!.outcome.failureCategory, "nonzero_exit");
  assert.match(record!.outcome.reason ?? "", /could not connect to stream/);
  assert.equal(record!.executions[0]!.providerId, "pi");
  assert.equal(record!.executions[0]!.outcome, "failed");
  assert.equal(record!.executions[0]!.progressEvents, 1);
  assert.equal(record!.policy[0]!.outcome, "allowed");
  assert.ok(typeof record!.durationMs === "number");
});

test("the digest is stable across reads and changes when an event changes", async (t) => {
  const { journal } = await failedRun(t);
  const events = await journal.list();
  assert.equal(digestEvents(events), digestEvents(await journal.list()));
  const tampered = events.map((event) => (event.type === "execution.failed" ? { ...event, payload: { ...(event.payload as object), message: "edited" } } : event));
  assert.notEqual(digestEvents(events), digestEvents(tampered));
  // The record digests the run's own events; task and trigger events carry no run id.
  // 记录的摘要覆盖该 Run 自己的事件；task 与 trigger 事件没有 run id。
  assert.equal(projectRunAudits(events)[0]!.digest, digestEvents(events.filter((event) => event.runId !== undefined)));
});

test("a failure with no journaled reason is reported as a finding, not a blank", () => {
  const base = { id: "e", occurredAt: "2026-11-03T00:00:00.000Z", payload: {} };
  const events = [
    { ...base, sequence: 1, type: "run.created" as const, runId: "r1", payload: {} },
    { ...base, sequence: 2, type: "run.status_changed" as const, runId: "r1", payload: { status: "failed" } },
  ];
  const [record] = projectRunAudits(events);
  assert.match(record!.outcome.reason ?? "", /No failure reason was journaled/);
});

test("gateway usage is attached by provider and time window, and labelled as inferred", async (t) => {
  const { journal } = await failedRun(t);
  const records = projectRunAudits(await journal.list());
  const execution = records[0]!.executions[0]!;
  const at = execution.startedAt!;
  attachGatewayUsage(records, [
    { t: at, agent: "pi", model: "google/gemini-4-argon", status: 400, in: 10, out: 0, cost: 0, err: "INVALID_ARGUMENT contents[3].parts[0].data" },
    { t: at, agent: "codex", status: 200, in: 99, out: 99, cost: 9 },
    { t: "2020-01-01T00:00:00.000Z", agent: "pi", status: 200, in: 5, out: 5, cost: 1 },
  ]);
  assert.equal(execution.gatewayUsage?.correlation, "time_window");
  assert.equal(execution.gatewayUsage?.calls, 1);
  assert.equal(execution.gatewayUsage?.errors, 1);
  assert.match(execution.gatewayUsage?.errorSamples[0]?.message ?? "", /INVALID_ARGUMENT/);
  const summary = summarizeAudits(records);
  assert.equal(summary.byProvider.pi?.failed, 1);
  assert.equal(summary.byFailureStage.execution, 1);
});

test("evaluation compares only runs the system judged, and labels need a finished run", async (t) => {
  const { summarizeAudits } = await import("../src/audit/run-audit.ts");
  const { labelRun } = await import("../src/audit/audit-service.ts");
  const base = { plan: [], policy: [], executions: [], evidence: [], basis: { events: 1, firstSequence: 1, lastSequence: 1 }, digest: "d", outcome: { status: "x", failureStage: "none" as const } };
  const at = new Date().toISOString();
  const rec = (runId: string, status: string, verdict?: "pass" | "fail") => ({ ...base, runId, status, createdAt: at, ...(verdict === undefined ? {} : { label: { verdict, labeledAt: at } }) });
  const summary = summarizeAudits([
    rec("a", "completed", "pass"),
    rec("b", "completed", "fail"),
    rec("c", "failed", "pass"),
    rec("d", "failed", "fail"),
    rec("e", "waiting_review", "pass"),
    rec("f", "completed"),
    rec("g", "waiting_review"),
  ]);
  assert.deepEqual(
    { labeled: summary.evaluation.labeled, agree: summary.evaluation.agree, falsePass: summary.evaluation.falsePass, falseFail: summary.evaluation.falseFail, unlabeled: summary.evaluation.unlabeledFinished },
    { labeled: 4, agree: 2, falsePass: 1, falseFail: 1, unlabeled: 2 },
  );
  assert.equal(summary.evaluation.agreement, 0.5);
  assert.equal(summary.passRate, 3 / 5, "waiting_review must not drag the pass rate down");

  const { journal } = await failedRun(t);
  const [record] = projectRunAudits(await journal.list());
  await assert.rejects(labelRun(journal, record!.runId, "maybe", ""), /pass|fail/);
  await assert.rejects(labelRun(journal, "nope", "pass", ""), /Unknown run/);
  await labelRun(journal, record!.runId, "fail", "  confirmed  ");
  const labeled = projectRunAudits(await journal.list())[0]!;
  assert.equal(labeled.label?.verdict, "fail");
  assert.equal(labeled.label?.note, "confirmed");
  assert.equal(labeled.digest, record!.digest, "a label is judgement, so it must not change the digest");
});

class UsageAdapter implements RuntimeAdapter {
  readonly id = "native-worker";
  readonly providerId = "native";
  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: false, work: ["general"], evidenceKinds: ["observation"] };
  }
  async *execute(_input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    yield { type: "session_started", sessionId: "session-usage" };
    yield { type: "evidence", evidence: { kind: "observation", summary: "did the work" } };
    yield {
      type: "completed",
      summary: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 2, durationMs: 12 },
    };
  }
}

test("exact adapter usage is journaled with run and step, and the audit shows it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "clone-audit-usage-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(dir, "journal.jsonl"));
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) });
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "do the thing", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "s",
    steps: [{ id: "s1", title: "work", instructions: "i", risk: "reversible_write", acceptanceCriteria: ["done"], agentId: "native-worker", requiredCapabilities: ["general"] }],
  });
  await runtime.execute(run.id, new StaticAgentRegistry([new UsageAdapter()]));

  const events = await journal.list();
  const usage = events.find((event) => event.type === "usage.recorded");
  assert.ok(usage, "usage.recorded must be journaled");
  const payload = usage.payload as Record<string, unknown>;
  assert.equal(payload.runId, run.id);
  assert.equal(payload.stepId, "s1");
  assert.equal(payload.source, "native-worker");
  assert.equal(payload.totalTokens, 15);
  assert.equal(payload.modelCalls, 2);

  const [record] = projectRunAudits(events);
  assert.deepEqual(record!.executions[0]!.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    modelCalls: 2,
  });
});
