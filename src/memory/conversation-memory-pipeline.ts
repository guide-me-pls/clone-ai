/**
 * Conversation memory as a thin wrapper over MemoryPipeline: the merge point
 * (recordConversationRequest) lives with the worker, the draining lives here,
 * and both read the journal so a restart loses nothing.
 *
 * 把对话记忆作为 MemoryPipeline 的薄包装：合并点（recordConversationRequest）与 Worker 放在一起，
 * 排空逻辑在这里，两者都读 Journal，因此重启不会丢东西。
 */
import { randomUUID } from "node:crypto";

import type { JournalStore } from "../core/journal.ts";
import { readTypes } from "../core/journal-types.ts";
import type { Evidence, MemoryCandidate, NewJournalEvent } from "../core/contracts.ts";
import { conversationJobsFromEvents, type ConversationTurn } from "./conversation-memory-worker.ts";
import type { MemoryPipeline } from "./memory-pipeline.ts";

const CONVERSATION_TYPES = [
  "memory.conversation.requested",
  "memory.conversation.extracted",
  "evidence.recorded",
  "memory.candidate.proposed",
  "memory.candidate.extracted",
] as const;

export class ConversationMemoryPipeline {
  readonly #journal: JournalStore;
  readonly #pipeline: MemoryPipeline;

  constructor(journal: JournalStore, pipeline: MemoryPipeline) {
    this.#journal = journal;
    this.#pipeline = pipeline;
  }

  /**
   * Accumulates one owner/assistant exchange into the pending conversation
   * batch. Only user text becomes evidence; the assistant's reply is context
   * the miner reads through the task objective, never a citation.
   * 把一次所有者/Assistant 交流累积到待处理的对话批次中。只有所有者的文字成为证据；Assistant
   * 的回复是提炼器通过任务目标读到的上下文，永不作为引用。
   */
  async record(input: { session: string; turns: readonly ConversationTurn[]; objective: string }): Promise<void> {
    const userTurns = input.turns.filter((turn) => turn.speaker === "user" && turn.text.trim().length > 0);
    if (userTurns.length === 0) return;
    // The journal's list() is a cached view; refresh so a batch drained by the
    // background loop and this new turn never disagree about what is open.
    // Journal 的 list() 是缓存视图；先刷新，使后台循环已处理的批次与本回合不会各执一词。
    await this.#journal.reload?.();
    const requested = await this.#journal.append({
      type: "memory.conversation.requested",
      runId: `conversation:${input.session}:${randomUUID().slice(0, 8)}`,
      payload: { session: input.session, taskObjective: input.objective },
    });
    const evidence: Evidence[] = userTurns.map((turn, index) => ({
      id: `conv:${input.session}:${requested.sequence}:${index}`,
      // The evidence belongs to the request that quoted it, so the miner can
      // rebuild one job per request from the journal alone.
      // 证据属于引用它的那次请求，因此提炼器仅凭 Journal 就能按请求重建任务。
      runId: requested.runId!,
      stepId: "conversation",
      producedBy: "owner",
      kind: "observation",
      summary: turn.text.trim().slice(0, 600),
      locator: `${input.session}#${index}`,
      createdAt: turn.at,
    }));
    const eventsToAppend: NewJournalEvent[] = evidence.map((item) => ({ type: "evidence.recorded", runId: item.runId, payload: item }));
    await this.#journal.appendBatch?.(eventsToAppend);
  }

  /** Drains every un-mined conversation batch, oldest first. 按从旧到新的顺序排空每个尚未提炼的对话批次。 */
  async processDue(): Promise<MemoryCandidate[]> {
    const drained: MemoryCandidate[] = [];
    // Conversation mining reads only its own request/extraction markers and the
    // evidence each request cites.
    // 对话提炼只读自己的请求/提炼标记，以及每个请求引用的证据。
    for (const job of conversationJobsFromEvents(await readTypes(this.#journal, CONVERSATION_TYPES))) {
      const candidates = await this.#pipeline.processJob(job);
      await this.#journal.append({
        type: "memory.conversation.extracted",
        runId: job.run.id,
        payload: { count: candidates.length, turns: job.evidence.length },
      });
      drained.push(...candidates);
    }
    return drained;
  }
}
