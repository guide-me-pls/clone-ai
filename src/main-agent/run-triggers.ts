/**
 * Which conversation asked for a Main Agent-proposed run.
 *
 * The trigger is the durable place the answer lives: `dispatch_task` and
 * `propose_work_plan` write `source: "main-agent"` and the conversation id
 * there, and the task and run point back at the trigger. Reading it back is
 * what lets a turn attribute only its own runs — a time-window diff would let
 * two concurrent conversations claim each other's work.
 *
 * 哪个对话请求了 Main Agent 提案的 Run。
 *
 * 答案持久保存在 Trigger 里：`dispatch_task` 与 `propose_work_plan` 在那里写入
 * `source: "main-agent"` 与对话 id，Task 与 Run 指回该 Trigger。读回它，回合才能只认领
 * 自己的 Run——按时间窗口做差集会让两个并发对话互相认领对方的工作。
 */
import type { JournalEvent } from "../core/contracts.ts";
import { conversationIdOf } from "./conversation.ts";

/** Runs the Main Agent proposed, keyed by run id, valued by conversation id. 由 Main Agent 提案的 Run，键为 Run id，值为对话 id。 */
export function mainAgentRunConversations(events: readonly JournalEvent[]): Map<string, string> {
  const triggerByTask = new Map<string, { source: string; conversationId: string }>();
  for (const event of events) {
    if (event.type !== "trigger.received") continue;
    const trigger = asRecord(event.payload);
    if (typeof trigger.id !== "string") continue;
    const payload = asRecord(trigger.payload);
    triggerByTask.set(trigger.id, {
      source: String(payload.source ?? ""),
      conversationId: conversationIdOf(typeof payload.conversationId === "string" ? payload.conversationId : undefined),
    });
  }
  const taskTrigger = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "task.created" || event.taskId === undefined) continue;
    const payload = asRecord(event.payload);
    if (typeof payload.triggerId === "string") taskTrigger.set(event.taskId, payload.triggerId);
  }
  const derived = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "run.created" || event.runId === undefined || event.taskId === undefined) continue;
    const triggerId = taskTrigger.get(event.taskId);
    if (triggerId === undefined) continue;
    const trigger = triggerByTask.get(triggerId);
    if (trigger?.source === "main-agent") derived.set(event.runId, trigger.conversationId);
  }
  return derived;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
