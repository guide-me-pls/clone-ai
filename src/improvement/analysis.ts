/**
 * Pure analysis for the improvement loop: which memories were exposed to which
 * runs and how those runs ended, what that suggests about each memory, and which
 * failures keep recurring. Nothing here reads or writes storage, so every rule
 * is testable and the whole result can be recomputed from the journal.
 *
 * 改进环路的纯分析：哪些记忆暴露给了哪些 Run、这些 Run 结局如何、这对每条记忆意味着什么，
 * 以及哪些失败在反复出现。这里不读写任何存储，因此每条规则都可测试，整个结果都能从 Journal 重算。
 */
import type { JournalEvent } from "../core/contracts.ts";
import { projectRunAudits, type RunAuditRecord } from "../audit/run-audit.ts";

/** Fewer exposures than this never trigger a suggestion: too little data. 曝光少于此值不触发建议：数据太少。 */
export const MIN_EXPOSURES = 5;
/** Distinct runs sharing one failure signature before it counts as a pattern. 同一失败签名出现在多少个不同 Run 中才算规律。 */
export const MIN_CLUSTER_RUNS = 3;

export type RunVerdict = "good" | "bad";

export interface MemoryUsage {
  memoryId: string;
  exposures: number;
  good: number;
  bad: number;
  lastExposedAt?: string;
}

export interface OutcomeProjection {
  usage: Map<string, MemoryUsage>;
  /** Terminal runs with a verdict, and how many ended well. 有结论的终态 Run 总数及其中成功的数量。 */
  runs: { total: number; good: number };
  verdicts: Map<string, RunVerdict>;
}

/**
 * The owner's label outranks the system's verification, because the label is the
 * ground truth the system is judged against. Runs still in flight, cancelled, or
 * awaiting review have no verdict and are excluded.
 * 所有者标签高于系统验证，因为标签正是系统被评判所依据的真值。进行中、已取消或等待审核的 Run 没有结论，予以排除。
 */
export function runVerdict(record: Pick<RunAuditRecord, "status" | "label">): RunVerdict | undefined {
  if (record.label !== undefined) return record.label.verdict === "pass" ? "good" : "bad";
  if (record.status === "completed") return "good";
  if (record.status === "failed") return "bad";
  return undefined;
}

export function projectOutcomes(events: readonly JournalEvent[], audits = projectRunAudits(events)): OutcomeProjection {
  const verdicts = new Map<string, RunVerdict>();
  for (const record of audits) {
    const verdict = runVerdict(record);
    if (verdict !== undefined) verdicts.set(record.runId, verdict);
  }
  const exposed = new Map<string, Map<string, string>>();
  for (const event of events) {
    if (event.type !== "memory.recalled" || event.runId === undefined) continue;
    const memories = (event.payload as { memories?: Array<{ id?: unknown }> } | null)?.memories ?? [];
    for (const memory of memories) {
      if (typeof memory.id !== "string") continue;
      const runs = exposed.get(memory.id) ?? new Map<string, string>();
      runs.set(event.runId, event.occurredAt);
      exposed.set(memory.id, runs);
    }
  }
  const usage = new Map<string, MemoryUsage>();
  for (const [memoryId, runs] of exposed) {
    const entry: MemoryUsage = { memoryId, exposures: 0, good: 0, bad: 0 };
    for (const [runId, at] of runs) {
      const verdict = verdicts.get(runId);
      if (verdict === undefined) continue;
      entry.exposures += 1;
      entry[verdict] += 1;
      if (entry.lastExposedAt === undefined || at > entry.lastExposedAt) entry.lastExposedAt = at;
    }
    usage.set(memoryId, entry);
  }
  return { usage, runs: { total: verdicts.size, good: [...verdicts.values()].filter((v) => v === "good").length }, verdicts };
}

/** Wilson score interval; behaves sensibly at small n where a raw rate does not. Wilson 区间：小样本下比原始比例可靠。 */
export function wilson(good: number, total: number, z = 1.96): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 1 };
  const p = good / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { lower: Math.max(0, (centre - margin) / denominator), upper: Math.min(1, (centre + margin) / denominator) };
}

export type SuggestionKind = "reinforce" | "retire" | "lesson" | "merge";

