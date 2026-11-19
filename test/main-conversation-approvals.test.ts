import assert from "node:assert/strict";
import test from "node:test";

import { mainConversationApprovals, mainConversationReviews, runResultByRun } from "../src/companion-server.ts";
import type { JournalEvent } from "../src/core/contracts.ts";

test("the main conversation carries every waiting run by its own id", () => {
  const runs = [
    { id: "run-approval", status: "waiting_approval", activeStepId: "step-external", taskId: "task-approval" },
    { id: "run-completed", status: "completed", taskId: "task-done" },
    { id: "run-no-step", status: "waiting_approval", taskId: "task-empty" },
  ] as unknown as Parameters<typeof mainConversationApprovals>[0];
  const tasks = {
    "task-approval": { title: "Publish the report" },
    "task-done": { title: "Finished work" },
    "task-empty": { title: "Waiting without a step" },
  };
  const approvals = mainConversationApprovals(runs, tasks);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.runId, "run-approval");
  assert.equal(approvals[0]!.stepId, "step-external");
  assert.equal(approvals[0]!.title, "Publish the report");
});

test("no waiting run means no approvals", () => {
  const runs = [{ id: "run-done", status: "completed", taskId: "task" }] as unknown as Parameters<typeof mainConversationApprovals>[0];
  assert.deepEqual(mainConversationApprovals(runs, { task: { title: "Done" } }), []);
});

test("the main conversation carries waiting reviews with their criteria", () => {
  const runs = [
    { id: "run-review", status: "waiting_review", taskId: "task-review" },
    { id: "run-other", status: "completed", taskId: "task-other" },
  ] as unknown as Parameters<typeof mainConversationReviews>[0];
  const tasks = { "task-review": { title: "Review the report" }, "task-other": { title: "Done" } };
  const verification = {
    runId: "run-review",
    passed: false,
    needsReview: true,
    unverifiedCriteria: ["The rendered page shows the requested detail."],
    summary: "A browser check is still unverified.",
    checkedEvidenceIds: [],
    createdAt: "2026-11-18T00:00:00.000Z",
  };
  const reviews = mainConversationReviews(runs, tasks, { "run-review": verification });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.runId, "run-review");
  assert.equal(reviews[0]!.title, "Review the report");
  assert.deepEqual(reviews[0]!.verification.unverifiedCriteria, verification.unverifiedCriteria);
});

test("a review carries the worker's answer, not only the criteria", () => {
  const runs = [{ id: "run-review", status: "waiting_review", taskId: "task-review" }] as unknown as Parameters<typeof mainConversationReviews>[0];
  const tasks = { "task-review": { title: "Review the report" } };
  const verification = {
    runId: "run-review",
    passed: false,
    needsReview: true,
    unverifiedCriteria: ["The page shows the detail."],
    summary: "A browser check is still unverified.",
    checkedEvidenceIds: [],
    createdAt: "2026-11-18T00:00:00.000Z",
  };
  const reviews = mainConversationReviews(runs, tasks, { "run-review": verification }, {
    "run-review": { summary: "The page renders the requested detail; two checks remain manual." },
  });
  assert.equal(reviews[0]!.result, "The page renders the requested detail; two checks remain manual.");
});

test("a single-agent completion becomes the run's result, while subagent summaries fill the gap", () => {
  const event = (sequence: number, type: JournalEvent["type"], runId: string, payload: Record<string, unknown>, occurredAt: string) => ({
    id: `e-${sequence}`, sequence, type, occurredAt, runId, payload,
  }) as unknown as JournalEvent;
  const results = runResultByRun([
    event(1, "execution.started", "run-a", { stepId: "s1" }, "2026-11-18T00:00:01.000Z"),
    event(2, "execution.completed", "run-a", { stepId: "s1", summary: "The review found three gaps." }, "2026-11-18T00:00:02.000Z"),
    event(3, "subagent.completed", "run-b", { workOrderId: "w1", summary: "First work order finished." }, "2026-11-18T00:00:03.000Z"),
    event(4, "subagent.completed", "run-b", { workOrderId: "w2", summary: "Second work order finished." }, "2026-11-18T00:00:04.000Z"),
  ]);
  assert.equal(results["run-a"]?.summary, "The review found three gaps.");
  assert.match(results["run-b"]?.summary ?? "", /First work order finished\.\n\nSecond work order finished\./);
  assert.equal(results["run-c"], undefined);
});
