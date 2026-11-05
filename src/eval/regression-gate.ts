/**
 * The deterministic regression gate.
 *
 * The gate re-runs the harness's *judgment* layers — evidence verification and
 * authority policy — against a held-out fixture set, and calibrates the audit
 * projection against owner labels. It never calls a model: a CI gate that needs
 * a provider is a gate that is skipped on the day it matters.
 *
 * Two rules make it a gate rather than a test suite:
 *
 *   1. Per-case behavior is recorded in a baseline. Any change — including an
 *      improvement — fails until the baseline is regenerated in the same
 *      change, so a verdict shift is reviewed instead of slipping in.
 *   2. Aggregate floors state what the project refuses to regress on: no
 *      false pass on the held-out set, full agreement on policy outcomes, and
 *      a minimum number of labeled audit records.
 *
 * What this does not do: measure model quality. The fixtures exercise the rules
 * around the model, which is where this repository's guarantees live.
 *
 * 确定性回归门禁。
 *
 * 门禁会针对 held-out 夹具重新运行 harness 的“判断”层——证据验证与权限策略——并用
 * 所有者标注校准审计投影。它从不调用模型：需要 Provider 的 CI 门禁，总会在最关键的那天
 * 被跳过。
 *
 * 两条规则使它成为门禁而不是普通测试集：
 *
 *   1. 每个用例的行为记录在基线里。任何变化——包括改进——都会失败，直到在同一次变更中
 *      重新生成基线，因此判定变化会被审查，而不是悄悄溜过。
 *   2. 聚合下限声明项目拒绝退化的底线：held-out 集上零假通过、策略结果完全一致，
 *      以及标注审计记录的最低数量。
 *
 * 它不做什么：衡量模型质量。夹具检验的是模型周围的规则，而这正是本仓库保证所在之处。
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Evidence, PlanStep, Run, Task, WorkPlan } from "../core/contracts.ts";
import type { PolicyDecision } from "../core/contracts.ts";
import { EvidenceVerifier } from "../core/verification.ts";
import { AuthorityPolicyEngine } from "../authority/policy-engine.ts";
import type { AuthorityConfig } from "../authority/standing-policy-store.ts";
import { summarizeAudits, type RunAuditRecord } from "../audit/run-audit.ts";

export const GATE_SCHEMA_VERSION = 1;

/** A step shape shared by both suites; scopes only matter to policy. 两个套件共用的步骤形状；只有策略关心 scopes。 */
export interface GateStep {
  id: string;
  title: string;
  instructions: string;
  risk: PlanStep["risk"];
  acceptanceCriteria: string[];
  scopes?: PlanStep["scopes"];
}

export interface VerdictCase {
  id: string;
  title: string;
  plan: { steps: GateStep[] };
  /** Relative path -> exact content, materialised into a throwaway workspace. 相对路径 -> 确切内容，写入一次性工作区。 */
  workspace?: Record<string, string>;
  evidence: Array<{ stepId: string; kind: Evidence["kind"]; summary: string; locator?: string }>;
  /** What the owner would say about this run. 所有者对这个 Run 的判定。 */
  ownerVerdict: "pass" | "fail";
  note?: string;
}

export interface PolicyCase {
  id: string;
  title: string;
  step: GateStep;
  approved: boolean;
  authority: AuthorityConfig;
  expectedOutcome: PolicyDecision["outcome"];
  note?: string;
}

export type VerdictOutcome = "pass" | "fail" | "review";

export interface CaseResult {
  suite: "verdict" | "policy";
  id: string;
  actual: string;
  expected: string;
  correct: boolean;
  detail?: string;
}

export interface VerdictSummary {
  cases: number;
  decided: number;
  agreement: number | null;
  falsePass: number;
  falseFail: number;
  review: number;
}

export interface PolicySummary {
  cases: number;
  agreement: number | null;
  /** System allowed what the fixture expected to be gated. 系统放行了夹具预期应被拦截的动作。 */
  unsafeAllows: number;
  /** System gated what the fixture expected to be allowed. 系统拦截了夹具预期应放行的动作。 */
  overBlocks: number;
}

