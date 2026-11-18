#!/usr/bin/env node
/**
 * Import an isolated benchmark Run into the owner's clone home, so the desktop
 * app's 审计与评估 → 运行记录 shows it and `npm run audit:export` can export it.
 *
 * Usage:
 *   node scripts/import-audit.mjs --source <clone-home> [--target ~/.clone]
 *       [--run <runId-prefix>|--all] [--dry-run]
 *
 * What it copies, and why:
 *   journal.sqlite3 rows for the selected Runs (the audit projection's source),
 *   main-agent-turns.jsonl lines for those turns (conversation history),
 *   prompt-snapshots referenced by those turns (what the model actually saw).
 * Event ids are unique, so a re-import is a no-op rather than a duplicate.
 *
 * 把隔离的评测 Run 导入所有者的 clone home，使桌面「审计与评估 → 运行记录」能看到它，
 * `npm run audit:export` 也能导出。
 *
 * 复制内容及理由：
 *   - 选中 Run 的 journal.sqlite3 行（审计投影的来源）；
 *   - 对应回合的 main-agent-turns.jsonl 行（对话历史）；
 *   - 这些回合引用的 prompt-snapshots（模型实际看到的提示词）。
 * 事件 id 唯一，因此重复导入是无操作，而不是重复。
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const source = resolve(flag("source", ""));
const target = resolve(flag("target", join(homedir(), ".clone")));
const runFilter = flag("run", "");
const all = args.includes("--all");
const dryRun = args.includes("--dry-run");
if (source === "" || (!all && runFilter === "")) {
  console.error("usage: node scripts/import-audit.mjs --source DIR [--target DIR] (--run PREFIX | --all) [--dry-run]");
  process.exit(2);
}

const sourceDb = join(source, "journal.sqlite3");
const targetDb = join(target, "journal.sqlite3");
const sourceTurns = join(source, "main-agent-turns.jsonl");
const targetTurns = join(target, "main-agent-turns.jsonl");

const columns = ["id", "type", "occurred_at", "task_id", "run_id", "payload"];

/** Rows for the selected Runs. 选中 Run 的事件行。 */
function selectEvents() {
  const db = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    const runs = db.prepare(
      "select distinct run_id from journal_events where run_id is not null and run_id <> '' order by run_id",
    ).all();
    const chosen = runs
      .map((row) => String(row.run_id))
      .filter((runId) => all || runId.startsWith(runFilter));
    if (chosen.length === 0) throw new Error(`No Run matches ${JSON.stringify(runFilter)} in ${sourceDb}.`);
    const rows = db.prepare(
      `select ${columns.join(", ")} from journal_events where run_id = ? order by sequence`,
    );
    const events = chosen.flatMap((runId) => rows.all(runId));
    // Turn events carry no run id; the turn that queued the run is the one worth
    // importing for context. Import every turn the source recorded, since the
    // benchmark home only holds this task's turn.
    const turns = db.prepare(
      `select ${columns.join(", ")} from journal_events where run_id is null and type like 'main_agent.%' order by sequence`,
    ).all();
    const tasks = db.prepare("select task_id from journal_events where run_id = ? and task_id is not null limit 1");
    const taskIds = new Set(chosen.flatMap((runId) => tasks.all(runId).map((row) => String(row.task_id))));
    const taskEvents = db.prepare(
      `select ${columns.join(", ")} from journal_events where run_id is null and task_id is not null order by sequence`,
    ).all().filter((row) => taskIds.has(String(row.task_id)));
    const triggers = db.prepare(
      `select ${columns.join(", ")} from journal_events where run_id is null and type = 'trigger.received' order by sequence`,
    ).all();
    return { runs: chosen, events: [...taskEvents, ...triggers, ...turns, ...events] };
  } finally {
    db.close();
  }
}

const { runs, events } = selectEvents();
const turnIds = new Set(events.filter((event) => event.type?.startsWith("main_agent.")).map((event) => JSON.parse(String(event.payload)).turnId).filter(Boolean));

