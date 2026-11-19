/**
 * Cheap local checks before a candidate becomes durable memory: fingerprint
 * dedup and a regex PII sweep. Not a vector index and not a compliance scanner.
 * 候选成为持久记忆前的廉价本地检查：指纹去重与正则 PII 扫描。不是向量索引，
 * 也不是合规扫描器。
 */
import { createHash } from "node:crypto";

import type { Evidence, MemoryCandidate } from "../core/contracts.ts";

export type MemoryPiiKind = "email" | "phone" | "private_key" | "token" | "payment_card";

interface PiiRule {
  kind: MemoryPiiKind;
  pattern: RegExp;
  replace: string;
}

const PII_RULES: readonly PiiRule[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    replace: "[redacted private key]",
  },
  { kind: "token", pattern: /\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/g, replace: "[redacted token]" },
  { kind: "token", pattern: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: "[redacted token]" },
  { kind: "token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi, replace: "Bearer [redacted]" },
  {
    kind: "token",
    pattern: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi,
    replace: "$1=[redacted]",
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: "[redacted email]",
  },
  {
    kind: "phone",
    pattern: /\b(?:\+?\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
    replace: "[redacted phone]",
  },
  { kind: "phone", pattern: /\b1[3-9]\d{9}\b/g, replace: "[redacted phone]" },
  {
    kind: "payment_card",
    pattern: /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g,
    replace: "[redacted card]",
  },
];

/**
 * Stable identity of a memory summary after Unicode and whitespace folding.
 * 折叠 Unicode 与空白后的记忆摘要稳定身份。
 */
export function memoryFingerprint(text: string): string {
  const normalized = text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function scanMemoryPii(text: string): MemoryPiiKind[] {
  const found = new Set<MemoryPiiKind>();
  for (const rule of PII_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (pattern.test(text)) found.add(rule.kind);
  }
  return [...found];
}

export function redactMemoryPii(text: string): { text: string; kinds: MemoryPiiKind[] } {
  const kinds = scanMemoryPii(text);
  let next = text;
  for (const rule of PII_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    next = next.replace(pattern, rule.replace);
  }
  return { text: next, kinds };
}

/**
 * Whether an evidence summary records something that went wrong. The mining
 * prompt marks these lines; the pipeline refuses a failed run's lesson that
 * cites none of them.
 *
 * 一条 Evidence 摘要是否记录了出错。提炼 Prompt 会标记这些行；流水线拒绝没有引用其中
 * 任何一条的失败任务教训。
 */
const FAILURE_SIGNAL = /\b(?:fail(?:ed|ure|s)?|errors?|exceptions?|timeouts?|timed out|enoent|eacces|denied|refused|not found|missing|regression|broken)\b|失败|报错|异常|超时|被拒绝|拒绝访问|不存在|找不到|未通过|回归|中断|无法|错误[:：]/iu;

export function evidenceRecordsFailure(summary: string): boolean {
  return FAILURE_SIGNAL.test(summary);
}

/**
 * Whether a candidate is a lesson about a failed run that does not cite the
 * failure it claims to explain.
 *
 * The failed-run branch asks the miner for a procedure grounded in what went
 * wrong. When the run's evidence only shows successful work (a directory
 * listing, a produced artifact), the model has no cause to cite and instead
 * restates the work order. A lesson is therefore accepted only when it cites
 * an evidence item that records a failure; with no such evidence at all, the
 * run yields no lesson rather than a confident guess.
 *
 * 判断候选是否是"声称解释失败、却没有引用失败"的失败任务教训。
 *
 * 失败分支要求提炼器基于出错事实给出 procedure。当 Run 的 Evidence 只显示成功的工作
 * （一次目录列表、一个已产出的工件）时，模型没有可引用的原因，就把工作单重说一遍。因此
 * 只有当教训引用了一条记录失败的 Evidence 时才接受；完全没有这类 Evidence 时，这个 Run
 * 不产出教训，而不是产出一个自信的猜测。
 */
export function isUngroundedFailureLesson(
  candidate: Pick<MemoryCandidate, "type" | "sourceEvidenceIds">,
  outcome: "completed" | "failed" | undefined,
  evidence: ReadonlyArray<Pick<Evidence, "id" | "summary">>,
): boolean {
  if (outcome !== "failed" || candidate.type !== "procedure") return false;
  const failureIds = new Set(evidence.filter((item) => evidenceRecordsFailure(item.summary)).map((item) => item.id));
  if (failureIds.size === 0) return true;
  return !candidate.sourceEvidenceIds.some((id) => failureIds.has(id));
}

/**
 * Labels that introduce a procedure copied from a task objective. Longest
 * first, so "candidate procedure" wins over "procedure".
 * 复制任务目标时常用的过程标签。长的在前，使 "candidate procedure" 先于 "procedure"。
 */
const PROCEDURE_LABELS: readonly string[] = [
  "candidate procedure",
  "候选过程",
  "候选流程",
  "procedure",
  "流程",
];

/** Decoration around a label, never inside a token. 标签周围的装饰；不会出现在词内部。 */
const DECORATION = "[\\s\\p{Z}\\p{Cc}\\p{Cf}\\uFE00-\\uFE0F\\u20E3\\p{So}\\p{Sk}*_#>•·\\-–—\"'“”‘’()[\\]{}]";
const LEADING_DECORATION = new RegExp(`^(?:${DECORATION})+`, "u");
const TRAILING_TEMPLATE = new RegExp(
  `[\\s\\p{Z}\\p{Cf}\\uFE00-\\uFE0F\\u20E3\\p{So}\\p{Sk}*_#>•·—–\\-:：,，;；()（）\\[\\]{}"'“”‘’]+\\s*`
  + `(?:${PROCEDURE_LABELS.join("|")})\\s*[)）\\]}]*[\\s。.!！?？…]*$`,
  "iu",
);
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

/**
 * Whether a candidate only restates the task it came from.
 *
 * A completed task is a work order, not durable knowledge: "review the RAG
 * project" says what was done, not what to remember. The comparison folds
 * Unicode, a locale-independent case, invisible format characters, whitespace,
 * punctuation and emoji, and strips a procedure label from either end of both
 * texts. It is deliberately exact: a paraphrase, or a longer memory that merely
 * begins with the task's words, is kept, because a looser similarity rule would
 * drop legitimate lessons.
 *
 * 判断候选是否只是在复述它来自的任务。
 *
 * 已完成任务是工作单，不是持久知识：“审查 RAG 项目”说的是做了什么，不是要记住什么。
 * 比较会折叠 Unicode、与区域设置无关的大小写、不可见格式字符、空白、标点与 emoji，并去掉
 * 两端的过程标签。它刻意保持精确：改写，或只是在开头提到任务措辞的更长记忆会被保留，因为
 * 更宽松的相似度规则会丢弃合法教训。
 */
export function restatesTaskObjective(summary: string, objective: string): boolean {
  const task = foldForComparison(stripProcedureTemplates(prepareForComparison(objective)));
  if (task.length === 0) return false;
  const candidate = foldForComparison(stripProcedureTemplates(prepareForComparison(summary)));
  return candidate.length > 0 && candidate === task;
}

/**
 * Whether this candidate should be refused as a task restatement.
 *
 * A typed preference, fact, decision or commitment may legitimately equal a
 * first-person task objective — the owner can state exactly what they asked
 * for. Only untyped legacy copies and procedures are refused automatically;
 * every other type stays for owner review.
 *
 * 判断这条候选是否应作为任务复述被拒绝。
 *
 * 有类型的偏好、事实、决定或承诺可能合法地等于第一人称的任务目标——所有者可能原样说出了
 * 自己要求的事。只有无类型的遗留复制与 procedure 会被自动拒绝；其他类型都留给所有者审核。
 */
export function isTaskRestatement(candidate: Pick<MemoryCandidate, "summary" | "type">, objective: string): boolean {
  if (candidate.type !== undefined && candidate.type !== "procedure") return false;
  return restatesTaskObjective(candidate.summary, objective);
}

/**
 * Whether a summary carries enough content to be a memory at all. Punctuation,
 * emoji and spacing alone fold to nothing and must not become candidates.
 * 摘要是否至少承载了可以做记忆的内容。只有标点、emoji 与空白会折叠为空，不能成为候选。
 */
export function hasDurableMemoryText(text: string): boolean {
  return Array.from(foldForComparison(stripProcedureTemplates(prepareForComparison(text)))).length >= 2;
}

/**
 * Comparison form: NFKC, a locale-independent lowercase, and no invisible
 * formatting or variation selectors.
 * 比较形式：NFKC、与区域设置无关的小写，并去掉不可见格式字符与变体选择符。
 */
function prepareForComparison(text: string): string {
  return text.normalize("NFKC")
    // U+0130 lowercases differently by locale; map it before lowering.
    // U+0130 的小写结果取决于区域设置；先映射再转小写。
    .replace(/İ/g, "i")
    .toLowerCase()
    .replace(INVISIBLE_CHARACTERS, "");
}

/** Control, format, variation-selector and keycap code points are invisible to a reader. 读者看不见的控制、格式、变体选择符与键帽码位。 */
const INVISIBLE_CHARACTERS = new RegExp("[\\p{Cc}\\p{Cf}\\uFE00-\\uFE0F\\u20E3]", "gu");

/**
 * Removes a procedure label from either end of the text. A label only counts
 * when a separator or the text's end bounds it, so "候选流程改进" is not read as
 * the label "候选流程".
 * 去掉文本两端的过程标签。只有分隔符或文本边界才算标签，因此“候选流程改进”不会被读成
 * 标签“候选流程”。
 */
function stripProcedureTemplates(text: string): string {
  let next = text;
  // Stacked labels are unusual but cheap to peel; three rounds bound the work.
  // 叠加标签不常见，但剥离成本低；三轮即可封顶。
  for (let round = 0; round < 3; round += 1) {
    const stripped = stripLeadingTemplate(next);
    if (stripped === next) break;
    next = stripped;
  }
  return stripTrailingTemplate(next);
}

function stripLeadingTemplate(text: string): string {
  const decoration = LEADING_DECORATION.exec(text);
  const body = text.slice(decoration?.[0].length ?? 0);
  const lower = body.toLowerCase();
  const label = PROCEDURE_LABELS.find((candidate) => lower.startsWith(candidate) && labelBoundary(body, candidate.length));
  if (label === undefined) return text;
  const rest = body.slice(label.length)
    .replace(/^\s*(?:是|为)?\s*[:：\-–—]?\s*/u, "")
    .replace(LEADING_DECORATION, "");
  return rest;
}

function stripTrailingTemplate(text: string): string {
  const match = TRAILING_TEMPLATE.exec(text);
  return match === null ? text : text.slice(0, match.index).trim();
}

function labelBoundary(text: string, labelLength: number): boolean {
  const next = text[labelLength];
  if (next === undefined) return true;
  // 是/为 are the CJK connectors a label may take before its separator.
  // 是/为 是标签在分隔符之前可能带的中文连接词。
  if (next === "是" || next === "为") return true;
  return !WORD_CHARACTER.test(next);
}

/**
 * Folded comparison form. Token-internal `.`, `-`, `#`, `&` and `+` are kept
 * (C vs C++, v12 vs v1.2), while every other punctuation mark, symbol, space
 * and separator is removed.
 * 折叠后的比较形式。词内部的 `.`、`-`、`#`、`&`、`+` 会保留（C 与 C++、v12 与 v1.2），
 * 其余标点、符号、空白与分隔符全部去掉。
 */
function foldForComparison(text: string): string {
  const protectedTokens: string[] = [];
  const mask = (token: string): string => {
    protectedTokens.push(token);
    return `\u0000${protectedTokens.length - 1}\u0001`;
  };
  // A dot or dash is token-internal only between alphanumerics (v1.2, 1-2);
  // `#`, `&` and `+` are meaningful at a token's edge (C++, C#, AT&T). A
  // sentence period is none of these and is removed.
  // 点或连字符只有夹在字母数字之间才算词内（v1.2、1-2）；`#`、`&`、`+` 在词边缘也
  // 有意义（C++、C#、AT&T）。句末句号不属于这些，会被删除。
  const masked = text
    .replace(/(?<=[\p{L}\p{N}])[.\-](?=[\p{L}\p{N}])/gu, (symbol) => mask(symbol))
    .replace(/(?<=[\p{L}\p{N}])[#&+]+/gu, (symbols) => mask(symbols))
    .replace(/[#&+]+(?=[\p{L}\p{N}])/gu, (symbols) => mask(symbols));
  const folded = masked.replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
  return folded.replace(/\u0000(\d+)\u0001/g, (_, index: string) => protectedTokens[Number(index)] ?? "");
}
