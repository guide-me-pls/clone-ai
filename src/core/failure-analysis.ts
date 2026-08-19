/**
 * Why a black-box worker failed, in a form two different providers can be
 * compared on.
 * 黑盒 Worker 失败的原因，且其形式可以在两个不同 Provider 之间比较。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceChange } from "./workspace-evidence.ts";

/**
 * The categories Clone AI ships with, kept for documentation and
 * autocomplete. The owner's catalog may introduce categories of its own, so
 * this is an open union rather than a closed one.
 * Clone AI 自带的类别，保留作为文档与自动补全。所有者的目录可以引入自己的类别，
 * 因此这是开放联合类型而不是封闭的。
 */
export type FailureCategory =
  | (string & {})
  | "launch_failed"
  | "timeout"
  | "aborted"
  | "nonzero_exit"
  | "no_artifact"
  | "missing_credential"
  | "missing_input"
  | "permission_denied"
  | "network"
  | "partial_side_effect"
  | "unexpected_side_effect"
  | "recovery_blocked"
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
  /** Changes observed before a failed worker returned. 失败 Worker 返回前观察到的 Workspace 变化。 */
  workspaceChanges?: WorkspaceChange[];
  /** Owner-authored guidance for this category, when the catalog supplies it. 目录为该类别提供的所有者自撰建议。 */
  guidance?: string;
}

export interface CorroborationResult {
  corroborated: boolean;
  category?: FailureCategory;
  overlap: number;
  summary: string;
  /** What the catalog advises the owner to check. 目录建议所有者检查什么。 */
  guidance?: string;
}

export interface FailurePattern {
  category: FailureCategory;
  /** Case-insensitive regular expression source. 大小写不敏感的正则表达式源串。 */
  match: string;
  /** Shown to the owner when this pattern fires. 该模式命中时展示给所有者的说明。 */
  guidance?: string;
}

export interface OutcomeCatalog {
  patterns: FailurePattern[];
  fallbackCategory: FailureCategory;
  /**
   * Categories that report only that something failed, without saying what.
   * Two agents agreeing on one of these proves nothing by itself.
   * 只说明"失败了"却没说明失败什么的类别。两个 Agent 仅在这些类别上一致不构成证明。
   */
  inconclusiveCategories: Set<FailureCategory>;
  source: "file" | "builtin";
}

export const OUTCOMES_DIRECTORY = "outcomes";
export const FAILURES_FILE = "failures.json";

const PATTERN_CREDENTIAL = String.raw`\b(api[_ -]?key|unauthorized|401|not logged in|authentication|credential|token (is )?(missing|invalid|expired))\b`;
const PATTERN_PERMISSION = String.raw`\b(permission denied|eacces|eperm|forbidden|403|read-?only file system)\b`;
const PATTERN_MISSING_INPUT = String.raw`\b(no such file|enoent|not found|cannot find|does not exist|missing (file|directory|argument))\b`;
const PATTERN_NETWORK = String.raw`\b(econnrefused|enotfound|etimedout|network|dns|socket hang up|502|503|504)\b`;

/**
 * The minimum catalog used when the owner has not written one. It is
 * deliberately thin: which errors a given agent emits is knowledge that
 * changes with every agent release, and the owner sees those errors before
 * this code could. The real catalog lives in
 * <dataDirectory>/outcomes/failures.json, where it can be edited by hand or
 * read by an MCP tool without touching this file.
 *
 * 所有者尚未撰写目录时使用的最小兜底。它刻意保持很薄：某个 Agent 会报什么错，是随每次
 * Agent 发版而变化的知识，而所有者比这段代码更早看到这些错误。真正的目录位于
 * <dataDirectory>/outcomes/failures.json，可手工编辑或由 MCP 工具读取，无需改动本文件。
 */
