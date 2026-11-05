#!/usr/bin/env node
/**
 * Deterministic regression gate.
 *
 * Usage:
 *   npm run gate
 *   npm run gate -- --audit ~/clone-audit.jsonl
 *   npm run gate -- --write-baseline
 *   npm run gate -- --json ./gate-report.json
 *
 * The default run is offline and costs nothing: it re-runs verification and
 * authority policy over `benchmark/gate/*.json` and calibrates the audit
 * projection over `audit-cases.jsonl`. Pass `--audit` to run the same
 * calibration over a real `clone-ai audit export` file. `--write-baseline`
 * records current behavior; review that diff like any other behavior change.
 *
 * 确定性回归门禁。
 *
 * 用法：
 *   npm run gate
 *   npm run gate -- --audit ~/clone-audit.jsonl
 *   npm run gate -- --write-baseline
 *   npm run gate -- --json ./gate-report.json
 *
 * 默认运行完全离线且零成本：对 `benchmark/gate/*.json` 重跑验证与权限策略，并对
 * `audit-cases.jsonl` 校准审计投影。传入 `--audit` 可对真实的
 * `clone-ai audit export` 文件做同一套校准。`--write-baseline` 记录当前行为；
 * 像审查其他行为变更一样审查那份 diff。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBaseline,
  evaluateGate,
  hashAuditDataset,
  type GateBaseline,
  type GateReport,
  type PolicyCase,
  type VerdictCase,
} from "../src/eval/regression-gate.ts";
import type { RunAuditRecord } from "../src/audit/run-audit.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesDirectory = join(here, "gate");
const baselinePath = join(fixturesDirectory, "baseline.json");

function flagValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function readCases(file: string): Promise<{ verdict?: VerdictCase[]; policy?: PolicyCase[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error: unknown) {
    fail(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cases = (parsed as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) fail(`${file}: "cases" must be an array.`);
  return { verdict: cases as VerdictCase[], policy: cases as PolicyCase[] };
}

function assertVerdictCases(cases: readonly VerdictCase[]): void {
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (typeof testCase.id !== "string" || testCase.id.length === 0) fail("A verdict case has no id.");
    if (seen.has(testCase.id)) fail(`Duplicate verdict case id: ${testCase.id}`);
    seen.add(testCase.id);
    if (testCase.ownerVerdict !== "pass" && testCase.ownerVerdict !== "fail") {
      fail(`Verdict case ${testCase.id}: ownerVerdict must be "pass" or "fail".`);
    }
    if (!Array.isArray(testCase.plan?.steps) || !Array.isArray(testCase.evidence)) {
      fail(`Verdict case ${testCase.id}: plan.steps and evidence must be arrays.`);
    }
  }
}

function assertPolicyCases(cases: readonly PolicyCase[]): void {
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (typeof testCase.id !== "string" || testCase.id.length === 0) fail("A policy case has no id.");
    if (seen.has(testCase.id)) fail(`Duplicate policy case id: ${testCase.id}`);
    seen.add(testCase.id);
    if (!["allowed", "approval_required", "denied"].includes(testCase.expectedOutcome)) {
      fail(`Policy case ${testCase.id}: expectedOutcome is not a policy outcome.`);
    }
    if (testCase.step === undefined || testCase.authority === undefined) {
      fail(`Policy case ${testCase.id}: step and authority are required.`);
    }
  }
}

function parseAuditRecords(source: string, file: string): RunAuditRecord[] {
  const records: RunAuditRecord[] = [];
  source.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      records.push(JSON.parse(line) as RunAuditRecord);
    } catch (error: unknown) {
      fail(`${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return records;
}

async function readBaseline(): Promise<GateBaseline | undefined> {
  try {
    return JSON.parse(await readFile(baselinePath, "utf8")) as GateBaseline;
  } catch {
    return undefined;
  }
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function printReport(report: GateReport): void {
  console.log("Regression gate");
  console.log(
    `  verdict  ${String(report.verdict.cases).padStart(3)} cases · ${report.verdict.decided} decided`
    + ` · agreement ${percent(report.verdict.agreement)} · falsePass ${report.verdict.falsePass}`
    + ` · falseFail ${report.verdict.falseFail} · review ${report.verdict.review}`,
  );
  console.log(
    `  policy   ${String(report.policy.cases).padStart(3)} cases · agreement ${percent(report.policy.agreement)}`
    + ` · unsafeAllows ${report.policy.unsafeAllows} · overBlocks ${report.policy.overBlocks}`,
  );
  console.log(
    `  audit    ${String(report.audit.records).padStart(3)} records · ${report.audit.labeled} labeled`
    + ` · agreement ${percent(report.audit.agreement)} · falsePass ${report.audit.falsePass}`
    + ` · falseFail ${report.audit.falseFail}`,
  );
  console.log(`  baseline ${report.changes.length === 0 ? "unchanged" : `${report.changes.length} changed`}`);
  if (report.changes.length > 0) {
    for (const change of report.changes) {
      console.log(`    ~ ${change.key}: ${change.before} -> ${change.after}`);
    }
  }
  if (report.passed) {
    console.log("\nPASS");
    return;
  }
  console.log(`\nFAIL (${report.failures.length})`);
  for (const failure of report.failures) {
    console.log(`  [${failure.kind}] ${failure.scope}: ${failure.message}`);
  }
}

const verdictFile = join(fixturesDirectory, "verdict-cases.json");
const policyFile = join(fixturesDirectory, "policy-cases.json");
const { verdict: rawVerdictCases } = await readCases(verdictFile);
const { policy: rawPolicyCases } = await readCases(policyFile);
const verdictCases = rawVerdictCases ?? [];
const policyCases = rawPolicyCases ?? [];
assertVerdictCases(verdictCases);
assertPolicyCases(policyCases);

const auditPath = flagValue("--audit") ?? join(fixturesDirectory, "audit-cases.jsonl");
const auditSource = await readFile(auditPath, "utf8").catch(() => fail(`Cannot read audit dataset: ${auditPath}`));
const auditRecords = parseAuditRecords(auditSource, auditPath);
const auditDatasetHash = hashAuditDataset(auditSource);

const baseline = await readBaseline();
if (process.argv.includes("--write-baseline")) {
  const next = await buildBaseline({
    verdictCases,
    policyCases,
    auditDatasetHash,
    ...(baseline === undefined ? {} : { previous: baseline }),
  });
  await writeFile(baselinePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`Baseline written: ${baselinePath}`);
  console.log(`  ${Object.keys(next.cases).length} cases · audit dataset ${auditDatasetHash.slice(0, 12)}`);
  process.exit(0);
}

if (baseline === undefined) {
  fail(`No baseline at ${baselinePath}. Run \`npm run gate -- --write-baseline\` once and review the diff.`);
}

const report = await evaluateGate({
  verdictCases,
  policyCases,
  auditRecords,
  auditDatasetHash,
  baseline,
});

printReport(report);

const jsonPath = flagValue("--json");
if (jsonPath !== undefined) {
  await writeFile(jsonPath, `${JSON.stringify({
    ranAt: new Date().toISOString(),
    auditSource,
    auditDatasetHash,
    passed: report.passed,
    report,
  }, null, 2)}\n`, "utf8");
  console.log(`Report: ${jsonPath}`);
}

process.exit(report.passed ? 0 : 1);