export interface AuditGateSummary {
  records: number;
  labeled: number;
  unlabeledFinished: number;
  agreement: number | null;
  falsePass: number;
  falseFail: number;
}

export interface VerdictThresholds {
  minCases: number;
  minAgreement: number;
  maxFalsePass: number;
}

export interface PolicyThresholds {
  minCases: number;
  minAgreement: number;
  maxUnsafeAllows: number;
}

export interface AuditThresholds {
  minLabeled: number;
  minAgreement: number;
  maxFalsePass: number;
}

export interface GateBaseline {
  schemaVersion: number;
  /** sha256 of the audit dataset, so the held-out records cannot change silently. 审计数据集的 sha256，使 held-out 记录无法悄悄变化。 */
  auditDatasetHash?: string;
  suites: {
    verdict?: VerdictThresholds;
    policy?: PolicyThresholds;
    audit?: AuditThresholds;
  };
  /** `<suite>/<id>` -> the behavior recorded when the baseline was written. `<suite>/<id>` -> 写基线时记录的行为。 */
  cases: Record<string, string>;
}

export type GateFailureKind =
  | "behavior_changed"
  | "missing_baseline"
  | "missing_case"
  | "dataset_changed"
  | "threshold";

export interface GateFailure {
  kind: GateFailureKind;
  scope: string;
  message: string;
}

export interface CaseChange {
  key: string;
  before: string;
  after: string;
}

export interface GateReport {
  verdict: VerdictSummary;
  policy: PolicySummary;
  audit: AuditGateSummary;
  verdictResults: CaseResult[];
  policyResults: CaseResult[];
  changes: CaseChange[];
  failures: GateFailure[];
  passed: boolean;
}

export const DEFAULT_THRESHOLDS: Required<GateBaseline["suites"]> = {
  verdict: { minCases: 1, minAgreement: 1, maxFalsePass: 0 },
  policy: { minCases: 1, minAgreement: 1, maxUnsafeAllows: 0 },
  audit: { minLabeled: 1, minAgreement: 1, maxFalsePass: 0 },
};

/**
 * Runs every verdict case against the current EvidenceVerifier.
 *
 * A throwaway workspace per case is deliberate: verification is allowed to read
 * real files, and the gate must prove that behavior without touching the
 * owner's tree.
 * 用当前的 EvidenceVerifier 运行每个判定用例。
 *
 * 每个用例使用一次性工作区是有意为之：验证会读取真实文件，门禁必须在不触碰所有者目录的
 * 前提下证明这一行为。
 */
export async function runVerdictSuite(
  cases: readonly VerdictCase[],
  options: { workspaceRoot?: string } = {},
): Promise<{ summary: VerdictSummary; results: CaseResult[] }> {
  const results: CaseResult[] = [];
  let falsePass = 0;
  let falseFail = 0;
  let review = 0;
  let agree = 0;
  let decided = 0;

  for (const testCase of cases) {
    const outcome = await runOneVerdictCase(testCase, options.workspaceRoot);
    const ownerPass = testCase.ownerVerdict === "pass";
    const correct = outcome.outcome === "pass" ? ownerPass : outcome.outcome === "fail" ? !ownerPass : false;
    if (outcome.outcome === "review") {
      review += 1;
    } else {
      decided += 1;
      if (correct) agree += 1;
      else if (outcome.outcome === "pass") falsePass += 1;
      else falseFail += 1;
    }
    results.push({
      suite: "verdict",
      id: testCase.id,
      actual: outcome.outcome,
      expected: testCase.ownerVerdict,
      correct,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    });
  }

  return {
    summary: {
      cases: cases.length,
      decided,
      agreement: decided === 0 ? null : agree / decided,
      falsePass,
      falseFail,
      review,
    },
    results,
  };
}

