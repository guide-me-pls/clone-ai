/**
 * ImprovementService closes the loop: it turns recorded outcomes into
 * suggestions, journals them, and applies one only when the owner approves.
 *
 * Observe (journal, owner labels) -> Diagnose (analysis.ts) -> Propose
 * (improvement.suggested) -> Gate (owner approve/dismiss) -> Apply (through
 * MemoryGovernance, so the usual audit trail and reversibility hold) ->
 * Measure again on the next sweep. It never edits code, prompts or authority
 * policy: the only things it can change are memories, through the same
 * governed path an owner would use.
 *
 * ImprovementService 闭合环路：把已记录的结局转成建议、写入 Journal，且只在所有者批准后才应用。
 *
 * 观察（Journal、所有者标签）-> 诊断（analysis.ts）-> 提案（improvement.suggested）->
 * 门禁（所有者批准/驳回）-> 应用（经 MemoryGovernance，沿用既有审计与可回滚性）->
 * 下一次扫描再度量。它从不修改代码、提示词或授权策略：它唯一能改的是记忆，且走所有者
 * 本来会用的同一条受治理路径。
 */
import type { JournalStore } from "../core/journal.ts";
import { projectRunAudits } from "../audit/run-audit.ts";
import { MEMORY_LIFETIME_DAYS, type MemoryGovernance } from "../memory/memory-governance.ts";
import { redactMemoryPii } from "../memory/memory-hygiene.ts";
import { findMergeCandidates } from "../memory/consolidation.ts";
import type { MemoryPipeline } from "../memory/memory-pipeline.ts";
import { clusterFailures, projectOutcomes, suggestLifecycle, type MemoryUsage, type Suggestion } from "./analysis.ts";

/** At most this many undecided suggestions at once; a flood trains blind approval. 同时最多这么多条未决建议；泛滥会训练出盲目通过。 */
export const MAX_PENDING_SUGGESTIONS = 10;
const DAY_MS = 24 * 3600 * 1000;

export interface PendingSuggestion extends Suggestion {
  suggestedAt: string;
}

export interface ImprovementServiceOptions {
  journal: JournalStore;
  governance: MemoryGovernance;
  /** Needed only to request lesson mining for runs the owner labeled failed. 仅用于为所有者标为失败的 Run 请求教训提炼。 */
  pipeline?: MemoryPipeline;
  guidanceFor?: (category: string) => string | undefined;
}

export class ImprovementService {
  readonly #journal: JournalStore;
  readonly #governance: MemoryGovernance;
  readonly #pipeline?: MemoryPipeline;
  readonly #guidanceFor?: (category: string) => string | undefined;

  constructor(options: ImprovementServiceOptions) {
    this.#journal = options.journal;
    this.#governance = options.governance;
    if (options.pipeline !== undefined) this.#pipeline = options.pipeline;
    if (options.guidanceFor !== undefined) this.#guidanceFor = options.guidanceFor;
  }

  /** The kill switch: CLONE_AI_IMPROVEMENT=0 stops the loop; approved memories keep working. 总开关：CLONE_AI_IMPROVEMENT=0 停止环路；已批准的记忆照常工作。 */
  static enabled(): boolean {
    return process.env.CLONE_AI_IMPROVEMENT !== "0";
  }

