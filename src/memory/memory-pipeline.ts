import { randomUUID } from "node:crypto";

import type { Evidence, JournalEvent, MemoryCandidate, NewJournalEvent, Run, Task } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";
import { workspaceExecutionLock } from "../core/workspace-lock.ts";

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
  readonly #lockPath?: string;
  #pending: PendingMemoryJob[] = [];

  constructor(journal: JournalStore, worker: MemoryWorker = new DeterministicMemoryWorker(), options: { lockPath?: string } = {}) {
    this.#journal = journal;
    this.#worker = worker;
    this.#lockPath = options.lockPath;
  }

  async request(run: Run, task: Task, evidence: Evidence[]): Promise<void> {
    await this.#journal.append(this.requestEvent(run, task, evidence));
    this.enqueue(run, task, evidence);
  }

  requestEvent(run: Run, task: Task, evidence: Evidence[]): NewJournalEvent {
    return {
      type: "memory.candidate.requested",
      runId: run.id,
      taskId: task.id,
      payload: {
        taskObjective: task.objective,
        sourceEvidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  enqueue(run: Run, task: Task, evidence: Evidence[]): void {
    if (!this.#pending.some((job) => job.run.id === run.id)) this.#pending.push({ run, task, evidence });
  }

  async rebuild(): Promise<void> {
    const events = await this.#journal.list();
    const processedRunIds = processedRuns(events);

    const requested = events.filter((event) => event.type === "memory.candidate.requested");
    for (const request of requested) {
      if (request.runId === undefined || processedRunIds.has(request.runId)) {
        continue;
      }
      const job = rehydrateJob(events, request);
      if (job !== undefined) {
        this.enqueue(job.run, job.task, job.evidence);
      }
    }
  }

  async processNext(runId?: string): Promise<MemoryCandidate[]> {
    const index = runId === undefined ? 0 : this.#pending.findIndex((job) => job.run.id === runId);
    const job = index < 0 ? undefined : this.#pending.splice(index, 1)[0];
    if (job === undefined) {
      return [];
    }

    try {
      const process = async (): Promise<MemoryCandidate[]> => {
        await this.#journal.reload?.();
        if (processedRuns(await this.#journal.list()).has(job.run.id)) return [];
        const candidates = await this.#worker.extract(job);
        const evidence = new Set(job.evidence.map((item) => item.id));
        if (candidates.some((candidate) => candidate.runId !== job.run.id || candidate.sourceEvidenceIds.length === 0
          || candidate.sourceEvidenceIds.some((id) => !evidence.has(id)))) {
          throw new Error("A memory candidate cites evidence outside its source run.");
        }
        if (this.#journal.appendBatch === undefined) throw new Error("The journal cannot atomically publish memory candidates.");
        await this.#journal.appendBatch([
          ...candidates.map((candidate): NewJournalEvent => ({
            type: "memory.candidate.proposed", runId: job.run.id, taskId: job.task.id, payload: candidate,
          })),
          { type: "memory.candidate.extracted", runId: job.run.id, taskId: job.task.id, payload: { count: candidates.length } },
        ]);
        return candidates;
      };
      return this.#lockPath === undefined ? await process() : await workspaceExecutionLock.run(this.#lockPath, process);
    } catch (error) {
      this.enqueue(job.run, job.task, job.evidence);
      throw error;
    }
  }

  hasPending(): boolean {
    return this.#pending.length > 0;
  }
}

function processedRuns(events: readonly JournalEvent[]): Set<string> {
  return new Set(events
    .filter((event) => event.type === "memory.candidate.extracted" || event.type === "memory.candidate.proposed")
    .map((event) => event.runId)
    .filter((runId): runId is string => runId !== undefined));
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
