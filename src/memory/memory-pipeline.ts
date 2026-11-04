import { randomUUID } from "node:crypto";

import type { Evidence, JournalEvent, MemoryCandidate, NewJournalEvent, Run, Task } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";
import { workspaceExecutionLock } from "../core/workspace-lock.ts";

export interface PendingMemoryJob {
  run: Run;
  task: Task;
  evidence: Evidence[];
  /**
   * How the run ended. A failed run is mined for lessons (what went wrong and
   * how to avoid it) rather than for facts about a delivered result.
   * Run 的结局。失败的 Run 被用来提炼教训（哪里出错、如何避免），而不是交付结果的事实。
   */
  outcome?: "completed" | "failed";
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

  async request(run: Run, task: Task, evidence: Evidence[], outcome: "completed" | "failed" = "completed"): Promise<void> {
    await this.#journal.append(this.requestEvent(run, task, evidence, outcome));
    this.enqueue(run, task, evidence, outcome);
  }

  requestEvent(run: Run, task: Task, evidence: Evidence[], outcome: "completed" | "failed" = "completed"): NewJournalEvent {
    return {
      type: "memory.candidate.requested",
      runId: run.id,
      taskId: task.id,
      payload: {
        taskObjective: task.objective,
        sourceEvidenceIds: evidence.map((item) => item.id),
        outcome,
      },
    };
  }

  /**
   * Requests mining for a run that is already in the journal, e.g. one the owner
   * later labeled a failure. Returns false when the run cannot be rebuilt or was
   * already requested for this outcome.
   * 为已在 Journal 中的 Run 请求提炼，例如所有者事后标为失败的 Run。Run 无法重建或该结局已请求过时返回 false。
   */
  async requestFromJournal(runId: string, outcome: "completed" | "failed"): Promise<boolean> {
    const events = await this.#journal.list();
    const already = events.some((event) => event.type === "memory.candidate.requested" && event.runId === runId
      && ((event.payload as { outcome?: unknown } | null)?.outcome === "failed" ? "failed" : "completed") === outcome);
    if (already) return false;
    const taskId = events.find((event) => event.type === "run.created" && event.runId === runId)?.taskId;
    if (taskId === undefined) return false;
    const job = rehydrateJob(events, { runId, taskId, payload: { outcome } } as JournalEvent);
    if (job === undefined) return false;
    await this.request(job.run, job.task, job.evidence, outcome);
    return true;
  }

  enqueue(run: Run, task: Task, evidence: Evidence[], outcome: "completed" | "failed" = "completed"): void {
    if (!this.#pending.some((job) => job.run.id === run.id && (job.outcome ?? "completed") === outcome)) this.#pending.push({ run, task, evidence, outcome });
  }

  async rebuild(): Promise<void> {
    const events = await this.#journal.list();
    const processedRunIds = processedRuns(events);

    const requested = events.filter((event) => event.type === "memory.candidate.requested");
    for (const request of requested) {
      const requestOutcome = (request.payload as { outcome?: unknown } | null)?.outcome === "failed" ? "failed" : "completed";
      if (request.runId === undefined || processedRunIds.has(`${request.runId}:${requestOutcome}`)) {
        continue;
      }
      const job = rehydrateJob(events, request);
      if (job !== undefined) {
        this.enqueue(job.run, job.task, job.evidence, job.outcome);
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
        if (processedRuns(await this.#journal.list()).has(`${job.run.id}:${job.outcome ?? "completed"}`)) return [];
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
          { type: "memory.candidate.extracted", runId: job.run.id, taskId: job.task.id, payload: { count: candidates.length, outcome: job.outcome ?? "completed" } },
        ]);
        return candidates;
      };
      return this.#lockPath === undefined ? await process() : await workspaceExecutionLock.run(this.#lockPath, process);
    } catch (error) {
      this.enqueue(job.run, job.task, job.evidence, job.outcome);
      throw error;
    }
  }

  hasPending(): boolean {
    return this.#pending.length > 0;
  }
}

/**
 * Keys are `runId:outcome`, so a run mined as completed can still be mined again
 * for lessons after the owner labels it a failure. Legacy events carry no
 * outcome and count as completed.
 * 键为 `runId:outcome`，因此按“完成”提炼过的 Run，在所有者把它标为失败后仍可再按教训提炼。
 * 旧事件没有 outcome，按“完成”计。
 */
function processedRuns(events: readonly JournalEvent[]): Set<string> {
  const keys = new Set<string>();
  const extracted = new Set<string>();
  for (const event of events) {
    if (event.runId === undefined || event.type !== "memory.candidate.extracted") continue;
    extracted.add(event.runId);
    keys.add(`${event.runId}:${(event.payload as { outcome?: unknown } | null)?.outcome === "failed" ? "failed" : "completed"}`);
  }
  // A proposal with no extraction marker is a legacy batch.
  // 没有提炼完成标记的提案属于旧批次。
  for (const event of events) {
    if (event.runId !== undefined && event.type === "memory.candidate.proposed" && !extracted.has(event.runId)) keys.add(`${event.runId}:completed`);
  }
  return keys;
}

export class DeterministicMemoryWorker implements MemoryWorker {
  async extract(job: PendingMemoryJob): Promise<MemoryCandidate[]> {
    // Without a model there is no lesson to extract from a failure.
    // 没有模型就无法从失败中提炼教训。
    if (job.evidence.length === 0 || job.outcome === "failed") {
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
  const outcome = (request.payload as { outcome?: unknown } | null)?.outcome === "failed" ? "failed" : "completed";
  return { run, task, evidence, outcome };
}
