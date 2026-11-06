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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { defaultLegacyDirectory, migrateLegacyCloneHome, prepareCloneHome, resolveClonePaths } from "../config/clone-home.ts";
import { createMainAgentSession } from "../main-agent/session.ts";
import { isNativeMainAgentSelected, runNativeMainAgentTurn } from "../main-agent/native-runtime.ts";
import { recordPromptSnapshot } from "../main-agent/prompt-snapshot.ts";
import {
  beginMainAgentTurn,
  finishMainAgentTurn,
  observeMainAgentSession,
} from "../main-agent/turn-audit.ts";
import { collectSessionUsage, recordUsage } from "../observability/usage.ts";
import { createKernelRuntimeSession } from "../main-agent/tools/kernel-tools.ts";
import { MainAgentBusyError, withMainAgentLock } from "../main-agent/prompt-lock.ts";
import { BadCaseLog } from "../reporting/bad-case-log.ts";
import { OpportunityService } from "../opportunity/opportunity-service.ts";
import { createJournalStore } from "../core/sqlite-journal.ts";
import { WorkerRegistry } from "../workers/worker-registry.ts";
import { MdMemoryStore } from "../memory/md-memory-store.ts";
import { describeAuthority, StandingPolicyStore } from "../authority/standing-policy-store.ts";
import { MemoryGovernance } from "../memory/memory-governance.ts";
import { ImprovementService } from "../improvement/improvement-service.ts";
import { describeExport, EXPORT_EXCLUDES, exportOwnerData } from "../config/export.ts";
import { beginInvocation } from "../audit/invocation-ledger.ts";
import { readInvocation, readInvocations } from "../audit/invocation-ledger.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `clone-ai — your local digital twin runtime

Usage:
  clone-ai "<请求>"              Talk to the Main Agent (default)
  clone-ai app                   Open the installed native desktop app
  clone-ai status                Show runs, workers, memory, and bad cases
  clone-ai workers               List worker CLIs and whether they are installed
  clone-ai install <worker>      Install a missing worker (npm global)
  clone-ai sessions              List Main Agent conversations
  clone-ai resume <n>            Continue conversation number <n> (see sessions)
  clone-ai new "<请求>"           Start a fresh conversation
  clone-ai memory [query]        List or search reviewed memories
  clone-ai improve [list|stats|sweep|approve <id>|dismiss <id>]
                                 Review what the improvement loop suggests
  clone-ai export [dir]          Copy conversations, memories and the journal to dir
  clone-ai cases                 Print the local bad-case log
  clone-ai opportunities         List open opportunity cards
  clone-ai approve <runId>       Approve a run waiting for confirmation
  clone-ai reject <runId>        Reject a run waiting for confirmation
  clone-ai cancel <runId>        Cancel a queued, running, or waiting run
  clone-ai review <runId> [accept|reject]  Inspect or resolve criteria requiring review
  clone-ai authority [list]      Show autonomy levels and standing policies
  clone-ai authority level <domain> <observe|prepare|act_with_approval|act_auto>
  clone-ai authority grant <files|shell|network> <read|write|exec> <resource> --max <level> [--label <text>] [--until <ISO date>]
  clone-ai authority revoke <policyId>
  clone-ai audit [<runId>|export [--out file]]  Why runs failed, per run; export JSONL for evals
  clone-ai audit turns [--limit N] [--json]  Main Agent turns: input, reply, tools, model usage
  clone-ai invocations [list|show <id>]  Every Agent call, its prompt, reply and Run ids
  clone-ai traces [list|export|show <runId>|clear --yes]  Failed traces for the repair lane
  clone-ai repair [--dry-run] [--keep] [--max-traces N] [--agent <id>] [--base <ref>]
                                 Fix failed traces as a clone-ai Run in an isolated worktree; never merges
  clone-ai selfcheck [--full] [--repair]   Adversarial suite + gate; --repair hands a red round to the repair lane
  clone-ai model <worker> [<model>|--clear]  Show, pin or clear the model a worker CLI uses
  clone-ai effort <worker> [<level>|--clear]  Show, pin or clear the reasoning effort
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
    case "app": return startApp();
    case "gui":
      console.error("Browser preview was removed. Use `clone-ai app` to open the native Clone AI application.");
      return 1;
    case "status": return showStatus(paths.dataDirectory);
    case "workers": return listWorkers(paths.dataDirectory);
    case "install": return installWorker(paths.dataDirectory, argv[1]);
    case "sessions": return listSessions(paths.dataDirectory);
    case "resume": return resumeSession(paths.dataDirectory, argv[1]);
    case "new": return converse(paths.dataDirectory, argv.slice(1).join(" ").trim(), true);
    case "memory": return showMemory(paths.dataDirectory, argv.slice(1).join(" ").trim());
    case "improve": return improveCommand(paths.dataDirectory, argv.slice(1));
    case "export": return exportCommand(paths.dataDirectory, argv[1]);
    case "cases": return showCases(paths.dataDirectory);
    case "opportunities": return showOpportunities(paths.dataDirectory);
    case "approve": return decideRun(paths.dataDirectory, argv[1], "approve");
    case "reject": return decideRun(paths.dataDirectory, argv[1], "reject");
    case "cancel": return decideRun(paths.dataDirectory, argv[1], "cancel");
    case "review": return reviewRun(paths.dataDirectory, argv[1], argv[2]);
    case "authority": return authorityCommand(paths.dataDirectory, argv.slice(1));
    case "audit": return auditCommand(paths.dataDirectory, argv.slice(1));
    case "invocations": return invocationsCommand(paths.dataDirectory, argv.slice(1));
    case "traces": return tracesCommand(paths.dataDirectory, argv.slice(1));
    case "repair": return repairCommand(paths.dataDirectory, argv.slice(1));
    case "selfcheck": return selfCheckCommand(paths.dataDirectory, argv.slice(1));
    case "model": return modelCommand(paths.dataDirectory, argv.slice(1));
    case "effort": return effortCommand(paths.dataDirectory, argv.slice(1));
    case "bench": return runBench(argv.slice(1));
    case "doctor": return doctor(paths.dataDirectory);
    default: return converse(paths.dataDirectory, argv.join(" ").trim());
  }
}

