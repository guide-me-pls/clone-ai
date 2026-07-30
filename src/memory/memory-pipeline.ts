import { randomUUID } from "node:crypto";

import type { Evidence, JournalEvent, MemoryCandidate, Run, Task } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";

export interface PendingMemoryJob {
  run: Run;
  task: Task;
  evidence: Evidence[];
}

export interface MemoryWorker {
  extract(job: PendingMemoryJob): Promise<MemoryCandidate[]>;
}

/**
 * Memory is deliberately asynchronous. Completion of a user task records a
 * durable request, while extraction and later human/policy review happen out
 * of band. The worker never writes durable personal memory directly.
 *
 * Memory 被刻意设计为异步：任务完成只会写入一条持久化请求；提取以及后续的人或 Policy
 * 审核在主执行链之外进行。Worker 无权直接写入长期个人记忆。
 */
export class MemoryPipeline {
  readonly #journal: JournalStore;
  readonly #worker: MemoryWorker;
  #pending: PendingMemoryJob[] = [];

  constructor(journal: JournalStore, worker: MemoryWorker = new DeterministicMemoryWorker()) {
    this.#journal = journal;
    this.#worker = worker;
  }

  async request(run: Run, task: Task, evidence: Evidence[]): Promise<void> {
    await this.#journal.append({
      type: "memory.candidate.requested",
      runId: run.id,
      taskId: task.id,
      payload: {
        taskObjective: task.objective,
        sourceEvidenceIds: evidence.map((item) => item.id),
      },
    });
    this.#pending.push({ run, task, evidence });
  }

  async rebuild(): Promise<void> {
    const events = await this.#journal.list();
    const proposedRunIds = new Set(
      events.filter((event) => event.type === "memory.candidate.proposed").map((event) => event.runId),
    );

    const requested = events.filter((event) => event.type === "memory.candidate.requested");
    for (const request of requested) {
      if (request.runId === undefined || proposedRunIds.has(request.runId)) {
        continue;
      }
      const job = rehydrateJob(events, request);
      if (job !== undefined) {
        this.#pending.push(job);
      }
    }
  }

  async processNext(): Promise<MemoryCandidate[]> {
    const job = this.#pending.shift();
    if (job === undefined) {
      return [];
    }

    const candidates = await this.#worker.extract(job);
    for (const candidate of candidates) {
      await this.#journal.append({
        type: "memory.candidate.proposed",
        runId: candidate.runId,
        taskId: job.task.id,
        payload: candidate,
      });
    }
    return candidates;
  }
}

export class DeterministicMemoryWorker implements MemoryWorker {
  async extract(job: PendingMemoryJob): Promise<MemoryCandidate[]> {
    if (job.evidence.length === 0) {
      return [];
    }

    return [
      {
        id: randomUUID(),
        runId: job.run.id,
        sourceEvidenceIds: job.evidence.map((item) => item.id),
        summary: `候选流程：${job.task.objective}`,
        confidence: "low",
        status: "proposed",
        createdAt: new Date().toISOString(),
      },
    ];
  }
}

function rehydrateJob(events: JournalEvent[], request: JournalEvent): PendingMemoryJob | undefined {
  const run = events.find((event) => event.type === "run.created" && event.runId === request.runId)?.payload as Run | undefined;
  if (run === undefined) {
    return undefined;
  }

  const task = events.find((event) => event.type === "task.created" && event.taskId === request.taskId)?.payload as Task | undefined;
  if (task === undefined) {
    return undefined;
  }

  const evidence = events
    .filter((event) => event.type === "evidence.recorded" && event.runId === request.runId)
    .map((event) => event.payload as Evidence);
  return { run, task, evidence };
}
