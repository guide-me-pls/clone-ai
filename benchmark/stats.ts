/**
 * Small statistics helpers for the benchmark reports. Kept in a module so the
 * median and percentile rules are testable without running a model.
 * 基准报告用的小型统计工具。单独成模块，使中位数与百分位规则无需运行模型即可测试。
 */

/** Arithmetic median; even-length inputs average the two middle values. 算术中位数；偶数长度取中间两个的平均。 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Nearest-rank percentile (1..100): the smallest value whose rank covers p% of
 * the samples. No interpolation, so every reported number is an observed value.
 * 最近秩百分位（1..100）：秩覆盖 p% 样本的最小值。不做插值，因此报告的每个数字都是
 * 实际观测值。
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.min(100, Math.max(1, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, rank - 1)]!;
}