export interface Suggestion {
  /** Deterministic, so recomputing the same basis never creates a duplicate. 确定性，因此对同一依据重算不会产生重复。 */
  id: string;
  kind: SuggestionKind;
  /** Memory id for reinforce/retire/merge; failure signature for lesson. reinforce/retire/merge 为记忆 id；lesson 为失败签名。 */
  target: string;
  title: string;
  /** The numbers behind the suggestion, shown to the owner. 建议背后的数字，展示给所有者。 */
  rationale: string;
  /** Present for a lesson: the memory text the owner would be adding. lesson 专有：所有者将加入的记忆文本。 */
  proposedSummary?: string;
  evidenceRunIds?: string[];
  /** Present for a merge: the ids this merge would replace. merge 专有：本次合并将取代的 id。 */
  retireIds?: string[];
}

export interface LifecycleMemory {
  id: string;
  summary: string;
  status: string;
}

/**
 * Compares each memory's success rate with the runs that never recalled it.
 * This is observational, not causal: recall correlates with task type. So it
 * only ever suggests, needs MIN_EXPOSURES on both sides, and compares interval
 * bounds rather than raw rates.
 * 把每条记忆的成功率与“从未召回它”的 Run 对比。这是观察性而非因果：召回与任务类型相关。
 * 因此它只做建议，要求两侧都至少有 MIN_EXPOSURES 个样本，且比较的是区间界而非原始比例。
 */
export function suggestLifecycle(projection: OutcomeProjection, memories: readonly LifecycleMemory[]): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const memory of memories) {
    if (memory.status !== "active") continue;
    const used = projection.usage.get(memory.id);
    if (used === undefined || used.exposures < MIN_EXPOSURES) continue;
    const otherTotal = projection.runs.total - used.exposures;
    if (otherTotal < MIN_EXPOSURES) continue;
    const baseline = (projection.runs.good - used.good) / otherTotal;
    const interval = wilson(used.good, used.exposures);
    const bucket = Math.floor(used.exposures / MIN_EXPOSURES) * MIN_EXPOSURES;
    const numbers = `${used.good}/${used.exposures} runs that recalled it ended well, vs ${(baseline * 100).toFixed(0)}% for runs that did not (95% interval ${(interval.lower * 100).toFixed(0)}–${(interval.upper * 100).toFixed(0)}%).`;
    if (interval.upper < baseline) {
      suggestions.push({ id: `retire:${memory.id}@${bucket}`, kind: "retire", target: memory.id, title: `Archive: ${memory.summary}`, rationale: numbers });
    } else if (interval.lower >= baseline) {
      suggestions.push({ id: `reinforce:${memory.id}@${bucket}`, kind: "reinforce", target: memory.id, title: `Keep: ${memory.summary}`, rationale: numbers });
    }
  }
  return suggestions;
}

/**
 * A failure signature seen in MIN_CLUSTER_RUNS or more different runs is a
 * pattern rather than an incident, so it earns a lesson proposal. One-off
 * failures are left to the per-run miner, which proposes low-confidence,
 * expiring candidates.
 * 在 MIN_CLUSTER_RUNS 个及以上不同 Run 中出现的失败签名是规律而非意外，因此值得提出教训提案。
 * 一次性失败留给逐 Run 的提炼器，它只提出低置信、会过期的候选。
 */
export function clusterFailures(audits: readonly RunAuditRecord[], guidanceFor: (category: string) => string | undefined = () => undefined): Suggestion[] {
  const groups = new Map<string, { category: string; runs: Set<string> }>();
  for (const record of audits) {
    if (runVerdict(record) !== "bad") continue;
    for (const execution of record.executions) {
      const signature = execution.failure?.signature;
      if (signature === undefined || signature.length === 0) continue;
      const group = groups.get(signature) ?? { category: execution.failure?.category ?? "unknown", runs: new Set<string>() };
      group.runs.add(record.runId);
      groups.set(signature, group);
    }
  }
  const suggestions: Suggestion[] = [];
  for (const [signature, group] of groups) {
    if (group.runs.size < MIN_CLUSTER_RUNS) continue;
    const guidance = guidanceFor(group.category);
    const bucket = Math.floor(group.runs.size / MIN_CLUSTER_RUNS) * MIN_CLUSTER_RUNS;
    suggestions.push({
      id: `lesson:${hashShort(signature)}@${bucket}`,
      kind: "lesson",
      target: signature,
      title: `Recurring failure (${group.category}) in ${group.runs.size} runs`,
      rationale: `The same failure signature appeared in ${group.runs.size} different runs.`,
      proposedSummary: `Recurring failure (${group.category}, ${group.runs.size} runs): ${signature}.${guidance === undefined ? "" : ` Guidance: ${guidance}`}`,
      evidenceRunIds: [...group.runs],
    });
  }
  return suggestions;
}

function hashShort(text: string): string {
  let hash = 5381;
  for (const char of text) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}
