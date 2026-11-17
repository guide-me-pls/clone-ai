#!/usr/bin/env node
/**
 * Audit JSONL for evals and the deterministic gate — a maintenance script.
 *
 * Usage:
 *   npm run audit:export -- [--out <file>]
 *
 * Writes the same projection `GET /api/audit/export` serves. `npm run gate --
 * --audit <file>` reads it for calibration.
 *
 * 供 eval 与确定性门禁使用的审计 JSONL——维护脚本。
 */
import { writeFile } from "node:fs/promises";

import { loadAudits, toJsonl } from "../src/audit/audit-service.ts";
import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex === -1 ? undefined : args[outIndex + 1];

const paths = resolveClonePaths();
await prepareCloneHome(paths);
const journal = createJournalStore(paths.dataDirectory);

async function run() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run audit:export -- [--out <file>]");
    return 0;
  }
  const records = await loadAudits(journal);
  const jsonl = toJsonl(records);
  if (out === undefined) {
    process.stdout.write(jsonl);
  } else {
    await writeFile(out, jsonl, "utf8");
    console.log(`Wrote ${records.length} run records to ${out}.`);
  }
  return 0;
}

try {
  process.exitCode = await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  journal.close?.();
}
