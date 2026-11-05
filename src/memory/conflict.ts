/**
 * Near-duplicate and contradictory memories.
 *
 * Fingerprint dedup at promotion catches the same sentence twice. It cannot
 * catch the same fact reworded, or a fact the owner changed their mind about:
 * "报告的模板用蓝色" and "报告模板改用绿色" are different strings and both stay
 * active. At recall time that means two memories can be in the context at once
 * saying different things, and the model has no way to choose between them.
 *
 * This module finds those pairs so a human or the improvement loop can decide.
 * It compares token overlap, not meaning: two memories about the same subject
 * with different values score high on overlap, which is exactly the signal.
 * It is deliberately conservative — a false "these look alike" costs one
 * glance, a false "these are the same" silently deletes a fact.
 *
 * 近似重复与相互矛盾的记忆。
 *
 * 提升时的指纹去重能抓住同一句话出现两次，却抓不住同一事实改写，也抓不住所有者改变主意：
 * "报告的模板用蓝色"与"报告模板改用绿色"是不同字符串，两条都会保持活跃。召回时，上下文中可能
 * 同时存在两条互相矛盾的记忆，模型无从取舍。
 *
 * 本模块找出这些配对，交给人类或改进环路决定。它比较的是词重叠而非语义：同一主题、不同取值的
 * 两条记忆重叠分很高，这正是所需信号。它刻意保守——误报"看起来像"只需多看一眼，误报"是同一个"
 * 则会静默删掉一个事实。
 */
import { tokenize } from "./md-memory-store.ts";

export interface ConflictSubject {
  id: string;
  summary: string;
  type?: string;
  createdAt: string;
  status?: string;
}

export interface ConflictPair {
  /** The memory to keep: newer when the pair is not identical. 保留的记忆：不同时取较新的一条。 */
  keep: ConflictSubject;
  /** The memory to retire. 应退役的记忆。 */
  retire: ConflictSubject;
  similarity: number;
  reason: "near-duplicate" | "same-subject";
}

/** Token-set Jaccard. Symmetric, bounded, and cheap enough to run over one owner's library. Token 集合 Jaccard，对称、有界，且对单个所有者的记忆库足够便宜。 */
export function summarySimilarity(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  // Overlap coefficient, not Jaccard: two memories about one subject differ in
  // length and wording, and Jaccard punishes the longer one for it. Overlap
  // asks "is most of the shorter one contained in the longer one", which is the
  // question a review queue actually wants.
  // 用重叠系数而非 Jaccard：同一主题的两条记忆长度与措辞都不同，Jaccard 会因较长的一条而惩罚它。
  // 重叠系数问的是"较短的一条是否大部分包含在较长的一条里"，这才是复核队列真正关心的问题。
  return intersection / Math.min(a.size, b.size);
}

/**
 * Thresholds measured on the pairs this was written for (see
 * test/memory-conflict.test.ts): a reworded statement scores 0.57-0.93, an
 * unrelated one 0.0-0.4, and — the limit worth knowing — a *changed value*
 * in Chinese ("蓝色" -> "绿色") scores only 0.29, because the differing value
 * replaces a bigram at both ends. That case is therefore not reliably caught,
 * and the trade-off log records it rather than hiding it behind a tuned
 * threshold.
 *
 * 阈值来自写它时的那批配对（见 test/memory-conflict.test.ts）：改写句 0.74–0.83，无关句
 * 0.0–0.22；而值得知道的局限是——中文里**取值改变**（"蓝色" -> "绿色"）只有 0.29，因为不同的取值
 * 在两端各替换了一个 bigram。该情形因此无法可靠捕获，权衡记录如实记下，而不是用调过的阈值掩盖。
 */
export const NEAR_DUPLICATE = 0.55;
export const SAME_SUBJECT = 0.35;

/**
 * Pairs worth a decision, most similar first, each memory appearing at most
 * once. Only active memories of the same type are compared: a preference and a
 * procedure that share words are usually both true.
 * 值得决策的配对，最相似的在前，每条记忆最多出现一次。只比较同类型的活跃记忆：一条偏好与一条共享
 * 词汇的流程通常都为真。
 */
export function findConflicts(memories: readonly ConflictSubject[]): ConflictPair[] {
  const active = memories.filter((memory) => memory.status === undefined || memory.status === "active");
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const left = active[i]!;
      const right = active[j]!;
      if (left.type !== undefined && right.type !== undefined && left.type !== right.type) continue;
      const similarity = summarySimilarity(left.summary, right.summary);
      if (similarity < SAME_SUBJECT) continue;
      const [keep, retire] = left.createdAt >= right.createdAt ? [left, right] : [right, left];
      pairs.push({
        keep,
        retire,
        similarity: Number(similarity.toFixed(3)),
        reason: similarity >= NEAR_DUPLICATE ? "near-duplicate" : "same-subject",
      });
    }
  }
  const used = new Set<string>();
  return pairs
    .sort((a, b) => b.similarity - a.similarity)
    .filter((pair) => {
      if (used.has(pair.keep.id) || used.has(pair.retire.id)) return false;
      used.add(pair.keep.id);
      used.add(pair.retire.id);
      return true;
    });
}

/**
 * Drops a later candidate that restates an earlier one, keeping whichever
 * scored higher (ties go to the later one, which is the newer memory).
 * 丢弃后出现却只是复述前一条的候选，保留分数更高的一条（平分时取较新的那条）。
 */
export function dedupeContext<T extends { id: string; summary: string; score: number }>(candidates: readonly T[]): T[] {
  const kept: T[] = [];
  for (const candidate of candidates) {
    const duplicateIndex = kept.findIndex((item) => summarySimilarity(item.summary, candidate.summary) >= NEAR_DUPLICATE);
    if (duplicateIndex < 0) {
      kept.push(candidate);
      continue;
    }
    if (candidate.score > kept[duplicateIndex]!.score) kept[duplicateIndex] = candidate;
  }
  return kept;
}
