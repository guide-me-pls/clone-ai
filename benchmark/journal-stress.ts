#!/usr/bin/env node
/**
 * Journal and projection stress check.
 *
 * Every performance claim in the trade-off log so far came from a one-off
 * measurement. This makes it repeatable: it writes a realistic event mix, then
 * measures the three reads the runtime does on a timer — the queue tick's
 * refresh, the full replay a fresh process pays, and a scoped type read.
 *
 * It asserts nothing: a benchmark that fails CI on a slow laptop teaches
 * nothing. Read the numbers and compare against the last run recorded in
 * benchmark/results/journal-stress-*.json.
 *
 * 使用方式：node --experimental-strip-types benchmark/journal-stress.ts [events]
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { replay } from "../src/core/run-state.ts";

export interface StressReport {
  events: number;
  runs: number;
  appendMs: number;
  listMs: number;
  replayMs: number;
  incrementalRefreshMs: number;
  listForRunMs: number;
  listTypesMs: number;
  databaseBytes: number;
}

const EVENT_MIX = [
  { type: "execution.progress", weight: 6 },
  { type: "agent.tool_started", weight: 2 },
  { type: "agent.tool_completed", weight: 2 },
  { type: "evidence.recorded", weight: 1 },
  { type: "subagent.progress", weight: 1 },
] as const;

export async function runJournalStress(events = 100_000, runs = 200): Promise<StressReport> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-journal-stress-"));
  const path = join(directory, "journal.sqlite3");
  const store = new SqliteJournalStore(path);
  try {
    const started = Date.now();
    const totalWeight = EVENT_MIX.reduce((sum, entry) => sum + entry.weight, 0);
    let written = 0;
    // Interleave a run.created every so often so the projection has something
    // to reduce, not only progress noise.
    // 每隔一段插入一条 run.created，使投影有事可做，而不只是进度噪声。
    while (written < events) {
      for (const entry of EVENT_MIX) {
        for (let i = 0; i < entry.weight && written < events; i += 1) {
          const runIndex = written % runs;
          await store.append({ type: entry.type, runId: `run-${runIndex}`, payload: { stepId: "s1", message: "working", i: written } });
          written += 1;
        }
      }
    }
    const appendMs = Date.now() - started;

    let started2 = Date.now();
    const all = await store.list();
    const listMs = Date.now() - started2;

    started2 = Date.now();
    replay(all);
    const replayMs = Date.now() - started2;

    // What a queue tick costs once the projection is warm.
    // 投影已热时，一次调度 tick 的代价。
    started2 = Date.now();
    await store.listSince(all.at(-1)!.sequence);
    const incrementalRefreshMs = Date.now() - started2;

    started2 = Date.now();
    await store.listForRun(`run-${runs - 1}`);
    const listForRunMs = Date.now() - started2;

    started2 = Date.now();
    await store.listTypesSince(["evidence.recorded"], 0);
    const listTypesMs = Date.now() - started2;

    const { size } = await import("node:fs/promises").then((fs) => fs.stat(path));
    return { events: all.length, runs, appendMs, listMs, replayMs, incrementalRefreshMs, listForRunMs, listTypesMs, databaseBytes: size };
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export function printStressReport(report: StressReport): void {
  console.log(`Journal stress — ${report.events} events across ${report.runs} runs`);
  console.log(`  append        ${report.appendMs} ms`);
  console.log(`  list()        ${report.listMs} ms   (full replay, paid once per fresh process)`);
  console.log(`  replay        ${report.replayMs} ms   (projection fold)`);
  console.log(`  listSince     ${report.incrementalRefreshMs} ms   (a warm queue tick)`);
  console.log(`  listForRun    ${report.listForRunMs} ms`);
  console.log(`  listTypes     ${report.listTypesMs} ms`);
  console.log(`  database      ${(report.databaseBytes / 1024 / 1024).toFixed(1)} MB`);
}

async function main(): Promise<void> {
  const events = Number(process.argv[2] ?? 100_000);
  const report = await runJournalStress(Number.isFinite(events) ? events : 100_000);
  printStressReport(report);
  const here = fileURLToPath(new URL(".", import.meta.url));
  const resultsDirectory = join(here, "results");
  await mkdir(resultsDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const path = join(resultsDirectory, `journal-stress-${stamp}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nReport: ${path}`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
