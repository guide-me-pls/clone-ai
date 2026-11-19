/**
 * A subagent row in Agent 协作 must be able to name the task record that
 * explains it. The row itself has no destination; the run does. These checks
 * pin the payload field the UI turns into a link, for both views that show the
 * card: the conversation that aggregates subagents from several runs, and the
 * task record that owns one run.
 * Agent 协作 里的子 Agent 行必须能指出解释它的任务记录。行本身没有目的地，Run 有。这些
 * 检查固定界面用来生成链接的载荷字段，覆盖显示该卡片的两种视图：聚合多个 Run 子 Agent 的
 * 对话，以及拥有单个 Run 的任务记录。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCompanionServer } from "../src/companion-server.ts";
import { SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { companionFetch } from "./helpers/companion-api.ts";

const TASK_ID = "task-deliverable";
const RUN_ID = "run-deliverable";
const SUBAGENT_ID = "agent-deliverable";
const CONVERSATION_ID = "main-agent-conversation";

async function seedJournal(dataDirectory: string): Promise<void> {
  const journal = new SqliteJournalStore(join(dataDirectory, "journal.sqlite3"));
  try {
    await journal.append({
      type: "trigger.received",
      payload: {
        id: "trigger-deliverable",
        kind: "query",
        summary: "准备本地交付物",
        occurredAt: "2026-11-19T00:00:00.000Z",
        payload: { source: "main-agent", conversationId: CONVERSATION_ID },
      },
    });
    await journal.append({
      type: "task.created",
      taskId: TASK_ID,
      payload: {
        id: TASK_ID,
        triggerId: "trigger-deliverable",
        title: "准备本地交付物",
        objective: "准备本地交付物",
        acceptanceCriteria: [],
        createdAt: "2026-11-19T00:00:01.000Z",
      },
    });
    await journal.append({
      type: "run.created",
      taskId: TASK_ID,
      runId: RUN_ID,
      payload: {
        id: RUN_ID,
        taskId: TASK_ID,
        status: "failed",
        createdAt: "2026-11-19T00:00:02.000Z",
        updatedAt: "2026-11-19T00:00:05.000Z",
        failureReason: "Subagent draft did not satisfy its artifact contract.",
      },
    });
    await journal.append({
      type: "subagent.dispatched",
      taskId: TASK_ID,
      runId: RUN_ID,
      payload: {
        id: SUBAGENT_ID,
        runId: RUN_ID,
        stepId: "step-deliverable",
        workOrderId: "order-deliverable",
        agentId: "native-worker",
        providerId: "native",
        role: "worker",
        title: "准备本地交付物",
        status: "running",
        attempt: 1,
        startedAt: "2026-11-19T00:00:03.000Z",
        updatedAt: "2026-11-19T00:00:03.000Z",
      },
    });
    await journal.append({
      type: "subagent.failed",
      taskId: TASK_ID,
      runId: RUN_ID,
      payload: {
        workOrderId: "order-deliverable",
        message: "Subagent draft did not satisfy its artifact contract.",
      },
    });
  } finally {
    journal.close();
  }
}

test("both views name the run that owns each subagent row", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-agent-links-"));
  await seedJournal(dataDirectory);
  const server = await startCompanionServer({ port: 0, dataDirectory });
  t.after(async () => {
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const conversationResponse = await companionFetch(server.url, server.token, `/api/sessions/${CONVERSATION_ID}`);
  assert.equal(conversationResponse.status, 200);
  const conversation = await conversationResponse.json() as {
    subagents: Array<{ id: string; runId: string; title: string; status: string }>;
  };
  assert.equal(conversation.subagents.length, 1);
  assert.equal(conversation.subagents[0]!.id, SUBAGENT_ID);
  assert.equal(conversation.subagents[0]!.runId, RUN_ID);
  assert.equal(conversation.subagents[0]!.title, "准备本地交付物");
  assert.equal(conversation.subagents[0]!.status, "failed");

  const recordResponse = await companionFetch(server.url, server.token, `/api/sessions/${RUN_ID}`);
  assert.equal(recordResponse.status, 200);
  const record = await recordResponse.json() as {
    subagents: Array<{ id: string; runId: string }>;
  };
  assert.equal(record.subagents.length, 1);
  assert.equal(record.subagents[0]!.runId, RUN_ID);
});
