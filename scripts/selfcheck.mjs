#!/usr/bin/env node
/**
 * One self-check round — a maintenance script, not a product CLI.
 *
 * Usage:
 *   npm run selfcheck -- list
 *   npm run selfcheck -- [--full] [--repair]
 *
 * `--repair` hands a red round to the gated repair lane. The lane commits a
 * branch through a real Kernel Run and never merges.
 *
 * 一轮自检——维护脚本，不是产品 CLI。
 *
 * `--repair` 把红色的一轮交给带闸门的修复通道；通道通过真实的 Kernel Run 提交
 * 一个分支，绝不合并。
 */
import { resolve } from "node:path";

import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { readSelfCheckRounds, runSelfCheckRound } from "../src/eval/self-check.ts";
import { runRepairLane } from "../src/repair/repair-lane.ts";

const args = process.argv.slice(2);
const paths = resolveClonePaths();
await prepareCloneHome(paths);
const dataDirectory = paths.dataDirectory;

async function run() {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log("Usage: npm run selfcheck -- list | [--full] [--repair]");
    return 0;
  }
  if (args[0] === "list") {
    const rounds = await readSelfCheckRounds(dataDirectory);
    if (rounds.length === 0) {
      console.log("No self-check rounds yet.");
      return 0;
    }
    for (const round of rounds) {
      console.log(`${round.generatedAt.slice(0, 19).replace("T", " ")}  ${round.verdict === "green" ? "绿色" : "红色"}  probes ${round.probes.passed}/${round.probes.total}  gate ${round.gate.status === 0 ? "ok" : `exit ${round.gate.status}`}`);
    }
    return 0;
  }

  const journal = createJournalStore(dataDirectory);
  try {
    const round = await runSelfCheckRound({ dataDirectory, journal, fullTests: args.includes("--full") });
    let repairExit;
    if (round.verdict !== "green" && args.includes("--repair")) {
      console.log("\n红色探针已导出为轨迹，交给修复通道运行（提交分支，绝不合并）…");
      const report = await runRepairLane({ dataDirectory, repo: resolve(process.cwd()), maxTraces: 5 });
      repairExit = report.status === "fixed" ? 0 : 1;
      console.log(`修复通道：${report.status}${report.error === undefined ? "" : ` — ${report.error}`}`);
      if (report.branch !== undefined) console.log(`分支：${report.branch}（未合并）`);
    }
    console.log(`\n${round.verdict === "green" ? "绿色" : "红色"} · 探针 ${round.probes.passed}/${round.probes.total} · gate ${round.gate.status === 0 ? "ok" : `exit ${round.gate.status}`}${round.tests === undefined ? "" : ` · tests ${round.tests.status === 0 ? "ok" : `exit ${round.tests.status}`}`}`);
    for (const probe of round.probes.probes.filter((item) => !item.passed)) {
      console.log(`  ✗ ${probe.boundary} · ${probe.attack}：${probe.detail ?? ""}`);
    }
    if (round.traceExport !== undefined && repairExit === undefined) {
      console.log(`已导出 ${round.traceExport.written.length} 条轨迹到 ${round.traceExport.directory}，可交给修复通道（或加 --repair）。`);
    }
    if (round.reportPath !== undefined) console.log(`报告：${round.reportPath}`);
    if (repairExit !== undefined) return repairExit;
    return round.verdict === "green" ? 0 : 1;
  } finally {
    journal.close?.();
  }
}

process.exitCode = await run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
