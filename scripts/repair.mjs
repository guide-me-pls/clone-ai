#!/usr/bin/env node
/**
 * The gated repair lane — a maintenance script, not a product CLI.
 *
 * Usage:
 *   npm run repair -- [--dry-run] [--keep] [--max-traces N] [--agent <id>] [--base <ref>] [--repo <path>]
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
import { resolve } from "node:path";

import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { runRepairLane } from "../src/repair/repair-lane.ts";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const maxTraces = Number(flagValue("--max-traces") ?? "5");

const paths = resolveClonePaths();
await prepareCloneHome(paths);

async function run() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run repair -- [--dry-run] [--keep] [--max-traces N] [--agent <id>] [--base <ref>] [--repo <path>]");
    return 0;
  }
  if (!Number.isInteger(maxTraces) || maxTraces < 1) {
    console.error("--max-traces must be a positive integer.");
    return 1;
  }
  const report = await runRepairLane({
    dataDirectory: paths.dataDirectory,
    repo: resolve(flagValue("--repo") ?? process.cwd()),
    ...(flagValue("--base") === undefined ? {} : { base: flagValue("--base") }),
    ...(flagValue("--agent") === undefined ? {} : { agentId: flagValue("--agent") }),
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