async function runOneVerdictCase(
  testCase: VerdictCase,
  workspaceRoot: string | undefined,
): Promise<{ outcome: VerdictOutcome; detail?: string }> {
  const hasWorkspace = testCase.workspace !== undefined;
  const directory = hasWorkspace
    ? await mkdtemp(join(workspaceRoot ?? tmpdir(), "clone-ai-gate-"))
    : undefined;
  try {
    if (directory !== undefined) {
      for (const [path, content] of Object.entries(testCase.workspace ?? {})) {
        // Fixtures only name flat files; nested paths would make the fixture a
        // directory-layout claim the gate cannot police.
        // 夹具只点名扁平文件；嵌套路径会把夹具变成门禁无法约束的目录布局声明。
        if (path.includes("/") || path.includes("\\")) {
          throw new Error(`Verdict case ${testCase.id}: workspace paths must be flat (got "${path}").`);
        }
        await writeFile(join(directory, path), content, "utf8");
      }
    }
    const run: Run = {
      id: `gate-run-${testCase.id}`,
      taskId: `gate-task-${testCase.id}`,
      status: "verifying",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const plan: WorkPlan = {
      id: `gate-plan-${testCase.id}`,
      runId: run.id,
      summary: testCase.title,
      steps: testCase.plan.steps,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const evidence: Evidence[] = testCase.evidence.map((item, index) => ({
      id: `gate-evidence-${testCase.id}-${index}`,
      runId: run.id,
      stepId: item.stepId,
      kind: item.kind,
      summary: item.summary,
      ...(item.locator === undefined ? {} : { locator: item.locator }),
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const result = await new EvidenceVerifier({
      ...(directory === undefined ? {} : { workspacePath: directory }),
    }).verify({ run, plan, evidence });
    const outcome: VerdictOutcome = result.needsReview === true ? "review" : result.passed ? "pass" : "fail";
    return { outcome, detail: result.summary };
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Runs every policy case through the production authority engine with the
 * fixture's own configuration. `home` is fixed so a forbidden-path verdict does
 * not depend on whose machine runs the gate.
 * 用夹具自带的配置让每个策略用例通过生产 Authority 引擎。`home` 固定，使禁区判定不依赖
 * 运行门禁的机器。
 */
export async function runPolicySuite(
  cases: readonly PolicyCase[],
  options: { home?: string } = {},
): Promise<{ summary: PolicySummary; results: CaseResult[] }> {
  // A throwaway home makes `~/...` fixtures and forbidden-path checks
  // deterministic on every machine, and proves the rules without reading the
  // real home directory.
  // 一次性 home 让 `~/...` 夹具与禁区检查在任何机器上都确定，并在不读取真实家目录的
  // 前提下证明这些规则。
  const temporaryHome = options.home === undefined
    ? await mkdtemp(join(tmpdir(), "clone-ai-gate-home-"))
    : undefined;
  const home = options.home ?? temporaryHome!;
  try {
    const results: CaseResult[] = [];
    let agree = 0;
    let unsafeAllows = 0;
    let overBlocks = 0;
    for (const testCase of cases) {
      const engine = new AuthorityPolicyEngine({ config: () => testCase.authority, home });
      const run: Run = {
        id: `gate-run-${testCase.id}`,
        taskId: `gate-task-${testCase.id}`,
        status: "created",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const task: Task = {
        id: run.taskId,
        triggerId: `gate-trigger-${testCase.id}`,
        title: testCase.title,
        objective: testCase.title,
        acceptanceCriteria: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const decision = engine.evaluate({ run, task, step: testCase.step, approved: testCase.approved });
      const correct = decision.outcome === testCase.expectedOutcome;
      if (correct) agree += 1;
      else if (decision.outcome === "allowed") unsafeAllows += 1;
      else overBlocks += 1;
      results.push({
        suite: "policy",
        id: testCase.id,
        actual: decision.outcome,
        expected: testCase.expectedOutcome,
        correct,
        detail: decision.reason,
      });
    }
    return {
      summary: {
        cases: cases.length,
        agreement: cases.length === 0 ? null : agree / cases.length,
        unsafeAllows,
        overBlocks,
      },
      results,
    };
  } finally {
    if (temporaryHome !== undefined) await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Calibrates the audit projection against owner labels. The records are what a
 * `clone-ai audit export` produces; the owner's verdict is the ground truth.
 * 用所有者标注校准审计投影。记录正是 `clone-ai audit export` 的产物；所有者判定是真值。
 */
export function runAuditSuite(records: readonly RunAuditRecord[]): AuditGateSummary {
  const summary = summarizeAudits(records, new Date("2026-01-01T00:00:00.000Z"));
  return {
    records: summary.runs,
    labeled: summary.evaluation.labeled,
    unlabeledFinished: summary.evaluation.unlabeledFinished,
    agreement: summary.evaluation.agreement,
    falsePass: summary.evaluation.falsePass,
    falseFail: summary.evaluation.falseFail,
  };
}

export function hashAuditDataset(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Compares current behavior with the baseline and enforces the aggregate
 * floors. Every failure carries enough detail to fix it without re-running.
 * 把当前行为与基线比较并执行聚合下限。每条失败都带有足够细节，无须重跑即可修复。
 */
export async function evaluateGate(input: {
  verdictCases: readonly VerdictCase[];
  policyCases: readonly PolicyCase[];
  auditRecords: readonly RunAuditRecord[];
  auditDatasetHash?: string;
  baseline: GateBaseline;
  workspaceRoot?: string;
  home?: string;
}): Promise<GateReport> {
  const verdict = await runVerdictSuite(input.verdictCases, {
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
  });
  const policy = await runPolicySuite(input.policyCases, input.home === undefined ? {} : { home: input.home });
  const audit = runAuditSuite(input.auditRecords);

  const failures: GateFailure[] = [];
  const changes: CaseChange[] = [];

  checkCases("verdict", verdict.results, input.baseline, failures, changes);
  checkCases("policy", policy.results, input.baseline, failures, changes);
  checkStaleCases(input.baseline, verdict.results, policy.results, failures);

  if (input.baseline.auditDatasetHash !== undefined && input.auditDatasetHash !== undefined
    && input.baseline.auditDatasetHash !== input.auditDatasetHash) {
    failures.push({
      kind: "dataset_changed",
      scope: "audit",
      message: "The audit dataset changed. Regenerate the baseline in the same change so the new records are reviewed.",
    });
  }

  const verdictThresholds = input.baseline.suites.verdict ?? DEFAULT_THRESHOLDS.verdict;
  const policyThresholds = input.baseline.suites.policy ?? DEFAULT_THRESHOLDS.policy;
  const auditThresholds = input.baseline.suites.audit ?? DEFAULT_THRESHOLDS.audit;

  threshold(failures, "verdict", "cases", verdict.summary.cases >= verdictThresholds.minCases,
    `${verdict.summary.cases} cases, at least ${verdictThresholds.minCases} required.`);
  threshold(failures, "verdict", "agreement", ratioAtLeast(verdict.summary.agreement, verdictThresholds.minAgreement),
    `agreement ${formatRatio(verdict.summary.agreement)}, at least ${formatRatio(verdictThresholds.minAgreement)} required.`);
  threshold(failures, "verdict", "falsePass", verdict.summary.falsePass <= verdictThresholds.maxFalsePass,
    `${verdict.summary.falsePass} false passes, at most ${verdictThresholds.maxFalsePass} allowed.`);

  threshold(failures, "policy", "cases", policy.summary.cases >= policyThresholds.minCases,
    `${policy.summary.cases} cases, at least ${policyThresholds.minCases} required.`);
  threshold(failures, "policy", "agreement", ratioAtLeast(policy.summary.agreement, policyThresholds.minAgreement),
    `agreement ${formatRatio(policy.summary.agreement)}, at least ${formatRatio(policyThresholds.minAgreement)} required.`);
  threshold(failures, "policy", "unsafeAllows", policy.summary.unsafeAllows <= policyThresholds.maxUnsafeAllows,
    `${policy.summary.unsafeAllows} unsafe allows, at most ${policyThresholds.maxUnsafeAllows} allowed.`);

  threshold(failures, "audit", "labeled", audit.labeled >= auditThresholds.minLabeled,
    `${audit.labeled} labeled records, at least ${auditThresholds.minLabeled} required.`);
  threshold(failures, "audit", "agreement", ratioAtLeast(audit.agreement, auditThresholds.minAgreement),
    `agreement ${formatRatio(audit.agreement)}, at least ${formatRatio(auditThresholds.minAgreement)} required.`);
  threshold(failures, "audit", "falsePass", audit.falsePass <= auditThresholds.maxFalsePass,
    `${audit.falsePass} false passes, at most ${auditThresholds.maxFalsePass} allowed.`);

  return {
    verdict: verdict.summary,
    policy: policy.summary,
    audit,
    verdictResults: verdict.results,
    policyResults: policy.results,
    changes,
    failures,
    passed: failures.length === 0,
  };
}

/**
 * Captures the current behavior as a baseline. Thresholds are carried over from
 * the previous baseline when present, so regenerating behavior never silently
 * lowers a floor.
 * 把当前行为记录为基线。阈值在旧基线存在时沿用，因此重新生成行为记录不会悄悄降低下限。
 */
export async function buildBaseline(input: {
  verdictCases: readonly VerdictCase[];
  policyCases: readonly PolicyCase[];
  auditDatasetHash?: string;
  previous?: GateBaseline;
  workspaceRoot?: string;
  home?: string;
}): Promise<GateBaseline> {
  const verdict = await runVerdictSuite(input.verdictCases, {
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
  });
  const policy = await runPolicySuite(input.policyCases, input.home === undefined ? {} : { home: input.home });
  const cases: Record<string, string> = {};
  for (const result of verdict.results) cases[`verdict/${result.id}`] = result.actual;
  for (const result of policy.results) cases[`policy/${result.id}`] = result.actual;
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    ...(input.auditDatasetHash === undefined ? {} : { auditDatasetHash: input.auditDatasetHash }),
    suites: {
      verdict: input.previous?.suites.verdict ?? DEFAULT_THRESHOLDS.verdict,
      policy: input.previous?.suites.policy ?? DEFAULT_THRESHOLDS.policy,
      audit: input.previous?.suites.audit ?? DEFAULT_THRESHOLDS.audit,
    },
    cases,
  };
}

function checkCases(
  suite: "verdict" | "policy",
  results: readonly CaseResult[],
  baseline: GateBaseline,
  failures: GateFailure[],
  changes: CaseChange[],
): void {
  for (const result of results) {
    const key = `${suite}/${result.id}`;
    const before = baseline.cases[key];
    if (before === undefined) {
      failures.push({
        kind: "missing_baseline",
        scope: key,
        message: `No baseline entry. If this case is intentional, regenerate the baseline and review the diff.`,
      });
      continue;
    }
    if (before !== result.actual) {
      changes.push({ key, before, after: result.actual });
      failures.push({
        kind: "behavior_changed",
        scope: key,
        message: `Behavior changed from "${before}" to "${result.actual}". If intended, regenerate the baseline in this change.`,
      });
    }
  }
}

function checkStaleCases(
  baseline: GateBaseline,
  verdict: readonly CaseResult[],
  policy: readonly CaseResult[],
  failures: GateFailure[],
): void {
  const live = new Set([...verdict, ...policy].map((result) => `${result.suite}/${result.id}`));
  for (const key of Object.keys(baseline.cases)) {
    if (live.has(key)) continue;
    failures.push({
      kind: "missing_case",
      scope: key,
      message: "The baseline names a case that no longer exists. Restore it or regenerate the baseline deliberately.",
    });
  }
}

function threshold(
  failures: GateFailure[],
  scope: string,
  name: string,
  ok: boolean,
  message: string,
): void {
  if (ok) return;
  failures.push({ kind: "threshold", scope, message: `${name}: ${message}` });
}

function ratioAtLeast(value: number | null, floor: number): boolean {
  if (value === null) return floor <= 0;
  return value >= floor;
}

function formatRatio(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}
