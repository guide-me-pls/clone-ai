/**
 * Background consolidation: propose merges, never perform them.
 *
 * `src/memory/conflict.ts` already measures the right similarity — the overlap
 * coefficient, thresholded at 0.55 / 0.35 against measured pairs — but until
 * now `findConflicts` had no production caller; its only consumers were tests.
 * Claude Code 2.1.319 runs background memory consolidation on a timer and
 * reports "consolidated N memory files". clone-ai's governance forbids the model
 * from writing memory — promotion needs the owner — so the honest equivalent of
 * "consolidate" is a suggestion the owner approves, not a silent rewrite.
 *
 * A merge suggestion names the memories it would replace, proposes one summary
 * that carries both, and is journaled through the existing improvement loop
 * (`improvement.suggested`, `kind: "merge"`). Approving it authors the merged
 * memory and archives the sources as `retired`; both steps go through
 * `MemoryGovernance`, so the merge is as reversible as any other memory change.
 *
 * 后台巩固：提出合并建议，绝不自行合并。
 *
 * `src/memory/conflict.ts` 早已度量了正确的相似度——重叠系数，阈值 0.55 / 0.35 来自实测配对——
 * 但此前 `findConflicts` 没有生产调用方，唯一的消费者是测试。Claude Code 2.1.319 会定时跑后台
 * 记忆巩固并报告 "consolidated N memory files"。clone-ai 的治理禁止模型写记忆——提升需要所有者——
 * 因此"巩固"的诚实对应物是一条由所有者批准的建议，而不是静默重写。
 *
 * 合并建议点名它要取代的记忆、提出一条同时承载两者的摘要，并经既有改进环路写入 Journal
 * （`improvement.suggested`，`kind: "merge"`）。批准时手写合并后的记忆、把来源以 `retired` 归档；
 * 两步都走 `MemoryGovernance`，因此这次合并与其他记忆变更一样可逆。
 */
import type { MemoryEntry } from "./md-memory-store.ts";
import { NEAR_DUPLICATE, summarySimilarity } from "./conflict.ts";
import type { Suggestion } from "../improvement/analysis.ts";

/** A memory the consolidator is allowed to consider; the store's own shape plus its id. 巩固器可以考察的记忆；Store 的形状加上 id。 */
export interface ConsolidationCandidate {
  id: string;
  summary: string;
  type: MemoryEntry["type"];
  status: MemoryEntry["status"];
  sensitivity: MemoryEntry["sensitivity"];
  createdAt: string;
}

export interface MergeSuggestion extends Suggestion {
  kind: "merge";
  /** The memory kept by the merge; the others are archived. 合并后保留的记忆；其余被归档。 */
  keepId: string;
  /** Ids the merge would retire. 会被这次合并退役的 id。 */
  retireIds: string[];
}

/** Signals that two statements describe different values of the same thing, so a merge would pick one silently. 表示两条陈述描述同一事物的不同取值——合并会静默选中其中一个。 */
const DIFFERENT_VALUE_SIGNALS: readonly RegExp[] = [
  /改成|改为|改到|不再|取代|替换|changed? to|instead of|no longer/i,
];

/**
 * Same-type active memories whose overlap coefficient is at least the
 * near-duplicate threshold. Secret memories are excluded: merging them would
 * require their text in the suggestion, which is owner-visible only.
 *
 * 同类型、活跃、重叠系数达到近重复阈值的记忆。secret 记忆被排除：合并需要在建议里写出它们的
 * 正文，而正文只对所有者可见。
 */
export function findMergeCandidates(memories: readonly ConsolidationCandidate[], options: { limit?: number } = {}): MergeSuggestion[] {
  const eligible = memories.filter((memory) => memory.status === "active" && memory.sensitivity !== "secret");
  const pairs: Array<{ keep: ConsolidationCandidate; retire: ConsolidationCandidate; similarity: number }> = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      const left = eligible[i]!;
      const right = eligible[j]!;
      if (left.type !== right.type) continue;
      // A statement that explicitly changes a value is a revision, not a
      // duplicate: merging it with the statement it replaces would erase the
      // "changed to" that is the whole content of the newer one.
      // 明确改变取值的陈述是修订而非重复：把它与被它取代的陈述合并，会抹掉"改到"这个新陈述的全部内容。
      if (DIFFERENT_VALUE_SIGNALS.some((pattern) => pattern.test(right.summary) || pattern.test(left.summary))) continue;
      const similarity = summarySimilarity(left.summary, right.summary);
      if (similarity < NEAR_DUPLICATE) continue;
      const [keep, retire] = left.createdAt >= right.createdAt ? [left, right] : [right, left];
      pairs.push({ keep, retire, similarity });
    }
  }
  pairs.sort((left, right) => {
    const leftScore = similarityOf(left);
    const rightScore = similarityOf(right);
    return rightScore - leftScore;
  });
  const used = new Set<string>();
  const suggestions: MergeSuggestion[] = [];
  for (const pair of pairs) {
    if (suggestions.length >= (options.limit ?? 5)) break;
    if (used.has(pair.keep.id) || used.has(pair.retire.id)) continue;
    used.add(pair.keep.id);
    used.add(pair.retire.id);
    // The merged summary keeps the newer statement first, because the newer one
    // is the one the owner is thinking of; the older wording follows as context.
    // 合并摘要把较新的陈述放在最前，因为所有者想的是它；较旧的措辞作为上下文跟随其后。
    const merged = pair.keep.summary.trim() === pair.retire.summary.trim()
      ? pair.keep.summary
      : `${pair.keep.summary} ${pair.retire.summary}`;
    suggestions.push({
      id: `merge:${pair.keep.id}+${pair.retire.id}`,
      kind: "merge",
      target: pair.keep.id,
      title: `Merge: ${truncate(pair.keep.summary, 60)}`,
      rationale: `${pair.retire.id} and ${pair.keep.id} say the same thing (overlap ${pair.similarity.toFixed(2)}); merging keeps one memory instead of two.`,
      proposedSummary: merged,
      evidenceRunIds: [],
      keepId: pair.keep.id,
      retireIds: [pair.retire.id],
    });
  }
  return suggestions;
}

/** Similarity is encoded in the rationale; recovering it here keeps the sort independent of order. 相似度写在理由里；从这里还原使排序与插入顺序无关。 */
function similarityOf(pair: { keep: ConsolidationCandidate; retire: ConsolidationCandidate }): number {
  return summarySimilarity(pair.keep.summary, pair.retire.summary);
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