let turnLines = [];
try {
  turnLines = (await readFile(sourceTurns, "utf8")).split("\n").filter(Boolean).filter((line) => {
    try { return turnIds.has(JSON.parse(line).id); } catch { return false; }
  });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

/** Prompt snapshots referenced by those turns. 这些回合引用的提示词快照。 */
const snapshotFiles = [];
try {
  for (const line of turnLines) {
    const turn = JSON.parse(line);
    const match = events.find((event) => event.type === "main_agent.prompt_snapshot" && JSON.parse(String(event.payload)).turnId === turn.id);
    const locator = match === undefined ? undefined : JSON.parse(String(match.payload)).locator;
    if (typeof locator === "string" && locator.length > 0) snapshotFiles.push(locator);
  }
} catch {
  // A malformed turn is reported below by the row count, not by a crash.
}

console.log(`source: ${source}`);
console.log(`target: ${target}`);
console.log(`runs:   ${runs.join(", ")}`);
console.log(`events: ${events.length}`);
console.log(`turns:  ${turnLines.length}`);
console.log(`snapshots: ${snapshotFiles.length}`);

if (dryRun) {
  console.log("dry run: nothing written.");
  process.exit(0);
}

await mkdir(target, { recursive: true });
const targetStats = await readFile(targetDb).then(() => true, () => false);
if (!targetStats) {
  // Create the schema by opening the real store once; the journal store owns it.
  const { createJournalStore } = await import("../src/core/sqlite-journal.ts");
  const store = createJournalStore(target);
  await store.refresh();
  store.close?.();
}

const db = new DatabaseSync(targetDb);
let inserted = 0;
let skipped = 0;
try {
  db.exec("begin");
  const exists = db.prepare("select 1 from journal_events where id = ?");
  const insert = db.prepare(
    `insert into journal_events (id, type, occurred_at, task_id, run_id, payload) values (?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    if (exists.get(String(event.id)) !== undefined) { skipped += 1; continue; }
    insert.run(String(event.id), String(event.type), String(event.occurred_at),
      event.task_id === null ? null : String(event.task_id),
      event.run_id === null ? null : String(event.run_id),
      String(event.payload));
    inserted += 1;
  }
  db.exec("commit");
} catch (error) {
  db.exec("rollback");
  throw error;
} finally {
  db.close();
}

if (turnLines.length > 0) {
  const existing = (await readFile(targetTurns, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const ids = new Set(existing.map((line) => { try { return JSON.parse(line).id; } catch { return undefined; } }));
  const fresh = turnLines.filter((line) => !ids.has(JSON.parse(line).id));
  await writeFile(targetTurns, [...existing, ...fresh].join("\n") + (existing.length + fresh.length > 0 ? "\n" : ""), "utf8");
  console.log(`turns appended: ${fresh.length}`);
}

for (const locator of snapshotFiles) {
  const from = join(source, locator);
  const to = join(target, locator);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

// The invocation ledger is a separate, append-only view ("who asked, what did
// the agent answer, which Run came back"). The eval driver does not call the
// CLI's beginInvocation, so import the turn's own timestamps here. The id is
// prefixed and stable, making a re-import a no-op.
// 调用账本是独立的追加视图（"谁问的、Agent 答了什么、返回了哪个 Run"）。评测驱动没有调用
// CLI 的 beginInvocation，因此在这里按回合自己的时间戳导入。id 有前缀且稳定，重复导入无操作。
const turnEvents = events.filter((event) => event.type?.startsWith("main_agent."));
const completed = turnEvents.find((event) => event.type === "main_agent.turn_completed");
if (completed !== undefined) {
  const info = JSON.parse(String(completed.payload));
  const started = turnEvents.find((event) => event.type === "main_agent.turn_started" && JSON.parse(String(event.payload)).turnId === info.turnId);
  const startedInfo = started === undefined ? {} : JSON.parse(String(started.payload));
  const invocationId = `eval-${info.turnId}`;
  const ledgerPath = join(target, "audit", "invocations.jsonl");
  await mkdir(dirname(ledgerPath), { recursive: true });
  const existingLedger = await readFile(ledgerPath, "utf8").catch(() => "");
  const already = existingLedger.split("\n").some((line) => { try { return JSON.parse(line).id === invocationId; } catch { return false; } });
  if (!already) {
    const runStatuses = new Map();
    for (const event of events) {
      if (event.run_id === null || event.run_id === undefined) continue;
      if (event.type === "run.status_changed") {
        try { runStatuses.set(String(event.run_id), JSON.parse(String(event.payload)).status); } catch { /* ignore */ }
      }
    }
    const newRuns = (info.spawnedRunIds ?? []).map((id) => ({ id, status: runStatuses.get(id) ?? "unknown" }));
    const lines = [
      {
        schemaVersion: 1, phase: "started", id: invocationId, at: info.startedAt ?? startedInfo.startedAt,
        caller: { kind: "eval-import", sessionId: "shadowport-fps", pid: process.pid },
        surface: "main", prompt: startedInfo.input ?? flag("prompt", ""),
        workspacePath: flag("workspace", ""), dataDirectory: source,
        command: "eval-import", turnId: info.turnId,
      },
      {
        schemaVersion: 1, phase: "completed", id: invocationId, at: info.completedAt,
        durationMs: info.durationMs, reply: info.reply,
        modelId: info.usage?.modelId, provider: info.usage?.provider, effort: startedInfo.effort,
        newRuns,
      },
    ];
    await writeFile(ledgerPath, existingLedger + lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    console.log(`invocation ledger appended: ${invocationId} (${newRuns.map((run) => run.id).join(", ") || "no runs"})`);
  } else {
    console.log(`invocation ledger already has ${invocationId}`);
  }
}

console.log(`journal events inserted: ${inserted}; already present: ${skipped}`);
console.log("");
console.log("The desktop app reads this on its next refresh. Export it for evals with:");
console.log("  npm run audit:export -- --out audit-shadowport.jsonl");
