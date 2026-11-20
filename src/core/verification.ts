import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Evidence, PlanStep, Verifier, VerificationResult } from "./contracts.ts";
import { DiffFileVerifier, TestCommandVerifier } from "./verifier-plugins.ts";
import { verifiedPathInRoots } from "./verified-workspace-path.ts";

/**
 * What an acceptance criterion can be checked against on this machine.
 *
 * The v0.1 scope is the local workspace: a criterion that names a file is
 * checked by opening that file. Anything else stays a human judgement and is
 * reported as unchecked rather than silently counted as passed.
 *
 * 在本机上可以对验收标准做的实际检查。
 *
 * v0.1 的范围是本地 Workspace：点名了文件的标准，就用打开该文件来检查。其他标准仍属
 * 人工判断，会被如实报告为"未自动验证"，而不是悄悄算作通过。
 */
export interface FileExpectation {
  path: string;
  mustContain: string[];
  minBytes?: number;
}

/**
 * True when the words immediately before a path say the file is *not* expected.
 *
 * A plan that writes "do not claim out/video.mp4 exists" is being careful, and
 * reading it as a promise turns honesty into a failure. Only the clause right
 * before the path is inspected, so a prohibition on one file cannot hide a real
 * deliverable named later in the same sentence.
 *
 * 当路径前的措辞表明"并不期望该文件"时为 true。
 *
 * 计划里写"不要声称 out/video.mp4 已生成"是在谨慎，把它读成承诺会让诚实变成失败。只检查路径
 * 紧邻的分句，因此对一个文件的禁止不会掩盖同一句后面真正点名的交付物。
 */