export const BUILT_IN_CATALOG: OutcomeCatalog = {
  patterns: [
    {
      category: "missing_credential",
      match: PATTERN_CREDENTIAL,
      guidance: "The agent could not authenticate. Check that its credentials are listed in the provider's env allowlist and present in this environment.",
    },
    {
      category: "permission_denied",
      match: PATTERN_PERMISSION,
      guidance: "The agent was refused access. Check workspace and file permissions.",
    },
    {
      category: "missing_input",
      match: PATTERN_MISSING_INPUT,
      guidance: "Something the work order referenced is absent. Check its inputs and dependency evidence.",
    },
    {
      category: "network",
      match: PATTERN_NETWORK,
      guidance: "The agent could not reach the network.",
    },
  ],
  fallbackCategory: "unknown",
  inconclusiveCategories: new Set<FailureCategory>(["nonzero_exit", "unknown"]),
  source: "builtin",
};

/**
 * Loads the owner's catalog, falling back to the built-in minimum. A malformed
 * catalog is a configuration error worth surfacing rather than silently
 * ignoring, so parsing problems throw instead of degrading.
 * 载入所有者的目录，缺失时回退到内建最小集合。格式错误的目录是值得暴露的配置问题，
 * 而不该被静默忽略，因此解析失败会抛错而不是降级。
 */
export async function loadOutcomeCatalog(dataDirectory: string): Promise<OutcomeCatalog> {
  const path = join(dataDirectory, OUTCOMES_DIRECTORY, FAILURES_FILE);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return BUILT_IN_CATALOG;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain an object.`);
  }
  const record = parsed as Record<string, unknown>;
  const rawPatterns = Array.isArray(record.patterns) ? record.patterns : [];
  const patterns = rawPatterns.map((entry, index) => validatePattern(entry, `${path}#patterns[${index}]`));
  const inconclusive = Array.isArray(record.inconclusiveCategories)
    ? record.inconclusiveCategories.filter((value): value is string => typeof value === "string")
    : [...BUILT_IN_CATALOG.inconclusiveCategories];
  return {
    patterns,
    fallbackCategory: typeof record.fallbackCategory === "string" ? record.fallbackCategory : "unknown",
    inconclusiveCategories: new Set<FailureCategory>(inconclusive),
    source: "file",
  };
}

function validatePattern(value: unknown, where: string): FailurePattern {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.category !== "string" || record.category.trim().length === 0) {
    throw new Error(`${where} needs a non-empty "category".`);
  }
  if (typeof record.match !== "string" || record.match.trim().length === 0) {
    throw new Error(`${where} needs a non-empty "match" regular expression.`);
  }
  try {
    new RegExp(record.match, "i");
  } catch (error: unknown) {
    throw new Error(`${where} has an invalid "match" expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    category: record.category,
    match: record.match,
    ...(typeof record.guidance === "string" ? { guidance: record.guidance } : {}),
  };
}

/**
 * Classifies free-form worker output against a catalog. The taxonomy exists to
 * decide whether two independent agents hit the same wall, not to produce a
 * precise diagnosis — and it never decides whether work is complete. That
 * stays the Kernel's judgement, made from the workspace.
 * 依据目录对自由格式的 Worker 输出分类。这套分类的用途是判断两个独立 Agent 是否撞上
 * 同一堵墙，而不是给出精确诊断——它也永远不决定工作是否完成，那始终是 Kernel 依据
 * Workspace 做出的判断。
 */
export function classifyFailure(
  text: string,
  fallback: FailureCategory = "unknown",
  catalog: OutcomeCatalog = BUILT_IN_CATALOG,
): { category: FailureCategory; guidance?: string } {
  for (const pattern of catalog.patterns) {
    if (new RegExp(pattern.match, "i").test(text)) {
      return { category: pattern.category, ...(pattern.guidance === undefined ? {} : { guidance: pattern.guidance }) };
    }
  }
  return { category: fallback };
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
export function corroborateFailures(
  reports: readonly FailureReport[],
  catalog: OutcomeCatalog = BUILT_IN_CATALOG,
): CorroborationResult {
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
  const corroborated = catalog.inconclusiveCategories.has(left.category)
    ? best.overlap >= 0.5
    : true;
  return {
    corroborated,
    category: corroborated ? left.category : undefined,
    overlap: Number(best.overlap.toFixed(2)),
    ...(left.guidance === undefined ? {} : { guidance: left.guidance }),
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

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "was", "were", "has", "have",
  "not", "but", "you", "your", "its", "are", "can", "could", "would", "should",
  "error", "failed", "failure", "exception", "please", "try", "again",
]);
