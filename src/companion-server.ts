import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { JournalEvent, MemoryCandidate, MemorySensitivity, MemoryType, Run, Task } from "./core/contracts.ts";
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel } from "./workers/effort.ts";
import { describeFailureForOwner } from "./core/failure-display.ts";
import { appendWorkUpdate, describeWorkUpdate, readWorkUpdates } from "./main-agent/work-updates.ts";
import { createJournalStore } from "./core/sqlite-journal.ts";
import { replay } from "./core/run-state.ts";
import { approveQueryRun, cancelQueryRun, rejectQueryRun, reviewQueryRun, runQuery } from "./application/run-query.ts";
import { LocalScheduler } from "./scheduling/local-scheduler.ts";
import { describeSchedule, ScheduleStore, type LocalSchedule, type ScheduleKind } from "./scheduling/schedule-store.ts";
import { SessionStore } from "./sessions/session-store.ts";
import { loadProviderRegistry } from "./workers/provider-catalog.ts";
import { WorkerSettingsStore } from "./config/worker-settings.ts";
import { WorkerRegistry } from "./workers/worker-registry.ts";
import { runMainAgentQuery } from "./application/run-main-query.ts";
import { MainAgentBusyError } from "./main-agent/prompt-lock.ts";
import {
  authorizeCompanionRequest,
  clearCompanionEndpointIfOwned,
  injectCompanionToken,
  issueCompanionToken,
  normalizeCompanionHost,
  persistCompanionEndpoint,
  persistCompanionToken,
} from "./companion-auth.ts";
import { MemoryGovernance } from "./memory/memory-governance.ts";
import { scanMemoryPii } from "./memory/memory-hygiene.ts";
import { describeAuthority, StandingPolicyStore } from "./authority/standing-policy-store.ts";
import { OpportunityService } from "./opportunity/opportunity-service.ts";
import { RunQueueConsumer } from "./application/run-queue.ts";
import { createRuntimeAssembly } from "./core/runtime-factory.ts";
import { createConfiguredAgentRegistry } from "./workers/configured-worker-registry.ts";
import { DailyReportRunner, type DailyReportSettings } from "./reporting/daily-report-runner.ts";
import { BadCaseLog } from "./reporting/bad-case-log.ts";
import { readJsonFile } from "./config/json-file.ts";
import { MdMemoryStore, GovernedMemorySource } from "./memory/md-memory-store.ts";
import type { JournalStore } from "./core/journal.ts";
import type { CloneRuntime } from "./core/runtime.ts";
import { logJson } from "./observability/json-log.ts";
import { emptyRunMetrics, summarizeRuns } from "./observability/run-metrics.ts";
import {
  defaultLegacyDirectory,
  migrateLegacyCloneHome,
  prepareCloneHome,
  resolveClonePaths,
  type ClonePaths,
} from "./config/clone-home.ts";
import { CloneConfigStore } from "./config/clone-config.ts";
import { uiStrings } from "./desktop/ui-locale.ts";
import { readConnectorSettings, writeConnectorSettings } from "./connectors/connector-registry.ts";
import { compileBriefing } from "./main-agent/situation-briefing.ts";
import { buildFallbackPlan } from "./planning/fallback-planner.ts";
import { reconcileCommitments } from "./state/commitment-reconciler.ts";
import { describeHistory, mainAgentSessionDirectory, readConversation, searchHistory } from "./main-agent/conversation-history.ts";
import { listOwnerConversations, readCurrentSessionPointer } from "./main-agent/session.ts";
import { inspectMagpieGateway } from "./integrations/magpie-gateway.ts";
import { listPiModelIds, listPiModels, piModelReference } from "./main-agent/pi-model-catalog.ts";
import {
  listEffectiveProviderConfigs,
  readUserProviderConfigs,
  removeUserProviderConfig,
  upsertUserProviderConfig,
} from "./config/provider-config-store.ts";

export interface CompanionServerOptions {
  host?: string;
  port?: number;
  dataDirectory?: string;
  workspacePath?: string;
  clientPath?: string;
}

export interface RunningCompanionServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

/**
 * Normalize the owner's Main Agent text without imposing a minimum length.
 * Empty or whitespace-only input is the only rejected case.
 *
 * 规范化所有者送给 Main Agent 的文本，不设置最小长度；只有空串或纯空白会被拒绝。
 */
export function normalizeMainAgentRequestText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The desktop Main Agent uses an append-only turn ledger so an interrupted
 * model call is still visible after a restart instead of becoming a spinner
 * that never resolves.
 *
 * 桌面 Main Agent 使用只追加的回合账本：即使模型调用异常中断，重启后仍能看到
 * 这次失败，而不会留下一个永远转圈的占位卡片。
 */
export interface MainAgentTurnRecord {
  id: string;
  text: string;
  status: "started" | "completed" | "failed" | "interrupted";
  startedAt: string;
  ownerPid?: number;
  completedAt?: string;
  reply?: string;
  error?: string;
}

/**
 * Mark a turn left in `started` by a dead daemon as interrupted. A PID-bearing
 * owner file makes this precise: only a turn whose owning process is gone is
 * rewritten, never one still streaming in another instance.
 *
 * 把崩溃 Daemon 留下的 `started` 回合标记为 interrupted。带 PID 的 owner
 * 文件让判断精确：只改写其所属进程已消失的回合，绝不误改另一个实例中仍在流的回合。
 */
export async function reconcileInterruptedMainAgentTurns(dataDirectory: string): Promise<MainAgentTurnRecord[]> {
  const records = await readMainAgentTurnRecords(dataDirectory);
  const ownerFile = join(dataDirectory, "main-agent-turn-owner.json");
  let ownerPid: number | undefined;
  try {
    const parsed = JSON.parse(await readFile(ownerFile, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) ownerPid = parsed.pid;
  } catch {
    ownerPid = undefined;
  }
  if (ownerPid === process.pid) return records;
  const result: MainAgentTurnRecord[] = [];
  for (const record of records) {
    if (record.status !== "started") {
      result.push(record);
      continue;
    }
    const recordOwnerPid = record.ownerPid ?? ownerPid;
    if (recordOwnerPid !== undefined && !isProcessAlive(recordOwnerPid)) {
      const interrupted: MainAgentTurnRecord = {
        ...record,
        status: "interrupted",
        completedAt: new Date().toISOString(),
        error: "The local runtime stopped before this turn completed.",
      };
      await appendMainAgentTurnRecord(dataDirectory, interrupted);
      result.push(interrupted);
    } else {
      result.push(record);
    }
  }
  return result;
}

/** Claim the desktop turn ledger for this daemon process. 由当前 Daemon 进程接管桌面回合账本。 */
export async function claimMainAgentTurnOwner(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "main-agent-turn-owner.json"),
    `${JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() })}\n`,
    "utf8",
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Runs the Main Agent proposed during a conversation. They are tasks of that
 * chat; listing them as sibling conversations is what made one request look like
 * two chats.
 * 主 Agent 在对话中提案的 Run。它们是该对话的任务；把它们列为同级对话，就使一次请求看起来
 * 像两个对话。
 */
function derivedRunIds(events: readonly JournalEvent[]): Set<string> {
  const triggerSource = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "trigger.received") continue;
    const trigger = asRecord(event.payload);
    if (typeof trigger.id !== "string") continue;
    // The Trigger's own payload carries the source; the event payload wraps it.
    // Trigger 自己的 payload 携带来源；事件 payload 把它包了一层。
    triggerSource.set(trigger.id, String(asRecord(trigger.payload).source ?? ""));
  }
  const taskTrigger = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "task.created" || event.taskId === undefined) continue;
    const payload = asRecord(event.payload);
    if (typeof payload.triggerId === "string") taskTrigger.set(event.taskId, payload.triggerId);
  }
  const derived = new Set<string>();
  for (const event of events) {
    if (event.type !== "run.created" || event.runId === undefined || event.taskId === undefined) continue;
    const trigger = taskTrigger.get(event.taskId);
    if (trigger !== undefined && triggerSource.get(trigger) === "main-agent") derived.add(event.runId);
  }
  return derived;
}

/**
 * Derives the one-line update for a settled run from the journal, then stores it.
 * Everything here is read-only against the Kernel; the journal stays the truth
 * and this is a readable projection for the conversation.
 * 从 Journal 推导落定 Run 的一行更新并保存。这里对 Kernel 全是只读；Journal 仍是真相，
 * 这只是给对话看的可读投影。
 */
async function recordWorkUpdate(
  dataDirectory: string,
  journal: JournalStore,
  runtime: { getRun(runId: string): Run },
  runId: string,
): Promise<void> {
  let run: Run;
  try {
    run = runtime.getRun(runId);
  } catch {
    return;
  }
  const status = run.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled" && status !== "waiting_review") return;
  const events = (await journal.list()).filter((event) => event.runId === runId);
  const plan = events.find((event) => event.type === "plan.created");
  const task = events.find((event) => event.type === "task.created");
  const steps = plan === undefined ? [] : (asRecord(plan.payload).steps as Array<{ title?: string }> | undefined) ?? [];
  const rawTitle = asRecord(task?.payload).title;
  const title = (typeof rawTitle === "string" ? rawTitle : steps[0]?.title) ?? "未命名任务";
  const evidenceCount = events.filter((event) => event.type === "evidence.recorded").length;
  const failure = events.find((event) => event.type === "execution.failed");
  const reason = failure === undefined ? undefined : String(asRecord(failure.payload).message ?? "");
  const summary = status === "completed"
    ? `完成 ${steps.length || 1} 个步骤`
    : reason !== undefined && reason.length > 0
      ? reason.split("\n")[0]!.slice(0, 160)
      : "";
  await appendWorkUpdate(dataDirectory, {
    id: `${runId}:${status}`,
    runId,
    title: plainText(title).slice(0, 120),
    status,
    summary: plainText(summary),
    at: run.updatedAt,
    evidenceCount,
  });
}

/**
 * Markdown stripped down to what a one-line sidebar can show. The preview used
 * to carry "**bold**" and code ticks straight from the model, which wrapped into
 * several lines and read as noise.
 * 把 Markdown 收敛成单行侧栏能显示的样子。此前的预览把模型输出里的 "**加粗**" 和反引号原样
 * 带出来，撑成好几行，读起来像噪音。
 */
export function plainText(value: string): string {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export async function readMainAgentTurnRecords(dataDirectory: string): Promise<MainAgentTurnRecord[]> {
  const file = join(dataDirectory, "main-agent-turns.jsonl");
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const byId = new Map<string, MainAgentTurnRecord>();
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record = JSON.parse(trimmed) as Partial<MainAgentTurnRecord>;
      if (typeof record.id !== "string" || typeof record.text !== "string") continue;
      if (record.status !== "started" && record.status !== "completed" && record.status !== "failed" && record.status !== "interrupted") continue;
      if (typeof record.startedAt !== "string") continue;
      byId.set(record.id, {
        id: record.id,
        text: record.text,
        status: record.status,
        startedAt: record.startedAt,
        ...(typeof record.ownerPid === "number" ? { ownerPid: record.ownerPid } : {}),
        ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
        ...(typeof record.reply === "string" ? { reply: record.reply } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
      });
    } catch {
      continue;
    }
  }
  return [...byId.values()];
}