/** Default path: a conversation turn with the Main Agent. 默认路径：与 Main Agent 的一轮对话。 */
async function converse(dataDirectory: string, query: string, fresh = false): Promise<number> {
  if (query.trim().length === 0) {
    console.error('Please describe what you want. Example: clone-ai "整理今天要推进的事情"');
    return 1;
  }
  const paths = resolveClonePaths({ dataDirectory });
  const audit = await beginInvocation({
    prompt: query,
    surface: "cli",
    workspacePath: paths.workspacePath,
    dataDirectory,
    command: fresh ? "new" : "converse",
  });
  let reply = "";
  let before: Array<{ id: string; status: string; planId?: string }> = [];
  try {
    before = await listRunSnapshot(dataDirectory);
    await withMainAgentLock(dataDirectory, async () => {
      if (isNativeMainAgentSelected()) {
        const result = await runNativeMainAgentTurn({
          dataDirectory,
          text: query,
          source: "cli",
          onDelta: (delta) => process.stdout.write(delta),
        });
        process.stdout.write("\n");
        if (result.error !== undefined) console.error(result.error);
        return;
      }
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const { session, prompt } = await createMainAgentSession({
        dataDirectory,
        query,
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
      // Record the inputs before the prompt runs: a failed turn is only
      // debuggable if the prompt it read is still on disk.
      // 在 prompt 运行前记录输入：失败的一轮只有在它读过的提示词仍在磁盘上时才可调试。
      const snapshot = await recordPromptSnapshot(dataDirectory, prompt);
      const sessionFile = session.sessionManager.getSessionFile();
      const turn = await beginMainAgentTurn({
        dataDirectory,
        text: query,
        source: "cli",
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(prompt.modelId === undefined ? {} : { modelId: prompt.modelId }),
        ...(prompt.provider === undefined ? {} : { provider: prompt.provider }),
        ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
        ...(snapshot === undefined ? {} : { promptMaterialHash: snapshot.materialHash }),
      });
      audit.note({
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(prompt.modelId === undefined ? {} : { modelId: prompt.modelId }),
        ...(prompt.provider === undefined ? {} : { provider: prompt.provider }),
        ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
      });
      observeMainAgentSession(session, turn);
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          reply += event.assistantMessageEvent.delta;
          process.stdout.write(event.assistantMessageEvent.delta);
        }
      });
      const started = Date.now();
      const beforeStats = (() => {
        try { return session.getSessionStats(); } catch { return undefined; }
      })();
      let turnStatus: "completed" | "failed" = "completed";
      let turnError: string | undefined;
      try {
        await session.prompt(query);
        process.stdout.write("\n");
      } catch (error: unknown) {
        turnStatus = "failed";
        turnError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        const usage = collectSessionUsage(session, Date.now() - started, beforeStats);
        try {
          await recordUsage(dataDirectory, { ...usage, turnId: turn.turnId });
        } catch {
          // Usage is telemetry; losing it must not hide the reply or the error.
          // 用量是遥测；丢掉它不能盖住回复或错误。
        }
        await finishMainAgentTurn(turn, {
          status: turnStatus,
          reply,
          ...(turnError === undefined ? {} : { error: turnError }),
          usage: { ...usage, turnId: turn.turnId },
        });
        session.dispose();
      }
    });
    await drainQueuedRuns(dataDirectory);
    const after = await listRunSnapshot(dataDirectory);
    const seen = new Set(before.map((run) => run.id));
    await audit.complete({
      reply,
      newRuns: after.filter((run) => !seen.has(run.id)),
    });
  } catch (error: unknown) {
    await audit.fail(error);
    if (error instanceof MainAgentBusyError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  return 0;
}

async function listRunSnapshot(dataDirectory: string): Promise<Array<{ id: string; status: string; planId?: string }>> {
  const { runtime, close } = await createKernelRuntimeSession(dataDirectory);
  try {
    return runtime.listRuns().map((run) => ({ id: run.id, status: run.status, ...(run.planId === undefined ? {} : { planId: run.planId }) }));
  } finally {
    close();
  }
}

/**
 * Executes whatever the conversation just queued, before the process exits.
 *
 * The Main Agent proposes plans through the Kernel, which journals them as
 * `queued`. In the GUI a long-lived consumer picks those up; in the CLI there
 * is none, so without this the twin would say "I've started on that" and then
 * exit having run nothing. The rule is that the system never claims to have
 * accepted work it has no intention of performing: either an executor takes
 * over here, or the owner is told the work is only saved.
 *
 * 在进程退出前，执行本次对话刚刚排队的工作。
 *
 * Main Agent 通过 Kernel 提案，Kernel 会把它们以 `queued` 记入 Journal。GUI 里有常驻
 * 消费者会接走；CLI 里没有，因此若不做这件事，分身会说“我已经开始做了”然后什么都没
 * 跑就退出。规则是：系统绝不声称接受了一份它根本不打算执行的工作——要么这里有执行者
 * 接手，要么明确告知所有者“仅保存、尚未执行”。
 */
async function drainQueuedRuns(dataDirectory: string): Promise<void> {
  const { createRuntimeAssembly } = await import("../core/runtime-factory.ts");
  const { RunQueueConsumer } = await import("../application/run-queue.ts");
  const { createConfiguredAgentRegistry } = await import("../workers/configured-worker-registry.ts");
  const { WorkerSettingsStore } = await import("../config/worker-settings.ts");

  const paths = resolveClonePaths({ dataDirectory });
  const assembly = await createRuntimeAssembly({ dataDirectory });
  const { runtime, journal } = assembly;
  try {
    await runtime.refresh();
    const pending = runtime.listRuns().filter((run) => run.status === "queued");
    if (pending.length === 0) return;

    const settings = new WorkerSettingsStore(paths.legacyAgentsFile);
    const consumer = new RunQueueConsumer({
      runtime,
      journal,
      registry: async () => createConfiguredAgentRegistry(
        (await settings.get()).agents,
        { dataDirectory, workspacePath: paths.workspacePath },
      ),
      onError: (runId, error) => {
        console.error(`\nRun ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    });

    console.log(`\nExecuting ${pending.length} queued run(s)...`);
    const started = await consumer.tick();
    await consumer.stop();
    await runtime.refresh();

    for (const runId of started) {
      const run = runtime.getRun(runId);
      console.log(`  ${run.status === "completed" ? "✓" : run.status === "waiting_approval" ? "⏸" : "✗"} ${runId.slice(0, 8)} → ${run.status}`);
    }
    // A run another process already claimed is not silently dropped: the owner
    // is told where it went. 已被其他进程领取的 Run 不会被静默丢弃：告知所有者它去了哪里。
    const unclaimed = pending.filter((run) => !started.includes(run.id));
    if (unclaimed.length > 0) {
      console.log(`  ${unclaimed.length} run(s) are being executed by another Clone AI process.`);
    }
  } finally {
    assembly.close();
  }
}

/**
 * The native application bundle is the only product UI. This command never
 * starts a companion server or opens a browser.
 *
 * 原生应用包是唯一的产品界面。这个命令不会启动 companion server，也不会打开浏览器。
 */
async function startApp(): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("The native desktop app launcher is available on macOS. Build the platform app with `npm run desktop:build`.");
    return 1;
  }
  const appBundle = [
    join(packageRoot, "dist", "Clone AI.app"),
    join(process.cwd(), "dist", "Clone AI.app"),
    "/Applications/Clone AI.app",
  ].find((candidate) => existsSync(candidate));
  if (appBundle === undefined) {
    console.error("Clone AI.app was not found. Build it with `npm run desktop:mac:build`.");
    return 1;
  }
  const child = spawn("/usr/bin/open", [appBundle], { stdio: "ignore", windowsHide: true });
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.once("error", () => resolve(1));
  });
  if (code !== 0) {
    console.error(`Could not open ${appBundle}.`);
    return 1;
  }
  console.log(`Opened ${appBundle}`);
  return 0;
}

async function showStatus(dataDirectory: string): Promise<number> {
  const { runtime, close } = await createKernelRuntimeSession(dataDirectory);
  let runs: ReturnType<typeof runtime.listRuns>;
  try { runs = runtime.listRuns(); } finally { close(); }
  const recent = runs.slice(-5).reverse();
  const workers = await new WorkerRegistry(dataDirectory).list();
  const store = new MdMemoryStore({ dataDirectory });
  const journal = createJournalStore(dataDirectory);
  const governance = new MemoryGovernance({ store, journal });
  let memory;
  try {
    memory = await governance.stats();
  } finally {
    await governance.close();
    (journal as { close?: () => void }).close?.();
  }
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
  const journal = createJournalStore(dataDirectory);
  const governance = new MemoryGovernance({ store, journal });
  try {
    if (query.length > 0) {
      const matches = await governance.recall(query);
      if (matches.length === 0) console.log("No matching memories.");
      for (const match of matches) console.log(`[${match.score.toFixed(2)}] ${match.entry.summary}`);
      return 0;
    }
    const entries = await governance.list({ status: "active" });
    if (entries.length === 0) console.log("No memories yet.");
    for (const entry of entries) console.log(`- (${entry.type}) ${entry.summary}`);
    return 0;
  } finally {
    await governance.close();
    (journal as { close?: () => void }).close?.();
  }
}

/** Takes the owner's data out, unencrypted and in a documented layout. 把所有者的数据取走，不加密，布局有文档。 */
async function exportCommand(dataDirectory: string, destination: string | undefined): Promise<number> {
  const target = destination ?? join(dataDirectory, "export");
  if (target === dataDirectory || dataDirectory.startsWith(`${target}/`)) {
    console.error("The export destination must not contain the data directory.");
    return 1;
  }
  const manifest = await exportOwnerData({ dataDirectory, destination: target });
  console.log(describeExport(manifest, target));
  for (const skip of EXPORT_EXCLUDES) console.log(`  skipped: ${skip}`);
  return 0;
}

/** The owner's console for the improvement loop. 所有者操作改进环路的控制台。 */
async function improveCommand(dataDirectory: string, args: string[]): Promise<number> {
  const store = new MdMemoryStore({ dataDirectory });
  const journal = createJournalStore(dataDirectory);
  const governance = new MemoryGovernance({ store, journal });
  const service = new ImprovementService({ journal, governance });
  try {
    const [action = "list", id] = args;
    if (action === "stats") {
      const { usage, runs } = await service.usage();
      const summaries = new Map((await governance.list()).map((entry) => [entry.id, entry.summary]));
      console.log(`${runs.good}/${runs.total} runs with a verdict ended well.`);
      for (const item of usage) console.log(`${item.good}/${item.exposures} good  ${item.memoryId}  ${summaries.get(item.memoryId) ?? ""}`);
      return 0;
    }
    if (action === "sweep") {
      const { suggested } = await service.sweep();
      console.log(`${suggested.length} new suggestion(s).`);
      return 0;
    }
    if (action === "approve" || action === "dismiss") {
      if (id === undefined) throw new Error(`${action} needs a suggestion id.`);
      if (action === "approve") console.log((await service.approve(id)).applied);
      else {
        await service.dismiss(id);
        console.log(`Dismissed ${id}.`);
      }
      return 0;
    }
    const pending = await service.pending();
    if (pending.length === 0) console.log("No pending suggestions.");
    for (const item of pending) console.log(`${item.id}\n  ${item.title}\n  ${item.rationale}${item.proposedSummary === undefined ? "" : `\n  Proposed: ${item.proposedSummary}`}`);
    return 0;
  } finally {
    await governance.close();
    (journal as { close?: () => void }).close?.();
  }
}

async function showCases(dataDirectory: string): Promise<number> {
  const text = await new BadCaseLog({ dataDirectory }).readLog();
  console.log(text.trim().length === 0 ? "No bad cases recorded yet." : text);
  return 0;
}

/** Authority is owner-only: this is one of its two write paths (the other is the desktop app). 权限只归所有者：这是它的两条写入路径之一（另一条是桌面应用）。 */
async function authorityCommand(dataDirectory: string, args: string[]): Promise<number> {
  const journal = createJournalStore(dataDirectory);
  try {
    const store = new StandingPolicyStore(dataDirectory, journal);
    await store.load();
    const [action = "list", ...rest] = args;
    if (action === "list") {
      console.log(describeAuthority(store.snapshot()));
      return 0;
    }
    if (action === "level") {
      const [domain, level] = rest;
      await store.setDomainLevel(domain as never, level as never);
      console.log(`${domain} is now ${level}.`);
      return 0;
    }
    if (action === "grant") {
      const [domain, access, resource] = rest;
      const flag = (name: string): string | undefined => {
        const index = rest.indexOf(name);
        return index === -1 ? undefined : rest[index + 1];
      };
      const max = flag("--max");
      if (max === undefined) throw new Error("grant needs --max <level>.");
      const policy = await store.addPolicy({
        label: flag("--label") ?? `${domain} ${access} ${resource}`,
        scopes: [{ domain, access, resource }],
        maxAutonomy: max as never,
        ...(flag("--until") === undefined ? {} : { validUntil: flag("--until") as string }),
      });
      console.log(`Granted ${policy.id} (max ${policy.maxAutonomy}).`);
      return 0;
    }
    if (action === "revoke") {
      if (rest[0] === undefined) throw new Error("revoke needs a policy id.");
      await store.revokePolicy(rest[0]);
      console.log(`Revoked ${rest[0]}.`);
      return 0;
    }
    console.error("Usage: clone-ai authority [list|level|grant|revoke]");
    return 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

/** Pin the model a worker CLI uses, so it does not inherit a default the gateway cannot serve. 固定 worker CLI 使用的模型，避免它沿用网关无法正确服务的默认模型。 */
/** Audit is a projection of the journal; nothing here writes. 审计是 Journal 的投影，这里不写任何东西。 */
/** Pin the reasoning effort a worker CLI uses; the gateway says which levels its model supports. 固定 worker CLI 的推理强度；网关会说明其模型支持哪些档位。 */
/**
 * Failed traces for the repair pipeline: list what is on disk, export fresh ones
 * from the journal, show one, or clear them. Export is redacted before writing.
 * 供修复流水线使用的失败轨迹：列出磁盘上的、从 Journal 导出新的、查看单条、或清空。
 * 导出在写入前完成脱敏。
 */
/**
 * One self-check round: adversarial probes, the deterministic gate, optionally
 * the full suite. The result is journaled, so the loop is auditable even when
 * nobody is watching.
 * 一轮自检：对抗探针、确定性门禁，可选全量测试。结果写入 Journal，即使没人看着，回路也可审计。
 */
async function selfCheckCommand(dataDirectory: string, args: string[]): Promise<number> {
  const { runSelfCheckRound, readSelfCheckRounds } = await import("../eval/self-check.ts");
  const [first] = args;
  if (first === "list") {
    const rounds = await readSelfCheckRounds(dataDirectory);
    if (rounds.length === 0) { console.log("No self-check rounds yet."); return 0; }
    for (const round of rounds) console.log(`${round.generatedAt.slice(0, 19).replace("T", " ")}  ${round.verdict === "green" ? "绿色" : "红色"}  probes ${round.probes.passed}/${round.probes.total}  gate ${round.gate.status === 0 ? "ok" : `exit ${round.gate.status}`}`);
    return 0;
  }
  const journal = createJournalStore(dataDirectory);
  try {
    const round = await runSelfCheckRound({ dataDirectory, journal, fullTests: args.includes("--full") });
    let repairExit: number | undefined;
    if (round.verdict !== "green" && args.includes("--repair")) {
      // The loop does not edit code: a red round becomes traces, and the repair
      // lane turns those into a branch through a real Kernel Run. It never
      // merges, so the owner still reviews the patch.
      // 回路不改代码：红色的一轮变成轨迹，由修复通道通过真实的 Kernel Run 变成一个分支。通道绝不
      // 合并，补丁仍由所有者审查。
      console.log("\n红色探针已导出为轨迹，交给修复通道运行（提交分支，绝不合并）…");
      const { runRepairLane } = await import("../repair/repair-lane.ts");
      const report = await runRepairLane({ dataDirectory, repo: resolve(process.cwd()), maxTraces: 5 });
      repairExit = report.status === "fixed" ? 0 : 1;
      console.log(`修复通道：${report.status}${report.error === undefined ? "" : ` — ${report.error}`}`);
      if (report.branch !== undefined) console.log(`分支：${report.branch}（未合并）`);
    }
    console.log(`
${round.verdict === "green" ? "绿色" : "红色"} · 探针 ${round.probes.passed}/${round.probes.total} · gate ${round.gate.status === 0 ? "ok" : `exit ${round.gate.status}`}${round.tests === undefined ? "" : ` · tests ${round.tests.status === 0 ? "ok" : `exit ${round.tests.status}`}`}`);
    for (const probe of round.probes.probes.filter((item) => !item.passed)) console.log(`  ✗ ${probe.boundary} · ${probe.attack}：${probe.detail ?? ""}`);
    if (round.traceExport !== undefined && repairExit === undefined) console.log(`已导出 ${round.traceExport.written.length} 条轨迹到 ${round.traceExport.directory}，可交给夜间修复（或加 --repair）。`);
    if (round.reportPath !== undefined) console.log(`报告：${round.reportPath}`);
    return round.verdict === "green" ? 0 : 1;
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

async function tracesCommand(dataDirectory: string, args: string[]): Promise<number> {
  const { exportFailedTraces, listFailedTraces, tracesDirectory } = await import("../audit/failed-traces.ts");
  const journal = createJournalStore(dataDirectory);
  try {
    const [action = "list", ...rest] = args;
    if (action === "export") {
      const result = await exportFailedTraces(dataDirectory, journal);
      console.log(`Exported ${result.written.length} trace(s) to ${result.directory}.`);
      return 0;
    }
    if (action === "show") {
      const runId = rest[0];
      if (runId === undefined) { console.error("traces show needs a run id."); return 1; }
      const { readFile } = await import("node:fs/promises");
      const path = `${tracesDirectory(dataDirectory)}/${runId}.json`;
      try { console.log(await readFile(path, "utf8")); } catch { console.error(`No trace for ${runId}.`); return 1; }
      return 0;
    }
    if (action === "clear") {
      if (!rest.includes("--yes")) { console.error("Refusing to delete traces without --yes."); return 1; }
      const { rm } = await import("node:fs/promises");
      await rm(tracesDirectory(dataDirectory), { recursive: true, force: true });
      console.log("Failed traces cleared.");
      return 0;
    }
    const traces = await listFailedTraces(dataDirectory);
    if (traces.length === 0) { console.log("No failed traces. Run `clone-ai traces export` after a failure."); return 0; }
    for (const trace of traces) console.log(`${trace.runId.slice(0, 8)}  ${trace.kind.padEnd(8)} ${trace.signals.length ? `[${trace.signals.join(", ")}] ` : ""}${trace.title}`);
    return 0;
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

/**
 * The repair lane, driven from the CLI. Every phase of the repair is a Kernel
 * Run; this function only reads the flags and reports what the lane observed.
 * 命令行驱动的修复通道。修复的每个阶段都是 Kernel Run；本函数只解析参数并报告通道观察到的事实。
 */
async function repairCommand(dataDirectory: string, args: string[]): Promise<number> {
  const { runRepairLane } = await import("../repair/repair-lane.ts");
  const flagValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const maxTraces = Number(flagValue("--max-traces") ?? "5");
  if (!Number.isInteger(maxTraces) || maxTraces < 1) {
    console.error("--max-traces must be a positive integer.");
    return 1;
  }
  const report = await runRepairLane({
    dataDirectory,
    repo: resolve(flagValue("--repo") ?? process.cwd()),
    ...(flagValue("--base") === undefined ? {} : { base: flagValue("--base") }),
    ...(flagValue("--agent") === undefined ? {} : { agentId: flagValue("--agent") }),
    maxTraces,
    dryRun: args.includes("--dry-run"),
    keep: args.includes("--keep"),
  });
  if (report.status === "no-traces") {
    console.log("No failed traces. Run `clone-ai traces export` after a failure.");
    return 0;
  }
  if (report.status === "dry-run") {
    console.log(`Dry run: ${report.traces.length} trace(s) would be repaired.`);
    return 0;
  }
  if (report.status === "failed") {
    console.error(`Repair failed (${report.failedGate ?? "error"}): ${report.error ?? "unknown error"}`);
    if (report.runId !== undefined) console.error(`Run: ${report.runId} — inspect with \`clone-ai audit ${report.runId}\``);
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

async function effortCommand(dataDirectory: string, args: string[]): Promise<number> {
  const { listEffectiveProviderConfigs, readUserProviderConfigs, upsertUserProviderConfig } = await import("../config/provider-config-store.ts");
  const [providerId, value] = args;
  const effective = await listEffectiveProviderConfigs(dataDirectory);
  if (providerId === undefined) {
    for (const provider of effective) console.log(`${provider.id}: ${provider.effort ?? "(CLI default)"}${provider.efforts ? ` · levels ${provider.efforts.join(", ")}` : ""}`);
    return 0;
  }
  const provider = effective.find((candidate) => candidate.id === providerId);
  if (provider === undefined) { console.error(`Unknown worker "${providerId}".`); return 1; }
  if (value === undefined) { console.log(`${provider.id}: ${provider.effort ?? "(CLI default)"}${provider.efforts ? ` · levels ${provider.efforts.join(", ")}` : ""}`); return 0; }
  if (value !== "--clear" && provider.efforts !== undefined && !provider.efforts.includes(value as never)) {
    console.error(`${providerId} accepts: ${provider.efforts.join(", ")}.`);
    return 1;
  }
  const existing = (await readUserProviderConfigs(dataDirectory)).find((candidate) => candidate.id === providerId) ?? { id: provider.id, command: provider.command };
  const { effort: _drop, ...rest } = existing;
  await upsertUserProviderConfig(dataDirectory, value === "--clear" ? rest : { ...rest, effort: value as never });
  console.log(value === "--clear" ? `${providerId}: effort cleared.` : `${providerId}: effort pinned to ${value}.`);
  return 0;
}

async function invocationsCommand(dataDirectory: string, args: string[]): Promise<number> {
  const [first] = args;
  if (first === "show") {
    const id = args[1];
    if (id === undefined) {
      console.error("Usage: clone-ai invocations show <id>");
      return 1;
    }
    const record = await readInvocation(id, { dataDirectory, limit: 500 });
    if (record === undefined) {
      console.error(`No invocation matches "${id}".`);
      return 1;
    }
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  const records = await readInvocations({ dataDirectory, limit: 100 });
  if (records.length === 0) {
    console.log("No Agent invocations yet.");
    return 0;
  }
  for (const record of records) {
    const duration = record.durationMs === undefined ? "-" : `${record.durationMs}ms`;
    const caller = record.caller.kind + (record.caller.sessionId === undefined ? "" : `:${record.caller.sessionId.slice(0, 8)}`);
    console.log(`${record.id.slice(0, 8)}  ${record.status.padEnd(10)} ${duration.padStart(9)}  ${caller.padEnd(22)} ${record.surface.padEnd(8)} ${record.prompt.replace(/\s+/g, " ").slice(0, 60)}`);
  }
  return 0;
}

async function auditCommand(dataDirectory: string, args: string[]): Promise<number> {
  const { loadAudits, summarizeAudits, toJsonl } = await import("../audit/audit-service.ts");
  const { writeFile } = await import("node:fs/promises");
  const journal = createJournalStore(dataDirectory);
  try {
    const [first, ...rest] = args;
    if (first === "turns") {
      const { loadTurnAudits } = await import("../audit/turn-audit.ts");
      const limitIndex = rest.indexOf("--limit");
      const requested = limitIndex >= 0 ? Number.parseInt(rest[limitIndex + 1] ?? "", 10) : 100;
      const turns = await loadTurnAudits(journal, { limit: Number.isFinite(requested) ? requested : 100 });
      if (rest.includes("--json")) {
        process.stdout.write(`${JSON.stringify(turns, null, 2)}\n`);
        return 0;
      }
      if (turns.length === 0) {
        console.log("No Main Agent turns recorded yet.");
        return 0;
      }
      for (const turn of turns) {
        const usage = turn.usage === undefined
          ? ""
          : ` · ${turn.usage.totalTokens ?? 0} tokens${turn.usage.costUsd === undefined ? "" : ` · $${turn.usage.costUsd.toFixed(4)}`}`;
        const input = turn.input.replace(/\s+/g, " ").slice(0, 80);
        const output = (turn.reply ?? turn.error ?? "").replace(/\s+/g, " ").slice(0, 80);
        console.log(`${turn.turnId.slice(0, 8)}  ${turn.status.padEnd(10)} ${turn.source.padEnd(9)} ${turn.toolCalls.length} 个工具 · ${turn.modelId ?? "默认模型"}${usage}  ${turn.startedAt}`);
        console.log(`  in:  ${input}`);
        if (output.length > 0) console.log(`  out: ${output}`);
        for (const call of turn.toolCalls) console.log(`  tool: ${call.name}${call.isError === true ? " (error)" : ""}${call.durationMs === undefined ? "" : ` ${call.durationMs}ms`}`);
      }
      return 0;
    }
    if (first === "export") {
      const records = await loadAudits(journal);
      const out = rest.indexOf("--out") === -1 ? undefined : rest[rest.indexOf("--out") + 1];
      if (out === undefined) process.stdout.write(toJsonl(records));
      else { await writeFile(out, toJsonl(records), "utf8"); console.log(`Wrote ${records.length} run records to ${out}.`); }
      return 0;
    }
    if (first !== undefined) {
      const [record] = await loadAudits(journal, { runId: first });
      if (record === undefined) { console.error(`No run matches "${first}".`); return 1; }
      console.log(JSON.stringify(record, null, 2));
      return 0;
    }
    const records = await loadAudits(journal);
    const summary = summarizeAudits(records);
    console.log(`${summary.runs} runs · by status ${JSON.stringify(summary.byStatus)}`);
    if (Object.keys(summary.byFailureStage).length > 0) console.log(`failures by stage ${JSON.stringify(summary.byFailureStage)} · category ${JSON.stringify(summary.byFailureCategory)}`);
    for (const record of records.slice(-15)) {
      const ms = record.durationMs === undefined ? "-" : `${record.durationMs}ms`;
      const why = record.outcome.reason === undefined ? "" : `  ${record.outcome.failureStage}${record.outcome.failureCategory === undefined ? "" : `/${record.outcome.failureCategory}`}: ${record.outcome.reason.slice(0, 160)}`;
      console.log(`${record.runId.slice(0, 8)}  ${record.status.padEnd(10)} ${ms.padStart(8)}  ${(record.taskTitle ?? record.objective ?? "").slice(0, 40)}${why}`);
    }
    return 0;
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

async function modelCommand(dataDirectory: string, args: string[]): Promise<number> {
  const { listEffectiveProviderConfigs, readUserProviderConfigs, upsertUserProviderConfig } = await import("../config/provider-config-store.ts");
  const [providerId, value] = args;
  const effective = await listEffectiveProviderConfigs(dataDirectory);
  if (providerId === undefined) {
    for (const provider of effective) console.log(`${provider.id}: ${provider.model ?? "(CLI default)"}`);
    return 0;
  }
  const provider = effective.find((candidate) => candidate.id === providerId);
  if (provider === undefined) { console.error(`Unknown worker "${providerId}".`); return 1; }
  if (value === undefined) { console.log(`${provider.id}: ${provider.model ?? "(CLI default)"}`); return 0; }
  const existing = (await readUserProviderConfigs(dataDirectory)).find((candidate) => candidate.id === providerId) ?? { id: provider.id, command: provider.command };
  const { model: _drop, ...rest } = existing;
  await upsertUserProviderConfig(dataDirectory, value === "--clear" ? rest : { ...rest, model: value });
  console.log(value === "--clear" ? `${providerId}: model cleared.` : `${providerId}: model pinned to ${value}.`);
  return 0;
}

async function showOpportunities(dataDirectory: string): Promise<number> {
  const journal = createJournalStore(dataDirectory);
  try {
    const service = new OpportunityService(journal);
    await service.scanAndRecord();
    const cards = await service.list();
    if (cards.length === 0) console.log("No open opportunities.");
    for (const card of cards) console.log(`- [${card.source}] ${card.title}\n    ${card.whyNow}`);
    return 0;
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

async function decideRun(dataDirectory: string, runId: string | undefined, action: "approve" | "reject" | "cancel"): Promise<number> {
  if (runId === undefined || runId.trim().length === 0) {
    console.error(`Usage: clone-ai ${action} <runId>`);
    return 1;
  }
  const { approveQueryRun, cancelQueryRun, rejectQueryRun } = await import("../application/run-query.ts");
  const fn = action === "approve" ? approveQueryRun : action === "reject" ? rejectQueryRun : cancelQueryRun;
  const result = await fn(dataDirectory, runId.trim());
  console.log(`${action} ${result.runId.slice(0, 8)} → ${result.status}`);
  return 0;
}

async function reviewRun(dataDirectory: string, runId: string | undefined, decision: string | undefined): Promise<number> {
  if (runId === undefined || (decision !== undefined && decision !== "accept" && decision !== "reject")) {
    console.error("Usage: clone-ai review <runId> [accept|reject]");
    return 1;
  }
  if (decision === undefined) {
    const journal = createJournalStore(dataDirectory);
    try {
      const verification = (await journal.list()).filter((event) => event.runId === runId && event.type === "verification.completed").at(-1)?.payload as { summary?: string; unverifiedCriteria?: string[] } | undefined;
      if (verification === undefined) {
        console.error("No verification result exists for this run.");
        return 1;
      }
      console.log(verification.summary ?? "Review the result and its evidence.");
      for (const criterion of verification.unverifiedCriteria ?? []) console.log(`- ${criterion}`);
      return 0;
    } finally {
      (journal as { close?: () => void }).close?.();
    }
  }
  const { reviewQueryRun } = await import("../application/run-query.ts");
  const result = await reviewQueryRun(dataDirectory, runId, decision);
  console.log(`review ${result.runId.slice(0, 8)} → ${result.status}`);
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
