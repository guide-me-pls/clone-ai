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
import type { Evidence, MemoryCandidate, NewJournalEvent } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";
import { MdMemoryStore, type MemoryEntry } from "./md-memory-store.ts";
import type { MemoryType } from "../core/contracts.ts";
import { workspaceExecutionLock } from "../core/workspace-lock.ts";
import { memoryFingerprint, redactMemoryPii } from "./memory-hygiene.ts";

/**
 * Default lifetime of a mined memory and the idle window after which any active
 * memory is archived. 90 days matches a project, a work cycle or a term; a
 * memory nobody recalled or edited for that long is not earning its place.
 * 提炼记忆的默认寿命，以及任何活跃记忆闲置多久后被归档。90 天对应一个项目、一个工作周期或
 * 一个学期；这么久没人召回或编辑的记忆，没有保留的价值。
 */
export const MEMORY_LIFETIME_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

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
    return pendingFromEvents(events);
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
    return this.withLock(async () => {
      await this.recoverUnlocked();
      await this.#journal.reload?.();
      const proposed = pendingFromEvents(await this.#journal.list()).find((item) => item.id === candidate.id);
      if (proposed === undefined) throw new Error("This memory candidate is not pending or was already decided.");
      candidate = proposed;
      await this.assertEvidenceExists(candidate.sourceEvidenceIds, candidate.runId);
      const fingerprint = memoryFingerprint(candidate.summary);
      const duplicate = (await this.#store.list({ status: "active" }))
        .find((entry) => memoryFingerprint(entry.summary) === fingerprint);
      if (duplicate !== undefined) {
        throw new Error(`This candidate matches an existing memory (${duplicate.id}).`);
      }
      const redactedSummary = redactMemoryPii(candidate.summary);
      const sourceLine = `Source: ${candidate.sourceEvidenceIds.map((id) => `evidence:${id}`).join(", ")}`;
      const redactedContent = redactMemoryPii(`${candidate.summary}\n\n${sourceLine}`);
      let sensitivity = overrides.sensitivity ?? candidate.sensitivity ?? "private";
      // Public recall would serve the raw candidate to workers; PII stays secret.
      // 公开召回会把原始候选交给 Worker；含 PII 的记忆保持 secret。
      if (redactedSummary.kinds.length > 0 && sensitivity !== "secret") {
        sensitivity = "secret";
      }
      const entry = this.#store.prepareCommit({
        summary: redactedSummary.text,
        content: redactedContent.text,
        type: overrides.type ?? candidate.type ?? "fact",
        confidence: candidate.confidence,
        sensitivity,
        sourceRunId: candidate.runId,
        sourceEvidenceIds: candidate.sourceEvidenceIds,
        // A mined memory fades unless something keeps it alive; the miner's own
        // expiry wins when it gave one. 提炼记忆除非有人维持否则淡出；提炼器给了过期时间则以它为准。
        expiresAt: candidate.expiresAt ?? new Date(Date.now() + MEMORY_LIFETIME_DAYS * DAY_MS).toISOString(),
      });
      await this.applyRecorded(entry, {
        type: "memory.candidate.promoted",
        runId: candidate.runId,
        payload: {
          candidateId: candidate.id,
          memoryId: entry.id,
          summary: entry.summary,
          type: entry.type,
          sensitivity: entry.sensitivity,
          fingerprint,
          ...(redactedSummary.kinds.length === 0 ? {} : { piiRedacted: redactedSummary.kinds }),
          decidedAt: new Date().toISOString(),
        },
      });
      return entry;
    });
  }

  /** Rejects a candidate; the decision is journaled for audit. 拒绝候选；决定记入 Journal 供审计。 */
  async reject(candidateId: string, reason?: string): Promise<void> {
    await this.withLock(async () => {
      await this.recoverUnlocked();
      await this.#journal.reload?.();
      if (!pendingFromEvents(await this.#journal.list()).some((candidate) => candidate.id === candidateId)) {
        throw new Error("This memory candidate is not pending or was already decided.");
      }
      await this.#journal.append({
        type: "memory.candidate.rejected",
        payload: {
          candidateId,
          ...(reason === undefined || reason.trim().length === 0 ? {} : { reason: reason.trim() }),
          decidedAt: new Date().toISOString(),
        },
      });
    });
  }

  /**
   * The owner writing a memory by hand. This is the one commit path that cites
   * no evidence, and it is legitimate precisely because the owner is the
   * evidence — a stated preference is true by virtue of being stated. A mined
   * candidate has no such standing, which is why promote() still demands
   * citations.
   *
   * 所有者手写一条记忆。这是唯一不引用证据的提交路径，而它之所以正当，恰恰因为所有者
   * 本人就是证据——一条被声明的偏好，因其被声明而为真。被提炼的候选没有这种地位，
   * 所以 promote() 依然强制要求引用。
   */
  async author(input: {
    summary: string;
    content?: string;
    type?: MemoryType;
    confidence?: MemoryCandidate["confidence"];
    sensitivity?: MemoryCandidate["sensitivity"];
    expiresAt?: string;
  }): Promise<MemoryEntry> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      const entry = this.#store.prepareCommit({
        summary: input.summary,
        ...(input.content === undefined ? {} : { content: input.content }),
        type: input.type ?? "preference",
        // Owner-authored memory is high confidence by definition: it is not an
        // inference about the owner, it is the owner speaking.
        // 所有者手写的记忆按定义就是高置信：它不是对所有者的推断，而是所有者本人在说话。
        confidence: input.confidence ?? "high",
        sensitivity: input.sensitivity ?? "private",
        sourceRunId: "owner",
        sourceEvidenceIds: [],
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });
      await this.applyRecorded(entry, {
        type: "memory.authored",
        payload: {
          memoryId: entry.id,
          summary: entry.summary,
          type: entry.type,
          sensitivity: entry.sensitivity,
          authoredAt: entry.createdAt,
        },
      });
      return entry;
    });
  }

  /** Corrects a committed memory. 修正一条已提交的记忆。 */
  async update(memoryId: string, update: { summary?: string; content?: string; type?: MemoryType; confidence?: MemoryCandidate["confidence"]; sensitivity?: MemoryCandidate["sensitivity"]; expiresAt?: string }): Promise<MemoryEntry> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      const entry = await this.#store.prepareUpdate(memoryId, update);
      await this.applyRecorded(entry, {
        type: "memory.updated",
        payload: {
          memoryId,
          fields: Object.keys(update),
          updatedAt: entry.updatedAt,
        },
      });
      return entry;
    });
  }

  /** Archives a memory with the reason recorded. 归档一条记忆并记录原因。 */
  async archive(memoryId: string, reason: "manual" | "expired" | "idle" | "retired" | "deleted" = "manual"): Promise<MemoryEntry> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      const entry = await this.#store.prepareUpdate(memoryId, { status: "archived" });
      await this.applyRecorded(entry, {
        type: "memory.archived",
        payload: { memoryId, reason, archivedAt: new Date().toISOString() },
      });
      return entry;
    });
  }

  /** Archives every expired memory and returns their ids. 归档全部过期记忆并返回其 id。 */
  async expireDue(): Promise<string[]> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      const now = new Date().toISOString();
      const expired = (await this.#store.list({ status: "active" })).filter((entry) => entry.expiresAt !== undefined && entry.expiresAt <= now);
      for (const memory of expired) {
        const entry = await this.#store.prepareUpdate(memory.id, { status: "archived" });
        await this.applyRecorded(entry, {
          type: "memory.archived",
          payload: { memoryId: memory.id, reason: "expired", archivedAt: new Date().toISOString() },
        });
      }
      return expired.map((entry) => entry.id);
    });
  }

  /**
   * Archives active memories that were neither recalled, read nor edited for
   * `idleDays`. Archiving rather than deleting keeps the decision reversible
   * through restore(); the journal records the reason as "idle".
   * 归档闲置超过 `idleDays` 天（既未被召回、读取也未被编辑）的活跃记忆。归档而非删除，使该决定
   * 可通过 restore() 撤销；Journal 把原因记为 "idle"。
   */
  async archiveIdle(idleDays = MEMORY_LIFETIME_DAYS): Promise<string[]> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      const cutoff = new Date(Date.now() - idleDays * DAY_MS).toISOString();
      const idle = (await this.#store.list({ status: "active" })).filter((entry) => (
        [entry.createdAt, entry.updatedAt, entry.lastAccessedAt ?? ""].reduce((latest, value) => (value > latest ? value : latest)) < cutoff
      ));
      for (const memory of idle) {
        const entry = await this.#store.prepareUpdate(memory.id, { status: "archived" });
        await this.applyRecorded(entry, {
          type: "memory.archived",
          payload: { memoryId: memory.id, reason: "idle", idleDays, archivedAt: new Date().toISOString() },
        });
      }
      return idle.map((entry) => entry.id);
    });
  }

  /** Brings an archived memory back into use. 让一条已归档的记忆重新生效。 */
  async restore(memoryId: string): Promise<MemoryEntry> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      const entry = await this.#store.prepareUpdate(memoryId, { status: "active" });
      await this.applyRecorded(entry, {
        type: "memory.restored",
        payload: { memoryId, restoredAt: entry.updatedAt },
      });
      return entry;
    });
  }

  /**
   * Folds hand edits made directly to the .md files back into the index.
   *
   * The files are the content layer the owner owns, so an edit made in a text
   * editor is as legitimate as one made in the GUI — but the index would not
   * know about it until something looks. This is that look, and it is journaled
   * so the audit trail shows the index changed without a GUI action.
   *
   * 把直接在 .md 文件上做的手动编辑折回索引。
   *
   * 文件是所有者拥有的内容层，因此在文本编辑器里做的修改与在 GUI 里做的一样正当——
   * 只是在有人去看之前，索引不会知道。这里就是那次"去看"，并且写入 Journal，
   * 使审计轨迹能显示索引在没有 GUI 动作的情况下发生了变化。
   */
  async syncFromFiles(): Promise<{ added: number; archived: number; updated: number }> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      return this.#store.syncFromFiles(async (entry, action) => {
        await this.applyRecorded(entry, action === "archived"
          ? { type: "memory.archived", payload: { memoryId: entry.id, reason: "deleted", source: "files", archivedAt: entry.updatedAt } }
          : { type: "memory.updated", payload: { memoryId: entry.id, source: "files", action, updatedAt: entry.updatedAt } }, { acceptFileEdit: true });
      });
    });
  }

  /**
   * Read one memory body by id. Judgement stays with the caller; this only adds
   * the usage count a recall would have added.
   * 按 id 读取一条记忆的正文。判断留给调用方；这里只补上召回本来也会加的使用计数。
   */
  async read(id: string): Promise<MemoryEntry | undefined> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      return this.#store.read(id);
    });
  }

  /** Path of the .md file the owner can open and edit. 所有者可以直接打开编辑的 .md 文件路径。 */
  filePathFor(entry: MemoryEntry): string {
    return this.#store.filePathFor(entry.id, entry.status);
  }

  async list(options: { status?: "active" | "archived"; type?: MemoryType } = {}): Promise<MemoryEntry[]> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      return this.#store.list(options);
    });
  }

  async recall(query: string, options: { maxResults?: number; includeSecret?: boolean } = {}): Promise<ReturnType<MdMemoryStore["recall"]> extends Promise<infer T> ? T : never> {
    return this.withLock(async () => {
      await this.recoverUnlocked();
      return this.#store.recall(query, options);
    });
  }

  async stats(): Promise<{ active: number; archived: number; total: number; pending: number; contentDirectory: string }> {
    await this.recover();
    const storeStats = await this.#store.stats();
    const pending = (await this.pendingCandidates()).length;
    return { ...storeStats, pending, contentDirectory: this.#store.contentDirectory };
  }

  /** Releases the underlying SQLite handle. 释放底层 SQLite 句柄。 */
  async close(): Promise<void> {
    await this.#store.close();
  }

  async recover(): Promise<void> {
    await this.withLock(() => this.recoverUnlocked());
  }

  async inspectPending(): Promise<{ memories: MemoryEntry[]; stats: { active: number; archived: number; total: number; pending: number; contentDirectory: string }; conflicts: Array<{ id: string; memoryId: string; summary: string }> }> {
    return this.withLock(async () => {
      await this.#journal.reload?.();
      const events = await this.#journal.list();
      const recorded = new Set(events.map((event) => (event.payload as { mutationId?: unknown } | null)?.mutationId).filter((id): id is string => typeof id === "string"));
      return {
        memories: await this.#store.list(),
        stats: { ...await this.#store.stats(), pending: pendingFromEvents(events).length, contentDirectory: this.#store.contentDirectory },
        conflicts: this.#store.pendingMutations().filter((item) => recorded.has(item.id)),
      };
    });
  }

  async keepConflictingFile(mutationId: string): Promise<void> {
    await this.withLock(async () => {
      await this.#journal.reload?.();
      const events = await this.#journal.list();
      const pending = this.#store.pendingMutations().find((item) => item.id === mutationId);
      const recorded = events.some((event) => event.type !== "memory.mutation.discarded"
        && (event.payload as { mutationId?: unknown } | null)?.mutationId === mutationId);
      if (pending === undefined || !recorded) throw new Error("The pending memory change does not exist.");
      await this.#journal.append({
        type: "memory.mutation.discarded",
        payload: { mutationId, memoryId: pending.memoryId, reason: "owner_kept_file", decidedAt: new Date().toISOString() },
      });
      this.#store.discardMutation(mutationId);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return workspaceExecutionLock.run(this.#store.governanceLockPath, operation);
  }

  private async recoverUnlocked(): Promise<void> {
    const pending = new Set(this.#store.pendingMutationIds());
    if (pending.size === 0) return;
    await this.#journal.reload?.();
    const events = await this.#journal.list();
    const discarded = new Set(events.filter((event) => event.type === "memory.mutation.discarded")
      .map((event) => (event.payload as { mutationId?: unknown } | null)?.mutationId)
      .filter((id): id is string => typeof id === "string"));
    for (const id of discarded) {
      if (!pending.has(id)) continue;
      this.#store.discardMutation(id);
      pending.delete(id);
    }
    for (const event of events) {
      const payload = event.payload as { mutationId?: unknown } | null;
      const id = payload?.mutationId;
      if (typeof id !== "string" || !pending.has(id)) continue;
      await this.#store.applyMutation(id);
      pending.delete(id);
    }
    // Under the cross-process governance lock, an unjournaled stage cannot be
    // an in-flight writer. It never became authoritative and can be discarded.
    // 持有跨进程治理锁时，未入账的暂存不可能仍在写入，且从未生效，可以丢弃。
    for (const id of pending) this.#store.discardMutation(id);
  }

  private async applyRecorded(entry: MemoryEntry, event: NewJournalEvent, options: { acceptFileEdit?: boolean } = {}): Promise<void> {
    const mutationId = this.#store.stageMutation(entry, options);
    await this.#journal.append({
      ...event,
      payload: { ...(event.payload as Record<string, unknown>), mutationId },
    });
    await this.#store.applyMutation(mutationId);
  }

  private async assertEvidenceExists(evidenceIds: readonly string[], runId: string): Promise<void> {
    if (evidenceIds.length === 0) {
      throw new Error("A memory candidate must cite at least one evidence id.");
    }
    const events = await this.#journal.list();
    const known = new Set(
      events.filter((event) => event.type === "evidence.recorded" && event.runId === runId && (event.payload as Evidence).runId === runId)
        .map((event) => (event.payload as Evidence).id),
    );
    const missing = evidenceIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`A memory candidate cites evidence that does not exist in its run: ${missing.join(", ")}.`);
    }
  }
}

function pendingFromEvents(events: readonly import("../core/contracts.ts").JournalEvent[]): MemoryCandidate[] {
  const decided = new Set(events
    .filter((event) => event.type === "memory.candidate.promoted" || event.type === "memory.candidate.rejected")
    .map((event) => String((event.payload as { candidateId?: unknown }).candidateId ?? "")));
  return events.filter((event) => event.type === "memory.candidate.proposed")
    .map((event) => event.payload as MemoryCandidate)
    .filter((candidate) => !decided.has(candidate.id));
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
