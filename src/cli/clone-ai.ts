#!/usr/bin/env node
/**
 * The clone-ai command line. One binary, subcommands, no npm scripts.
 *
 * `clone-ai "..."` is a conversation with the Main Agent, exactly like the
 * other coding agents on your machine. Everything else is a subcommand.
 *
 * clone-ai 命令行：一个可执行文件、若干子命令，不再需要 npm scripts。
 *
 * `clone-ai "..."` 就是与 Main Agent 对话，用法与你机器上其他 Coding Agent 一致；
 * 其余功能都是子命令。
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { defaultLegacyDirectory, migrateLegacyCloneHome, prepareCloneHome, resolveClonePaths } from "../config/clone-home.ts";
import { createMainAgentSession } from "../main-agent/session.ts";
import { createKernelRuntime } from "../main-agent/tools/kernel-tools.ts";
import { BadCaseLog } from "../reporting/bad-case-log.ts";
import { OpportunityService } from "../opportunity/opportunity-service.ts";
import { createJournalStore } from "../core/sqlite-journal.ts";
import { WorkerRegistry } from "../workers/worker-registry.ts";
import { MdMemoryStore } from "../memory/md-memory-store.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `clone-ai — your local digital twin runtime

Usage:
  clone-ai "<请求>"              Talk to the Main Agent (default)
  clone-ai gui [--port <n>]      Start the local GUI and open it in a browser
  clone-ai status                Show runs, workers, memory, and bad cases
  clone-ai workers               List worker CLIs and whether they are installed
  clone-ai install <worker>      Install a missing worker (npm global)
  clone-ai sessions              List Main Agent conversations
  clone-ai resume <n>            Continue conversation number <n> (see sessions)
  clone-ai new "<请求>"           Start a fresh conversation
  clone-ai memory [query]        List or search reviewed memories
  clone-ai cases                 Print the local bad-case log
  clone-ai opportunities         List open opportunity cards
  clone-ai bench [--provider p]  Run the reliability benchmark
  clone-ai doctor                Check the local setup
  clone-ai --help | --version

Data lives in your clone home (~/.clone-ai by default, or CLONE_AI_DATA_DIR).`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string };
    console.log(pkg.version);
    return 0;
  }

  const paths = resolveClonePaths();
  await prepareCloneHome(paths);
  await migrateLegacyCloneHome({
    legacyDirectory: defaultLegacyDirectory(paths.workspacePath),
    targetDirectory: paths.dataDirectory,
  });

  switch (command) {
    case "gui": return startGui(argv.slice(1));
    case "status": return showStatus(paths.dataDirectory);
    case "workers": return listWorkers(paths.dataDirectory);
    case "install": return installWorker(paths.dataDirectory, argv[1]);
    case "sessions": return listSessions(paths.dataDirectory);
    case "resume": return resumeSession(paths.dataDirectory, argv[1]);
    case "new": return converse(paths.dataDirectory, argv.slice(1).join(" ").trim(), true);
    case "memory": return showMemory(paths.dataDirectory, argv.slice(1).join(" ").trim());
    case "cases": return showCases(paths.dataDirectory);
    case "opportunities": return showOpportunities(paths.dataDirectory);
    case "bench": return runBench(argv.slice(1));
    case "doctor": return doctor(paths.dataDirectory);
    default: return converse(paths.dataDirectory, argv.join(" ").trim());
  }
}

/** Default path: a conversation turn with the Main Agent. 默认路径：与 Main Agent 的一轮对话。 */
async function converse(dataDirectory: string, query: string, fresh = false): Promise<number> {
  if (query.length < 2) {
    console.error('Please describe what you want. Example: clone-ai "整理今天要推进的事情"');
    return 1;
  }
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { session } = await createMainAgentSession({
    dataDirectory,
    // A fresh conversation is explicit; the default continues the last one.
    // 新会话是显式选择；默认续上一次对话。
    ...(fresh ? { sessionManager: SessionManager.create(dataDirectory, join(dataDirectory, "pi-sessions", "main-agent")) } : {}),
  });
  if (fresh) {
    const file = session.sessionManager.getSessionFile();
    if (file !== undefined) {
      const { writeCurrentSessionPointer } = await import("../main-agent/session.ts");
      await writeCurrentSessionPointer(join(dataDirectory, "pi-sessions", "main-agent"), file);
    }
  }
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  try {
    await session.prompt(query);
    process.stdout.write("\n");
    return 0;
  } finally {
    session.dispose();
  }
}

/** Starts the companion daemon and opens the browser at its URL. 启动 companion 并在浏览器打开。 */
async function startGui(args: string[]): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? args[portIndex + 1] : undefined;
  const { startCompanionServer } = await import("../companion-server.ts");
  const server = await startCompanionServer(port === undefined ? {} : { port: Number(port) });
  console.log(`clone-ai GUI: ${server.url}`);
  openBrowser(server.url);
  console.log("Press Ctrl+C to stop.");
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      void server.close().then(resolve, resolve);
    });
  });
  return 0;
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
}

async function showStatus(dataDirectory: string): Promise<number> {
  const runtime = await createKernelRuntime(dataDirectory);
  const runs = runtime.listRuns();
  const recent = runs.slice(-5).reverse();
  const workers = await new WorkerRegistry(dataDirectory).list();
  const store = new MdMemoryStore({ dataDirectory });
  const memory = await store.stats();
  store.close();
  const cases = (await new BadCaseLog({ dataDirectory }).readLog()).split("\n").filter((line) => line.startsWith("- [seq")).length;

  console.log(`Runs: ${runs.length} total`);
  for (const run of recent) console.log(`  ${run.id.slice(0, 8)}  ${run.status.padEnd(16)} ${run.updatedAt}`);
  console.log(`Workers: ${workers.filter((worker) => worker.installed).map((worker) => worker.id).join(", ") || "none installed"}`);
  console.log(`Memory: ${memory.active} active, ${memory.archived} archived`);
  console.log(`Bad cases logged: ${cases}`);
  return 0;
}