  /** One pass of the loop. Safe to repeat: suggestions are deterministic and deduplicated. 环路的一次扫描。可重复执行：建议是确定性的且去重。 */
  async sweep(): Promise<{ suggested: PendingSuggestion[]; lessonsRequested: string[] }> {
    await this.#journal.reload?.();
    const events = await this.#journal.list();
    const audits = projectRunAudits(events);

    // An owner "fail" on a run the system passed is the strongest signal that
    // the system was wrong, so it is mined for lessons even though it completed.
    // 所有者对系统判为通过的 Run 标 “fail”，是系统判断错误的最强信号，因此即使它已完成也要提炼教训。
    const lessonsRequested: string[] = [];
    if (this.#pipeline !== undefined) {
      for (const record of audits) {
        if (record.label?.verdict !== "fail" || record.status !== "completed") continue;
        if (await this.#pipeline.requestFromJournal(record.runId, "failed")) lessonsRequested.push(record.runId);
      }
    }

    const projection = projectOutcomes(events, audits);
    const memories = await this.#governance.list({ status: "active" });
    const found: Suggestion[] = [
      ...suggestLifecycle(projection, memories),
      ...clusterFailures(audits, this.#guidanceFor),
      // Consolidation runs on the same sweep as expiry and idle archiving: it is
      // an O(n²) similarity pass over the active library, which is why it never
      // runs per turn. A secret memory never reaches it; the suggestion would
      // have to quote the text.
      // 巩固与过期、闲置归档跑在同一次扫描中：它对活跃库做 O(n²) 相似度比较，因此从不每回合运行。
      // secret 记忆不会进入它：建议必须引用正文。
      ...findMergeCandidates(memories),
    ];

    const decided = new Set<string>();
    const pending = new Map<string, PendingSuggestion>();
    for (const event of events) {
      const payload = (event.payload ?? {}) as { id?: unknown };
      if (typeof payload.id !== "string") continue;
      if (event.type === "improvement.suggested") pending.set(payload.id, { ...(event.payload as Suggestion), suggestedAt: event.occurredAt });
      else if (event.type === "improvement.applied" || event.type === "improvement.dismissed") decided.add(payload.id);
    }
    for (const id of decided) pending.delete(id);

    const suggested: PendingSuggestion[] = [];
    for (const suggestion of found) {
      if (decided.has(suggestion.id) || pending.has(suggestion.id)) continue;
      if (pending.size + suggested.length >= MAX_PENDING_SUGGESTIONS) break;
      const event = await this.#journal.append({ type: "improvement.suggested", payload: suggestion });
      suggested.push({ ...suggestion, suggestedAt: event.occurredAt });
    }
    return { suggested, lessonsRequested };
  }

  async pending(): Promise<PendingSuggestion[]> {
    await this.#journal.reload?.();
    const open = new Map<string, PendingSuggestion>();
    for (const event of await this.#journal.list()) {
      const id = (event.payload as { id?: unknown } | null)?.id;
      if (typeof id !== "string") continue;
      if (event.type === "improvement.suggested") open.set(id, { ...(event.payload as Suggestion), suggestedAt: event.occurredAt });
      else if (event.type === "improvement.applied" || event.type === "improvement.dismissed") open.delete(id);
    }
    return [...open.values()];
  }

  /** Per-memory usage, for the owner to inspect. 每条记忆的使用情况，供所有者查看。 */
  async usage(): Promise<{ usage: MemoryUsage[]; runs: { total: number; good: number } }> {
    await this.#journal.reload?.();
    const projection = projectOutcomes(await this.#journal.list());
    return { usage: [...projection.usage.values()].sort((a, b) => b.exposures - a.exposures), runs: projection.runs };
  }

  /** Applies a suggestion the owner approved. 应用所有者已批准的建议。 */
  async approve(id: string): Promise<{ applied: string }> {
    const suggestion = (await this.pending()).find((item) => item.id === id);
    if (suggestion === undefined) throw new Error("This suggestion does not exist or was already decided.");
    let applied: string;
    if (suggestion.kind === "retire") {
      await this.#governance.archive(suggestion.target, "retired");
      applied = `Archived memory ${suggestion.target}.`;
    } else if (suggestion.kind === "merge") {
      // The merged memory is authored first, then the sources are retired: a
      // failure between the two leaves a duplicate, which the next sweep
      // proposes again — the reverse order would leave nothing at all.
      // 先手写合并后的记忆，再退役来源：两步之间失败只会留下重复，下一次扫描会再次提出；顺序反过来
      // 则什么都不会留下。
      const sources = [suggestion.target, ...(suggestion.retireIds ?? [])];
      const entries = await this.#governance.list({ status: "active" });
      const originals = sources.map((id) => entries.find((entry) => entry.id === id)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      if (originals.length < 2) throw new Error("The memories this merge would combine no longer exist as active memories.");
      const merged = await this.#governance.author({
        summary: redactMemoryPii(suggestion.proposedSummary ?? originals.map((entry) => entry.summary).join(" ")).text,
        type: originals[0]!.type,
        confidence: "high",
      });
      for (const original of originals) await this.#governance.archive(original.id, "retired");
      applied = `Merged ${originals.map((entry) => entry.id).join(", ")} into ${merged.id}.`;
    } else if (suggestion.kind === "reinforce") {
      const memory = await this.#governance.read(suggestion.target);
      if (memory === undefined) throw new Error("The memory no longer exists.");
      // Only a memory that expires is extended; one without an expiry already lives until idle.
      // 只延长会过期的记忆；没有过期时间的记忆本来就活到闲置为止。
      await this.#governance.update(memory.id, {
        confidence: "high",
        ...(memory.expiresAt === undefined ? {} : { expiresAt: new Date(Date.now() + MEMORY_LIFETIME_DAYS * DAY_MS).toISOString() }),
      });
      applied = `Reinforced memory ${memory.id}.`;
    } else {
      const entry = await this.#governance.author({
        summary: redactMemoryPii(suggestion.proposedSummary ?? suggestion.title).text,
        type: "procedure",
        confidence: "medium",
        expiresAt: new Date(Date.now() + MEMORY_LIFETIME_DAYS * DAY_MS).toISOString(),
      });
      applied = `Added lesson ${entry.id}.`;
    }
    await this.#journal.append({ type: "improvement.applied", payload: { id, kind: suggestion.kind, target: suggestion.target, applied } });
    return { applied };
  }

  async dismiss(id: string): Promise<void> {
    if (!(await this.pending()).some((item) => item.id === id)) throw new Error("This suggestion does not exist or was already decided.");
    await this.#journal.append({ type: "improvement.dismissed", payload: { id } });
  }
}