async function appendMainAgentTurnRecord(dataDirectory: string, record: MainAgentTurnRecord): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(join(dataDirectory, "main-agent-turns.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

export async function recordMainAgentClientInterruption(
  dataDirectory: string,
  input: { turnId: string; text: string; error: string; startedAt?: string },
): Promise<MainAgentTurnRecord> {
  const records = await readMainAgentTurnRecords(dataDirectory);
  const existing = records.find((record) => record.id === input.turnId);
  if (existing?.status === "completed" || existing?.status === "failed" || existing?.status === "interrupted") {
    return existing;
  }
  const record: MainAgentTurnRecord = {
    id: input.turnId,
    text: input.text,
    status: "interrupted",
    startedAt: existing?.startedAt ?? input.startedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: input.error.slice(0, 2_000),
    ...(existing?.ownerPid === undefined ? {} : { ownerPid: existing.ownerPid }),
  };
  await appendMainAgentTurnRecord(dataDirectory, record);
  return record;
}

async function runRecordedMainAgentTurn(
  dataDirectory: string,
  text: string,
  turnId: string,
  options: Parameters<typeof runMainAgentQuery>[2] = {},
): Promise<Awaited<ReturnType<typeof runMainAgentQuery>>> {
  const startedAt = new Date().toISOString();
  await appendMainAgentTurnRecord(dataDirectory, {
    id: turnId,
    text,
    status: "started",
    startedAt,
    ownerPid: process.pid,
  });
  try {
    const result = await runMainAgentQuery(dataDirectory, text, options);
    if (result.error !== undefined) {
      throw new Error(result.error);
    }
    await appendMainAgentTurnRecord(dataDirectory, {
      id: turnId,
      text,
      status: "completed",
      startedAt,
      ownerPid: process.pid,
      completedAt: new Date().toISOString(),
      reply: result.reply,
    });
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await appendMainAgentTurnRecord(dataDirectory, {
      id: turnId,
      text,
      status: "failed",
      startedAt,
      ownerPid: process.pid,
      completedAt: new Date().toISOString(),
      error: message,
    });
    throw error;
  }
}

/**
 * Local-only daemon transport used by the desktop shell. The shipped Tauri
 * window opens this loopback URL; it is never a hosted web service.
 *
 * 桌面 Shell 使用的仅本地 Daemon Transport。发布的 Tauri Window 会打开这个 Loopback URL；
 * 它绝不是托管 Web 服务。
 */
export async function startCompanionServer(options: CompanionServerOptions = {}): Promise<RunningCompanionServer> {
  const host = normalizeCompanionHost(options.host ?? "127.0.0.1");
  const port = options.port ?? parsePort(process.env.CLONE_AI_PORT, 4317);
  // One resolver owns every persistent path, so the daemon, the CLI, and the
  // Main Agent cannot disagree about where the owner's data lives.
  // 由唯一的解析器决定所有持久化路径，使 Daemon、CLI 与 Main Agent 不会对
  // "所有者数据在哪里" 产生分歧。
  const paths = resolveClonePaths({
    ...(options.dataDirectory === undefined ? {} : { dataDirectory: options.dataDirectory }),
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  await prepareCloneHome(paths);
  // Copying is additive and never overwrites a file the owner already has in
  // the new home, so an interrupted upgrade can simply be run again.
  // 复制只做增量、绝不覆盖新目录中已存在的文件，因此升级中断后可以直接重跑。
  await migrateLegacyCloneHome({
    legacyDirectory: defaultLegacyDirectory(paths.workspacePath),
    targetDirectory: paths.dataDirectory,
  });
  const dataDirectory = paths.dataDirectory;
  const workspacePath = paths.workspacePath;
  // A previous desktop crash may have left a turn in `started`; record that
  // outcome before a new daemon accepts more work.
  // 上一次桌面崩溃可能留下 `started` 回合；新 Daemon 接活前先把这次结果记下来。
  await reconcileInterruptedMainAgentTurns(dataDirectory);
  await claimMainAgentTurnOwner(dataDirectory);
  // The GUI assets ship with the package, so they must be resolved relative to
  // this module — the desktop app runs from its bundle, not the owner's cwd.
  // GUI 资源随应用包发布，因此必须相对本模块解析——桌面应用从应用包运行，
  // 而不是所有者的当前目录。
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const clientPath = options.clientPath ?? join(packageRoot, "apps", "desktop", "ui", "index.html");
  const clientDirectory = dirname(clientPath);
  const [client, clientCss, componentCss, clientJs, componentJs, auditCss, auditJs, memoryCss, memoryJs] = await Promise.all([
    readFile(clientPath, "utf8"),
    readFile(join(clientDirectory, "style.css"), "utf8"),
    readFile(join(clientDirectory, "components.css"), "utf8"),
    readFile(join(clientDirectory, "app.js"), "utf8"),
    readFile(join(clientDirectory, "components.js"), "utf8"),
    readFile(join(clientDirectory, "audit.css"), "utf8"),
    readFile(join(clientDirectory, "audit.js"), "utf8"),
    readFile(join(clientDirectory, "memory.css"), "utf8"),
    readFile(join(clientDirectory, "memory.js"), "utf8"),
  ]);
  const token = issueCompanionToken();
  await persistCompanionToken(paths.dataDirectory, token);
  const clientHtml = injectCompanionToken(client, token);
  const startedAt = Date.now();
  const schedules = new ScheduleStore(paths.schedulesFile);
  const sessions = new SessionStore(paths.sessionsFile);
  const providers = await loadProviderRegistry(dataDirectory);
  const agentSettings = new WorkerSettingsStore(paths.legacyAgentsFile, providers);
  const agentRegistry = new WorkerRegistry(dataDirectory);
  // One Runtime assembly, and therefore one journal, shared by every module in
  // this process. Separate stores over the same file each keep their own
  // sequence counter and their own cached view, which is how duplicate
  // sequences and stale reads appear.
  // 本进程内所有模块共用一个 Runtime 组装，因而共用一本 Journal。针对同一文件建多个
  // Store，每个都持有自己的 sequence 计数器和缓存视图——重复 sequence 与陈旧读数正是这么来的。
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  const journal = assembly.journal;
  const memoryGovernance = new MemoryGovernance({
    journal,
    store: new MdMemoryStore({ dataDirectory }),
  });
  const config = new CloneConfigStore(paths);
  const scheduler = new LocalScheduler({
    store: schedules,
    run: async (schedule, occurrence) => {
      return await runQuery(dataDirectory, schedule.query, {
        kind: "schedule",
        payload: {
          scheduleId: schedule.id,
          occurrenceId: occurrence.id,
          occurrenceKey: occurrence.runKey,
          scheduleKind: schedule.kind,
          scheduleDescription: describeSchedule(schedule),
        },
      }, await agentSettings.get(), { workspacePath });
    },
  });
  // The opportunity plane and the daily bad-case report share the same
  // journal. The report is opt-in: without reporting.json there is no email.
  // 机会平面与每日坏案例报告共享同一本 Journal。报告是显式开启的：没有 reporting.json
  // 就不会发邮件。
  // Accepted plans must actually run. Without this consumer a Run reaching
  // "queued" would sit there while the GUI claims progress.
  // 已接受的计划必须真的跑起来。没有这个消费者，到达 "queued" 的 Run 会一直停在那里，
  // 而 GUI 却宣称正在推进。
  const { runtime: queueRuntime } = assembly;
  const runQueue = new RunQueueConsumer({
    runtime: queueRuntime,
    journal,
    registry: async () => createConfiguredAgentRegistry((await agentSettings.get()).agents, { dataDirectory, workspacePath }),
    onError: (runId, error) => {
      logJson("error", "Run failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    // The guardian: when a background run settles, say what happened in the
    // conversation, so the next turn — human or Main Agent — starts from the
    // result instead of a status colour.
    // 守护线程：后台 Run 落定时，在对话里说明发生了什么，使下一轮——不论是人还是 Main
    // Agent——从结果开始，而不是从一个状态颜色开始。
    onSettled: (runId) => recordWorkUpdate(dataDirectory, journal, queueRuntime, runId),
  });
  runQueue.start();
  const opportunityService = new OpportunityService(journal);
  const badCaseLog = new BadCaseLog({ dataDirectory });
  await badCaseLog.appendNew(await journal.list()).catch(() => undefined);
  const reporting = await readJsonFile<DailyReportSettings>(join(dataDirectory, "reporting.json"));
  const reportRunner = reporting === undefined
    ? undefined
    : new DailyReportRunner({
        journal,
        dataDirectory,
        settings: reporting,
        opportunities: () => opportunityService.list(),
      });
  let reportInFlight: Promise<void> | undefined;
  let reportTimer: NodeJS.Timeout | undefined;
  if (reportRunner !== undefined && reporting?.enabled === true) {
    reportTimer = setInterval(() => {
      if (reportInFlight !== undefined) return;
      reportInFlight = reportRunner.maybeSend().then((result) => {
        if (result === "unknown") logJson("error", "A daily report has an unknown delivery outcome; review it before retrying");
      }).catch((error: unknown) => {
        logJson("error", "Daily report delivery failed; review its outcome before retrying", {
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => { reportInFlight = undefined; });
    }, 3_600_000);
    reportTimer.unref();
  }

  /**
   * The background loop that keeps the twin's own state moving.
   *
   * Two things previously only happened at startup or not at all: scanning for
   * opportunities, and turning a completed run's `memory.candidate.requested`
   * into a reviewable candidate. Both are what makes the twin appear to notice
   * things and learn, so both belong on a timer rather than on a user action.
   *
   * 让分身自身状态持续推进的后台循环。
   *
   * 之前有两件事只在启动时发生、或根本不发生：扫描机会，以及把已完成 Run 的
   * `memory.candidate.requested` 转成可审核的候选。这两件事正是“分身会注意到事情、会
   * 学习”的来源，因此它们属于定时器，而不是属于某个用户动作。
   */
  const runMaintenance = async (): Promise<void> => {
    // The reconcile pass runs before the scan and settles what landed since
    // the last tick — commitments served by verified runs, occurrences that
    // passed unsatisfied. The scan then reads the advanced due dates, so a
    // settled Friday proposes next Friday's card instead of re-proposing a
    // past one. Order is the loop: observe, settle, then look for new diffs.
    // 收敛扫描先于机会扫描运行，结算自上次 tick 以来落地的东西——被已验证 Run 服务过的
    // 承诺、未被满足而错过的周期。机会扫描随后读到推进后的到期时间，因此被结算的周五
    // 提出的是下一个周五的卡片，而不是重复提出已过去的那个。顺序即环路：观察、结算、
    // 再找新的差异。
    await reconcileCommitments(journal).catch(() => undefined);
    // Drain every pending candidate: a completed run must not wait for the
    // next tick to become something the owner can review.
    // 排空所有待处理候选：已完成的 Run 不应等到下一次 tick 才变成所有者可审核的东西。
    try {
      await assembly.memory.rebuild();
      for (let drained = 0; drained < 50 && assembly.memory.hasPending(); drained += 1) {
        await assembly.memory.processNext();
      }
    } catch (error: unknown) {
      logJson("error", "Memory extraction failed; the job remains pending", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await opportunityService.scanAndRecord().catch(() => undefined);
    await badCaseLog.appendNew(await journal.list()).catch(() => undefined);
  };
  let maintenanceInFlight: Promise<void> | undefined;
  const startMaintenance = (): Promise<void> => {
    if (maintenanceInFlight !== undefined) return maintenanceInFlight;
    maintenanceInFlight = runMaintenance().finally(() => { maintenanceInFlight = undefined; });
    return maintenanceInFlight;
  };
  await startMaintenance();
  const maintenance = setInterval(() => {
    void startMaintenance().catch((error: unknown) => logJson("error", "Maintenance failed", {
      error: error instanceof Error ? error.message : String(error),
    }));
  }, 5 * 60_000);
  maintenance.unref();

  const bound = { port };
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, {
        host,
        listenPort: bound.port,
        token,
        startedAt,
        dataDirectory,
        workspacePath,
        paths,
        config,
        client: clientHtml,
        clientCss,
        componentCss,
        clientJs,
        componentJs,
        auditCss,
        auditJs,
        memoryCss,
        memoryJs,
        schedules,
        sessions,
        agentSettings,
        agentRegistry,
        memoryGovernance,
        reportRunner,
        opportunityService,
        badCaseLog,
        journal,
        runtime: queueRuntime,
        runQueue,
        authority: assembly.authority,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "The local runtime encountered an unexpected error.";
      sendJson(response, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The local companion did not expose a TCP address.");
  }
  const url = `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
  const endpointStartedAt = new Date().toISOString();
  await persistCompanionEndpoint(dataDirectory, url, endpointStartedAt);
  bound.port = address.port;
  scheduler.start();
  return {
    url,
    token,
    // Shutdown waits for the queue: a consumer still writing into the data
    // directory after close() resolves is a corrupted journal.
    // 关闭要等待队列：close() 返回后仍在往数据目录写入的消费者，意味着损坏的 Journal。
    close: async () => {
      clearInterval(maintenance);
      if (reportTimer !== undefined) clearInterval(reportTimer);
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await scheduler.stop();
      await runQueue.stop();
      await Promise.allSettled([maintenanceInFlight, reportInFlight]);
      await serverClosed;
      await clearCompanionEndpointIfOwned(dataDirectory, endpointStartedAt);
      await memoryGovernance.close();
      // Release the journal last: the queue and governance above may still be
      // finishing writes, and closing the database under them would lose those
      // records or fail the shutdown.
      // 最后释放 Journal：上面的队列与记忆治理可能仍在收尾写入，在它们下面关掉数据库
      // 会丢记录或让关停失败。
      assembly.close();
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    host: string;
    listenPort: number;
    token: string;
    startedAt: number;
    dataDirectory: string;
    workspacePath: string;
    paths: ClonePaths;
    config: CloneConfigStore;
    client: string;
    clientCss: string;
    componentCss: string;
    clientJs: string;
    componentJs: string;
    auditCss: string;
    auditJs: string;
    memoryCss: string;
    memoryJs: string;
    schedules: ScheduleStore;
    sessions: SessionStore;
    agentSettings: WorkerSettingsStore;
    agentRegistry: WorkerRegistry;
    memoryGovernance: MemoryGovernance;
    reportRunner?: DailyReportRunner;
    opportunityService: OpportunityService;
    badCaseLog: BadCaseLog;
    journal: JournalStore;
    runtime: CloneRuntime;
    runQueue: RunQueueConsumer;
    authority: StandingPolicyStore;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${context.host === "::1" ? "[::1]" : context.host}`);
  const method = request.method ?? "GET";
  const authorized = authorizeCompanionRequest({
    method,
    pathname: url.pathname,
    hostHeader: headerValue(request.headers.host),
    originHeader: headerValue(request.headers.origin),
    authorization: headerValue(request.headers.authorization),
    token: context.token,
    listenPort: context.listenPort,
  });
  if (!authorized.ok) {
    sendJson(response, authorized.status, { error: authorized.error });
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    let journal: "ok" | "error" = "ok";
    try {
      await context.journal.list();
    } catch {
      journal = "error";
    }
    let runs = emptyRunMetrics();
    try {
      await context.runtime.refresh();
      runs = summarizeRuns(context.runtime.listRuns());
    } catch {
      // Health still answers; missing run counts are better than a 500.
      // Health 仍然应答；缺 Run 计数好过 500。
    }
    sendJson(response, journal === "ok" ? 200 : 503, {
      ok: journal === "ok",
      pid: process.pid,
      uptimeMs: Date.now() - context.startedAt,
      journal,
      queue: { inFlight: context.runQueue.inFlight().length },
      runs,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(context.client);
    return;
  }
  if (request.method === "GET" && url.pathname === "/style.css") {
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    response.end(context.clientCss);
    return;
  }
  if (request.method === "GET" && url.pathname === "/components.css") {
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    response.end(context.componentCss);
    return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(context.clientJs);
    return;
  }
  if (request.method === "GET" && url.pathname === "/audit.css") {
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    response.end(context.auditCss);
    return;
  }
  if (request.method === "GET" && url.pathname === "/audit.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(context.auditJs);
    return;
  }
  if (request.method === "GET" && url.pathname === "/memory.css") {
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    response.end(context.memoryCss);
    return;
  }
  if (request.method === "GET" && url.pathname === "/memory.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(context.memoryJs);
    return;
  }
  if (request.method === "GET" && url.pathname === "/components.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(context.componentJs);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, await buildDashboard(context.dataDirectory, context.sessions));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    // Paths are shown so the owner can find and inspect their own data; no
    // credential value is ever part of this payload. ui.strings follows
    // config.locale so the desktop chrome is not stuck in one language.
    // 展示路径是为了让所有者能找到并检查自己的数据；该响应从不包含任何凭据值。
    // ui.strings 跟随 config.locale，桌面框架文案就不会锁死在一种语言上。
    const config = await context.config.get();
    sendJson(response, 200, {
      config,
      ui: { locale: config.locale, strings: uiStrings(config.locale) },
      paths: {
        dataDirectory: context.paths.dataDirectory,
        workspacePath: context.paths.workspacePath,
        configFile: context.paths.configFile,
        providersFile: context.paths.providersFile,
        memoryDirectory: join(context.dataDirectory, "memory"),
        outcomesDirectory: context.paths.outcomesDirectory,
        workspaceRuntimeDirectory: context.paths.workspaceRuntimeDirectory,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/options") {
    const current = await context.config.get();
    const piModels = await listPiModels().catch(() => []);
    sendJson(response, 200, {
      workspacePath: current.workspacePath,
      mainAgentModel: current.mainAgentModel,
      mainAgentEffort: current.mainAgentEffort,
      effortLevels: EFFORT_LEVELS,
      models: piModels,
    });
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    const update: { workspacePath?: string; locale?: "zh-CN" | "en"; mainAgentModel?: string; mainAgentEffort?: EffortLevel | undefined } = {};
    if (typeof body.workspacePath === "string" && body.workspacePath.trim().length > 0) {
      update.workspacePath = body.workspacePath.trim();
    }
    if (body.locale === "zh-CN" || body.locale === "en") update.locale = body.locale;
    if ("mainAgentModel" in body) {
      if (typeof body.mainAgentModel !== "string") {
        sendJson(response, 400, { error: "mainAgentModel must be a string (empty clears it)." });
        return;
      }
      update.mainAgentModel = body.mainAgentModel.trim();
    }
    if ("mainAgentEffort" in body) {
      if (body.mainAgentEffort === "" || body.mainAgentEffort === null) update.mainAgentEffort = undefined;
      else if (isEffortLevel(body.mainAgentEffort)) update.mainAgentEffort = body.mainAgentEffort;
      else {
        sendJson(response, 400, { error: `mainAgentEffort must be one of ${EFFORT_LEVELS.join(", ")} (empty clears it).` });
        return;
      }
    }
    if (Object.keys(update).length === 0) {
      sendJson(response, 400, { error: "Provide a workspacePath, locale, mainAgentModel, or mainAgentEffort to change." });
      return;
    }
    sendJson(response, 200, { config: await context.config.update(update) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings/providers") {
    sendJson(response, 200, {
      providers: await listEffectiveProviderConfigs(context.dataDirectory),
      userDefined: await readUserProviderConfigs(context.dataDirectory),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/gateways") {
    // This is a loopback-only capability probe. It intentionally returns no
    // credential material and does not write Magpie's own configuration.
    // 这只是回环能力探测：刻意不返回任何凭据，也不改写 Magpie 自己的配置。
    const gateway = await inspectMagpieGateway();
    const piModels = gateway.running
      ? new Set((await listPiModels("magpie").catch(() => [])).map((model) => model.id))
      : new Set<string>();
    sendJson(response, 200, {
      gateways: [{
        ...gateway,
        models: gateway.models.map((model) => ({
          ...model,
          compatible: piModels.has(model.id),
        })),
        compatibleModelCount: piModels.size === 0
          ? 0
          : gateway.models.filter((model) => piModels.has(model.id)).length,
      }],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/gateways/magpie/apply") {
    const body = await readJsonBody(request);
    if (typeof body.model !== "string") {
      sendJson(response, 400, { error: "Provide a Magpie model id to apply." });
      return;
    }
    const modelId = body.model.trim().replace(/^magpie\//, "");
    if (modelId.length === 0) {
      sendJson(response, 200, { config: await context.config.update({ mainAgentModel: "" }) });
      return;
    }
    const gateway = await inspectMagpieGateway();
    if (!gateway.running) {
      sendJson(response, 409, { error: gateway.error ?? "Magpie gateway is not running." });
      return;
    }
    if (!gateway.models.some((model) => model.id === modelId)) {
      sendJson(response, 400, { error: `Magpie does not expose the model "${modelId}".` });
      return;
    }
    const reference = piModelReference(modelId);
    try {
      // The Pi catalog is the final capability check: writing a model Clone AI
      // cannot construct would turn a settings success into a later chat failure.
      // Pi 目录是最终能力校验：写入 Clone AI 无法构造的模型会把设置成功变成之后的对话失败。
      if (!(await listPiModelIds("magpie")).includes(modelId)) {
        sendJson(response, 409, {
          error: `Magpie is running, but Pi is not connected to "${modelId}". Enable Pi in Magpie, run magpie sync, then retry.`,
        });
        return;
      }
      sendJson(response, 200, {
        config: await context.config.update({ mainAgentModel: reference }),
        gateway: await inspectMagpieGateway(),
      });
    } catch (error: unknown) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Could not validate the Pi model catalog.",
      });
    }
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings/providers") {
    const body = await readJsonBody(request);
    if (body.hostAccess === "unrestricted" && body.acknowledgeUnrestrictedHostAccess !== true) {
      sendJson(response, 400, { error: "Unrestricted host access requires explicit acknowledgement; it is not a sandbox." });
      return;
    }
    try {
      // Validation lives in the store, so the GUI cannot write a declaration
      // the Runtime would later refuse to launch.
      // 校验在 Store 内进行，因此 GUI 无法写入 Runtime 之后会拒绝启动的声明。
      const providers = await upsertUserProviderConfig(context.dataDirectory, body as never);
      sendJson(response, 200, { providers });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid provider declaration." });
    }
    return;
  }

  const providerMatch = url.pathname.match(/^\/api\/settings\/providers\/([^/]+)$/);
  if (request.method === "DELETE" && providerMatch?.[1] !== undefined) {
    const providers = await removeUserProviderConfig(context.dataDirectory, decodeURIComponent(providerMatch[1]));
    sendJson(response, 200, { providers });
    return;
  }

  if (url.pathname.startsWith("/api/audit")) {
    // The audit is a projection of the journal. Deleting a session hides it from the
    // conversation list only; the record stays here, marked deleted, so an eval never
    // loses a run because someone tidied their sidebar.
    // 审计是 Journal 的投影。删除会话只是把它从对话列表隐藏；记录仍留在这里并标为已删除，
    // 评估不会因为有人整理了侧边栏而丢掉某个 Run。
    const audit = await import("./audit/audit-service.ts");
    try {
      const deletedRunIds = await context.sessions.deletedRunIds();
      const gateway = url.searchParams.get("gateway") !== "0";
      if (method === "GET" && url.pathname === "/api/audit/export") {
        const records = await audit.loadAudits(context.journal, { gateway, deletedRunIds });
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": `attachment; filename="clone-ai-audit-${new Date().toISOString().slice(0, 10)}.jsonl"`,
          "cache-control": "no-store",
        });
        response.end(audit.toJsonl(records));
        return;
      }
      const labelMatch = /^\/api\/audit\/([^/]+)\/label$/.exec(url.pathname);
      if (method === "POST" && labelMatch !== null) {
        const body = await readJsonBody(request);
        const runId = decodeURIComponent(labelMatch[1]!);
        await audit.labelRun(context.journal, runId, body.verdict, body.note);
        const [record] = await audit.loadAudits(context.journal, { runId, gateway: false, deletedRunIds });
        sendJson(response, 200, { record });
        return;
      }
      if (method === "GET" && url.pathname === "/api/audit") {
        const records = await audit.loadAudits(context.journal, { gateway, deletedRunIds });
        sendJson(response, 200, { summary: audit.summarizeAudits(records), records: records.slice(-200).reverse() });
        return;
      }
      const one = /^\/api\/audit\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && one !== null) {
        const [record] = await audit.loadAudits(context.journal, { runId: decodeURIComponent(one[1]!), gateway, deletedRunIds });
        if (record === undefined) sendJson(response, 404, { error: "Unknown run." });
        else sendJson(response, 200, { record });
        return;
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid audit request." });
      return;
    }
  }

  if (url.pathname.startsWith("/api/authority")) {
    // Only the owner's GUI/CLI reaches this (bearer token above). Workers and the
    // Main Agent have no route or tool that edits authority.
    // 只有所有者的 GUI/CLI 能到这里（上面的 bearer token）。Worker 与 Main Agent 没有任何
    // 修改权限的路由或工具。
    try {
      if (method === "GET" && url.pathname === "/api/authority") {
        const config = context.authority.snapshot();
        sendJson(response, 200, { config, summary: describeAuthority(config) });
        return;
      }
      if (method === "GET" && url.pathname === "/api/authority/decisions") {
        const events = (await context.journal.list())
          .filter((event) => event.type === "policy.decided" || event.type === "authority.changed")
          .slice(-100)
          .reverse();
        sendJson(response, 200, { events });
        return;
      }
      if (method === "PUT" && url.pathname === "/api/authority/domains") {
        const body = await readJsonBody(request);
        sendJson(response, 200, { config: await context.authority.setDomainLevel(body.domain as never, body.level as never) });
        return;
      }
      if (method === "POST" && url.pathname === "/api/authority/policies") {
        const body = await readJsonBody(request);
        const policy = await context.authority.addPolicy({
          label: body.label as string,
          scopes: body.scopes,
          maxAutonomy: body.maxAutonomy as never,
          ...(typeof body.validFrom === "string" ? { validFrom: body.validFrom } : {}),
          ...(typeof body.validUntil === "string" ? { validUntil: body.validUntil } : {}),
        });
        sendJson(response, 201, { policy });
        return;
      }
      const revoke = /^\/api\/authority\/policies\/([^/]+)$/.exec(url.pathname);
      if (method === "DELETE" && revoke !== null) {
        sendJson(response, 200, { policy: await context.authority.revokePolicy(decodeURIComponent(revoke[1]!)) });
        return;
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid authority request." });
      return;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/connectors") {
    // Declarations only. A connector's target is a path the owner chose; the
    // env list holds variable names, so nothing here can carry a credential.
    // 只返回声明。target 是所有者选定的路径；env 只有变量名，因此这里不可能携带凭据。
    sendJson(response, 200, { connectors: await readConnectorSettings(context.dataDirectory) });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/connectors") {
    const body = await readJsonBody(request);
    const entries = Array.isArray(body.connectors) ? body.connectors : undefined;
    if (entries === undefined) {
      sendJson(response, 400, { error: "Provide a connectors array." });
      return;
    }
    try {
      sendJson(response, 200, { connectors: await writeConnectorSettings(context.dataDirectory, entries) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid connector declaration." });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/conversation") {
    // The continuous thread behind the Chat tab. Runs are tasks and are listed
    // separately; a conversational turn must not become its own session.
    // 对话页背后的连续线程。Run 是任务、单独列出；一次普通对话不该变成自己的会话。
    const { readConversation } = await import("./main-agent/conversation-history.ts");
    const limit = Number(url.searchParams.get("limit") ?? 200);
    sendJson(response, 200, { messages: await readConversation(context.dataDirectory, Number.isFinite(limit) ? limit : 200) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/situation") {
    // Read the shared journal rather than opening a new store, and do not let
    // a GUI poll trigger connector writes: observation is the background
    // loop's job, so refreshing a panel cannot append duplicate observations.
    // 读共享的 Journal，而不是新开一个 Store；且不让 GUI 轮询触发 Connector 写入：
    // 观察是后台循环的职责，因此刷新面板不会重复追加观察事件。
    const briefing = await compileBriefing({
      journal: context.journal,
      dataDirectory: context.dataDirectory,
      workspacePath: context.workspacePath,
      includeObservations: false,
    });
    sendJson(response, 200, {
      text: briefing.text,
      overdue: briefing.situation.overdueCommitments,
      dueSoon: briefing.situation.dueSoonCommitments,
      activeGoals: briefing.situation.activeGoals,
      selfModel: briefing.situation.selfModel,
      observations: briefing.observations.map((result) => ({
        connectorId: result.connectorId,
        count: result.observations.length,
        error: result.error,
      })),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, await context.agentSettings.get());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    sendJson(response, 200, { providers: await context.agentRegistry.list() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agents/install-missing") {
    const body = await readJsonBody(request);
    if (body.acknowledgeGlobalInstall !== true) {
      sendJson(response, 400, { error: "Confirm the global software installation before continuing." });
      return;
    }
    try {
      const providers = await context.agentRegistry.list();
      const installed = [];
      for (const provider of providers.filter((provider) => !provider.installed && provider.installable)) {
        installed.push(await context.agentRegistry.install(provider.id));
      }
      sendJson(response, 200, { installed, providers: await context.agentRegistry.list() });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The local Agent installation failed." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memory/governed/recall") {
    // The owner's way of asking "what will the twin actually remember from
    // this?" — recall against the one governed library, not a panel-only copy.
    // The answer is exactly what a worker assignment would receive.
    // 所有者问"分身到底会从这句话里想起什么"的方式——对唯一的受治理库做召回，
    // 而不是某个只在面板里存在的副本。答案就是 Worker 派发会收到的东西。
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query.length === 0) {
      sendJson(response, 400, { error: "A recall test needs a query." });
      return;
    }
    const source = new GovernedMemorySource(context.dataDirectory, 4, context.journal);
    const matches = await source.recall(query, "recall-test");
    sendJson(response, 200, {
      query,
      matches: matches.map((match) => ({
        summary: match.memory.summary,
        score: match.score,
        matchedTerms: match.matchedTerms,
      })),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/reporting/bad-cases") {
    const text = await context.badCaseLog.readLog();
    sendJson(response, 200, { text });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/opportunities") {
    const opportunities = await context.opportunityService.list();
    sendJson(response, 200, { opportunities });
    return;
  }
  const opportunityMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)\/(accept|dismiss)$/);
  if (request.method === "POST" && opportunityMatch?.[1] !== undefined && opportunityMatch?.[2] !== undefined) {
    const cardId = decodeURIComponent(opportunityMatch[1]);
    const accepted = opportunityMatch[2] === "accept";
    try {
      const card = await context.opportunityService.find(cardId);
      // Accepting must produce work, not just a resolved card. The trigger
      // alone leaves the run in `planning`, which no consumer ever picks up —
      // so the deterministic planner attaches a plan here and the run reaches
      // `queued`, where the same consumer that serves the chat takes it.
      // Otherwise "accept" is a button that creates a run which forever sits
      // unstarted, which is worse than no run at all: it looks like a promise.
      // 接受必须产生工作，而不只是一张被处置的卡片。仅 acceptTrigger 会把 Run 留在
      // `planning`，而没有任何消费者会捡起它——因此这里用确定性规划器附上计划，让 Run
      // 进入 `queued`，交给与聊天同一个消费者。否则“接受”就是一个创建出永远不启动的
      // Run 的按钮，比没有 Run 更糟：它看起来像一句承诺。
      let runId: string | undefined;
      if (accepted && card !== undefined) {
        // A failed-task card is a diagnosis entry point, not a request to
        // repeat the same failing run. Re-running it verbatim produced a wall
        // of duplicate failures and hid the actual reason.
        // 失败任务卡片是诊断入口，不是重复执行同一条失败任务的按钮。
        // 原样重跑只会堆出一墙重复失败，并把真正原因藏起来。
        if (card.source === "failed_task") {
          const failedRunId = card.serves?.kind === "run" ? card.serves.id : undefined;
          if (failedRunId === undefined) {
            sendJson(response, 409, { error: "The failed run this card refers to is no longer available." });
            return;
          }
          await context.opportunityService.resolve(cardId, "accepted");
          sendJson(response, 200, { decided: cardId, runId: failedRunId, inspectOnly: true });
          return;
        }
        const { run } = await context.runtime.acceptTrigger({
          kind: "signal",
          summary: card.title,
          payload: { opportunityId: card.id, source: card.source, whyNow: card.whyNow, trigger: "opportunity.accepted" },
        });
        const settings = await context.agentSettings.get();
        const enabled = new Set(settings.agents.filter((agent) => agent.enabled).map((agent) => agent.id));
        const plan = buildFallbackPlan(`${card.title}。${card.proposedResult}`, enabled);
        await context.runtime.attachPlan(run.id, {
          ...plan,
          // The card knew which commitment it served; the plan inheriting that
          // link is what lets the reconcile loop settle the commitment when
          // this run lands. Without it the run completes and the Friday it was
          // for stays open forever.
          // 卡片知道自己服务的是哪个承诺；计划继承这条联动，收敛环才能在这个 Run 落地时
          // 结算该承诺。没有它，Run 完成了，而它为之而做的那个周五永远悬而未结。
          ...(card.serves?.kind === "commitment" ? { servesCommitmentId: card.serves.id } : {}),
        });
        runId = run.id;
      }
      await context.opportunityService.resolve(cardId, accepted ? "accepted" : "dismissed");
      sendJson(response, 200, { decided: cardId, ...(runId === undefined ? {} : { runId }) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The opportunity could not be resolved." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memory/candidates") {
    const candidates = await context.memoryGovernance.pendingCandidates();
    sendJson(response, 200, {
      candidates: candidates.map((candidate) => ({
        ...candidate,
        piiFindings: scanMemoryPii(candidate.summary),
      })),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memory/governed") {
    // The .md files are the content layer the owner owns, and a hand edit made
    // in a text editor is as legitimate as one made here — so fold those edits
    // in before reading, or the GUI would show a stale view and quietly
    // overwrite work done outside it.
    // .md 文件是所有者拥有的内容层，在文本编辑器里做的手改与在这里做的一样正当——
    // 所以先把这些改动折回再读，否则 GUI 会显示过期视图，并悄悄覆盖在它之外完成的工作。
    let syncError: string | undefined;
    try {
      await context.memoryGovernance.syncFromFiles();
    } catch (error: unknown) {
      syncError = error instanceof Error ? error.message : "The memory files could not be read.";
    }
    if (syncError !== undefined) {
      const snapshot = await context.memoryGovernance.inspectPending();
      sendJson(response, 200, { ...snapshot, syncError });
      return;
    }
    const [memories, stats] = await Promise.all([
      context.memoryGovernance.list(),
      context.memoryGovernance.stats(),
    ]);
    sendJson(response, 200, { memories, stats, ...(syncError === undefined ? {} : { syncError }) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/memory/governed/sync") {
    try {
      sendJson(response, 200, { synced: await context.memoryGovernance.syncFromFiles() });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The memory files could not be synced." });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/memory/governed") {
    const body = await readJsonBody(request);
    if (typeof body.summary !== "string" || body.summary.trim().length < 3) {
      sendJson(response, 400, { error: "A memory needs a summary of at least three characters." });
      return;
    }
    try {
      const memory = await context.memoryGovernance.author({
        summary: body.summary,
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(isMemoryType(body.type) ? { type: body.type } : {}),
        ...(isSensitivity(body.sensitivity) ? { sensitivity: body.sensitivity } : {}),
        ...(isConfidence(body.confidence) ? { confidence: body.confidence } : {}),
      });
      sendJson(response, 201, { memory });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The memory could not be created." });
    }
    return;
  }
  const memoryDetailMatch = url.pathname.match(/^\/api\/memory\/governed\/([^/]+)$/);
  if (request.method === "GET" && memoryDetailMatch?.[1] !== undefined) {
    // Progressive disclosure: the list carries summaries, and the body plus
    // provenance is fetched only when the owner opens one memory. A read counts
    // as use, exactly like a recall.
    // 渐进式披露：列表只带摘要，正文与来源只在所有者展开某一条时才读取。读取与召回一样计为使用。
    try {
      const memory = await context.memoryGovernance.read(decodeURIComponent(memoryDetailMatch[1]));
      if (memory === undefined) {
        sendJson(response, 404, { error: "This memory does not exist." });
        return;
      }
      const events = await context.journal.list();
      const wanted = new Set(memory.sourceEvidenceIds);
      const evidence = wanted.size === 0 ? [] : events
        .filter((event) => event.type === "evidence.recorded" && wanted.has((event.payload as { id?: string }).id ?? ""))
        .map((event) => {
          const payload = event.payload as { id: string; kind: string; summary: string; locator?: string };
          return { id: payload.id, kind: payload.kind, summary: payload.summary, ...(payload.locator === undefined ? {} : { locator: payload.locator }) };
        });
      // Which work actually pulled this memory in, newest first: the journal is the
      // only place that records a recall against a run, so it is the honest answer
      // to "where was this used?" — the access count alone cannot say.
      // 这条记忆实际被哪次工作取用，最新在前：只有 Journal 把召回记录到具体 Run 上，
      // 因此"它用在哪了"只能从 Journal 得到——单看使用次数说不出这句话。
      const usage = events
        .filter((event) => event.type === "memory.recalled")
        .flatMap((event) => {
          const payload = event.payload as { query?: unknown; memories?: Array<{ id?: string }> };
          const mentioned = Array.isArray(payload.memories) && payload.memories.some((item) => item.id === memory.id);
          return mentioned
            ? [{
                at: event.occurredAt,
                ...(event.runId === undefined ? {} : { runId: event.runId }),
                query: typeof payload.query === "string" ? payload.query.slice(0, 160) : "",
              }]
            : [];
        })
        .reverse()
        .slice(0, 20);
      sendJson(response, 200, {
        memory,
        file: { path: context.memoryGovernance.filePathFor(memory) },
        evidence,
        usage,
      });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The memory could not be read." });
    }
    return;
  }

  const memoryConflictMatch = url.pathname.match(/^\/api\/memory\/governed\/conflicts\/([^/]+)\/keep-file$/);
  if (request.method === "POST" && memoryConflictMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    if (body.confirmDiscardPendingChange !== true) {
      sendJson(response, 400, { error: "Confirm that the pending change will be discarded and the file kept." });
      return;
    }
    try {
      await context.memoryGovernance.keepConflictingFile(decodeURIComponent(memoryConflictMatch[1]));
      await context.memoryGovernance.syncFromFiles();
      sendJson(response, 200, { resolved: true });
    } catch (error: unknown) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "The memory conflict could not be resolved." });
    }
    return;
  }
  const governedMatch = url.pathname.match(/^\/api\/memory\/governed\/([^/]+)$/);
  if (request.method === "PATCH" && governedMatch?.[1] !== undefined) {
    const id = decodeURIComponent(governedMatch[1]);
    const body = await readJsonBody(request);
    const update: Parameters<MemoryGovernance["update"]>[1] = {};
    if (typeof body.summary === "string") update.summary = body.summary;
    if (typeof body.content === "string") update.content = body.content;
    if (isMemoryType(body.type)) update.type = body.type;
    if (isSensitivity(body.sensitivity)) update.sensitivity = body.sensitivity;
    if (isConfidence(body.confidence)) update.confidence = body.confidence;
    const status = body.status === "active" || body.status === "archived" ? body.status : undefined;
    if (Object.keys(update).length === 0 && status === undefined) {
      sendJson(response, 400, { error: "A memory update needs at least one field." });
      return;
    }
    try {
      // Content first, then status: an archive is recorded with its own reason,
      // so folding it into the edit would lose why the memory went out of use.
      // 先内容后状态：归档会带着自己的原因入账，把它并进编辑就会丢掉"为什么不再使用"。
      let memory = Object.keys(update).length === 0
        ? undefined
        : await context.memoryGovernance.update(id, update);
      if (status !== undefined) {
        memory = status === "archived"
          ? await context.memoryGovernance.archive(id)
          : await context.memoryGovernance.restore(id);
      }
      sendJson(response, 200, { memory });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The memory could not be updated." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/context") {
    sendJson(response, 200, await buildContextView(context.dataDirectory));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/context/search") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query.length === 0) {
      sendJson(response, 400, { error: "A history search needs a query." });
      return;
    }
    sendJson(response, 200, { query, excerpts: await searchHistory(context.dataDirectory, query, { limit: 12 }) });
    return;
  }
  const candidateDecisionMatch = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/(promote|reject)$/);
  if (request.method === "POST" && candidateDecisionMatch?.[1] !== undefined && candidateDecisionMatch?.[2] !== undefined) {
    const candidateId = decodeURIComponent(candidateDecisionMatch[1]);
    const action = candidateDecisionMatch[2];
    const body = await readJsonBody(request);
    try {
      if (action === "promote") {
        if ((body.type !== undefined && !isMemoryType(body.type)) || (body.sensitivity !== undefined && !isSensitivity(body.sensitivity))) {
          sendJson(response, 400, { error: "Invalid memory type or sensitivity." });
          return;
        }
        const candidate = (await context.memoryGovernance.pendingCandidates()).find((item) => item.id === candidateId);
        if (candidate === undefined) {
          sendJson(response, 404, { error: "The requested memory candidate does not exist or was already decided." });
          return;
        }
        const memory = await context.memoryGovernance.promote(candidate, {
          ...(isMemoryType(body.type) ? { type: body.type } : {}),
          ...(isSensitivity(body.sensitivity) ? { sensitivity: body.sensitivity } : {}),
        });
        sendJson(response, 201, { memory });
      } else {
        await context.memoryGovernance.reject(candidateId, typeof body.reason === "string" ? body.reason : undefined);
        sendJson(response, 200, { decided: candidateId, action: "rejected" });
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The memory decision could not be recorded." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/schedules") {
    const occurrences = (await context.schedules.listOccurrences()).filter((item) => item.status === "unknown");
    let reportDeliveries: Awaited<ReturnType<DailyReportRunner["unknownDeliveries"]>> = [];
    let reportError = false;
    if (context.reportRunner !== undefined) {
      try {
        reportDeliveries = await context.reportRunner.unknownDeliveries();
      } catch (error: unknown) {
        reportError = true;
        logJson("error", "Daily report delivery state could not be read", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    sendJson(response, 200, { schedules: (await context.schedules.list()).map(toScheduleView), occurrences, reportDeliveries, reportError });
    return;
  }
  const reportDeliveryMatch = url.pathname.match(/^\/api\/reporting\/deliveries\/(\d{4}-\d{2}-\d{2})\/resolve$/);
  if (request.method === "POST" && reportDeliveryMatch?.[1] !== undefined) {
    if (context.reportRunner === undefined) {
      sendJson(response, 404, { error: "Reporting is not configured." });
      return;
    }
    const body = await readJsonBody(request);
    if ((body.resolution !== "retry" && body.resolution !== "dismiss") || body.confirmChecked !== true) {
      sendJson(response, 400, { error: "Confirm that you checked the email outcome before deciding." });
      return;
    }
    try {
      await context.reportRunner.resolveDelivery(reportDeliveryMatch[1], body.resolution);
      const result = body.resolution === "retry" ? await context.reportRunner.maybeSend() : "dismissed";
      sendJson(response, 200, { resolved: true, result });
    } catch (error: unknown) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "The report delivery could not be resolved." });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/schedules") {
    const body = await readJsonBody(request);
    const query = typeof body.query === "string" ? body.query : "";
    const kind = isScheduleKind(body.kind) ? body.kind : "daily";
    const time = typeof body.time === "string" ? body.time : undefined;
    const weekdays = Array.isArray(body.weekdays) && body.weekdays.every((day) => typeof day === "number") ? body.weekdays : undefined;
    const dayOfMonth = typeof body.dayOfMonth === "number" ? body.dayOfMonth : undefined;
    const month = typeof body.month === "number" ? body.month : undefined;
    const cron = typeof body.cron === "string" ? body.cron : undefined;
    const intervalMinutes = typeof body.intervalMinutes === "number" ? body.intervalMinutes : undefined;
    try {
      sendJson(response, 201, { schedule: toScheduleView(await context.schedules.add({ query, kind, time, weekdays, dayOfMonth, month, cron, intervalMinutes })) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The schedule is invalid." });
    }
    return;
  }

  const occurrenceMatch = url.pathname.match(/^\/api\/schedules\/occurrences\/([^/]+)\/resolve$/);
  if (request.method === "POST" && occurrenceMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    if (body.resolution !== "retry" && body.resolution !== "dismiss") {
      sendJson(response, 400, { error: "Choose retry or dismiss after checking the outcome." });
      return;
    }
    try {
      await context.schedules.resolveOccurrence(decodeURIComponent(occurrenceMatch[1]), body.resolution);
      sendJson(response, 200, { resolved: true, resolution: body.resolution });
    } catch (error: unknown) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "The occurrence could not be resolved." });
    }
    return;
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (request.method === "PATCH" && scheduleMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    if (typeof body.enabled !== "boolean") {
      sendJson(response, 400, { error: "A schedule update needs an enabled boolean." });
      return;
    }
    try {
      sendJson(response, 200, { schedule: toScheduleView(await context.schedules.setEnabled(decodeURIComponent(scheduleMatch[1]), body.enabled)) });
    } catch (error: unknown) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : "The schedule was not found." });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/main-agent/stream") {
    const body = await readJsonBody(request);
    const text = normalizeMainAgentRequestText(body.text);
    const turnId = typeof body.turnId === "string" && body.turnId.trim().length > 0
      ? body.turnId.trim()
      : randomUUID();
    if (text.length === 0) {
      sendJson(response, 400, { error: "Please enter a request before sending." });
      return;
    }
    // Delay the SSE headers until the Main Agent lock is held. A busy session
    // must remain a readable 409, not an already-open stream.
    // 等到拿到 Main Agent 锁再发 SSE 头。会话正忙时必须仍是可读的 409，而不是已经打开的流。
    let streamOpen = false;
    const ensureStream = (): void => {
      if (streamOpen) return;
      streamOpen = true;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
    };
    const send = (event: string, data: unknown): void => {
      ensureStream();
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const result = await runRecordedMainAgentTurn(context.dataDirectory, text, turnId, {
        onDelta: (delta) => send("delta", { delta }),
      });
      send("done", result);
    } catch (error: unknown) {
      if (!streamOpen) {
        const busy = error instanceof MainAgentBusyError;
        sendJson(response, busy ? 409 : 500, {
          error: error instanceof Error ? error.message : "The Main Agent failed.",
        });
        return;
      }
      send("failed", { error: error instanceof Error ? error.message : "The Main Agent failed." });
    } finally {
      if (streamOpen) response.end();
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/main-agent/query") {
    const body = await readJsonBody(request);
    const text = normalizeMainAgentRequestText(body.text);
    const turnId = typeof body.turnId === "string" && body.turnId.trim().length > 0
      ? body.turnId.trim()
      : randomUUID();
    if (text.length === 0) {
      sendJson(response, 400, { error: "Please enter a request before sending." });
      return;
    }
    // A remote channel can retry after its own timeout. Reusing a terminal
    // turn id returns the original result instead of running the request again.
    // 远程通道可能在自身超时后重试；终态回合复用原 id 时返回原结果，而不是再次执行。
    const existingTurn = (await readMainAgentTurnRecords(context.dataDirectory))
      .find((record) => record.id === turnId);
    if (existingTurn?.status === "completed") {
      sendJson(response, 200, {
        reply: existingTurn.reply ?? "",
        newRuns: [],
        deduplicated: true,
      });
      return;
    }
    if (existingTurn?.status === "failed" || existingTurn?.status === "interrupted") {
      sendJson(response, 409, {
        error: existingTurn.error ?? "This turn already ended without a successful reply.",
        deduplicated: true,
      });
      return;
    }
    if (existingTurn?.status === "started") {
      sendJson(response, 409, {
        error: "This turn is already running.",
        deduplicated: true,
      });
      return;
    }
    try {
      const result = await runRecordedMainAgentTurn(context.dataDirectory, text, turnId);
      sendJson(response, 200, result);
    } catch (error: unknown) {
      if (error instanceof MainAgentBusyError) {
        sendJson(response, 409, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/requests") {    const body = await readJsonBody(request);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length === 0) {
      sendJson(response, 400, { error: "Please enter work before sending." });
      return;
    }
    const result = await runQuery(
      context.dataDirectory,
      query,
      {},
      await context.agentSettings.get(),
      { workspacePath: context.workspacePath },
    );
    sendJson(response, 201, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/main-agent/interruptions") {
    const body = await readJsonBody(request);
    const turnId = typeof body.turnId === "string" ? body.turnId.trim() : "";
    const text = normalizeMainAgentRequestText(body.text);
    const error = typeof body.error === "string" ? body.error.trim() : "";
    const startedAt = typeof body.startedAt === "string" ? body.startedAt : undefined;
    if (turnId.length === 0 || text.length === 0 || error.length === 0) {
      sendJson(response, 400, { error: "An interruption record needs turnId, text, and error." });
      return;
    }
    const record = await recordMainAgentClientInterruption(context.dataDirectory, {
      turnId,
      text,
      error,
      ...(startedAt === undefined ? {} : { startedAt }),
    });
    sendJson(response, 202, { recorded: true, turn: record });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch?.[1] !== undefined) {
    const runId = decodeURIComponent(sessionMatch[1]);
    if (runId === MAIN_AGENT_SESSION_ID) {
      if (await context.sessions.isConversationDeleted(runId)) {
        sendJson(response, 404, { error: "This conversation was hidden together with its tasks." });
        return;
      }
      sendJson(response, 200, await buildMainAgentConversation(context.dataDirectory));
      return;
    }
    if (await context.sessions.isDeleted(runId)) {
      sendJson(response, 404, { error: "This session was removed from the local conversation list." });
      return;
    }
    sendJson(response, 200, await buildSession(context.dataDirectory, runId, await context.agentSettings.get()));
    return;
  }
  if (request.method === "DELETE" && sessionMatch?.[1] !== undefined) {
    const runId = decodeURIComponent(sessionMatch[1]);
    if (runId === MAIN_AGENT_SESSION_ID) {
      // Hiding the conversation hides the tasks it spawned, in one step. 隐藏对话时一并隐藏它派生出的任务。
      const view = await loadRuntimeView(context.dataDirectory);
      const children = [...derivedRunIds(view.events)].filter((id) => view.runs.some((run) => run.id === id));
      await context.sessions.deleteConversation(runId, children);
      sendJson(response, 204, undefined);
      return;
    }
    const { runs } = await loadRuntimeView(context.dataDirectory);
    if (!runs.some((run) => run.id === runId)) {
      sendJson(response, 404, { error: "The requested local session does not exist." });
      return;
    }
    await context.sessions.delete(runId);
    sendJson(response, 204, undefined);
    return;
  }

  const restoreMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);
  if (request.method === "POST" && restoreMatch?.[1] !== undefined) {
    const target = decodeURIComponent(restoreMatch[1]);
    if (target === MAIN_AGENT_SESSION_ID) await context.sessions.restoreConversation(target);
    else await context.sessions.restore(target);
    sendJson(response, 204, undefined);
    return;
  }

  const agentSettingMatch = url.pathname.match(/^\/api\/settings\/agents\/([^/]+)$/);
  if (request.method === "PATCH" && agentSettingMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    const update: { enabled?: boolean; providerId?: string } = {};
    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (typeof body.providerId === "string" && body.providerId.trim().length > 0) update.providerId = body.providerId;
    if (Object.keys(update).length === 0) {
      sendJson(response, 400, { error: "An agent setting update needs an enabled boolean or providerId." });
      return;
    }
    try {
      sendJson(response, 200, await context.agentSettings.updateAgent(decodeURIComponent(agentSettingMatch[1]), update));
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The agent setting could not be updated." });
    }
    return;
  }

  const agentInstallMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/install$/);
  if (request.method === "POST" && agentInstallMatch?.[1] !== undefined) {
    const id = decodeURIComponent(agentInstallMatch[1]);
    if (id !== "codex-cli" && id !== "claude-code" && id !== "pi") {
      sendJson(response, 404, { error: "The requested local Agent is not supported." });
      return;
    }
    const body = await readJsonBody(request);
    if (body.acknowledgeGlobalInstall !== true) {
      sendJson(response, 400, { error: "Confirm the global software installation before continuing." });
      return;
    }
    try {
      sendJson(response, 200, { provider: await context.agentRegistry.install(id) });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The local Agent installation failed." });
    }
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/memory/settings") {
    // Retired with the legacy memory store: recall is governed by the library
    // itself, and a second settings surface would describe a system that no
    // longer exists. Kept as an explicit 410 so a stale client learns why
    // instead of reading a 404 as "wrong path".
    // 随 legacy 记忆存储一同退役：召回由记忆库本身治理，第二个设置界面描述的是一套
    // 已不存在的系统。保留显式 410，使旧客户端能知道原因，而不是把 404 当成"路径错了"。
    sendJson(response, 410, { error: "The legacy memory store was retired; use the governed memory library." });
    return;
  }

  const traceMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/trace$/);
  if (request.method === "GET" && traceMatch?.[1] !== undefined) {
    // The full, ordered trace of one run: every journal event in plain language,
    // with the raw payload kept one level down. This is the view an owner or an
    // eval reads to answer "what actually happened, in what order?".
    // 单个 Run 的完整有序轨迹：每条 Journal 事件都用可读的语言呈现，原始数据放在下一层。
    // 所有者或评估据此回答"究竟发生了什么、按什么顺序"。
    const runId = decodeURIComponent(traceMatch[1]);
    try {
      const events = await context.journal.list();
      const run = events.find((event) => event.type === "run.created" && event.runId === runId);
      if (run === undefined) {
        sendJson(response, 404, { error: "Unknown run." });
        return;
      }
      const taskId = run.taskId;
      const task = events.find((event) => event.type === "task.created" && event.taskId === taskId);
      const triggerId = task === undefined ? undefined : String(asRecord(task.payload).triggerId ?? "");
      const items = events
        .filter((event) => event.runId === runId
          || (event.runId === undefined && taskId !== undefined && event.taskId === taskId)
          || (event.type === "trigger.received" && triggerId !== undefined && String(asRecord(event.payload).id ?? "") === triggerId))
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => {
          const described = toTimelineItem(event);
          return {
            sequence: event.sequence,
            at: described.occurredAt,
            type: event.type,
            label: described.label,
            detail: described.detail,
            payload: JSON.stringify(event.payload ?? null).slice(0, 2_000),
          };
        });
      sendJson(response, 200, { runId, taskId: taskId ?? null, items });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The trace could not be read." });
    }
    return;
  }

  const approvalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/approve$/);
  if (request.method === "POST" && approvalMatch?.[1] !== undefined) {
    try {
      const result = await approveQueryRun(
        context.dataDirectory,
        decodeURIComponent(approvalMatch[1]),
        await context.agentSettings.get(),
        { workspacePath: context.workspacePath },
      );
      sendJson(response, 200, result);
    } catch (error: unknown) {
      sendJson(response, runActionStatus(error), { error: error instanceof Error ? error.message : "The run could not be approved." });
    }
    return;
  }
  const rejectMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/reject$/);
  if (request.method === "POST" && rejectMatch?.[1] !== undefined) {
    try {
      const result = await rejectQueryRun(
        context.dataDirectory,
        decodeURIComponent(rejectMatch[1]),
        await context.agentSettings.get(),
        { workspacePath: context.workspacePath },
      );
      sendJson(response, 200, result);
    } catch (error: unknown) {
      sendJson(response, runActionStatus(error), { error: error instanceof Error ? error.message : "The run could not be rejected." });
    }
    return;
  }
  const reviewMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/review$/);
  if (request.method === "POST" && reviewMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    if (body.decision !== "accept" && body.decision !== "reject") {
      sendJson(response, 400, { error: "Review requires an explicit accept or reject decision." });
      return;
    }
    try {
      const result = await reviewQueryRun(context.dataDirectory, decodeURIComponent(reviewMatch[1]), body.decision, { workspacePath: context.workspacePath });
      sendJson(response, 200, result);
    } catch (error: unknown) {
      sendJson(response, runActionStatus(error), { error: error instanceof Error ? error.message : "The review could not be recorded." });
    }
    return;
  }
  const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
    try {
      const result = await cancelQueryRun(
        context.dataDirectory,
        decodeURIComponent(cancelMatch[1]),
        await context.agentSettings.get(),
        { workspacePath: context.workspacePath },
      );
      sendJson(response, 200, result);
    } catch (error: unknown) {
      sendJson(response, runActionStatus(error), { error: error instanceof Error ? error.message : "The run could not be cancelled." });
    }
    return;
  }
  sendJson(response, 404, { error: "The local companion endpoint was not found." });
}

async function buildDashboard(dataDirectory: string, sessions: SessionStore): Promise<DashboardView> {
  const { events, state, tasks, runs } = await loadRuntimeView(dataDirectory);
  const [turns, ownerHistory] = await Promise.all([
    readMainAgentTurnRecords(dataDirectory),
    readConversation(dataDirectory, 200),
  ]);
  const deletedRunIds = await sessions.deletedRunIds();
  const conversationDeleted = await sessions.isConversationDeleted(MAIN_AGENT_SESSION_ID);
  const visibleRuns = runs.filter((run) => !deletedRunIds.has(run.id));
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id));
  const eventsByRun = new Map<string, JournalEvent[]>();
  for (const event of events) {
    if (event.runId === undefined) continue;
    const list = eventsByRun.get(event.runId) ?? [];
    list.push(event);
    eventsByRun.set(event.runId, list);
  }
  // A conversational turn is not a task. The Main Agent proposes a one-step
  // direct_response plan for "hello", and showing that as its own session made
  // every message spawn another conversation box. Those runs stay in the
  // journal and the audit; the sidebar shows tasks.
  // 对话不是任务。面对一句"你好"，Main Agent 会提案一个单步 direct_response 计划，把它显示成
  // 独立会话，就使每条消息都裂变出一个新的对话框。这些 Run 仍留在 Journal 与审计里，
  // 侧栏只显示任务。
  const taskRuns = visibleRuns.filter((run) => !isConversationalRun(state, run));
  // Runs the Main Agent proposed are tasks of the conversation, not sibling
  // chats: one request must not read as two conversations in the sidebar.
  // 主 Agent 提案的 Run 是对话的任务，而不是同级对话：一次请求不应在侧栏读成两个对话。
  const derived = derivedRunIds(events);
  const childCount = taskRuns.filter((run) => derived.has(run.id)).length;
  const summary = conversationDeleted ? undefined : summarizeOwnerConversation(ownerHistory, turns);
  const conversationSummary = summary === undefined
    ? undefined
    : {
        ...summary,
        kind: "conversation" as const,
        ...(childCount === 0 ? {} : { childCount }),
      };
  const allSessions = [
    ...taskRuns.map((run) => ({
      ...toSessionSummary(run, tasks, describeRunFailure(run, eventsByRun.get(run.id) ?? []).reason),
      updatedAtMs: Date.parse(run.updatedAt),
      ...(derived.has(run.id) ? { parentId: MAIN_AGENT_SESSION_ID } : {}),
    })),
    ...(conversationSummary === undefined ? [] : [conversationSummary]),
  ].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  // Legacy builds created a fresh Run every time the owner accepted the same
  // failed-task card. Group those identical failures so the sidebar reflects
  // the one problem that still needs attention, not a wall of copies.
  // 旧版本在所有者每次接受同一张失败任务卡时都会新建 Run。把相同失败聚合起来，
  // 让侧栏显示真正需要处理的那个问题，而不是一墙副本。
  const groupedSessions = groupDuplicateFailures(allSessions);

  const approvals = visibleRuns
    .filter((run) => run.status === "waiting_approval" && run.activeStepId !== undefined)
    .map((run) => ({
      runId: run.id,
      title: titleFor(run, tasks),
      stepId: run.activeStepId!,
      description: "The next step can affect an external system and needs your approval.",
    }));
  const active = visibleRuns
    .filter((run) => ["planning", "queued", "running", "verifying"].includes(run.status))
    .slice(0, 4)
    .map((run) => compactRun(run, tasks));
  const subagents = Object.values(state.subagents)
    .filter((subagent) => visibleRunIds.has(subagent.runId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map((subagent) => ({
      runId: subagent.runId,
      title: subagent.title,
      agentId: subagent.agentId,
      role: subagent.role,
      status: subagent.status,
      summary: subagent.summary,
      updatedAt: subagent.updatedAt,
    }));
  const completed = visibleRuns
    .filter((run) => run.status === "completed")
    .slice(0, 4)
    .map((run) => ({ ...compactRun(run, tasks), evidenceCount: (state.evidenceByRun[run.id] ?? []).length }));
  const memories = events
    .filter((event) => event.type === "memory.candidate.proposed")
    .slice(-4)
    .reverse()
    .map((event) => {
      const payload = asRecord(event.payload);
      return {
        summary: typeof payload.summary === "string" ? payload.summary : "The system proposed a memory candidate.",
        confidence: typeof payload.confidence === "string" ? payload.confidence : "unknown",
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    counts: { approvals: approvals.length, active: active.length, completed: visibleRuns.filter((run) => run.status === "completed").length },
    approvals,
    active,
    subagents,
    completed,
    memories,
    sessions: groupedSessions.slice(0, 40).map(({ updatedAtMs: _updatedAtMs, duplicateCount: _duplicateCount, ...summary }) => summary),
    deletedConversations: (await sessions.deletedConversations())
      .map((entry) => ({
        id: entry.id,
        title: "已隐藏的对话",
        childCount: entry.childRunIds.length,
        at: entry.at,
      })),
    timeline: events.slice(-12).reverse().map(toTimelineItem),
  };
}

type DashboardSession = SessionSummary & { updatedAtMs: number; duplicateCount?: number };

/** A plan that only answers, with nothing to execute. 只作答、没有可执行内容的计划。 */
function isConversationalRun(state: { plans: Record<string, { steps: Array<{ requiredCapabilities?: string[] }> }> }, run: Run): boolean {
  const plan = run.planId === undefined ? undefined : state.plans[run.planId];
  if (plan === undefined || plan.steps.length !== 1) return false;
  const step = plan.steps[0]!;
  return (step.requiredCapabilities ?? []).includes("direct_response");
}

function groupDuplicateFailures(sessions: DashboardSession[]): DashboardSession[] {
  const groups = new Map<string, DashboardSession & { duplicateCount: number }>();
  const result: DashboardSession[] = [];
  for (const session of sessions) {
    const isFailure = session.status === "failed" || session.status === "cancelled";
    if (!isFailure) {
      result.push(session);
      continue;
    }
    const key = `${session.status}\u0000${session.title.replace(/\s+/g, " ").trim()}\u0000${session.preview.slice(0, 90)}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.duplicateCount += 1;
      continue;
    }
    const first = { ...session, duplicateCount: 1 };
    groups.set(key, first);
    result.push(first);
  }
  return result.map((session) => (session.duplicateCount ?? 1) > 1
    ? { ...session, preview: `${session.preview} · 同类失败 ${session.duplicateCount ?? 1} 次` }
    : session);
}

const MAIN_AGENT_SESSION_ID = "main-agent-conversation";

type OwnerHistoryMessage = Awaited<ReturnType<typeof readConversation>>[number];

function summarizeOwnerConversation(
  history: OwnerHistoryMessage[],
  turns: MainAgentTurnRecord[],
): DashboardSession | undefined {
  if (history.length === 0) {
    const latestTurn = [...turns]
      .sort((left, right) => Date.parse(left.completedAt ?? left.startedAt) - Date.parse(right.completedAt ?? right.startedAt))
      .at(-1);
    return latestTurn === undefined ? undefined : toMainAgentTurnSummary(latestTurn);
  }
  const ordered = [...history].sort((left, right) => left.at.localeCompare(right.at));
  const latestUser = [...ordered].reverse().find((message) => message.speaker === "user");
  const latestAssistant = [...ordered].reverse().find((message) => message.speaker === "assistant");
  const latestAt = ordered.at(-1)?.at ?? new Date().toISOString();
  const latestTurn = [...turns]
    .sort((left, right) => Date.parse(left.completedAt ?? left.startedAt) - Date.parse(right.completedAt ?? right.startedAt))
    .at(-1);
  const terminalAfterReply = latestTurn !== undefined
    && latestTurn.status !== "completed"
    && Date.parse(latestTurn.startedAt) >= Date.parse(latestAssistant?.at ?? "1970-01-01T00:00:00.000Z");
  const display = latestTurn !== undefined
    ? describeFailureForOwner(latestTurn.error)
    : undefined;
  return {
    id: MAIN_AGENT_SESSION_ID,
    title: latestUser?.text.replace(/\s+/g, " ").trim().slice(0, 80) || "Main Agent 对话",
    status: terminalAfterReply ? latestTurn.status === "started" ? "running" : "failed" : "completed",
    updatedAt: latestTurn !== undefined && Date.parse(latestTurn.completedAt ?? latestTurn.startedAt) > Date.parse(latestAt)
      ? latestTurn.completedAt ?? latestTurn.startedAt
      : latestAt,
    updatedAtMs: Math.max(
      Date.parse(latestAt),
      latestTurn === undefined ? 0 : Date.parse(latestTurn.completedAt ?? latestTurn.startedAt),
    ),
    preview: terminalAfterReply
      ? latestTurn.status === "started"
        ? "这轮对话仍在本地运行时中推进。"
        : `异常中断：${display?.summary ?? "本轮没有完成"}`
      : latestAssistant?.text.replace(/\s+/g, " ").trim().slice(0, 80) || "这轮对话没有返回文字",
  };
}

function toMainAgentTurnSummary(turn: MainAgentTurnRecord): SessionSummary & { updatedAtMs: number } {
  const updatedAt = turn.completedAt ?? turn.startedAt;
  const display = turn.status === "failed" || turn.status === "interrupted"
    ? describeFailureForOwner(turn.error)
    : undefined;
  return {
    id: MAIN_AGENT_SESSION_ID,
    title: plainText(turn.text).slice(0, 80) || "Main Agent conversation",
    status: turn.status === "completed" ? "completed" : turn.status === "started" ? "running" : "failed",
    updatedAt,
    updatedAtMs: Date.parse(updatedAt),
    preview: turn.status === "failed" || turn.status === "interrupted"
      ? `异常中断：${display?.summary ?? "本轮没有完成"}`
      : turn.reply?.trim()
        ? plainText(turn.reply).slice(0, 120)
        : "本轮没有返回文字",
  };
}

async function buildMainAgentConversation(dataDirectory: string): Promise<SessionView> {
  const [history, turnRecords] = await Promise.all([
    readConversation(dataDirectory, 500),
    readMainAgentTurnRecords(dataDirectory),
  ]);
  const turns = [...turnRecords].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const messages: ConversationMessage[] = history.map((message, index) => ({
    id: `history-${index}-${message.session}-${message.at}`,
    role: message.speaker === "user" ? "person" : "clone",
    text: message.text,
    occurredAt: message.at,
  }));
  for (const turn of turns) {
    const at = turn.completedAt ?? turn.startedAt;
    const started = Date.parse(turn.startedAt);
    const ended = Date.parse(turn.completedAt ?? new Date().toISOString()) + 10_000;
    const hasStoredAssistantReply = history.some((message) => (
      message.speaker === "assistant"
      && Date.parse(message.at) >= started
      && Date.parse(message.at) <= ended
      && message.text.trim().length > 0
    ));
    if (hasStoredAssistantReply) continue;
    if (turn.status === "failed" || turn.status === "interrupted") {
      const display = describeFailureForOwner(turn.error);
      messages.push({
        id: `turn-failed-${turn.id}`,
        role: "clone",
        text: `本次对话异常中断：${display.summary}\n\n下一步：${display.guidance}`,
        occurredAt: at,
        tone: "warning",
      });
    } else if (turn.status === "started") {
      messages.push({
        id: `turn-running-${turn.id}`,
        role: "clone",
        text: "这轮对话仍在本地运行时中推进。",
        occurredAt: at,
      });
    } else if (turn.reply !== undefined && turn.reply.trim().length > 0) {
      messages.push({
        id: `turn-reply-${turn.id}`,
        role: "clone",
        text: turn.reply,
        occurredAt: at,
      });
    } else {
      messages.push({
        id: `turn-empty-${turn.id}`,
        role: "clone",
        text: "本轮模型没有返回文字说明。",
        occurredAt: at,
        tone: "warning",
      });
    }
  }
  // Work updates are merged into the same thread by time, so a task that finished
  // while the owner was away reads as part of the conversation, not as a status.
  // 工作更新按时间合入同一条线程：所有者不在时完成的任务读起来是对话的一部分，而不是状态。
  for (const update of await readWorkUpdates(dataDirectory)) {
    messages.push({
      id: `work-${update.id}`,
      role: "clone",
      text: describeWorkUpdate(update),
      occurredAt: update.at,
      ...(update.status === "failed" || update.status === "waiting_review" ? { tone: "warning" as const } : {}),
    });
  }
  messages.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const summary = summarizeOwnerConversation(history, turns);
  const sessionSummary: SessionSummary = summary === undefined
    ? {
        id: MAIN_AGENT_SESSION_ID,
        title: "新的对话",
        status: "completed",
        updatedAt: new Date().toISOString(),
        preview: "从一个清晰的意图开始",
      }
    : (() => {
        const { updatedAtMs: _updatedAtMs, duplicateCount: _duplicateCount, ...value } = summary;
        return value;
      })();
  const latestUser = [...history].reverse().find((message) => message.speaker === "user");
  return {
    ...sessionSummary,
    query: latestUser?.text ?? turns.at(-1)?.text ?? "",
    evidenceCount: 0,
    subagents: [],
    approvals: [],
    messages,
    recalledMemories: [],
    activity: [],
    trace: [],
  };
}

async function buildSession(dataDirectory: string, runId: string, settings: { agents: Array<{ id: string; providerId: string }> }): Promise<SessionView> {
  const { events, state, tasks, runs } = await loadRuntimeView(dataDirectory);
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error("The requested local session does not exist.");
  }

  const task = tasks[run.taskId];
  const trigger = events.find((event) => event.type === "trigger.received" && asRecord(event.payload).id === task?.triggerId);
  const query = typeof asRecord(trigger?.payload).summary === "string" ? String(asRecord(trigger?.payload).summary) : titleFor(run, tasks);
  const providerByRole = new Map(settings.agents.map((agent) => [agent.id, agent.providerId]));
  const subagents = Object.values(state.subagents)
    .filter((subagent) => subagent.runId === run.id)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .map((subagent) => ({
      id: subagent.id,
      title: subagent.title,
      agentId: subagent.agentId,
      role: subagent.role,
      providerId: subagent.providerId ?? providerByRole.get(subagent.agentId) ?? "unknown",
      status: subagent.status,
      summary: subagent.summary,
      updatedAt: subagent.updatedAt,
    }));
  const evidenceCount = (state.evidenceByRun[run.id] ?? []).length;
  const plan = run.planId === undefined ? undefined : state.plans[run.planId];
  const approvals = run.status === "waiting_approval" && run.activeStepId !== undefined
    ? [{ runId: run.id, stepId: run.activeStepId, description: "下一步会影响外部系统，需要你的确认。" }]
    : [];
  const runEvents = events.filter((event) => event.runId === run.id);
  const recalledMemories = runEvents
    .filter((event) => event.type === "memory.recalled")
    .flatMap((event) => {
      const payload = asRecord(event.payload);
      const memories = Array.isArray(payload.memories) ? payload.memories : [];
      return memories.map((memory) => asRecord(memory)).filter((memory) => typeof memory.summary === "string").map((memory) => ({
        id: String(memory.id ?? ""),
        summary: String(memory.summary),
        score: typeof memory.score === "number" ? memory.score : 0,
        matchedTerms: Array.isArray(memory.matchedTerms) ? memory.matchedTerms.filter((term): term is string => typeof term === "string") : [],
      }));
    });

  return {
    ...toSessionSummary(run, tasks, describeRunFailure(run, runEvents).reason),
    query,
    evidenceCount,
    plan: plan === undefined
      ? undefined
      : {
        summary: displayPlanSummary(plan.summary),
        steps: plan.steps.map((step) => ({
          id: step.id,
          title: displayPlanStepTitle(step.title),
          risk: step.risk,
          delegated: step.subagents !== undefined,
        })),
      },
    subagents,
    approvals,
    ...(state.verificationByRun[run.id] === undefined ? {} : { verification: state.verificationByRun[run.id] }),
    messages: buildConversation(run, query, subagents.length, evidenceCount, runEvents, recalledMemories.length),
    recalledMemories,
    activity: runEvents.slice(-16).reverse().map(toTimelineItem),
    trace: runEvents.map(toTraceItem),
  };
}

async function loadRuntimeView(dataDirectory: string) {
  // Read through the same seam the writers use: hardcoding JSONL here would
  // silently show an empty history whenever the owner enables SQLite.
  // 通过写入端使用的同一 seam 读取：在此写死 JSONL 会导致所有者启用 SQLite 后
  // 界面悄悄显示空历史。
  const journal = createJournalStore(dataDirectory);
  try {
    const events = await journal.list();
    const state = replay(events);
    const tasks = state.tasks;
    const runs = Object.values(state.runs).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { events, state, tasks, runs };
  } finally {
    // This runs per request; an unclosed SQLite handle would accumulate one
    // open file per page view. 每个请求都会走到这里；不关闭的 SQLite 句柄会随着每次
    // 页面访问不断累积。
    (journal as { close?: () => void }).close?.();
  }
}

function toSessionSummary(run: Run, tasks: Record<string, Task>, failureReason?: string): SessionSummary {
  return {
    id: run.id,
    title: plainText(titleFor(run, tasks)).slice(0, 90),
    status: run.status,
    updatedAt: run.updatedAt,
    preview: plainText(previewForStatus(run.status, failureReason ?? run.failureReason)).slice(0, 120),
  };
}

function buildConversation(
  run: Run,
  query: string,
  subagentCount: number,
  evidenceCount: number,
  events: JournalEvent[],
  recalledMemoryCount: number,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ id: `user-${run.id}`, role: "person", text: query, occurredAt: run.createdAt }];
  const plan = events.find((event) => event.type === "plan.created");
  if (plan !== undefined) {
    messages.push({
      id: `plan-${run.id}`,
      role: "clone",
      text: subagentCount > 0
        ? `我已把这件事拆成 ${subagentCount} 个可追踪的子任务，并会在每一步保留证据。`
        : "我已准备好一份有边界的执行计划，并会在关键动作前检查权限。",
      occurredAt: plan.occurredAt,
    });
  }

  if (recalledMemoryCount > 0) {
    messages.push({
      id: `memory-${run.id}`,
      role: "clone",
      text: `I used ${recalledMemoryCount} active local memory item${recalledMemoryCount === 1 ? "" : "s"} as context for this work.`,
      occurredAt: plan?.occurredAt ?? run.createdAt,
    });
  }

  if (run.status === "waiting_approval") {
    messages.push({
      id: `approval-${run.id}`,
      role: "clone",
      text: "准备工作已经完成。下一步会影响外部系统，我需要你确认后才会继续。",
      occurredAt: run.updatedAt,
      tone: "approval",
    });
  } else if (run.status === "waiting_review") {
    messages.push({
      id: `review-${run.id}`,
      role: "clone",
      text: "工作已执行，但部分验收标准无法自动验证。请检查证据后决定是否接受。",
      occurredAt: run.updatedAt,
      tone: "approval",
    });
  } else if (run.status === "completed") {
    const review = [...events].reverse().find((event) => event.type === "verification.completed");
    const reviewedByOwner = asRecord(review?.payload).reviewedBy === "owner";
    messages.push({
      id: `complete-${run.id}`,
      role: "clone",
      text: `${reviewedByOwner ? "你已核验并接受结果" : "已完成自动验证"}${evidenceCount > 0 ? `，附有 ${evidenceCount} 条证据` : ""}。你可以在下方查看执行记录。`,
      occurredAt: run.updatedAt,
      tone: "success",
    });
  } else if (run.status === "failed" || run.status === "cancelled") {
    const failure = describeRunFailure(run, events);
    messages.push({
      id: `blocked-${run.id}`,
      role: "clone",
      text: failure.message,
      occurredAt: run.updatedAt,
      tone: "warning",
    });
  } else {
    messages.push({
      id: `progress-${run.id}`,
      role: "clone",
      text: "我正在按计划推进，并持续检查权限、证据和可恢复性。",
      occurredAt: run.updatedAt,
    });
  }
  return messages;
}

function previewForStatus(status: Run["status"], failureReason?: string): string {
  if (status === "waiting_approval") return "等待你的确认";
  if (status === "waiting_review") return "等待你核验结果";
  if (status === "completed") return "已完成并验证";
  if (status === "failed" || status === "cancelled") {
    return failureReason?.trim() ? failureReason.trim().slice(0, 90) : "需要处理：没有记录到失败原因";
  }
  return "正在推进";
}

/**
 * Turn a stored failure into something the owner can act on. Older journals
 * only recorded `failed`, so when no reason exists we infer the worker from
 * the dispatch event and give an explicit next step instead of a dead end.
 *
 * 把已保存的失败转换成所有者可以行动的信息。旧 Journal 只记录 `failed`；
 * 没有原因时从派发事件推断 Worker，并给出明确下一步，而不是死胡同。
 */
function describeRunFailure(run: Run, events: JournalEvent[]): { reason?: string; message: string } {
  if (run.status !== "failed" && run.status !== "cancelled") {
    return { message: "这条工作已结束。" };
  }
  if (run.status === "cancelled") {
    const reason = run.failureReason?.trim();
    return {
      reason,
      message: reason === undefined || reason.length === 0
        ? "这条工作已取消，没有继续执行。"
        : `这条工作已取消。原因：${reason}`,
    };
  }

  const failedEvent = [...events].reverse().find((event) => event.type === "execution.failed");
  const failedPayload = asRecord(failedEvent?.payload);
  const report = asRecord(failedPayload.report);
  const recorded = run.failureReason?.trim()
    || (typeof failedPayload.message === "string" ? failedPayload.message.trim() : "")
    || (typeof report.detail === "string" ? report.detail.trim() : "");
  const startedEvent = [...events].reverse().find((event) => event.type === "execution.started");
  const providerId = typeof report.providerId === "string"
    ? report.providerId
    : typeof asRecord(startedEvent?.payload).providerId === "string"
      ? String(asRecord(startedEvent?.payload).providerId)
      : undefined;
  const category = typeof report.category === "string" ? report.category : "";

  if (recorded.length > 0) {
    const display = describeFailureForOwner(recorded, {
      ...(category.length === 0 ? {} : { category }),
      ...(providerId === undefined ? {} : { providerId }),
    });
    return {
      reason: display.summary,
      message: `这条工作没有完成。原因：${display.summary}\n\n下一步：${display.guidance}`,
    };
  }

  const providerHint = providerId === undefined
    ? "旧版本没有记录具体失败原因。"
    : `旧版本没有记录具体失败原因；最后一次派发使用的是 ${providerId} Worker。`;
  const display = describeFailureForOwner(undefined, providerId === undefined ? {} : { providerId });
  return { reason: display.summary, message: `${providerHint}\n\n下一步：${display.guidance}` };
}

function compactRun(run: Run, tasks: Record<string, Task>): { runId: string; title: string; status: string; updatedAt: string } {
  return { runId: run.id, title: titleFor(run, tasks), status: run.status, updatedAt: run.updatedAt };
}

function titleFor(run: Run, tasks: Record<string, Task>): string {
  return tasks[run.taskId]?.title ?? "Unnamed work";
}

function displayPlanSummary(summary: string): string {
  return summary === "Prepare with parallel child agents, review their evidence, then wait before an external action."
    ? "旧版演示会先在本地准备，再在外部动作前等待你的确认。"
    : summary;
}

function displayPlanStepTitle(title: string): string {
  const legacyTitles: Record<string, string> = {
    "Prepare the work safely": "在本地准备结果",
    "Perform the external action": "执行外部操作",
  };
  return legacyTitles[title] ?? title;
}

function toScheduleView(schedule: LocalSchedule): ScheduleView {
  return {
    id: schedule.id,
    query: schedule.query,
    kind: schedule.kind,
    time: schedule.time,
    weekdays: schedule.weekdays,
    dayOfMonth: schedule.dayOfMonth,
    month: schedule.month,
    cron: schedule.cron,
    intervalMinutes: schedule.intervalMinutes,
    description: describeSchedule(schedule),
    enabled: schedule.enabled,
    lastRunKey: schedule.lastRunKey,
  };
}

function isScheduleKind(value: unknown): value is ScheduleKind {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "yearly" || value === "cron" || value === "interval";
}

function isMemoryType(value: unknown): value is MemoryType {
  return value === "fact" || value === "preference" || value === "procedure" || value === "decision" || value === "commitment";
}

function isSensitivity(value: unknown): value is MemorySensitivity {
  return value === "public" || value === "private" || value === "secret";
}

function isConfidence(value: unknown): value is MemoryCandidate["confidence"] {
  return value === "low" || value === "medium" || value === "high";
}

/**
 * What the Main Agent's context looks like right now.
 *
 * The number worth showing is entriesOutOfContext: how much of the
 * conversation the model can no longer see but that is still on disk. Every
 * other figure here is scale; that one is the gap search_history closes.
 *
 * Main Agent 当前上下文的样子。
 *
 * 真正值得展示的数字是 entriesOutOfContext：对话中模型已经看不到、但仍在磁盘上的
 * 那部分有多少。这里其他数字都只是规模；只有这一个，是 search_history 所要弥合的缺口。
 */
async function buildContextView(dataDirectory: string) {
  const [history, conversations, current] = await Promise.all([
    describeHistory(dataDirectory),
    listOwnerConversations(dataDirectory),
    readCurrentSessionPointer(mainAgentSessionDirectory(dataDirectory)),
  ]);
  const active = current ?? conversations[0]?.path;
  return {
    ...history,
    directory: mainAgentSessionDirectory(dataDirectory),
    ...(active === undefined ? {} : { activeSession: active }),
    conversations: conversations.map((row) => ({
      path: row.path,
      messages: row.messages,
      preview: row.preview,
      updatedAt: new Date(row.mtimeMs).toISOString(),
      active: row.path === active,
    })),
  };
}

function toTraceItem(event: JournalEvent): TraceItem {
  return { ...toTimelineItem(event), sequence: event.sequence, type: event.type };
}

function toTimelineItem(event: JournalEvent): { label: string; detail: string; occurredAt: string } {
  const payload = asRecord(event.payload);
  const labels: Partial<Record<JournalEvent["type"], string>> = {
    "trigger.received": "收到请求",
    "task.created": "创建任务",
    "run.created": "创建任务运行",
    "run.status_changed": "更新任务状态",
    "plan.created": "生成执行计划",
    "policy.decided": "检查执行权限",
    "approval.granted": "记录你的确认",
    "execution.started": "开始执行步骤",
    "execution.failed": "执行失败",
    "execution.progress": "执行进度",
    "subagent.dispatched": "派发子 Agent",
    "subagent.resumed": "恢复子 Agent",
    "subagent.session_started": "子 Agent 会话开始",
    "subagent.progress": "子 Agent 进度",
    "subagent.completed": "子 Agent 返回证据",
    "subagent.failed": "子 Agent 失败",
    "subagent.cancelled": "子 Agent 已取消",
    "subagent.verified": "校验子 Agent 证据",
    "dispatch.decided": "选择执行者",
    "dispatch.blocked": "派发被拒绝",
    "agent.installed": "安装 Worker",
    "agent.install_failed": "Worker 安装失败",
    "agent.message_delta": "Agent 输出文字",
    "agent.tool_started": "Agent 调用工具",
    "agent.tool_completed": "Agent 结束工具",
    "evidence.recorded": "记录证据",
    "workspace.isolation.applied": "隔离工作落盘",
    "verification.completed": "记录验证结果",
    "memory.candidate.requested": "排队记忆复核",
    "memory.candidate.proposed": "提出记忆候选",
    "memory.recalled": "召回本地记忆",
    "usage.recorded": "记录用量",
    "audit.labeled": "人工判定",
    "authority.changed": "修改权限",
  };
  return { label: labels[event.type] ?? event.type, detail: detailFor(event.type, payload), occurredAt: event.occurredAt };
}

function detailFor(type: JournalEvent["type"], payload: Record<string, unknown>): string {
  if (type === "run.status_changed" && typeof payload.status === "string") {
    const statusLabel: Record<string, string> = {
      created: "已创建", planning: "规划中", queued: "排队中", running: "运行中", waiting_approval: "等待你审批",
      verifying: "验证中", waiting_review: "等待你复核", completed: "已完成", failed: "失败", cancelled: "已取消",
    };
    const reason = typeof payload.reason === "string" ? `：${payload.reason}` : "";
    return `${statusLabel[payload.status] ?? payload.status}${payload.activeStepId ? ` · 步骤 ${String(payload.activeStepId)}` : ""}${reason}`;
  }
  if (type === "plan.created") {
    const steps = Array.isArray(payload.steps) ? payload.steps as Array<Record<string, unknown>> : [];
    const titles = steps.map((step) => String(step.title ?? step.id ?? "步骤")).slice(0, 4);
    return `${steps.length} 个步骤：${titles.join(" → ")}${steps.length > 4 ? " …" : ""}`;
  }
  if (type === "execution.started") {
    return `${String(payload.providerId ?? "worker")} 执行步骤 ${String(payload.stepId ?? "")}${Array.isArray(payload.authorizedEvidenceKinds) ? ` · 可记录 ${payload.authorizedEvidenceKinds.join("/")}` : ""}`;
  }
  if (type === "evidence.recorded") {
    return `${String(payload.kind ?? "证据")}${payload.locator ? ` · ${String(payload.locator)}` : ""}${payload.summary ? ` — ${String(payload.summary).slice(0, 120)}` : ""}`;
  }
  if (type === "subagent.dispatched") {
    return `${String(payload.providerId ?? "worker")} 承接 ${String(payload.workOrderId ?? "子任务")}`;
  }
  if (type === "subagent.failed" && typeof payload.message === "string") {
    const report = asRecord(payload.report);
    return `${payload.message}${typeof report.category === "string" ? `（${report.category}）` : ""}`;
  }
  if (type === "trigger.received" && typeof payload.summary === "string") {
    return payload.summary.slice(0, 160);
  }
  if (type === "execution.failed") {
    const message = typeof payload.message === "string" ? payload.message : "Execution stopped without a reason.";
    const report = asRecord(payload.report);
    const category = typeof report.category === "string" ? `（${report.category}）` : "";
    return `${message}${category}`;
  }
  if ((type === "execution.progress" || type === "subagent.progress") && typeof payload.message === "string") {
    return payload.message;
  }
  if (type === "subagent.resumed") {
    return `Attempt ${String(payload.attempt ?? "?")} resumed for ${String(payload.workOrderId ?? "a work order")}.`;
  }
  if (type === "subagent.session_started" && typeof payload.sessionId === "string") {
    return `Session ${payload.sessionId} started.`;
  }
  if (type === "subagent.verified" && typeof payload.summary === "string") {
    return payload.summary;
  }
  if (type === "agent.message_delta" && typeof payload.text === "string") {
    return payload.text;
  }
  if ((type === "agent.tool_started" || type === "agent.tool_completed") && typeof payload.tool === "string") {
    return String(payload.tool);
  }
  if (type === "policy.decided") {
    const decision = asRecord(payload.decision);
    const reason = typeof decision.reason === "string" ? `：${decision.reason}` : "";
    return decision.outcome === "approval_required"
      ? `这一步会影响外部系统，需要你确认${reason}`
      : decision.outcome === "allowed"
        ? `本地的可逆步骤，允许继续${reason}`
        : `当前策略不允许这一步${reason}`;
  }
  if (type === "verification.completed") {
    const summary = typeof payload.summary === "string" ? `：${payload.summary}` : "";
    return payload.passed === true ? `验证通过${summary}` : payload.needsReview === true ? `需要你复核${summary}` : `验证未通过${summary}`;
  }
  if (type === "workspace.isolation.applied") {
    const copied = Array.isArray(payload.copied) ? payload.copied : [];
    return `隔离工作结束：${copied.length} 个文件回到工作区${payload.kept === true ? "，沙箱保留供检查" : ""}`;
  }
  if (type === "memory.recalled") {
    const memories = Array.isArray(payload.memories) ? payload.memories : [];
    const titles = memories.map((memory) => String(asRecord(memory).summary ?? "")).filter((text) => text.length > 0);
    return `用到 ${memories.length} 条记忆${titles.length > 0 ? `：${titles.slice(0, 3).map((text) => `「${text.slice(0, 40)}」`).join(" ")}` : ""}`;
  }
  if (type === "run.created") {
    return `运行 ${String(payload.id ?? "").slice(0, 8)} 已创建${payload.taskId === undefined ? "" : `（任务 ${String(payload.taskId).slice(0, 8)}）`}`;
  }
  if (type === "task.created") {
    return `任务「${String(payload.title ?? "未命名")}」：${String(payload.objective ?? "").slice(0, 120)}`;
  }
  if (type === "dispatch.decided") {
    const sourceLabels: Record<string, string> = {
      explicit: "你明确指定",
      rule: "能力与优先级规则",
      memory: "过去的结果",
      description: "Worker 自述",
    };
    const source = typeof payload.source === "string" ? payload.source : "rule";
    const worker = typeof payload.selectedAgentId === "string" ? payload.selectedAgentId : "?";
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    return `选中 ${worker}（依据：${sourceLabels[source] ?? source}）${reason ? `。${reason}` : ""}`;
  }
  if (type === "dispatch.blocked") {
    const code = typeof payload.code === "string" ? payload.code : "";
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    return `没有 Worker 能执行这一步（${code}）。${reason}`;
  }
  if (type === "agent.installed") {
    return `已安装 ${String(payload.agentId ?? "Worker")}${typeof payload.version === "string" ? `（${payload.version}）` : ""}`;
  }
  if (type === "agent.install_failed") {
    return `安装 ${String(payload.agentId ?? "Worker")} 失败：${String(payload.message ?? "")}`;
  }
  if (typeof payload.summary === "string") {
    return payload.summary;
  }
  if (typeof payload.title === "string") {
    return payload.title;
  }
  return "已记入本地 Journal。";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Candidates are no longer synced into any recall source.
 *
 * A mined candidate is a proposal. Copying it into an active memory store made
 * it reachable by the next task's recall before the owner ever saw it — the
 * exact memory pollution the governance layer exists to prevent. Candidates now
 * stay in the journal until the owner promotes them through MemoryGovernance.
 *
 * 候选不再被同步进任何召回来源。
 *
 * 提炼出的候选只是提案。把它拷贝进活跃记忆库，会让它在所有者见到之前就能被下一个任务
 * 召回——这正是治理层要防止的记忆污染。候选现在留在 Journal 中，直到所有者经
 * MemoryGovernance 提升它们。
 */

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 32_000) {
      throw new Error("The local request body is too large.");
    }
  }
  return body.length === 0 ? {} : asRecord(JSON.parse(body) as unknown);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function runActionStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Unknown run:")) return 404;
  if (message.includes("is not waiting for an approval") || message.includes("is not waiting for review") || message.includes("cannot be cancelled")) return 409;
  return 500;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("CLONE_AI_PORT must be a TCP port between 0 and 65535.");
  }
  return port;
}

interface DashboardView {
  generatedAt: string;
  counts: { approvals: number; active: number; completed: number };
  approvals: Array<{ runId: string; title: string; stepId: string; description: string }>;
  active: Array<{ runId: string; title: string; status: string; updatedAt: string }>;
  subagents: Array<{ runId: string; title: string; agentId: string; role: string; status: string; summary?: string; updatedAt: string }>;
  completed: Array<{ runId: string; title: string; status: string; updatedAt: string; evidenceCount: number }>;
  memories: Array<{ summary: string; confidence: string }>;
  sessions: SessionSummary[];
  /** Conversations hidden together with their tasks, offered back in the sidebar. 与其任务一起隐藏的对话，在侧栏提供恢复。 */
  deletedConversations: Array<{ id: string; title: string; childCount: number; at: string }>;
  timeline: Array<{ label: string; detail: string; occurredAt: string }>;
}

interface SessionSummary {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  preview: string;
  /** Set for a run derived from a conversation: it is a task of that chat, not another chat. 由对话派生出的 Run 会带此字段：它是该对话的任务，而不是另一个对话。 */
  parentId?: string;
  /** On the conversation: how many task runs belong to it. 对话上：属于它的任务数。 */
  childCount?: number;
  kind?: "conversation";
}

interface ConversationMessage {
  id: string;
  role: "person" | "clone";
  text: string;
  occurredAt: string;
  tone?: "approval" | "success" | "warning";
}

interface SessionView extends SessionSummary {
  query: string;
  evidenceCount: number;
  plan?: {
    summary: string;
    steps: Array<{ id: string; title: string; risk: string; delegated: boolean }>;
  };
  subagents: Array<{ id: string; title: string; agentId: string; role: string; providerId: string; status: string; summary?: string; updatedAt: string }>;
  approvals: Array<{ runId: string; stepId: string; description: string }>;
  verification?: import("./core/contracts.ts").VerificationResult;
  messages: ConversationMessage[];
  recalledMemories: Array<{ id: string; summary: string; score: number; matchedTerms: string[] }>;
  activity: Array<{ label: string; detail: string; occurredAt: string }>;
  trace: TraceItem[];
}

interface TraceItem {
  sequence: number;
  type: string;
  label: string;
  detail: string;
  occurredAt: string;
}

interface ScheduleView {
  id: string;
  query: string;
  kind: ScheduleKind;
  time?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  cron?: string;
  intervalMinutes?: number;
  description: string;
  enabled: boolean;
  lastRunKey?: string;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/companion-server.ts") === true) {
  void startCompanionServer()
    .then((companion) => {
      console.log(`clone-ai desktop companion preview: ${companion.url}`);
      const shutdown = (): void => {
        void companion.close().then(() => process.exit(0), () => process.exit(1));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      logJson("error", "companion failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    });
}
