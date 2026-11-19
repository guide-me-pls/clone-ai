import assert from "node:assert/strict";
import test from "node:test";

import { mainAgentRunConversations } from "../src/main-agent/run-triggers.ts";
import type { JournalEvent } from "../src/core/contracts.ts";

function event(type: JournalEvent["type"], payload: unknown, extra: Partial<JournalEvent> = {}): JournalEvent {
  return {
    sequence: 0,
    occurredAt: "2026-11-18T00:00:00.000Z",
    type,
    payload,
    ...extra,
  } as JournalEvent;
}

function scenario(input: {
  runId: string;
  taskId: string;
  triggerId: string;
  source: string;
  conversationId?: string;
}): JournalEvent[] {
  return [
    event("trigger.received", {
      id: input.triggerId,
      kind: "query",
      summary: "task",
      payload: {
        source: input.source,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      },
    }),
    event("task.created", { triggerId: input.triggerId }, { taskId: input.taskId }),
    event("run.created", { status: "planning" }, { runId: input.runId, taskId: input.taskId }),
  ];
}

test("a run belongs to the conversation named in its trigger", () => {
  const events = [
    ...scenario({ runId: "run-a", taskId: "task-a", triggerId: "trigger-a", source: "main-agent", conversationId: "conversation-a" }),
    ...scenario({ runId: "run-b", taskId: "task-b", triggerId: "trigger-b", source: "main-agent", conversationId: "conversation-b" }),
    // A run proposed before the conversation field existed belongs to the main
    // conversation, not to whichever task happened to run nearby.
    // conversation 字段出现之前提案的 Run 属于主对话，而不是附近运行的某个任务。
    ...scenario({ runId: "run-legacy", taskId: "task-legacy", triggerId: "trigger-legacy", source: "main-agent" }),
    // A desktop request is not a Main Agent task at all. 桌面请求根本不是 Main Agent 任务。
    ...scenario({ runId: "run-desktop", taskId: "task-desktop", triggerId: "trigger-desktop", source: "desktop-client" }),
  ];
  const map = mainAgentRunConversations(events);
  assert.equal(map.get("run-a"), "conversation-a");
  assert.equal(map.get("run-b"), "conversation-b");
  assert.equal(map.get("run-legacy"), "main-agent-conversation");
  assert.equal(map.has("run-desktop"), false);
});
