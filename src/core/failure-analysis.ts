/**
 * Why a black-box worker failed, in a form two different providers can be
 * compared on.
 * 黑盒 Worker 失败的原因，且其形式可以在两个不同 Provider 之间比较。
 */
export type FailureCategory =
  | "launch_failed"
  | "timeout"
  | "aborted"
  | "nonzero_exit"
  | "no_artifact"
  | "missing_credential"
  | "missing_input"
  | "permission_denied"
  | "network"
  | "unknown";

export interface FailureReport {
  providerId: string;
  agentId: string;
  category: FailureCategory;
  exitCode?: number | null;
  /** Normalized, comparable form; volatile details removed. 归一化后的可比较形式，已去掉易变细节。 */
  signature: string;
  /** Redacted human-readable tail of the worker's output. 脱敏后可读的 Worker 输出尾部。 */
  detail: string;
}

export interface CorroborationResult {
  corroborated: boolean;
  category?: FailureCategory;
  overlap: number;
  summary: string;
}

const CATEGORY_PATTERNS: ReadonlyArray<{ category: FailureCategory; pattern: RegExp }> = [
  { category: "missing_credential", pattern: /\b(api[_ -]?key|unauthorized|401|not logged in|authentication|credential|token (is )?(missing|invalid|expired))\b/i },
  { category: "permission_denied", pattern: /\b(permission denied|eacces|eperm|forbidden|403|read-?only file system)\b/i },
  { category: "missing_input", pattern: /\b(no such file|enoent|not found|cannot find|does not exist|missing (file|directory|argument))\b/i },
  { category: "network", pattern: /\b(econnrefused|enotfound|etimedout|network|dns|socket hang up|502|503|504)\b/i },
];

/**
 * Classifies free-form worker output. The taxonomy is deliberately coarse:
 * its purpose is deciding whether two independent agents hit the same wall,
 * not producing a precise diagnosis.
 * 对自由格式的 Worker 输出做分类。这套分类刻意保持粗粒度：它的用途是判断两个独立
 * Agent 是否撞上了同一堵墙，而不是给出精确诊断。
 */
export function classifyFailure(text: string, fallback: FailureCategory = "unknown"): FailureCategory {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return fallback;
}

/**
 * Strips everything that differs between two runs of the same problem — paths,
 * ids, hashes, numbers, timestamps, and the provider's own name — so that what
 * remains is the shape of the complaint.
 * 剥掉同一问题在两次运行之间会变化的一切——路径、ID、哈希、数字、时间戳，以及 Provider
 * 自己的名字——剩下的就是这条抱怨的形状。
 */
export function failureSignature(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[a-z]:\\[^\s"']+|\/[^\s"':]+/g, " path ")
    .replace(/\b[0-9a-f]{8,}\b/g, " id ")
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, " time ")
    .replace(/\b\d+\b/g, " n ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .slice(0, 60)
    .join(" ");
}

/**
 * The cross-agent check: when two independent providers fail the same way, the
 * obstacle is in the task or the environment, not in the agent. That verdict
 * is worth escalating to the owner instead of burning attempts on a third
 * agent that will hit the same wall.
 *
 * 跨 Agent 校验：当两个独立 Provider 以相同方式失败时，障碍在任务或环境中，而不在
 * Agent 身上。这个判断值得升级给所有者，而不是把尝试次数浪费在同样会撞墙的第三个
 * Agent 上。
 */
export function corroborateFailures(reports: readonly FailureReport[]): CorroborationResult {
  const distinct = new Map<string, FailureReport>();
  for (const report of reports) {
    if (!distinct.has(report.providerId)) distinct.set(report.providerId, report);
  }
  const independent = [...distinct.values()];
  if (independent.length < 2) {
    return { corroborated: false, overlap: 0, summary: "Only one provider has reported a failure so far." };
  }

  let best = { overlap: 0, pair: undefined as undefined | [FailureReport, FailureReport] };
  for (let i = 0; i < independent.length; i += 1) {
    for (let j = i + 1; j < independent.length; j += 1) {
      const left = independent[i]!;
      const right = independent[j]!;
      if (left.category !== right.category) continue;
      const overlap = tokenOverlap(left.signature, right.signature);
      if (overlap > best.overlap) best = { overlap, pair: [left, right] };
    }
  }

  if (best.pair === undefined) {
    return { corroborated: false, overlap: 0, summary: "Independent providers failed for different reasons." };
  }
  const [left, right] = best.pair;
  // Independent products describe the same wall in their own words, so shared
  // wording is a weak signal and agreement on a *diagnostic* category is the
  // strong one. For the two catch-all categories the reverse holds: "exited
  // nonzero" says nothing on its own, so wording has to carry the claim.
  // 各自独立的产品会用自己的措辞描述同一堵墙，因此措辞重合是弱信号，而在"有诊断意义的"
  // 类别上达成一致才是强信号。对两个兜底类别则相反："非零退出"本身什么都没说明，
  // 此时必须由措辞来支撑判断。
  const corroborated = INCONCLUSIVE_CATEGORIES.has(left.category)
    ? best.overlap >= 0.5
    : true;
  return {
    corroborated,
    category: corroborated ? left.category : undefined,
    overlap: Number(best.overlap.toFixed(2)),
    summary: corroborated
      ? `${left.providerId} and ${right.providerId} both failed with ${left.category}; the obstacle is in the task or environment, not the agent.`
      : `${left.providerId} and ${right.providerId} share category ${left.category} but describe different problems.`,
  };
}

function tokenOverlap(left: string, right: string): number {
  const a = new Set(left.split(" ").filter(Boolean));
  const b = new Set(right.split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Categories that report only that something failed, without saying what. Two
 * agents agreeing on these has no diagnostic content.
 * 只说明"失败了"却没说明失败什么的类别。两个 Agent 在这些类别上一致，不具备诊断意义。
 */
const INCONCLUSIVE_CATEGORIES: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  "nonzero_exit",
  "unknown",
]);

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "was", "were", "has", "have",
  "not", "but", "you", "your", "its", "are", "can", "could", "would", "should",
  "error", "failed", "failure", "exception", "please", "try", "again",
]);