async function listWorkers(dataDirectory: string): Promise<number> {
  for (const worker of await new WorkerRegistry(dataDirectory).list()) {
    const mark = worker.installed ? "✓" : worker.installable ? "·" : "✗";
    console.log(`${mark} ${worker.id.padEnd(14)} ${worker.command.padEnd(16)} ${worker.version ?? (worker.installed ? "" : "not installed")}`);
  }
  console.log("\n✓ installed · installable (clone-ai install <id>) ✗ no automatic installer");
  return 0;
}

async function installWorker(dataDirectory: string, id: string | undefined): Promise<number> {
  if (id === undefined) {
    console.error("Usage: clone-ai install <worker-id>");
    return 1;
  }
  const { installWorkerAgent } = await import("../main-agent/tools/kernel-tools.ts");
  const result = await installWorkerAgent(dataDirectory, id);
  console.log(result.installed ? `Installed ${id}${result.version ? ` (${result.version})` : ""}.` : `Failed: ${result.error}`);
  return result.installed ? 0 : 1;
}

/** Lists persisted Main Agent conversations, newest first. 列出已持久化的 Main Agent 对话，新的在前。 */
async function listSessions(dataDirectory: string): Promise<number> {
  const { listOwnerConversations, readCurrentSessionPointer } = await import("../main-agent/session.ts");
  const rows = await listOwnerConversations(dataDirectory);
  if (rows.length === 0) {
    console.log('No conversations yet. Start one: clone-ai "你好"');
    return 0;
  }
  const current = await readCurrentSessionPointer(join(dataDirectory, "pi-sessions", "main-agent"));
  console.log("  #  when              msgs  preview");
  for (const [index, row] of rows.entries()) {
    const marker = row.path === current ? "*" : " ";
    const when = new Date(row.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
    console.log(`${marker} ${String(index + 1).padStart(2)}  ${when}  ${String(row.messages).padStart(4)}  ${row.preview}`);
  }
  console.log('\n* is the conversation `clone-ai "..."` continues. Switch with `clone-ai resume <n>`, or start fresh with `clone-ai new "..."`.');
  return 0;
}

/** Points every entry point (CLI and GUI) at the chosen conversation. 把所有入口（CLI 与 GUI）指向所选对话。 */
async function resumeSession(dataDirectory: string, choice: string | undefined): Promise<number> {
  const { listOwnerConversations, writeCurrentSessionPointer } = await import("../main-agent/session.ts");
  const rows = await listOwnerConversations(dataDirectory);
  const index = Number(choice);
  if (!Number.isInteger(index) || index < 1 || index > rows.length) {
    console.error(`Usage: clone-ai resume <n>  (1..${rows.length || 1}; see clone-ai sessions)`);
    return 1;
  }
  const row = rows[index - 1]!;
  await writeCurrentSessionPointer(join(dataDirectory, "pi-sessions", "main-agent"), row.path);
  console.log(`Continuing conversation #${index} (${row.messages} msgs): ${row.preview || "(no preview)"}`);
  console.log("The GUI and the CLI now share this conversation.");
  return 0;
}

async function showMemory(dataDirectory: string, query: string): Promise<number> {
  const store = new MdMemoryStore({ dataDirectory });
  try {
    if (query.length > 0) {
      const matches = await store.recall(query);
      if (matches.length === 0) console.log("No matching memories.");
      for (const match of matches) console.log(`[${match.score.toFixed(2)}] ${match.entry.summary}`);
      return 0;
    }
    const entries = await store.list({ status: "active" });
    if (entries.length === 0) console.log("No memories yet.");
    for (const entry of entries) console.log(`- (${entry.type}) ${entry.summary}`);
    return 0;
  } finally {
    store.close();
  }
}

async function showCases(dataDirectory: string): Promise<number> {
  const text = await new BadCaseLog({ dataDirectory }).readLog();
  console.log(text.trim().length === 0 ? "No bad cases recorded yet." : text);
  return 0;
}

async function showOpportunities(dataDirectory: string): Promise<number> {
  const service = new OpportunityService(createJournalStore(dataDirectory));
  await service.scanAndRecord();
  const cards = await service.list();
  if (cards.length === 0) console.log("No open opportunities.");
  for (const card of cards) console.log(`- [${card.source}] ${card.title}\n    ${card.whyNow}`);
  return 0;
}

async function runBench(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(packageRoot, "benchmark", "run.ts"), ...args], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function doctor(dataDirectory: string): Promise<number> {
  console.log(`clone home: ${dataDirectory}`);
  console.log(`node: ${process.version} (${process.platform})`);
  const workers = await new WorkerRegistry(dataDirectory).list();
  const installed = workers.filter((worker) => worker.installed);
  console.log(`workers installed: ${installed.length}/${workers.length}`);
  for (const worker of workers) {
    console.log(`  ${worker.installed ? "✓" : "✗"} ${worker.id} → ${worker.command}`);
  }
  if (installed.length === 0) {
    console.log("\nNo worker CLI found. Install one, e.g.: clone-ai install pi");
    return 1;
  }
  console.log("\nReady. Try: clone-ai \"读一下 README 并总结三点\"");
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
