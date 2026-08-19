/**
 * MemoryGovernance: the only path from a proposed candidate to durable memory.
 *
 * Every governance action (promote, reject, update, archive, expire) is
 * journaled first, then applied to the store. The journal therefore remains
 * the audit truth: who decided, when, and why. The worker that mined the
 * candidate has proposal rights only; this service is where the owner or a
 * standing rule exercises the promotion right.
 *
 * MemoryGovernance：从提案候选到持久记忆的唯一路径。
 *
 * 每个治理动作（提升、拒绝、修正、归档、过期）都先记入 Journal，再应用到 Store。
 * Journal 因此始终是审计真相：谁在什么时候、基于什么理由做了决定。提炼候选的 Worker
 * 只有提案权；提升权在本服务中由所有者或常设规则行使。
 */
import type { Evidence, MemoryCandidate } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";
import { MdMemoryStore, type MemoryEntry } from "./md-memory-store.ts";
import type { MemoryType } from "../core/contracts.ts";

export interface MemoryGovernanceOptions {
  journal: JournalStore;
  store: MdMemoryStore;
}

export class MemoryGovernance {
  readonly #journal: JournalStore;
  readonly #store: MdMemoryStore;

  constructor(options: MemoryGovernanceOptions) {
    this.#journal = options.journal;
    this.#store = options.store;
  }

  /**
   * Candidates proposed by the mining worker and not yet promoted or rejected.
   * 提炼 Worker 已提案、且尚未被提升或拒绝的候选。
   */
  async pendingCandidates(): Promise<MemoryCandidate[]> {
    const events = await this.#journal.list();
    const decided = new Set(
      events
        .filter((event) => event.type === "memory.candidate.promoted" || event.type === "memory.candidate.rejected")
        .map((event) => String((event.payload as { candidateId?: unknown }).candidateId ?? "")),
    );
    return events
      .filter((event) => event.type === "memory.candidate.proposed")
      .map((event) => event.payload as MemoryCandidate)
      .filter((candidate) => !decided.has(candidate.id));
  }

  /**
   * Promotes a candidate into durable memory. The cited evidence must exist in
   * the journal; a hallucinated or stale citation is refused. The type and
   * sensitivity suggested by the mining worker are honored unless overridden.
   *
   * 把候选提升为持久记忆。候选引用的 Evidence 必须真实存在于 Journal；编造或过期的引用
   * 会被拒绝。提炼 Worker 建议的 type 与 sensitivity 会被沿用，除非显式覆盖。
   */
  async promote(candidate: MemoryCandidate, overrides: { type?: MemoryType; sensitivity?: MemoryCandidate["sensitivity"] } = {}): Promise<MemoryEntry> {
    await this.assertEvidenceExists(candidate.sourceEvidenceIds);
    const entry = await this.#store.commit({
      summary: candidate.summary,
      content: `${candidate.summary}\n\nSource: ${candidate.sourceEvidenceIds.map((id) => `evidence:${id}`).join(", ")}`,
      type: overrides.type ?? candidate.type ?? "fact",
      confidence: candidate.confidence,
      sensitivity: overrides.sensitivity ?? candidate.sensitivity ?? "private",
      sourceRunId: candidate.runId,
      sourceEvidenceIds: candidate.sourceEvidenceIds,
      ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
    });
    await this.#journal.append({
      type: "memory.candidate.promoted",
      runId: candidate.runId,
      payload: {
        candidateId: candidate.id,
        memoryId: entry.id,
        summary: entry.summary,
        type: entry.type,
        decidedAt: new Date().toISOString(),
      },
    });
    return entry;
  }

  /** Rejects a candidate; the decision is journaled for audit. 拒绝候选；决定记入 Journal 供审计。 */
  async reject(candidateId: string, reason?: string): Promise<void> {
    await this.#journal.append({
      type: "memory.candidate.rejected",
      payload: {
        candidateId,
        ...(reason === undefined || reason.trim().length === 0 ? {} : { reason: reason.trim() }),
        decidedAt: new Date().toISOString(),
      },
    });
  }

  /** Corrects a committed memory. 修正一条已提交的记忆。 */
  async update(memoryId: string, update: { summary?: string; type?: MemoryType; confidence?: MemoryCandidate["confidence"]; sensitivity?: MemoryCandidate["sensitivity"]; expiresAt?: string }): Promise<MemoryEntry> {
    const entry = await this.#store.update(memoryId, update);
    await this.#journal.append({
      type: "memory.updated",
      payload: {
        memoryId,
        fields: Object.keys(update),
        updatedAt: entry.updatedAt,
      },
    });
    return entry;
  }

  /** Archives a memory with the reason recorded. 归档一条记忆并记录原因。 */
  async archive(memoryId: string, reason: "manual" | "expired" | "deleted" = "manual"): Promise<MemoryEntry> {
    const entry = await this.#store.archive(memoryId);
    await this.#journal.append({
      type: "memory.archived",
      payload: { memoryId, reason, archivedAt: new Date().toISOString() },
    });
    return entry;
  }

  /** Archives every expired memory and returns their ids. 归档全部过期记忆并返回其 id。 */
  async expireDue(): Promise<string[]> {
    const ids = await this.#store.expireDue();
    for (const id of ids) {
      await this.#journal.append({
        type: "memory.archived",
        payload: { memoryId: id, reason: "expired", archivedAt: new Date().toISOString() },
      });
    }
    return ids;
  }

  async list(options: { status?: "active" | "archived"; type?: MemoryType } = {}): Promise<MemoryEntry[]> {
    return this.#store.list(options);
  }

  async recall(query: string, options: { maxResults?: number; includeSecret?: boolean } = {}): Promise<ReturnType<MdMemoryStore["recall"]> extends Promise<infer T> ? T : never> {
    return this.#store.recall(query, options);
  }

  async stats(): Promise<{ active: number; archived: number; total: number; pending: number }> {
    const storeStats = await this.#store.stats();
    const pending = (await this.pendingCandidates()).length;
    return { ...storeStats, pending };
  }

  /** Releases the underlying SQLite handle. 释放底层 SQLite 句柄。 */
  async close(): Promise<void> {
    await this.#store.close();
  }

  private async assertEvidenceExists(evidenceIds: readonly string[]): Promise<void> {
    if (evidenceIds.length === 0) {
      throw new Error("A memory candidate must cite at least one evidence id.");
    }
    const events = await this.#journal.list();
    const known = new Set(
      events.filter((event) => event.type === "evidence.recorded").map((event) => (event.payload as Evidence).id),
    );
    const missing = evidenceIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`A memory candidate cites evidence that does not exist: ${missing.join(", ")}.`);
    }
  }
}

/** Rebuilds the governance view from journal events; used by tests and reloads. 从 Journal 事件重建治理视图；供测试与重载使用。 */
export function candidateDecisions(events: readonly import("../core/contracts.ts").JournalEvent[]): { promoted: string[]; rejected: string[] } {
  const promoted: string[] = [];
  const rejected: string[] = [];
  for (const event of events) {
    if (event.type === "memory.candidate.promoted") {
      promoted.push(String((event.payload as { candidateId?: unknown }).candidateId ?? ""));
    } else if (event.type === "memory.candidate.rejected") {
      rejected.push(String((event.payload as { candidateId?: unknown }).candidateId ?? ""));
    }
  }
  return { promoted, rejected };
}
