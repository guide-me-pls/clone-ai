#!/usr/bin/env node
/**
 * Long-term consistency and restraint benchmark.
 *
 * The reliability benchmark measures whether the harness finishes a task. This
 * one measures whether the twin stays coherent over time and quiet when nothing
 * needs saying — the two properties a personal agent is judged on and a coding
 * agent never is.
 *
 * Usage: npm run bench:consistency [-- --verbose]
 * 长期一致性与克制基准。可靠性基准衡量脚手架能否完成任务；本基准衡量分身长期是否连贯、无事时是否
 * 安静——这是个人 Agent 被评判、而编码 Agent 从不被评判的两个性质。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { runConsistencySuite, runRestraintSuite } from "../src/eval/memory-consistency.ts";

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const consistency = await runConsistencySuite();
  const restraint = runRestraintSuite();

  console.log("Memory consistency");
  for (const scenario of consistency.scenarios) {
    console.log(`  ${scenario.passed ? "✓" : "✗"} ${scenario.id.padEnd(30)} ${scenario.description}`);
    if (verbose || !scenario.passed) {
      console.log(`      included: ${scenario.included.join(", ") || "(none)"}${scenario.missingTruth ? "  — truth missing" : ""}${scenario.contaminated.length > 0 ? `  — stale: ${scenario.contaminated.join(", ")}` : ""}`);
    }
  }
  console.log(`  passed ${consistency.passed}/${consistency.total}, contamination rate ${(consistency.contaminationRate * 100).toFixed(0)}%`);

  console.log("\nRestraint (interruptions)");
  for (const scenario of restraint.scenarios) {
    console.log(`  ${scenario.passed ? "✓" : "✗"} ${scenario.id.padEnd(30)} surfaced ${scenario.surfaced}, expected at most ${scenario.expected}`);
  }
  console.log(`  false-positive rate ${(restraint.falsePositiveRate * 100).toFixed(0)}%`);

  const here = fileURLToPath(new URL(".", import.meta.url));
  const resultsDirectory = join(here, "results");
  await mkdir(resultsDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const path = join(resultsDirectory, `memory-consistency-${stamp}.json`);
  await writeFile(path, `${JSON.stringify({ consistency, restraint }, null, 2)}\n`, "utf8");
  console.log(`\nReport: ${path}`);

  // Non-zero only on a genuine regression, so this can gate a change.
  // 仅在真正回归时返回非零，使其可以作为变更的门禁。
  if (consistency.passed < consistency.total || restraint.scenarios.some((scenario) => !scenario.passed)) process.exitCode = 1;
}

await main();
