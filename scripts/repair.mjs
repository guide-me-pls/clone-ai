#!/usr/bin/env node
/**
 * The gated repair lane — a maintenance script, not a product CLI.
 *
 * Usage:
 *   npm run repair -- [--dry-run] [--keep] [--max-traces N] [--agent <id>] [--base <ref>] [--repo <path>] [--worktrees-root <path>] [--decision <file>]
 *
 * Every phase of a repair is a Kernel Run in an isolated worktree. The lane
 * commits a branch and never merges or pushes it. The desktop app remains the
 * only owner-facing product surface.
 *
 * 带闸门的修复通道——维护脚本，不是产品 CLI。
 *
 * 修复的每个阶段都是隔离 worktree 中的 Kernel Run。通道提交分支，绝不合并或推送。
 * 桌面 App 仍是唯一面向所有者的产品界面。
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { runRepairLane } from "../src/repair/repair-lane.ts";
import { prepareAutomationHome } from "./automation-home.mjs";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const maxTraces = Number(flagValue("--max-traces") ?? "5");

const ownerPaths = resolveClonePaths();

async function run() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run repair -- [--dry-run] [--keep] [--max-traces N] [--agent <id>] [--base <ref>] [--repo <path>] [--worktrees-root <path>] [--decision <file>]");
    return 0;
  }
  if (!Number.isInteger(maxTraces) || maxTraces < 1) {
    console.error("--max-traces must be a positive integer.");
    return 1;
  }
  // A decision-level repair (reversing an older rule) cannot be inferred from a
  // trace that only shows the old behavior. The brief is read here, bounded,
  // and passed into both plan phases as expected behavior, not trace data.
  // 决定层面的修复（推翻旧规则）无法从只展示旧行为的轨迹中推断。这里读取并限制一份说明，
  // 把它作为期望行为而不是轨迹数据交给两个计划阶段。
  const decisionPath = flagValue("--decision");
  let decision;
  if (decisionPath !== undefined) {
    try {
      decision = (await readFile(resolve(decisionPath), "utf8")).trim();
    } catch (error) {
      console.error(`--decision file cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (decision.length === 0) {
      console.error("--decision file is empty.");
      return 1;
    }
    if (decision.length > 8_000) {
      console.error("--decision text must stay under 8,000 characters.");
      return 1;
    }
  }
  // The lane writes reports and consumes traces; the owner's home is input
  // only. Without this split a repair run shares the daemon's journal, which
  // already produced one raced `failed -> verifying` event on 2026-11-18.
  // 通道写报告、消费轨迹；所有者的 home 只是输入。没有这层拆分，修复运行会共享守护的
  // Journal——2026-11-18 已经因此产生过一次竞态的 `failed -> verifying` 事件。
  const automation = await prepareAutomationHome({
    repoRoot: resolve(import.meta.dirname, ".."),
    purpose: "repair",
    ownerDirectory: ownerPaths.dataDirectory,
  });
  console.log(`Automation home: ${automation.dataDirectory}${automation.seeded.length === 0 ? "" : ` (seeded ${automation.seeded.join(", ")})`}`);
  const paths = resolveClonePaths({ dataDirectory: automation.dataDirectory });
  await prepareCloneHome(paths);
  const report = await runRepairLane({
    dataDirectory: paths.dataDirectory,
    // The lane appends "failed-traces" to the directory it is given, so this
    // must be the owner's clone home, not the traces folder itself.
    // 通道会在给定目录后追加 "failed-traces"，因此这里必须给所有者 home，而不是轨迹文件夹本身。
    tracesDirectory: automation.ownerDirectory,
    repo: resolve(flagValue("--repo") ?? process.cwd()),
    ...(flagValue("--base") === undefined ? {} : { base: flagValue("--base") }),
    ...(flagValue("--agent") === undefined ? {} : { agentId: flagValue("--agent") }),
    ...(flagValue("--worktrees-root") === undefined ? {} : { worktreesRoot: flagValue("--worktrees-root") }),
    ...(decision === undefined ? {} : { decision }),
    maxTraces,
    dryRun: args.includes("--dry-run"),
    keep: args.includes("--keep"),
  });
  if (report.status === "no-traces") {
    console.log("No failed traces. Run `npm run traces -- export` after a failure.");
    return 0;
  }
  if (report.status === "dry-run") {
    console.log(`Dry run: ${report.traces.length} trace(s) would be repaired.`);
    return 0;
  }
  if (report.status === "failed") {
    console.error(`Repair failed (${report.failedGate ?? "error"}): ${report.error ?? "unknown error"}`);
    if (report.runId !== undefined) console.error(`Run: ${report.runId}`);
    if (report.worktree !== undefined) console.error(`Worktree kept for inspection: ${report.worktree}`);
    if (report.evalBefore !== undefined) console.error(`Eval before: ${report.evalBefore.red ? "red" : "NOT red"} — ${report.evalBefore.detail}`);
    if (report.regressionAfter !== undefined) console.error(`Regression after: ${report.regressionAfter.green ? "green" : "NOT green"} — ${report.regressionAfter.detail}`);
    console.error(`Report: ${report.reportPath}`);
    return 1;
  }
  console.log(`Repaired ${report.traces.length} trace(s) in Run ${report.runId ?? "?"} on ${report.branch}.`);
  if (report.evalBefore !== undefined) console.log(`  eval before: ${report.evalBefore.red ? "red" : "not red"} — ${report.evalBefore.detail}`);
  if (report.regressionAfter !== undefined) console.log(`  regression after: ${report.regressionAfter.green ? "green" : "NOT green"} — ${report.regressionAfter.detail}`);
  if (report.evalAfter !== undefined) console.log(`  eval after: tests exit ${report.evalAfter.tests.status}, typecheck exit ${report.evalAfter.typecheck.status}`);
  if (report.changed !== undefined) console.log(`  changed: ${report.changed.join(", ")}`);
  if (report.tradeOffEntry !== undefined) console.log(`  trade-off: ${report.tradeOffEntry}`);
  console.log(`  branch ${report.branch} is not merged; review it, then merge or delete. Never pushed.`);
  console.log(`Report: ${report.reportPath}`);
  return 0;
}

process.exitCode = await run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
