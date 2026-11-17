#!/usr/bin/env node
/**
 * Failed traces for the repair lane — a maintenance script, not a product CLI.
 *
 * Usage:
 *   npm run traces -- list
 *   npm run traces -- export
 *   npm run traces -- show <runId>
 *   npm run traces -- clear --yes
 *
 * The product surface is the desktop app. This script exists so AGENTS.md rule
 * 4 and a scheduled repair job can export traces after the `clone-ai` command
 * was removed.
 *
 * 供修复通道使用的失败轨迹——这是维护脚本，不是产品 CLI。
 *
 * 产品界面是桌面 App。保留本脚本，是为了在移除 `clone-ai` 命令后，AGENTS.md
 * 第 4 条与定时修复任务仍能导出轨迹。
 */
import { readFile, rm } from "node:fs/promises";

import { exportFailedTraces, listFailedTraces, tracesDirectory } from "../src/audit/failed-traces.ts";
import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";

const args = process.argv.slice(2);
const [action = "list", ...rest] = args;
const paths = resolveClonePaths();
await prepareCloneHome(paths);
const dataDirectory = paths.dataDirectory;

async function run() {
  if (action === "--help" || action === "-h" || action === "help") {
    console.log("Usage: npm run traces -- list | export | show <runId> | clear --yes");
    return 0;
  }
  if (action === "clear") {
    if (!rest.includes("--yes")) {
      console.error("Refusing to delete traces without --yes.");
      return 1;
    }
    await rm(tracesDirectory(dataDirectory), { recursive: true, force: true });
    console.log("Failed traces cleared.");
    return 0;
  }
  if (action === "show") {
    const runId = rest[0];
    if (runId === undefined) {
      console.error("traces show needs a run id.");
      return 1;
    }
    try {
      console.log(await readFile(`${tracesDirectory(dataDirectory)}/${runId}.json`, "utf8"));
      return 0;
    } catch {
      console.error(`No trace for ${runId}.`);
      return 1;
    }
  }

  const journal = createJournalStore(dataDirectory);
  try {
    if (action === "export") {
      const result = await exportFailedTraces(dataDirectory, journal);
      console.log(`Exported ${result.written.length} trace(s) to ${result.directory}.`);
      return 0;
    }
    if (action !== "list") {
      console.error(`Unknown traces action: ${action}`);
      console.error("Usage: npm run traces -- list | export | show <runId> | clear --yes");
      return 1;
    }
    const traces = await listFailedTraces(dataDirectory);
    if (traces.length === 0) {
      console.log("No failed traces. Run `npm run traces -- export` after a failure.");
      return 0;
    }
    for (const trace of traces) {
      console.log(`${trace.runId.slice(0, 8)}  ${trace.kind.padEnd(8)} ${trace.signals.length ? `[${trace.signals.join(", ")}] ` : ""}${trace.title}`);
    }
    return 0;
  } finally {
    journal.close?.();
  }
}

process.exitCode = await run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
