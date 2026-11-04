/**
 * ConversationMemoryWorker mines memories from what the owner says in chat.
 *
 * Task-run mining only sees a finished task's evidence, so anything the owner
 * states without asking for work - a preference, a constraint, a fact about
 * themselves - never becomes a memory unless they add it by hand. That is the
 * largest functional gap against companion products, which learn from
 * conversation. This worker closes it without bypassing the existing gate:
 * every candidate continues to need owner approval, evidence that really
 * exists, and a PII check before it becomes durable memory.
 *
 * 从所有者在对话里说的话中提炼记忆。
 *
 * 任务提炼只看已结束任务的 Evidence，因此所有者没有要求干活时说的话——一条偏好、一个约束、
 * 一件关于自己的事实——除非手工添加，否则永远不会成为记忆。这是与陪伴类产品最大的功能差距，
 * 它们会从对话中学习。本 Worker 在不绕过现有门禁的前提下补齐它：每条候选仍需所有者批准、
 * 引用真实存在的证据，并在成为持久记忆前经过 PII 检查。
 */
import { randomUUID } from "node:crypto";

import type { Evidence, JournalEvent, MemoryCandidate } from "../core/contracts.ts";
import {
  AgentMemoryWorker,
  miningPrompt,
  validateCandidates,
  type AgentMemoryWorkerOptions,
} from "./agent-memory-worker.ts";
import type { MemoryWorker, PendingMemoryJob } from "./memory-pipeline.ts";

export interface ConversationTurn {
  at: string;
  speaker: "user" | "assistant";
  text: string;
}

/**
 * The evidence ids are derived, not random: `conv:<session>:<index>` is stable
 * across re-mining, so a candidate's citation can be checked against the
 * transcript and a duplicate run cannot invent new ids.
 * 证据 id 是推导出来的而非随机的：`conv:<session>:<index>` 在重复提炼时保持稳定，因此候选的
 * 引用可对照对话记录核查，重复运行也无法编造新的 id。
 */
export function conversationEvidenceId(session: string, index: number): string {
  return `conv:${session}:${index}`;
}

/** Only the owner's own words are candidates for a memory; assistant text is untrusted. 只有所有者自己的话可作为记忆来源；Assistant 文本不可信。 */
export function conversationEvidence(turns: readonly ConversationTurn[], session: string): Array<Pick<Evidence, "id" | "kind" | "summary" | "locator"> & { at: string }> {
  return turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.speaker === "user" && turn.text.trim().length > 0)
    .map(({ turn, index }) => ({
      id: conversationEvidenceId(session, index),
      kind: "observation" as const,
      summary: turn.text.trim().slice(0, 600),
      locator: `${session}#${index}`,
      at: turn.at,
    }));
}

/**
 * Runs after the owner's turn: appends the conversation evidence and a
 * `memory.conversation.requested` event, so the
 * journal alone can rebuild the job after a restart. Returns the evidence ids
 * actually written (already journaled ones are skipped, keeping this idempotent).
 * 在所有者这一回合之后运行：写入对话证据，以及一条携带 `source: "conversation"` 的
 * `memory.conversation.requested` 事件，使仅凭 Journal 就能在重启后重建任务。返回真正写入的证据 id
 * （已入账的会跳过，从而保持幂等）。
 */
export async function recordConversationRequest(input: {
  journal: { list(): Promise<JournalEvent[]>; appendBatch(events: readonly import("../core/contracts.ts").NewJournalEvent[]): Promise<JournalEvent[]> };
  runId: string;
  session: string;
  turns: readonly ConversationTurn[];
  objective: string;
}): Promise<string[]> {
  const evidence = conversationEvidence(input.turns, input.session);
  if (evidence.length === 0) return [];
  const existing = new Set((await input.journal.list())
    .filter((event) => event.type === "evidence.recorded" && event.runId === input.runId)
    .map((event) => (event.payload as { id?: unknown }).id));
  const fresh = evidence.filter((item) => !existing.has(item.id));
  const already = (await input.journal.list()).some((event) => event.type === "memory.conversation.requested" && event.runId === input.runId);
  if (already) return [];
  await input.journal.appendBatch([
    ...fresh.map((item) => ({
      type: "evidence.recorded" as const,
      runId: input.runId,
      payload: {
        id: item.id,
        runId: input.runId,
        stepId: "conversation",
        producedBy: "owner",
        kind: "observation" as const,
        summary: item.summary,
        ...(item.locator === undefined ? {} : { locator: item.locator }),
        createdAt: item.at,
        },
    })),
    {
      type: "memory.conversation.requested" as const,
      runId: input.runId,
      payload: {
        taskObjective: input.objective,
        sourceEvidenceIds: evidence.map((item) => item.id),
        source: "conversation",
        outcome: "completed",
      },
    },
  ]);
  return evidence.map((item) => item.id);
}

