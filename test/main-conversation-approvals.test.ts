import assert from "node:assert/strict";
import test from "node:test";

import { mainConversationApprovals, mainConversationReviews } from "../src/companion-server.ts";

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
