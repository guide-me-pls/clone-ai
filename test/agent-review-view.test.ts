/**
 * A work order that needs the owner must carry the decision into the main
 * conversation, not only into its task record. This pins the payload the row
 * renders: the run id, the missing criterion and the verification summary.
 *
 * 需要所有者的工作单必须把决定带进主对话，而不仅是任务记录。这固定了行渲染所需的载荷：
 * Run id、缺失标准与验证摘要。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCompanionServer } from "../src/companion-server.ts";
import { SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { companionFetch } from "./helpers/companion-api.ts";

const TASK_ID = "task-review";
const RUN_ID = "run-review";
const SUBAGENT_ID = "agent-review";
const CONVERSATION_ID = "main-agent-conversation";

async function seedReviewJournal(dataDirectory: string): Promise<void> {
  const journal = new SqliteJournalStore(join(dataDirectory, "journal.sqlite3"));
  try {
    await journal.append({
      type: "trigger.received",
      payload: {
        id: "trigger-review",
        kind: "query",
        summary: "准备本地交付物",
        occurredAt: "2026-11-24T00:00:00.000Z",
        payload: { source: "main-agent", conversationId: CONVERSATION_ID },
      },
    });
    await journal.append({
      type: "task.created",
      taskId: TASK_ID,
      payload: {
        id: TASK_ID,
        triggerId: "trigger-review",
        title: "准备本地交付物",
        objective: "准备本地交付物",
        acceptanceCriteria: [],
        createdAt: "2026-11-24T00:00:01.000Z",
      },
    });
    await journal.append({
      type: "run.created",
      taskId: TASK_ID,
      runId: RUN_ID,
      payload: {
        id: RUN_ID,
        taskId: TASK_ID,
        status: "waiting_review",
        createdAt: "2026-11-24T00:00:02.000Z",
        updatedAt: "2026-11-24T00:00:05.000Z",
      },
    });
    await journal.append({
      type: "subagent.dispatched",
      taskId: TASK_ID,
      runId: RUN_ID,
      payload: {
        id: SUBAGENT_ID,
        runId: RUN_ID,
        stepId: "step-review",
        workOrderId: "order-review",
        agentId: "native-worker",
        providerId: "native",
        role: "worker",
        title: "准备本地交付物",
        status: "completed",
        attempt: 1,
        startedAt: "2026-11-24T00:00:03.000Z",
        updatedAt: "2026-11-24T00:00:04.000Z",
      },
    });
    await journal.append({
      type: "subagent.completed",
      taskId: TASK_ID,
      runId: RUN_ID,
      payload: { workOrderId: "order-review", summary: "Read the README." },
    });
    await journal.append({
      type: "verification.completed",
      taskId: TASK_ID,
      runId: RUN_ID,
      payload: {
        runId: RUN_ID,
        passed: false,
        needsReview: true,
        unverifiedCriteria: ["summary.md"],
        summary: "The worker's answer is available, but the promised artifact is missing: summary.md. The owner decides.",
        checkedEvidenceIds: [],
        createdAt: "2026-11-24T00:00:05.000Z",
      },
    });
  } finally {
    journal.close();
  }
}

test("the main conversation carries the work-order review on its subagent row", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-agent-review-"));
  await seedReviewJournal(dataDirectory);
  const server = await startCompanionServer({ port: 0, dataDirectory });
  t.after(async () => {
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const response = await companionFetch(server.url, server.token, `/api/sessions/${CONVERSATION_ID}`);
  assert.equal(response.status, 200);
  const conversation = await response.json() as {
    subagents: Array<{ id: string; runId: string; review?: { runId: string; summary: string; unverifiedCriteria: string[] } }>;
  };
  assert.equal(conversation.subagents.length, 1);
  assert.equal(conversation.subagents[0]!.id, SUBAGENT_ID);
  assert.equal(conversation.subagents[0]!.review?.runId, RUN_ID);
  assert.deepEqual(conversation.subagents[0]!.review?.unverifiedCriteria, ["summary.md"]);
  assert.match(conversation.subagents[0]!.review?.summary ?? "", /The owner decides/);
});