export interface ConversationMemoryWorkerOptions {
  miner?: AgentMemoryWorkerOptions;
  /** Caps how many candidates one conversation batch may propose. 一批对话最多可提出多少条候选。 */
  maxCandidates?: number;
}

/**
 * Wraps the task miner with a conversation-specific prompt. Reusing the miner's
 * validation means conversation candidates face exactly the same evidence and
 * shape checks as task candidates.
 * 用对话专用的 Prompt 包装任务提炼器。复用其校验，意味着对话候选与任务候选面对完全相同的
 * 证据与形态检查。
 */
export class ConversationMemoryWorker implements MemoryWorker {
  readonly #miner: AgentMemoryWorker;
  readonly #maxCandidates: number;

  constructor(options: ConversationMemoryWorkerOptions = {}) {
    this.#miner = new AgentMemoryWorker(options.miner ?? {});
    this.#maxCandidates = options.maxCandidates ?? 3;
  }

  async extract(job: PendingMemoryJob): Promise<MemoryCandidate[]> {
    const conversationJob: PendingMemoryJob = { ...job, promptOverride: conversationPrompt(job) };
    const raw = await this.#miner.extractRaw(conversationJob);
    if (raw === undefined) return [];
    return validateCandidates(raw, job, this.#maxCandidates);
  }
}

/** The conversation prompt: durable statements only, in the owner's own words. 对话 Prompt：只提炼持久陈述，并保留所有者的原话。 */
export function conversationPrompt(job: PendingMemoryJob): string {
  return [
    "The owner's messages below are from an ordinary conversation, not a task.",
    "Extract only durable, owner-specific statements they would expect you to remember: preferences, constraints, standing decisions, plans, relationships, and facts about their work or life.",
    "Ignore greetings, questions about the system, one-off tasks, and anything the assistant said.",
    "Never invent; if nothing qualifies, return [].",
    "",
    miningPrompt({ ...job, task: { ...job.task, objective: "Conversation with the owner" } }),
  ].join("\n");
}

/**
 * Rebuilds one miner job per un-drained conversation request, oldest first, so
 * a burst of turns is mined in order instead of only the newest one.
 * 为每个尚未处理的对话请求各重建一个提炼任务（最旧在前），使连续多轮对话按顺序提炼，
 * 而不是只处理最新的一条。
 */
export function conversationJobsFromEvents(events: readonly JournalEvent[]): PendingMemoryJob[] {
  const extracted = new Set(events
    .filter((event) => event.type === "memory.conversation.extracted")
    .map((event) => event.runId)
    .filter((runId): runId is string => runId !== undefined));
  const jobs: PendingMemoryJob[] = [];
  for (const request of events.filter((event) => event.type === "memory.conversation.requested")) {
    if (request.runId === undefined || extracted.has(request.runId)) continue;
    const recorded = events
      .filter((event) => event.type === "evidence.recorded" && event.runId === request.runId)
      .map((event) => event.payload as Evidence);
    if (recorded.length === 0) continue;
    const createdAt = recorded[0]?.createdAt ?? request.occurredAt;
    const objective = "Conversation with the owner";
    const job: PendingMemoryJob = {
      run: { id: request.runId, taskId: `${request.runId}:task`, status: "completed", createdAt, updatedAt: createdAt },
      task: { id: `${request.runId}:task`, triggerId: "conversation", title: "Conversation", objective, acceptanceCriteria: [], createdAt },
      evidence: recorded,
      outcome: "completed",
    };
    jobs.push({ ...job, promptOverride: conversationPrompt(job) });
  }
  return jobs;
}
