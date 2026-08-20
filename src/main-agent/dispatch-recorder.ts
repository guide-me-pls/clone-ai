import { randomUUID } from "node:crypto";

import type { JournalStore } from "../core/journal.ts";
import type { DispatchBlocked, DispatchDecision, WorkerInvocation } from "./dispatch-contracts.ts";

/**
 * Persists the routing decision before a worker process is spawned.
 *
 * Recording after the fact would be worthless for the case that matters: if the
 * supervisor dies mid-dispatch, the journal must still show which worker was
 * chosen and why. Writing first also makes "the owner asked for codex but pi
 * ran" a detectable contradiction rather than an untraceable one.
 *
 * 在启动 Worker 进程之前持久化路由决策。
 *
 * 事后补记对最关键的场景毫无价值：若 Supervisor 在派发中途死掉，Journal 仍必须显示当时
 * 选了哪个 Worker、为什么选它。先写入也让"所有者要 codex 却跑了 pi"成为可检测的矛盾，
 * 而不是无从追查的事故。
 */

export interface DispatchRecorder {
  recordDecision(decision: DispatchDecision): Promise<void>;
  recordBlocked(blocked: DispatchBlocked): Promise<void>;
  recordInvocation(invocation: WorkerInvocation): Promise<void>;
}

export class JournalDispatchRecorder implements DispatchRecorder {
  readonly #journal: JournalStore;

  constructor(journal: JournalStore) {
    this.#journal = journal;
  }

  async recordDecision(decision: DispatchDecision): Promise<void> {
    await this.#journal.append({
      type: "subagent.dispatched",
      runId: decision.taskId,
      payload: {
        kind: "dispatch.decision",
        taskId: decision.taskId,
        selectedAgentId: decision.selectedAgentId,
        providerId: decision.providerId,
        source: decision.source,
        matchedRuleIds: decision.matchedRuleIds,
        usedMemoryIds: decision.usedMemoryIds,
        alternatives: decision.alternatives,
        reason: decision.reason,
        sessionPolicy: decision.sessionPolicy,
        intentKind: decision.intent.kind,
        explicitAgentId: decision.intent.explicitAgentId,
        excludedAgentIds: decision.intent.excludedAgentIds,
        createdAt: decision.createdAt,
      },
    });
  }

  async recordBlocked(blocked: DispatchBlocked): Promise<void> {
    await this.#journal.append({
      type: "subagent.failed",
      runId: blocked.taskId,
      payload: {
        kind: "dispatch.blocked",
        taskId: blocked.taskId,
        code: blocked.code,
        reason: blocked.reason,
        requestedAgentId: blocked.requestedAgentId,
        consideredAgentIds: blocked.consideredAgentIds,
      },
    });
  }

  async recordInvocation(invocation: WorkerInvocation): Promise<void> {
    await this.#journal.append({
      type: "subagent.session_started",
      runId: invocation.taskId,
      payload: {
        kind: "dispatch.invocation",
        invocationId: invocation.invocationId,
        taskId: invocation.taskId,
        selectedAgentId: invocation.selectedAgentId,
        providerId: invocation.providerId,
        sessionPolicy: invocation.sessionPolicy,
        memorySourceIds: invocation.memorySourceIds,
        // The prompt is not journaled: it embeds the memory context, and the
        // memory ids above already make the injection auditable.
        // 不记录 Prompt 本身：它内嵌了记忆上下文，而上面的记忆 ID 已足以审计注入内容。
        promptCharacters: invocation.prompt.length,
        createdAt: invocation.createdAt,
      },
    });
  }
}

export function newInvocation(input: {
  taskId: string;
  selectedAgentId: string;
  providerId: string;
  prompt: string;
  memorySourceIds: readonly string[];
  now?: string;
}): WorkerInvocation {
  return {
    invocationId: randomUUID(),
    taskId: input.taskId,
    selectedAgentId: input.selectedAgentId,
    providerId: input.providerId,
    sessionPolicy: "fresh",
    prompt: input.prompt,
    memorySourceIds: input.memorySourceIds,
    createdAt: input.now ?? new Date().toISOString(),
  };
}