const NEGATION = /(?:不要|不得|不应|不能|不可|禁止|无需|别|勿|未|没有|并不|do\s+not|don't|never|must\s+not|should\s+not|cannot|can't|no\s+need|without|not\s+required|isn't|is\s+not)\s*(?:声称|宣称|声明|断言|承诺|claim|state|assert|promise|say)?\s*[:：]?\s*$/i;

function isNegatedPath(sentence: string, candidateStart: number): boolean {
  const before = sentence.slice(0, candidateStart);
  const clause = before.split(/[，,；;。！？!?]|(?<=\s)(?:and|but|then|or)\s/i).at(-1) ?? before;
  return NEGATION.test(clause.replace(/[`"'\s]+$/, " ").trimEnd() + " ");
}

/**
 * Recognises the file contract hidden in a plan step.
 *
 * Plans are written in prose by a model, so the contract has to be read out of
 * the words the owner and the agent actually use. Ordinary paths with directory
 * separators are extracted, except for URLs, code expressions and uppercase
 * constant directories. A root-level filename also needs an allowed extension
 * and an explicit file-intent word in the same sentence or assertion.
 * `包含` / `contains` phrases become required substrings. A path the sentence
 * explicitly says not to claim is not extracted at all.
 *
 * 识别隐藏在计划步骤里的文件契约。
 *
 * 计划是模型用自然语言写的，因此契约必须从所有者与 Agent 实际使用的措辞中读出来。
 * 带目录分隔符的普通路径可被提取，但排除 URL、代码表达式和全大写常量目录。根级文件名
 * 还必须使用允许的扩展名，且同一句或同一条标准中有明确文件意图词；`包含` / `contains`
 * 之类的表述则变成必须出现的子串。句子明确说"不要声称"的路径完全不提取。
 */
export function extractFileExpectations(step: PlanStep): FileExpectation[] {
  const found = new Map<string, FileExpectation>();
  const rootExtensions = new Set([
    "md", "markdown", "txt", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
    "json", "jsonl", "yaml", "yml", "toml", "sh", "py", "go", "rs", "java", "kt",
    "sql", "html", "css", "csv", "xml", "lock",
  ]);
  const fileIntent = /\b(?:file|exists|exist|create|write|save|output|update|add)\b|文件|存在|创建|写入|保存|生成|产出|更新/i;

  for (const assertion of [step.instructions, ...step.acceptanceCriteria]) {
    // A period inside a filename is not a sentence boundary.
    // 文件名中的点不是句子边界。
    for (const sentence of assertion.split(/\n|(?<=[。！？；])|(?<=[.!?;])(?=\s|$)/)) {
      const absolute = /(?:^|[\s(（`"'])(\/(?=[A-Za-z0-9._\\-])(?:[A-Za-z0-9._\\-]+(?:[ \t]+[A-Za-z0-9._\\-]+)*\/)*[A-Za-z0-9._\\-]*(?:[ \t]+[A-Za-z0-9._\\-]+)*?\.[A-Za-z0-9]{1,8})(?=[\s)）`"',.，。;；:：]|$)/g;
      const quoted = /[`"']([^`"'\s]+)[`"']/g;
      const bare = /(?:^|[\s(（])([A-Za-z0-9._/\\-]+\.[A-Za-z0-9]{1,8})(?=[\s)）,.，。;；:：]|$)/g;
      // Reserve complete paths even when excluded, so a suffix cannot become a separate promise.
      // 即使完整路径被排除，也要占用其范围，避免后缀被误认为单独的文件承诺。
      const occupied: Array<[number, number]> = [];
      for (const pattern of [absolute, quoted, bare]) {
        for (const match of sentence.matchAll(pattern)) {
          const candidate = match[1];
          if (candidate === undefined) continue;
          const candidateStart = match.index + match[0].indexOf(candidate);
          const candidateEnd = candidateStart + candidate.length;
          if (occupied.some(([start, end]) => candidateStart < end && candidateEnd > start)) continue;
          occupied.push([candidateStart, candidateEnd]);
          if (candidate.startsWith("..")) continue;
          if (!/^[A-Za-z0-9._/\\ -]+\.[A-Za-z0-9]{1,8}$/.test(candidate)) continue;
          const prefix = sentence.slice(0, candidateStart).replace(/[`"']$/, "");
          const suffix = sentence.slice(match.index + match[0].length);
          if (/(?:目录|文件夹|\bdirectory|\bfolder)\s*[:：]?\s*$/i.test(prefix)) continue;
          // A location searched for clues is context, not a promised file.
          // 搜索线索的位置是上下文，并非承诺交付的文件。
          if (/^\s*(?:里|中|内)的线索/.test(suffix)) continue;
          if (/[A-Za-z_$][\w.$]*\s*\($/.test(prefix) || /^\s*\(/.test(suffix)) continue;
          // A file the sentence says not to claim is not a deliverable; reading
          // it as one punishes the plan for being honest.
          // 句子说不要声称的文件不是交付物；当成交付物等于因诚实而惩罚计划。
          if (isNegatedPath(sentence, candidateStart)) continue;
          const segments = candidate.split(/[/\\]/);
          if (segments.length > 1) {
            // Only SCREAMING_SNAKE_CASE segments are code constants. A single
            // uppercase directory such as macOS's `/var/.../T/` is still a real
            // path and must remain eligible for the workspace boundary check.
            // 只有 SCREAMING_SNAKE_CASE 段才是代码常量；macOS `/var/.../T/`
            // 这类单字母大写目录仍是真实路径，必须继续接受工作区边界检查。
            if (segments.slice(0, -1).some((segment) => segment.includes("_") && /^[A-Z0-9_]+$/.test(segment))) continue;
          } else {
            const extension = candidate.slice(candidate.lastIndexOf(".") + 1).toLowerCase();
            if (!rootExtensions.has(extension) || !fileIntent.test(sentence)) continue;
          }
          if (!found.has(candidate)) found.set(candidate, { path: candidate, mustContain: [] });
        }
      }
    }
  }

  // Required substrings apply to the single file a step is about; a step that
  // writes two files needs explicit per-file criteria, which the Kernel cannot
  // invent. 必须出现的子串只适用于步骤所针对的那个文件；写两个文件的步骤需要按文件
  // 分别给出标准，而这不是 Kernel 能替它编出来的。
  const only = [...found.values()];
  if (only.length === 1 && only[0] !== undefined) {
    for (const criterion of step.acceptanceCriteria) {
      for (const match of criterion.matchAll(/(?:包含|contains?|includes?|mentions?)\s*[:：]?\s*[`"'"']([^`"'"']{2,80})[`"'"']/gi)) {
        const needle = match[1];
        if (needle !== undefined) only[0].mustContain.push(needle);
      }
    }
  }
  return only;
}

/**
 * Verifies that a run did what the plan said, not merely that something was
 * recorded.
 *
 * Counting evidence rows only proves an agent reported back. A digital twin is
 * trusted with the owner's real files, so when a step names a file the file is
 * opened and read: existence, non-emptiness, and the substrings the acceptance
 * criteria demanded. Criteria that cannot be machine-checked are listed as
 * unverified so the summary never overstates what was confirmed.
 *
 * 验证 Run 是否真的做到了计划所说的事，而不只是"有东西被记录下来"。
 *
 * 数证据条数只能证明 Agent 回报过。数字分身被托付了所有者的真实文件，因此当步骤点名
 * 某个文件时，就真的打开它读：是否存在、是否非空、验收标准要求的子串是否出现。无法
 * 机器检查的标准会被列为未验证，使摘要绝不夸大已确认的内容。
 */
export class EvidenceVerifier implements Verifier {
  readonly #workspacePath?: string;

  constructor(options: { workspacePath?: string } = {}) {
    this.#workspacePath = options.workspacePath;
  }

  async verify(input: Parameters<Verifier["verify"]>[0]): Promise<VerificationResult> {
    const failures: string[] = [];
    const unverified: string[] = [];

    for (const step of input.plan.steps) {
      const stepEvidence = input.evidence.filter((item) => item.stepId === step.id);
      if (stepEvidence.length === 0) {
        failures.push(`${step.title}: produced no evidence at all`);
        continue;
      }
      if (step.risk === "external_side_effect" || step.risk === "irreversible") {
        const receipt = stepEvidence.some((item) => item.kind === "receipt" && item.locator !== undefined);
        if (!receipt) {
          failures.push(`${step.title}: a ${step.risk} step needs a receipt with a locator`);
        }
      }

      const expectations = extractFileExpectations(step);
      if (expectations.length === 0) {
        unverified.push(...step.acceptanceCriteria.map((criterion) => `${step.title}: ${criterion}`));
        continue;
      }
      const roots = this.#rootsForStep(step);
      for (const expectation of expectations) {
        const problem = await this.checkFile(expectation, stepEvidence, roots);
        if (problem !== undefined) failures.push(`${step.title}: ${problem}`);
      }
      for (const criterion of step.acceptanceCriteria) {
        if (!isFileCriterionCovered(criterion, expectations)) unverified.push(`${step.title}: ${criterion}`);
      }
    }

    const needsReview = failures.length === 0 && unverified.length > 0;
    const passed = failures.length === 0 && !needsReview;
    return {
      runId: input.run.id,
      passed,
      ...(needsReview ? { needsReview: true, unverifiedCriteria: unverified } : {}),
      // The criteria live in their own field; repeating them inside the
      // summary made the record show the same long text twice.
      // 标准本身有独立字段；在摘要里再重复一遍会让记录把同一段长文本显示两次。
      summary: passed
        ? `Verified ${input.plan.steps.length} step(s) against the authorized roots.`
        : needsReview
          ? `Automatic checks passed; ${unverified.length} of ${reviewableCriteria(input.plan).length} acceptance criteria still need the owner's review.`
          : `Verification failed. ${failures.join("; ")}.`,
      checkedEvidenceIds: input.evidence.map((item) => item.id),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * The roots this step may be verified against: the internal base, plus every
   * files write scope the step declared. A scope is where the owner allowed
   * this step to write, so it is also where the verifier may read.
   * 该步骤可用于验证的根：内部基准，加上步骤声明的每个 files 写 Scope。Scope 是所有者
   * 允许该步骤写入的位置，因此也是验证器可以读取的位置。
   */
  #rootsForStep(step: PlanStep): Array<string | undefined> {
    const scopes = (step.scopes ?? [])
      .filter((scope) => scope.domain === "files" && scope.access !== "read")
      .map((scope) => scope.resource);
    return [this.#workspacePath, ...scopes];
  }

  /**
   * Resolves the promised path and reads it. A locator recorded by the agent is
   * preferred, because the agent knows where it actually wrote; the plan's path
   * is resolved inside one of the authorized roots.
   * 解析承诺的路径并读取。优先使用 Agent 记录的 locator，因为 Agent 知道自己真正写到
   * 了哪里；计划里的路径在任一授权根内解析。
   */
  private async checkFile(
    expectation: FileExpectation,
    evidence: Evidence[],
    roots: readonly (string | undefined)[],
  ): Promise<string | undefined> {
    const candidates: string[] = [];
    for (const item of evidence) {
      const locator = item.locator;
      if (locator === undefined) continue;
      if (locator.endsWith(expectation.path) || locator.includes(expectation.path)) candidates.push(locator);
    }
    if (isAbsolute(expectation.path)) {
      candidates.push(expectation.path);
    } else {
      for (const root of roots) {
        if (root === undefined) continue;
        candidates.push(resolve(root, expectation.path));
      }
    }
    let absent = candidates.length === 0;
    for (const candidate of candidates) {
      const inside = roots.some((root) => {
        if (root === undefined) return false;
        const path = relative(resolve(root), resolve(candidate));
        return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
      });
      const safe = await verifiedPathInRoots(candidate, roots);
      if (safe === undefined) {
        if (inside) {
          try {
            await stat(candidate);
          } catch {
            absent = true;
          }
        }
        continue;
      }
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(safe);
      } catch {
        absent = true;
        continue;
      }
      if (!info.isFile()) {
        return `"${expectation.path}" is a directory, not a promised file`;
      }
      let contents: string;
      try {
        contents = await readFile(safe, "utf8");
      } catch {
        return `"${expectation.path}" exists but could not be read`;
      }
      if (contents.trim().length === 0) {
        return `"${expectation.path}" exists but is empty`;
      }
      if (expectation.minBytes !== undefined && Buffer.byteLength(contents) < expectation.minBytes) {
        return `"${expectation.path}" is shorter than the required ${expectation.minBytes} bytes`;
      }
      const missing = expectation.mustContain.filter((needle) => !contents.includes(needle));
      if (missing.length > 0) {
        return `"${expectation.path}" is missing required content: ${missing.map((item) => `"${item}"`).join(", ")}`;
      }
      return undefined;
    }
    return absent
      ? `"${expectation.path}" was promised but does not exist on disk`
      : `"${expectation.path}" is outside the roots this step may verify or is protected`;
  }
}

/** Acceptance criteria that could need a review, counted once per clause. 可能需要复核的验收标准，按条计数（不重复）。 */
function reviewableCriteria(plan: { steps: readonly PlanStep[] }): string[] {
  return [...new Set(plan.steps.flatMap((step) => step.acceptanceCriteria.map((criterion) => `${step.title}: ${criterion}`)))];
}

function isFileCriterionCovered(criterion: string, expectations: FileExpectation[]): boolean {
  const contains = /(?:包含|contains?|includes?|mentions?)\s*[:：]?\s*[`"'']([^`"'']{2,80})[`"'']/gi;
  let remaining = criterion.replace(contains, "");
  const checkedSubstring = remaining !== criterion && expectations.some((expectation) => expectation.mustContain.length > 0);
  let namedFile = false;
  for (const expectation of expectations) {
    if (remaining.includes(expectation.path)) namedFile = true;
    remaining = remaining.split(expectation.path).join("");
  }
  const existence = /(?:存在|非空|已生成|生成|写入|file|exists?|non-empty|written)/i.test(remaining);
  remaining = remaining
    .replace(/(?:文件|存在|非空|已生成|生成|写入|file|exists?|non-empty|written)/gi, "")
    .replace(/[\s`"''，。,:：；;().（）]/g, "");
  return remaining.length === 0 && (checkedSubstring || (namedFile && existence));
}

/**
 * Runs every Verifier and fails if any of them failed. Empty summaries from
 * plugins that had nothing to check are dropped so the owner sees the file
 * contract, not three "nothing to do" sentences.
 * 跑完每一个 Verifier，任一失败则整体失败。没有东西可检查的插件会交出空摘要，
 * 丢掉它们，所有者看到的是文件契约，而不是三句“无事可做”。
 */
export class CompositeVerifier implements Verifier {
  readonly #verifiers: readonly Verifier[];

  constructor(verifiers: readonly Verifier[]) {
    this.#verifiers = verifiers;
  }

  async verify(input: Parameters<Verifier["verify"]>[0]): Promise<VerificationResult> {
    const results: VerificationResult[] = [];
    for (const verifier of this.#verifiers) {
      results.push(await verifier.verify(input));
    }
    const failures = results.filter((result) => !result.passed && !result.needsReview);
    const needsReview = failures.length === 0 && results.some((result) => result.needsReview);
    const passed = failures.length === 0 && !needsReview;
    const summaries = (failures.length === 0 ? results : failures)
      .map((result) => failures.length === 0
        ? result.summary.trim()
        : result.summary.trim().replace(/^Verification failed\.\s*/i, ""))
      .filter((summary) => summary.length > 0);
    return {
      runId: input.run.id,
      passed,
      ...(needsReview ? {
        needsReview: true,
        unverifiedCriteria: [...new Set(results.flatMap((result) => result.unverifiedCriteria ?? []))],
      } : {}),
      summary: failures.length === 0
        ? (summaries.join(" ") || `Verified ${input.plan.steps.length} step(s).`)
        : `Verification failed. ${summaries.join("; ")}`,
      checkedEvidenceIds: [...new Set(results.flatMap((result) => result.checkedEvidenceIds))],
      createdAt: new Date().toISOString(),
    };
  }
}

/**
 * Production Verifier: file contracts, receipt gate, then the test/diff plugins.
 * 生产 Verifier：文件契约、Receipt 闸门，然后是测试 / diff 插件。
 */
export function createDefaultVerifier(options: { workspacePath?: string } = {}): Verifier {
  return new CompositeVerifier([
    new EvidenceVerifier(options),
    new TestCommandVerifier(options),
    new DiffFileVerifier(options),
  ]);
}
