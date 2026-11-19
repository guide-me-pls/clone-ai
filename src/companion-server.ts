import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { JournalEvent, MemoryCandidate, MemorySensitivity, MemoryType, Run, Task, VerificationResult } from "./core/contracts.ts";
import { EFFORT_LEVELS, MAX_EFFORT_LENGTH, normalizeEffort } from "./workers/effort.ts";
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
import { runMainAgentQuery } from "./application/run-main-query.ts";
import {
  readMainAgentTurnRecords,
  recordMainAgentTurnInterrupted,
  type MainAgentTurnRecord,
} from "./main-agent/turn-audit.ts";
import { projectTurnAudits, turnAuditKey, type MainAgentTurnAudit } from "./audit/turn-audit.ts";
import { MAIN_AGENT_HISTORY_TURNS } from "./main-agent/native-runtime.ts";
import { MainAgentBusyError } from "./main-agent/prompt-lock.ts";
import { MainAgentCapacityError } from "./main-agent/main-agent-slots.ts";
import { conversationIdOf, MAIN_AGENT_DEFAULT_CONVERSATION_ID, parseConversationId } from "./main-agent/conversation.ts";
import { routeConversation, type RouteContext } from "./main-agent/conversation-router.ts";
import { mainAgentRunConversations } from "./main-agent/run-triggers.ts";
import {
  authorizeCompanionRequest,
  clearCompanionEndpointIfOwned,
  injectCompanionToken,
  issueCompanionToken,
  normalizeCompanionHost,
  persistCompanionEndpoint,
  persistCompanionToken,
} from "./companion-auth.ts";
import { acquireCompanionInstanceLock } from "./companion-instance.ts";
import { MemoryGovernance } from "./memory/memory-governance.ts";
import { ImprovementService } from "./improvement/improvement-service.ts";
import { MAX_TOTAL_DOCUMENT_CHARACTERS, parseAttachments, type DocumentAttachment } from "./main-agent/attachments.ts";
import { extractBinaryDocuments, type AttachmentReport } from "./main-agent/document-extract.ts";
import { buildAttention } from "./opportunity/attention.ts";
import { PersonalStateStore } from "./state/personal-state-store.ts";
import { sweepConnectors } from "./connectors/connector-registry.ts";
import { scanMemoryPii } from "./memory/memory-hygiene.ts";
import { describeAuthority, StandingPolicyStore } from "./authority/standing-policy-store.ts";
import { expandHome } from "./authority/scope.ts";
import { describeExport, EXPORT_EXCLUDES, exportOwnerData } from "./config/export.ts";
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
import { describeHistory, hasStoredMainConversation, mainAgentSessionDirectory, readConversation, searchHistory } from "./main-agent/conversation-history.ts";
import { listOwnerConversations, readCurrentSessionPointer } from "./main-agent/conversation-store.ts";
import { inspectMagpieGateway } from "./integrations/magpie-gateway.ts";
import { listMainAgentModelIds, listMainAgentModels, mainAgentModelReference } from "./main-agent/main-agent-model-catalog.ts";
import { MAX_INVOCATION_ID_LENGTH, markInvocations, readInvocation, searchInvocations } from "./audit/invocation-ledger.ts";
import { WhatsAppBindingInputError, WhatsAppSetupService } from "./mobile/whatsapp-setup.ts";

export interface CompanionServerOptions {
  host?: string;
  port?: number;
  dataDirectory?: string;
  workspacePath?: string;
  clientPath?: string;
  /** Explicit server deployment mode; never enabled by the desktop app. 显式服务器部署模式；桌面 App 不会启用。 */
  serverMode?: boolean;
  /** Stable public origin used by the server deployment and its documentation. 服务器部署使用的稳定公网来源。 */
  publicBaseUrl?: string;
  /** Stable companion token for a server deployment. 服务器部署使用的稳定 Companion 令牌。 */
  token?: string;
  /** Secret injected by the trusted reverse proxy; it keeps the app port private. 由可信反向代理注入的密钥，用于确保应用端口不直接暴露。 */
  proxySecret?: string;
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
 * The model and effort chosen for one turn, when that surface has a picker.
 *
 * The effort name is forwarded as the owner wrote it: the gateway declares
 * per-model levels (`none`, `ultra`, …) that this build has never heard of, so
 * membership in a fixed list would refuse a level the model advertises. Only a
 * value that is not a name at all — a non-string, or one beyond
 * `MAX_EFFORT_LENGTH` — is refused. An absent or empty value means "use the
 * configured default", which is what WhatsApp and scheduled turns send.
 *
 * 某个界面带有选择器时，本回合选定的模型与强度。
 *
 * 强度名称按所有者所写原样转发：网关按模型声明了本版本从未听说过的档位（`none`、`ultra`
 * 等），因此"在固定列表中"的校验会拒绝模型宣称支持的档位。只有根本不像名称的值——非字符串、
 * 或超过 `MAX_EFFORT_LENGTH`——会被拒绝。空值或缺省表示"使用配置的默认值"——WhatsApp 与
 * 定时回合就是这样发送的。
 */
function parseTurnModelAndEffort(
  body: Record<string, unknown>,
): { ok: true; model?: string; effort?: string } | { ok: false; error: string } {
  let model: string | undefined;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string") return { ok: false, error: "model must be a string." };
    const trimmed = body.model.trim();
    if (trimmed.length > 200) return { ok: false, error: "model must be at most 200 characters." };
    if (trimmed.length > 0) model = trimmed;
  }
  let effort: string | undefined;
  if (body.effort !== undefined && body.effort !== null && body.effort !== "") {
    effort = normalizeEffort(body.effort);
    if (effort === undefined) {
      return { ok: false, error: `effort must be a name of at most ${MAX_EFFORT_LENGTH} characters (empty uses the configured default).` };
    }
  }
  return {
    ok: true,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * The desktop Main Agent uses an append-only turn ledger so an interrupted
 * model call is still visible after a restart instead of becoming a spinner
 * that never resolves. The record type and its readers live in the shared
 * turn-audit module, so turns from any entry point use the same shape.
 *
 * 桌面 Main Agent 使用只追加的回合账本：即使模型调用异常中断，重启后仍能看到
 * 这次失败，而不会留下一个永远转圈的占位卡片。记录类型与读取函数位于共享的
 * turn-audit 模块，因此来自任意入口的回合形状一致。
 */
export { readMainAgentTurnRecords };
export { recordMainAgentTurnInterrupted as recordMainAgentClientInterruption };

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
      const interrupted = await recordMainAgentTurnInterrupted(dataDirectory, {
        turnId: record.id,
        text: record.text,
        error: "The local runtime stopped before this turn completed.",
        startedAt: record.startedAt,
        ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
      });
      result.push(interrupted ?? record);
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
/**
 * Whether an id names a conversation rather than a run. The ledger is the
 * authority: a conversation exists once it has a turn, and the default
 * conversation always exists because the desktop always offers it.
 * 一个 id 指向对话而不是 Run 吗。台账是权威：对话有回合即存在；默认对话始终存在，因为
 * 桌面始终提供它。
 */
async function isKnownConversation(dataDirectory: string, id: string): Promise<boolean> {
  if (id === MAIN_AGENT_DEFAULT_CONVERSATION_ID) return true;
  const records = await readMainAgentTurnRecords(dataDirectory);
  return records.some((record) => conversationIdOf(record.conversationId) === id);
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
  const allEvents = await journal.list();
  const events = allEvents.filter((event) => event.runId === runId);
  const plan = events.find((event) => event.type === "plan.created");
  const task = events.find((event) => event.type === "task.created");
  const rawTitle = asRecord(task?.payload).title;
  // The trigger is where the conversation that asked for this run lives. A run
  // without a scoped trigger — a desktop request, an older row — belongs to the
  // main conversation, which is what the reader assumes by omitting the field.
  // Trigger 里存着请求该 Run 的对话。没有作用域 Trigger 的 Run——桌面请求、更旧的行——属于
  // 主对话，读取方缺省时正是这样理解。
  const triggerId = typeof asRecord(task?.payload).triggerId === "string" ? String(asRecord(task?.payload).triggerId) : undefined;
  const trigger = triggerId === undefined
    ? undefined
    : allEvents.find((event) => event.type === "trigger.received" && asRecord(event.payload).id === triggerId);
  const triggerPayload = trigger === undefined ? {} : asRecord(asRecord(trigger.payload).payload);
  const conversationId = typeof triggerPayload.conversationId === "string" ? triggerPayload.conversationId : undefined;
  const steps = plan === undefined ? [] : (asRecord(plan.payload).steps as Array<{ title?: string }> | undefined) ?? [];
  const title = (typeof rawTitle === "string" ? rawTitle : steps[0]?.title) ?? "未命名任务";
  const evidenceCount = events.filter((event) => event.type === "evidence.recorded").length;
  const failure = events.find((event) => event.type === "execution.failed");
  const reason = failure === undefined ? run.failureReason : String(asRecord(failure.payload).message ?? "");
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
    ...(conversationId === undefined ? {} : { conversationId }),
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

async function runRecordedMainAgentTurn(
  dataDirectory: string,
  text: string,
  turnId: string,
  options: Parameters<typeof runMainAgentQuery>[2] = {},
): Promise<Awaited<ReturnType<typeof runMainAgentQuery>>> {
  // The shared turn recorder writes both the journal events and the ledger
  // rows; this wrapper only maps a model failure to an HTTP error.
  // 共享的回合记录器同时写 Journal 事件与台账行；这层只把模型失败映射为 HTTP 错误。
  const result = await runMainAgentQuery(dataDirectory, text, { ...options, turnId, source: "companion" });
  if (result.error !== undefined) throw new Error(result.error);
  return result;
}

/**
 * Turns the parsed attachments into the documents the Main Agent receives:
 * text documents as-is, PDF/.docx after extraction, all under the remaining
 * character budget. The reports let the interface tell the owner when a long
 * file was shortened.
 * 把解析后的附件变成 Main Agent 收到的文档：文本文档原样，PDF/.docx 先提取，全部受剩余
 * 字符预算约束。reports 让界面在长文件被截断时告诉所有者。
 */
async function resolveAttachmentDocuments(
  attachments: Extract<ReturnType<typeof parseAttachments>, { ok: true }>,
): Promise<
  | { ok: true; documents: DocumentAttachment[]; reports: AttachmentReport[] }
  | { ok: false; error: string }
> {
  const textCharacters = attachments.documents.reduce((total, document) => total + document.text.length, 0);
  const extraction = await extractBinaryDocuments(attachments.binaryDocuments, {
    remainingCharacters: Math.max(0, MAX_TOTAL_DOCUMENT_CHARACTERS - textCharacters),
  });
  if (!extraction.ok) return extraction;
  return {
    ok: true,
    documents: [...attachments.documents, ...extraction.documents],
    reports: extraction.reports,
  };
}

/**
 * Local-only daemon transport used by the desktop shell. The shipped Tauri
 * window opens this loopback URL; it is never a hosted web service.
 *
 * 桌面 Shell 使用的仅本地 Daemon Transport。发布的 Tauri Window 会打开这个 Loopback URL；
 * 它绝不是托管 Web 服务。
 */
export async function startCompanionServer(options: CompanionServerOptions = {}): Promise<RunningCompanionServer> {
  const serverMode = options.serverMode === true;
  const host = normalizeCompanionHost(options.host ?? (serverMode ? "0.0.0.0" : "127.0.0.1"), serverMode);
  const port = options.port ?? parsePort(process.env.CLONE_AI_PORT, 4317);
  // One resolver owns every persistent path, so the daemon and the Main Agent
  // cannot disagree about where the owner's data lives.
  // 由唯一的解析器决定所有持久化路径，使 Daemon 与 Main Agent 不会对
  // "所有者数据在哪里" 产生分歧。
  // There is no configured working directory. The internal base is an explicit
  // override (option or CLONE_AI_WORKSPACE) or the machine root; it is used for
  // relative paths and verification, not as a write permission.
  // 没有配置的工作目录。内部基准是显式覆盖（选项或 CLONE_AI_WORKSPACE），否则是机器
  // 根目录；它用于相对路径与验证，不是写权限。
  const basePaths = resolveClonePaths({
    ...(options.dataDirectory === undefined ? {} : { dataDirectory: options.dataDirectory }),
  });
  const paths = resolveClonePaths({
    dataDirectory: basePaths.dataDirectory,
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  await prepareCloneHome(paths);
  // One runtime per clone home: the lock is taken before the journal is
  // hydrated, so a second sidecar is refused before it can race transitions,
  // claim the turn ledger or overwrite the endpoint. A dead owner is reclaimed,
  // so a crash does not need a manual cleanup.
  // 每个 clone home 只跑一个运行时：锁在重放 Journal 之前取得，第二个 sidecar 因此在
  // 竞态状态转换、声明回合台账或覆盖端点之前就被拒绝。死掉的属主会被回收，崩溃无需手工清理。
  const instanceLock = await acquireCompanionInstanceLock(paths.dataDirectory);
  try {
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
  // In development the client files are read once, so editing the UI under a
  // running daemon does not reach the window: the served script can be missing a
  // function the source already calls, and the first click dies with "Can't find
  // variable". Re-reading them on each request costs a few file reads and makes
  // the window show the source that is actually on disk.
  // 开发模式下客户端文件只读取一次，因此在守护运行期间改界面不会到达窗口：被提供的脚本可能
  // 缺少源码已经在调用的函数，第一次点击就以 "Can't find variable" 失败。每次请求重读只花
  // 几次文件读取，却能让窗口显示磁盘上真正的源码。
  const reloadClientAssets = process.env.CLONE_AI_DEV_MODE === "1";
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
  const clientAssets = { client, clientCss, componentCss, clientJs, componentJs, auditCss, auditJs, memoryCss, memoryJs };
  const clientPathFor = {
    client: clientPath,
    clientCss: join(clientDirectory, "style.css"),
    componentCss: join(clientDirectory, "components.css"),
    clientJs: join(clientDirectory, "app.js"),
    componentJs: join(clientDirectory, "components.js"),
    auditCss: join(clientDirectory, "audit.css"),
    auditJs: join(clientDirectory, "audit.js"),
    memoryCss: join(clientDirectory, "memory.css"),
    memoryJs: join(clientDirectory, "memory.js"),
  } as const;
  const serveAsset = async (key: keyof typeof clientAssets): Promise<string> => (
    reloadClientAssets ? await readFile(clientPathFor[key], "utf8").catch(() => clientAssets[key]) : clientAssets[key]
  );
  const token = options.token?.trim() || issueCompanionToken();
  if (serverMode && token.length < 32) {
    throw new Error("Server deployment requires CLONE_AI_COMPANION_TOKEN with at least 32 characters.");
  }
  await persistCompanionToken(paths.dataDirectory, token);
  const clientHtml = injectCompanionToken(client, token);
  const startedAt = Date.now();
  const schedules = new ScheduleStore(paths.schedulesFile);
  const sessions = new SessionStore(paths.sessionsFile);
  const providers = await loadProviderRegistry(dataDirectory);
  const agentSettings = new WorkerSettingsStore(paths.legacyAgentsFile, providers);
  const agents = [{ id: "native", title: "Native worker", command: "in-process", installed: true, installable: false }];
  // One Runtime assembly, and therefore one journal, shared by every module in
  // this process. Separate stores over the same file each keep their own
  // sequence counter and their own cached view, which is how duplicate
  // sequences and stale reads appear.
  // 本进程内所有模块共用一个 Runtime 组装，因而共用一本 Journal。针对同一文件建多个
  // Store，每个都持有自己的 sequence 计数器和缓存视图——重复 sequence 与陈旧读数正是这么来的。
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  const journal = assembly.journal;
  /**
   * Close aborts background waits that have no acquisition deadline: the
   * maintenance pass's extraction lock, the governance lock its sweeps take,
   * and the post-run extraction a scheduled run queues. The controller never
   * cancels work that already holds a lock or a run that is executing; it ends
   * only the waits, so shutdown cannot be held until the shell SIGKILLs the
   * process.
   * 关停会中止没有获取截止时间的后台等待：维护轮的提炼锁、其扫描所取的治理锁，以及定时任务
   * 运行后排队的提炼。该控制器绝不取消已经持有锁的工作或正在执行的 Run；它只结束等待，使关停
   * 不会被拖到外壳 SIGKILL 进程。
   */
  const shutdown = new AbortController();
  const memoryGovernance = new MemoryGovernance({
    journal,
    store: new MdMemoryStore({ dataDirectory }),
    signal: shutdown.signal,
  });
  const improvement = new ImprovementService({ journal, governance: memoryGovernance, pipeline: assembly.memory });
  const config = new CloneConfigStore(paths);
  const whatsappSetup = new WhatsAppSetupService(dataDirectory, options.publicBaseUrl);
  const proxySecret = options.proxySecret?.trim();
  if (serverMode && (proxySecret === undefined || proxySecret.length < 32)) {
    throw new Error("Server deployment requires a proxy secret with at least 32 characters.");
  }
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
      }, await agentSettings.get(), { workspacePath, memorySignal: shutdown.signal });
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
   * into a reviewable candidate when a miner is configured (otherwise the job
   * is recorded as a zero-candidate extraction). Both are what makes the twin
   * appear to notice things and learn, so both belong on a timer rather than on
   * a user action.
   *
   * 让分身自身状态持续推进的后台循环。
   *
   * 之前有两件事只在启动时发生、或根本不发生：扫描机会，以及在配置了提炼器时把已完成 Run 的
   * `memory.candidate.requested` 转成可审核的候选（未配置时则记录为零候选提炼）。这两件事
   * 正是“分身会注意到事情、会学习”的来源，因此它们属于定时器，而不是属于某个用户动作。
   */
  const runMaintenance = async (): Promise<void> => {
    if (shutdown.signal.aborted) return;
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
    // The scan comes before every lock-taking step. It is the one piece of
    // maintenance the owner sees on first paint (the opportunity and attention
    // strips), and both the extraction lock and the governance lock have no
    // acquisition deadline: putting it after either would let another process
    // keep the cards empty for as long as it holds the lock.
    // 机会扫描放在每一个会取锁的步骤之前。它是所有者首屏就能看到的维护产出（机会条与注意力
    // 条），而提炼锁与治理锁都没有获取截止时间：把它放在任一锁之后，都会让别的进程持锁期间
    // 卡片一直为空。
    await opportunityService.scanAndRecord().catch(() => undefined);
    // One-time: candidates the retired deterministic miner wrote are copies of
    // their task objectives, not memories. Rejecting them once, with a reason,
    // stops the review list from asking about work orders forever. A failure is
    // retried on the next tick rather than dropping the cleanup.
    // 一次性：已退役的确定性提炼器写下的候选是任务目标的复制，不是记忆。带理由拒绝一次，
    // 使审核列表不再永远询问工作单。失败会在下一次 tick 重试，而不是放弃清理。
    if (!restatedCandidatesRetired) {
      try {
        await memoryGovernance.rejectRestatedCandidates();
        restatedCandidatesRetired = true;
      } catch (error: unknown) {
        if (shutdown.signal.aborted) return;
        logJson("error", "Legacy memory-candidate cleanup failed; it will retry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Expired memories are already hidden from recall; archiving them makes the
    // state honest and journals the reason. 过期记忆召回时已被隐藏；归档让状态与事实一致并记录原因。
    // The improvement sweep runs before the idle sweep so a memory the loop is
    // about to judge is not archived for idleness first.
    // 改进扫描先于闲置扫描，使环路即将评判的记忆不会先因闲置被归档。
    if (ImprovementService.enabled()) {
      await improvement.sweep().catch((error: unknown) => {
        if (shutdown.signal.aborted) return;
        logJson("error", "Improvement sweep failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }
    await memoryGovernance.archiveIdle().catch((error: unknown) => {
      if (shutdown.signal.aborted) return;
      logJson("error", "Memory idle sweep failed", { error: error instanceof Error ? error.message : String(error) });
    });
    await memoryGovernance.expireDue().catch((error: unknown) => {
      if (shutdown.signal.aborted) return;
      logJson("error", "Memory expiry sweep failed", { error: error instanceof Error ? error.message : String(error) });
    });
    await badCaseLog.appendNew(await journal.list()).catch(() => undefined);
    if (shutdown.signal.aborted) return;
    // Drain every pending job: a completed run must not wait for the next tick
    // to become something the owner can review, and a job with no miner must
    // record its zero-candidate extraction so the loop does not retry it
    // forever. This is the only step whose wait can be unbounded, so it runs
    // last; the signal ends the wait on shutdown and the job stays pending.
    // 排空所有待处理任务：已完成的 Run 不应等到下一次 tick 才变成所有者可审核的东西；
    // 没有提炼器的任务必须记录零候选提炼，使循环不会永远重试它。这是唯一可能无限等待的
    // 步骤，因此放在最后；关停信号结束等待，任务保持待处理。
    try {
      await assembly.memory.rebuild();
      for (let drained = 0; drained < 50 && assembly.memory.hasPending(); drained += 1) {
        if (shutdown.signal.aborted) return;
        await assembly.memory.processNext(undefined, { signal: shutdown.signal });
      }
    } catch (error: unknown) {
      if (shutdown.signal.aborted) return;
      logJson("error", "Memory extraction failed; the job remains pending", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (assembly.conversationMemory !== undefined) {
      await assembly.conversationMemory.processDue({ signal: shutdown.signal }).catch((error: unknown) => {
        if (shutdown.signal.aborted) return;
        logJson("error", "Conversation memory extraction failed; the batch remains pending", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };
  let maintenanceInFlight: Promise<void> | undefined;
  let restatedCandidatesRetired = false;
  const startMaintenance = (): Promise<void> => {
    if (maintenanceInFlight !== undefined) return maintenanceInFlight;
    maintenanceInFlight = runMaintenance().finally(() => { maintenanceInFlight = undefined; });
    return maintenanceInFlight;
  };
  const noteMaintenanceFailure = (error: unknown): void => logJson("error", "Maintenance failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  // The first pass runs after the endpoint is published, not before the server
  // listens: it takes the cross-process memory-extraction lock, whose
  // acquisition has no deadline. Waiting for it here made one held lock — a
  // second sidecar mid-extraction, or a miner waiting on a model — look like an
  // app that never finishes starting: the daemon was alive but never listened,
  // and the window stayed on 正在连接.
  // 首轮维护在端点发布之后运行，而不是在服务器监听之前：它会获取跨进程的记忆提炼锁，而该锁
  // 没有获取截止时间。在这里等待它，使一次持锁——另一个 sidecar 正在提炼，或提炼器正等模型——
  // 表现得像永远启动不完：Daemon 活着但从不监听，窗口停在"正在连接"。
  const maintenance = setInterval(() => {
    void startMaintenance().catch(noteMaintenanceFailure);
  }, 5 * 60_000);
  maintenance.unref();

  const bound = { port };
  const server = createServer(async (request, response) => {
    try {
      // In development each request re-reads the asset it serves, so an edit
      // under a running daemon cannot leave the window on a stale script that
      // calls functions the served copy no longer defines.
      // 开发模式下每个请求重读它要提供的资源，因此在守护运行期间的编辑不会让窗口停留在
      // 调用了旧函数定义的陈旧脚本上。
      const fresh = reloadClientAssets && request.url !== undefined
        ? {
            ...(request.url === "/app.js" ? { clientJs: await serveAsset("clientJs") } : {}),
            ...(request.url === "/components.js" ? { componentJs: await serveAsset("componentJs") } : {}),
            ...(request.url === "/audit.js" ? { auditJs: await serveAsset("auditJs") } : {}),
            ...(request.url === "/memory.js" ? { memoryJs: await serveAsset("memoryJs") } : {}),
            ...(request.url === "/" ? { client: injectCompanionToken(await serveAsset("client"), token) } : {}),
            ...(request.url === "/style.css" ? { clientCss: await serveAsset("clientCss") } : {}),
            ...(request.url === "/components.css" ? { componentCss: await serveAsset("componentCss") } : {}),
            ...(request.url === "/audit.css" ? { auditCss: await serveAsset("auditCss") } : {}),
            ...(request.url === "/memory.css" ? { memoryCss: await serveAsset("memoryCss") } : {}),
          }
        : {};
      await handleRequest(request, response, {
        host,
        listenPort: bound.port,
        allowRemoteHost: serverMode,
        proxySecret,
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
        ...fresh,
        schedules,
        sessions,
        agentSettings,
        agents: [
          { id: "native", title: "Native worker", command: "in-process", installed: true, installable: false },
        ],
        memoryGovernance,
        improvement,
        reportRunner,
        opportunityService,
        whatsappSetup,
        badCaseLog,
        journal,
        runtime: queueRuntime,
        runQueue,
        authority: assembly.authority,
        refreshCapacityPin: assembly.refreshCapacityPin,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "The local runtime encountered an unexpected error.";
      sendJson(response, error instanceof RequestBodyTooLargeError ? 413 : 500, { error: message });
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
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const url = `http://${localHost === "::1" ? "[::1]" : localHost}:${address.port}`;
  const endpointStartedAt = new Date().toISOString();
  await persistCompanionEndpoint(dataDirectory, url, endpointStartedAt);
  // The window can connect now. Periodic work settles the twin's state and may
  // take a while — or wait on a lock — so it runs behind the published endpoint
  // instead of in front of it.
  // 窗口现在可以连接了。周期性工作会收敛分身状态，可能耗时、也可能等锁；因此它在已发布的
  // 端点之后运行，而不是挡在它前面。
  void startMaintenance().catch(noteMaintenanceFailure);
  void whatsappSetup.initialize().catch((error: unknown) => {
    logJson("error", "WhatsApp bridge initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  bound.port = address.port;
  scheduler.start();
  return {
    url,
    token,
    // Shutdown waits for the queue: a consumer still writing into the data
    // directory after close() resolves is a corrupted journal.
    // 关闭要等待队列：close() 返回后仍在往数据目录写入的消费者，意味着损坏的 Journal。
    close: async () => {
      try {
      clearInterval(maintenance);
      if (reportTimer !== undefined) clearInterval(reportTimer);
      // A pass waiting for the extraction lock must not hold shutdown: abort
      // the wait first, then let the pass unwind before the stores close.
      // 等待提炼锁的维护轮不得拖住关停：先中止等待，让维护轮在存储关闭前解除。
      shutdown.abort();
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      // An open SSE stream keeps `server.close` pending until the client goes
      // away, so a desktop window left open would block shutdown forever.
      // Destroy idle and active sockets once the queue has stopped.
      // 打开的 SSE 流会让 `server.close` 一直挂起，直到客户端断开，因此一个开着的桌面窗口会
      // 永远阻塞关停。队列停止后销毁空闲与活动连接。
      await scheduler.stop();
      await runQueue.stop();
      await Promise.allSettled([maintenanceInFlight, reportInFlight]);
      server.closeAllConnections?.();
      await serverClosed;
      await clearCompanionEndpointIfOwned(dataDirectory, endpointStartedAt);
      await memoryGovernance.close();
      // Release the journal last: the queue and governance above may still be
      // finishing writes, and closing the database under them would lose those
      // records or fail the shutdown.
      // 最后释放 Journal：上面的队列与记忆治理可能仍在收尾写入，在它们下面关掉数据库
      // 会丢记录或让关停失败。
      assembly.close();
      } finally {
        // Release the home last, after the endpoint and the journal. A successor
        // that starts after this point must see a fully closed runtime.
        // 最后释放 home，在端点与 Journal 之后。此后启动的继任者必须看到一个完全关闭的运行时。
        await instanceLock.release();
      }
    },
  };
  } catch (error: unknown) {
    await instanceLock.release();
    throw error;
  }
}

/**
 * The config as the settings API may show it: the endpoint and the model are
 * public, the credential is not. Every response that carries a config goes
 * through here, so no route can leak the key by forgetting.
 * 设置接口可展示的配置：端点与模型是公开的，凭据不是。每个携带配置的响应都经过这里，
 * 因此没有哪条路由会因为忘记而泄漏密钥。
 */
function publicConfig(config: Awaited<ReturnType<CloneConfigStore["get"]>>): Record<string, unknown> {
  const { mainAgentApiKey, ...rest } = config;
  return { ...rest, ...(mainAgentApiKey === undefined ? {} : { hasMainAgentApiKey: true }) };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    host: string;
    listenPort: number;
    allowRemoteHost: boolean;
    proxySecret?: string;
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
    agents: Array<{ id: string; title: string; command: string; installed: boolean; installable: boolean }>;
    memoryGovernance: MemoryGovernance;
    improvement: ImprovementService;
    reportRunner?: DailyReportRunner;
    opportunityService: OpportunityService;
    whatsappSetup: WhatsAppSetupService;
    badCaseLog: BadCaseLog;
    journal: JournalStore;
    runtime: CloneRuntime;
    runQueue: RunQueueConsumer;
    authority: StandingPolicyStore;
    /** Re-reads the owner's pinned worker concurrency after a settings change. 设置变更后重新读取所有者固定的 Worker 并发上限。 */
    refreshCapacityPin: () => Promise<void>;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${context.host === "::1" ? "[::1]" : context.host}`);
  const method = request.method ?? "GET";
  if (context.proxySecret !== undefined
    && headerValue(request.headers["x-clone-proxy-secret"]) !== context.proxySecret) {
    sendJson(response, 403, { error: "A trusted reverse proxy is required." });
    return;
  }
  const authorized = authorizeCompanionRequest({
    method,
    pathname: url.pathname,
    hostHeader: headerValue(request.headers.host),
    originHeader: headerValue(request.headers.origin),
    authorization: headerValue(request.headers["x-clone-ai-token"]) !== undefined
      ? `Bearer ${headerValue(request.headers["x-clone-ai-token"])}`
      : headerValue(request.headers.authorization),
    token: context.token,
    listenPort: context.listenPort,
    allowRemoteHost: context.allowRemoteHost,
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
    // The API key is write-only: the settings page learns that one exists, never
    // its value, so a screenshot or a log of this endpoint cannot leak it.
    // 密钥是只写的：设置页只知道存在与否，永远拿不到值，因此这个接口的截图或日志都不会泄漏它。
    sendJson(response, 200, {
      config: publicConfig(config),
      ui: { locale: config.locale, strings: uiStrings(config.locale) },
      paths: {
        dataDirectory: context.paths.dataDirectory,
        configFile: context.paths.configFile,
        providersFile: context.paths.providersFile,
        memoryDirectory: join(context.dataDirectory, "memory"),
        outcomesDirectory: context.paths.outcomesDirectory,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/mobile/whatsapp") {
    sendJson(response, 200, { status: await context.whatsappSetup.status() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mobile/whatsapp/binding") {
    const body = await readJsonBody(request);
    const input: Record<string, string> = {};
    for (const key of ["accessToken", "phoneNumberId", "verifyToken", "appSecret", "allowedNumbers", "graphVersion"]) {
      if (typeof body[key] === "string") input[key] = body[key];
    }
    try {
      sendJson(response, 200, { status: await context.whatsappSetup.saveBinding(input) });
    } catch (error: unknown) {
      if (error instanceof WhatsAppBindingInputError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mobile/whatsapp/bridge/start") {
    await context.whatsappSetup.startBridge();
    sendJson(response, 200, { status: await context.whatsappSetup.status() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mobile/whatsapp/bridge/stop") {
    await context.whatsappSetup.stopBridge();
    sendJson(response, 200, { status: await context.whatsappSetup.status() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mobile/whatsapp/tunnel/start") {
    sendJson(response, 200, { status: await context.whatsappSetup.startTunnel() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mobile/whatsapp/tunnel/stop") {
    sendJson(response, 200, { status: await context.whatsappSetup.stopTunnel() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mobile/whatsapp/tunnel/install") {
    const body = await readJsonBody(request);
    if (body.acknowledgeInstall !== true) {
      sendJson(response, 400, { error: "安装 cloudflared 需要明确确认。" });
      return;
    }
    const result = await context.whatsappSetup.installCloudflared();
    sendJson(response, 200, { ...result, status: await context.whatsappSetup.status() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mobile/whatsapp/verify") {
    sendJson(response, 200, {
      profile: await context.whatsappSetup.verifyCloudCredentials(),
      status: await context.whatsappSetup.status(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/options") {
    const current = await context.config.get();
    const piModels = await listMainAgentModels().catch(() => []);
    sendJson(response, 200, {
      mainAgentModel: current.mainAgentModel,
      mainAgentEffort: current.mainAgentEffort,
      effortLevels: EFFORT_LEVELS,
      models: piModels,
    });
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    // The setting is gone, not hidden. An old client that still sends it gets
    // an explicit refusal instead of a silent no-op.
    // 这个设置已被移除，而不是被隐藏。仍然发送它的旧客户端会得到明确拒绝，而不是静默无效。
    if ("workspacePath" in body) {
      sendJson(response, 400, { error: "The working-directory setting was removed; a step names its own write targets." });
      return;
    }
    const update: { locale?: "zh-CN" | "en"; mainAgentModel?: string; mainAgentEffort?: string | undefined; mainAgentBaseUrl?: string; mainAgentApiKey?: string; maxConcurrentWorkers?: number; maxConcurrentMainAgents?: number } = {};
    if (body.locale === "zh-CN" || body.locale === "en") update.locale = body.locale;
    if ("mainAgentModel" in body) {
      if (typeof body.mainAgentModel !== "string") {
        sendJson(response, 400, { error: "mainAgentModel must be a string (empty clears it)." });
        return;
      }
      update.mainAgentModel = body.mainAgentModel.trim();
    }
    if ("mainAgentBaseUrl" in body) {
      if (typeof body.mainAgentBaseUrl !== "string") {
        sendJson(response, 400, { error: "mainAgentBaseUrl must be a string (empty clears it)." });
        return;
      }
      const value = body.mainAgentBaseUrl.trim();
      // A typo in the scheme would fail every turn silently; refuse it here,
      // where the owner can still see the field they typed.
      // 协议拼错会让每个回合静默失败；在这里拒绝，所有者还能看到自己输入的字段。
      if (value.length > 0 && !/^https?:\/\/[^\s]+$/.test(value)) {
        sendJson(response, 400, { error: "mainAgentBaseUrl must start with http:// or https://." });
        return;
      }
      update.mainAgentBaseUrl = value;
    }
    if ("mainAgentApiKey" in body) {
      if (typeof body.mainAgentApiKey !== "string") {
        sendJson(response, 400, { error: "mainAgentApiKey must be a string (empty clears it)." });
        return;
      }
      update.mainAgentApiKey = body.mainAgentApiKey.trim();
    }
    if ("mainAgentEffort" in body) {
      if (body.mainAgentEffort === "" || body.mainAgentEffort === null) update.mainAgentEffort = undefined;
      else {
        const effort = normalizeEffort(body.mainAgentEffort);
        if (effort === undefined) {
          sendJson(response, 400, { error: `mainAgentEffort must be a name of at most ${MAX_EFFORT_LENGTH} characters (empty clears it).` });
          return;
        }
        update.mainAgentEffort = effort;
      }
    }
    if ("maxConcurrentWorkers" in body) {
      const value = body.maxConcurrentWorkers;
      if (value === 0 || value === null) update.maxConcurrentWorkers = 0;
      else if (typeof value === "number" && Number.isFinite(value) && value > 0) update.maxConcurrentWorkers = Math.trunc(value);
      else {
        sendJson(response, 400, { error: "maxConcurrentWorkers must be a non-negative number (0 means auto)." });
        return;
      }
    }
    if ("maxConcurrentMainAgents" in body) {
      const value = body.maxConcurrentMainAgents;
      if (value === 0 || value === null) update.maxConcurrentMainAgents = 0;
      else if (typeof value === "number" && Number.isFinite(value) && value > 0) update.maxConcurrentMainAgents = Math.trunc(value);
      else {
        sendJson(response, 400, { error: "maxConcurrentMainAgents must be a non-negative number (0 means auto)." });
        return;
      }
    }
    if (Object.keys(update).length === 0) {
      sendJson(response, 400, { error: "Provide a locale, mainAgentModel, mainAgentEffort, mainAgentBaseUrl, mainAgentApiKey, maxConcurrentWorkers, or maxConcurrentMainAgents to change." });
      return;
    }
    const config = await context.config.update(update);
    // The pin is re-read on every dispatch, so this refresh is belt-and-braces;
    // it also makes an auto-mode change visible immediately in capacity reads.
    // 每次派发都会重新读取固定值，因此这里刷新只是双保险；它也自动模式的变化立即体现在
    // 容量读取中。
    await context.refreshCapacityPin().catch(() => undefined);
    sendJson(response, 200, { config: publicConfig(config) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings/providers") {
    // One in-process provider; the CLI recipe list no longer exists.
    // 只有进程内的 Provider；CLI 配方列表已不存在。
    sendJson(response, 200, { providers: [], userDefined: [] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/gateways") {
    // This is a loopback-only capability probe. It intentionally returns no
    // credential material and does not write Magpie's own configuration.
    // 这只是回环能力探测：刻意不返回任何凭据，也不改写 Magpie 自己的配置。
    const gateway = await inspectMagpieGateway();
    const piModels = gateway.running
      ? new Set((await listMainAgentModels("magpie").catch(() => [])).map((model) => model.id))
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
      sendJson(response, 200, { config: publicConfig(await context.config.update({ mainAgentModel: "" })) });
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
    const reference = mainAgentModelReference(modelId);
    try {
      // The gateway's own catalog is the capability check: writing a model the
      // endpoint does not serve would turn a settings success into a later chat failure.
      // 网关自己的目录就是能力校验：写入端点不提供的模型，会把设置成功变成之后的对话失败。
      if (!(await listMainAgentModelIds("magpie")).includes(modelId)) {
        sendJson(response, 409, {
          error: `Magpie is running, but it does not expose "${modelId}". Sync the model in Magpie, then retry.`,
        });
        return;
      }
      // Applying a gateway model also pins the endpoint: the model id alone was
      // not enough for an app whose environment is empty.
      // 应用网关模型时同时固定端点：对一台环境为空的 App，只有模型 id 是不够的。
      sendJson(response, 200, {
        config: publicConfig(await context.config.update({
          mainAgentModel: reference,
          mainAgentBaseUrl: gateway.endpoint,
        })),
        gateway: await inspectMagpieGateway(),
      });
    } catch (error: unknown) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Could not validate the gateway model catalog.",
      });
    }
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings/providers") {
    sendJson(response, 409, { error: "Worker CLI providers were removed; the native worker runs in-process." });
    return;
  }

  const providerMatch = url.pathname.match(/^\/api\/settings\/providers\/([^/]+)$/);
  if (request.method === "DELETE" && providerMatch?.[1] !== undefined) {
    sendJson(response, 409, { error: "Worker CLI providers were removed; there is nothing to delete." });
    return;
  }

  if (url.pathname === "/api/audit/selfcheck" || url.pathname.startsWith("/api/audit/selfcheck/")) {
    // The loop is a first-class audit object: list its rounds or run one now.
    // 回路本身是一等审计对象：列出各轮，或立即运行一轮。
    const { runSelfCheckRound, readSelfCheckRounds } = await import("./eval/self-check.ts");
    try {
      if (method === "GET" && url.pathname === "/api/audit/selfcheck") {
        sendJson(response, 200, { rounds: await readSelfCheckRounds(context.dataDirectory) });
        return;
      }
      if (method === "POST" && url.pathname === "/api/audit/selfcheck") {
        const body = await readJsonBody(request).catch(() => ({}) as Record<string, unknown>);
        const round = await runSelfCheckRound({
          dataDirectory: context.dataDirectory,
          journal: context.journal,
          fullTests: (body as Record<string, unknown>).fullTests === true,
        });
        sendJson(response, 200, { round });
        return;
      }
      const one = /^\/api\/audit\/selfcheck\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && one !== null) {
        const round = (await readSelfCheckRounds(context.dataDirectory, 50)).find((candidate) => candidate.id === decodeURIComponent(one[1]!));
        if (round === undefined) sendJson(response, 404, { error: "Unknown self-check round." });
        else sendJson(response, 200, { round });
        return;
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The self-check round failed." });
      return;
    }
  }

  if (url.pathname === "/api/audit/review" || url.pathname === "/api/audit/apply" || url.pathname === "/api/audit/revert") {
    // AI self-review: read the stored proposal, generate a new one, or apply one
    // configuration change. Applying is a single-field write the owner clicked.
    // AI 自我评审：读取已存的提案、生成新的，或应用其中一项配置改动。应用是所有者点击后的单字段写入。
    const { runSelfReview, loadReview } = await import("./audit/self-review.ts");
    const { applyReviewAction, revertReviewAction } = await import("./audit/apply-review.ts");
    try {
      if (url.pathname === "/api/audit/review" && method === "GET") {
        sendJson(response, 200, { review: (await loadReview(context.dataDirectory)) ?? null });
        return;
      }
      if (url.pathname === "/api/audit/review" && method === "POST") {
        sendJson(response, 200, { review: await runSelfReview(context.dataDirectory, context.journal) });
        return;
      }
      const body = await readJsonBody(request);
      const actionId = typeof body.actionId === "string" ? body.actionId : "";
      if (actionId.length === 0) {
        sendJson(response, 400, { error: "actionId is required." });
        return;
      }
      if (url.pathname === "/api/audit/apply" && method === "POST") {
        const applied = await applyReviewAction(context.dataDirectory, context.journal, actionId);
        sendJson(response, 200, { applied, review: await loadReview(context.dataDirectory) });
        return;
      }
      if (url.pathname === "/api/audit/revert" && method === "POST") {
        const reverted = await revertReviewAction(context.dataDirectory, context.journal, actionId);
        sendJson(response, 200, { reverted, review: await loadReview(context.dataDirectory) });
        return;
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The review request failed." });
      return;
    }
  }

  if (url.pathname.startsWith("/api/invocations")) {
    // The invocation ledger is shared across data directories, so an agent that
    // runs with an isolated CLONE_HOME is still visible in the owner's audit.
    // Deletion is a tombstone appended to the shared file, never a rewrite: the
    // file is appended to by several processes at once.
    // 调用账本跨数据目录共享，因此使用隔离 CLONE_HOME 的 Agent 仍会出现在所有者审计中。
    // 删除是追加到共享文件的墓碑，绝不重写文件：多个进程会同时追加它。
    try {
      if (method === "GET" && url.pathname === "/api/invocations") {
        const requested = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
        const result = await searchInvocations({
          dataDirectory: context.dataDirectory,
          limit,
          query: url.searchParams.get("q") ?? "",
          includeDeleted: url.searchParams.get("includeDeleted") === "1",
        });
        sendJson(response, 200, result);
        return;
      }
      const markMatch = /^\/api\/invocations\/(delete|restore)$/.exec(url.pathname);
      if (method === "POST" && markMatch !== null) {
        const body = await readJsonBody(request);
        const ids = Array.isArray(body.ids)
          ? body.ids
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
          : [];
        if (ids.length === 0) {
          sendJson(response, 400, { error: "Choose at least one invocation." });
          return;
        }
        if (ids.length > 1000) {
          sendJson(response, 400, { error: "Too many invocations in one request." });
          return;
        }
        if (ids.some((id) => id.length > MAX_INVOCATION_ID_LENGTH)) {
          sendJson(response, 400, { error: "Invocation ids look invalid." });
          return;
        }
        const changed = await markInvocations({ dataDirectory: context.dataDirectory }, ids, markMatch[1] === "delete");
        sendJson(response, 200, { changed });
        return;
      }
      const match = /^\/api\/invocations\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && match !== null) {
        const record = await readInvocation(decodeURIComponent(match[1]!), { dataDirectory: context.dataDirectory });
        if (record === undefined) sendJson(response, 404, { error: "Unknown invocation." });
        else sendJson(response, 200, { record });
        return;
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid invocation request." });
      return;
    }
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
      if (method === "GET" && url.pathname === "/api/audit/turns") {
        const turnAudit = await import("./audit/turn-audit.ts");
        const requested = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const result = await turnAudit.searchTurnAudits(context.journal, {
          limit: Number.isFinite(requested) ? requested : 100,
          query: url.searchParams.get("q") ?? "",
        });
        sendJson(response, 200, result);
        return;
      }
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

  if (request.method === "POST" && url.pathname === "/api/export") {
    // The owner takes their data out from the desktop. The chosen folder is a
    // parent; a timestamped subfolder keeps a second export from overwriting
    // the first, and the data directory may never be the destination.
    // 所有者从桌面把数据带走。所选文件夹只是父目录；带时间戳的子目录使第二次导出不会覆盖
    // 第一次，且数据目录本身绝不能作为导出目标。
    try {
      const body = await readJsonBody(request);
      const raw = typeof body.destination === "string" ? body.destination.trim() : "";
      if (raw.length === 0) {
        sendJson(response, 400, { error: "Choose a folder for the export." });
        return;
      }
      const expanded = expandHome(raw);
      if (!isAbsolute(expanded)) {
        sendJson(response, 400, { error: "The export destination must be an absolute path." });
        return;
      }
      const parent = resolve(expanded);
      const dataDirectory = resolve(context.dataDirectory);
      if (parent === dataDirectory || parent.startsWith(`${dataDirectory}${sep}`) || dataDirectory.startsWith(`${parent}${sep}`)) {
        sendJson(response, 400, { error: "The export destination must be outside the clone data directory." });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 23).replace(/[-:]/g, "").replace("T", "-").replace(".", "-");
      const destination = join(parent, `clone-ai-export-${stamp}`);
      const manifest = await exportOwnerData({ dataDirectory, destination });
      sendJson(response, 200, { destination, manifest, summary: describeExport(manifest, destination), excludes: EXPORT_EXCLUDES });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The export failed." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tables/export") {
    // A table the owner keeps: the desktop sends the CSV it already shows, and
    // the daemon writes it into the folder the owner picked. The write stays
    // owner-initiated — no agent scope, no approval, no Worker.
    // 所有者要留下的表格：桌面端把它已经显示的 CSV 发来，daemon 写进所有者挑中的文件夹。
    // 写入者是所有者而不是 Agent——不需要作用域、批准或 Worker。
    try {
      const body = await readJsonBody(request);
      const raw = typeof body.destination === "string" ? body.destination.trim() : "";
      const csv = typeof body.csv === "string" ? body.csv : "";
      if (raw.length === 0) {
        sendJson(response, 400, { error: "Choose a folder for the table." });
        return;
      }
      if (csv.trim().length === 0) {
        sendJson(response, 400, { error: "The table has no content to export." });
        return;
      }
      const bytes = Buffer.byteLength(csv, "utf8");
      if (bytes > MAX_TABLE_CSV_BYTES) {
        sendJson(response, 413, { error: `The table is too large to export (${bytes} bytes).` });
        return;
      }
      const expanded = expandHome(raw);
      if (!isAbsolute(expanded)) {
        sendJson(response, 400, { error: "The table destination must be an absolute path." });
        return;
      }
      const parent = resolve(expanded);
      const stats = await stat(parent).catch(() => undefined);
      if (stats === undefined || !stats.isDirectory()) {
        sendJson(response, 400, { error: "The table destination must be an existing folder." });
        return;
      }
      const dataDirectory = resolve(context.dataDirectory);
      if (parent === dataDirectory || parent.startsWith(`${dataDirectory}${sep}`) || dataDirectory.startsWith(`${parent}${sep}`)) {
        sendJson(response, 400, { error: "The table destination must be outside the clone data directory." });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 23).replace(/[-:]/g, "").replace("T", "-").replace(".", "-");
      const name = `clone-ai-table-${stamp}.csv`;
      const target = join(parent, name);
      // "wx" refuses an existing file: a stale export is never overwritten.
      // "wx" 拒绝已存在的文件：旧导出永远不会被覆盖。
      await writeFile(target, csv, { encoding: "utf8", flag: "wx" });
      sendJson(response, 200, { path: target, name, bytes });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The table export failed." });
    }
    return;
  }

  if (url.pathname.startsWith("/api/authority")) {
    // Only the owner's desktop app reaches this (bearer token above). Workers
    // and the Main Agent have no route or tool that edits authority.
    // 只有所有者的桌面 App 能到这里（上面的 bearer token）。Worker 与 Main Agent 没有任何
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
      folders: briefing.folders,
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
    sendJson(response, 200, { providers: [{ id: "native", title: "Native worker", command: "in-process", installed: true, installable: false }] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agents/install-missing") {
    // Nothing to install: the only worker runs in-process.
    // 没有需要安装的东西：唯一的 Worker 在进程内运行。
    sendJson(response, 200, { installed: [], providers: [{ id: "native", title: "Native worker", command: "in-process", installed: true, installable: false }] });
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
  if (request.method === "GET" && url.pathname === "/api/attention") {
    // One list of what needs the owner, composed from the services that own
    // each item. Read-only: acting on an item goes through its service.
    // 一份"需要所有者处理"的列表，由拥有每一项的服务合成。只读：对某项采取行动要走它所属的服务。
    const state = await new PersonalStateStore(context.journal).refresh();
    const sweep = await sweepConnectors({ dataDirectory: context.dataDirectory, workspacePath: context.workspacePath, limitPerConnector: 5 });
    sendJson(response, 200, {
      items: buildAttention({
        commitments: Object.values(state.commitments),
        goals: Object.values(state.goals),
        observations: sweep.observations.map((observation, index) => ({ ...observation, connectorId: sweep.results[index]?.connectorId })),
        candidates: await context.memoryGovernance.pendingCandidates(),
        suggestions: await context.improvement.pending(),
        opportunities: await context.opportunityService.list(),
      }),
    });
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
  if (request.method === "GET" && url.pathname === "/api/improvement") {
    sendJson(response, 200, { enabled: ImprovementService.enabled(), suggestions: await context.improvement.pending(), ...await context.improvement.usage() });
    return;
  }
  const improvementDecision = url.pathname.match(/^\/api\/improvement\/suggestions\/([^/]+)\/(approve|dismiss)$/);
  if (request.method === "POST" && improvementDecision?.[1] !== undefined && improvementDecision?.[2] !== undefined) {
    const id = decodeURIComponent(improvementDecision[1]);
    try {
      if (improvementDecision[2] === "approve") sendJson(response, 200, await context.improvement.approve(id));
      else {
        await context.improvement.dismiss(id);
        sendJson(response, 200, { dismissed: id });
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The decision could not be recorded." });
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
        versions: await context.memoryGovernance.versions(memory.id),
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
  if (request.method === "DELETE" && governedMatch?.[1] !== undefined) {
    // Deletion is the one irreversible memory action. The governance layer
    // refuses an active memory, so the owner must archive first; this route
    // maps that refusal to 409 rather than a generic 400.
    // 删除是唯一不可逆的记忆动作。治理层拒绝删除使用中的记忆，所有者必须先归档；本路由把
    // 这个拒绝映射成 409，而不是笼统的 400。
    const id = decodeURIComponent(governedMatch[1]);
    try {
      const removed = await context.memoryGovernance.remove(id);
      sendJson(response, 200, { deleted: { id: removed.id, summary: removed.summary } });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "The memory could not be deleted.";
      const status = /does not exist/.test(message) ? 404 : /Archive this memory before deleting/.test(message) ? 409 : 400;
      sendJson(response, status, { error: message });
    }
    return;
  }
  if (request.method === "PATCH" && governedMatch?.[1] !== undefined) {
    const id = decodeURIComponent(governedMatch[1]);
    const body = await readJsonBody(request);
    if (body.undo === true) {
      // An undo is its own decision, not a field edit: it restores the whole
      // previous version, so a body that also carries fields would be two
      // contradictory instructions in one request.
      // 撤销是独立的决定，不是字段编辑：它恢复整个上一版本，因此同时携带字段的请求体就是一条
      // 请求里两条互相矛盾的指令。
      if (Object.keys(body).some((key) => key !== "undo")) {
        sendJson(response, 400, { error: "An undo restores the previous version whole; send only { undo: true }." });
        return;
      }
      try {
        const { memory, restored } = await context.memoryGovernance.undo(id);
        sendJson(response, 200, { memory, undo: { restoredVersion: restored.id, recordedAt: restored.recordedAt } });
      } catch (error: unknown) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "The memory could not be restored." });
      }
      return;
    }
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
  if (request.method === "POST" && url.pathname === "/api/main-agent/route") {
    const body = await readJsonBody(request);
    const text = normalizeMainAgentRequestText(body.text);
    const turnId = typeof body.turnId === "string" && body.turnId.trim().length > 0
      ? body.turnId.trim()
      : randomUUID();
    let routeContext: RouteContext | undefined;
    if (body.context !== undefined) {
      const record = asRecord(body.context);
      const kind = record.kind;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if ((kind !== "task" && kind !== "conversation") || id.length === 0 || id.length > 200) {
        sendJson(response, 400, { error: "context must be {kind: \"task\" or \"conversation\", id}." });
        return;
      }
      routeContext = { kind, id };
    }
    // Routing is a decision, not a turn: it takes no Main Agent lock, runs no
    // tool, and journals its reason before the turn starts.
    // 路由是一个决定，不是一个回合：不取 Main Agent 锁、不运行工具，并在回合开始前写入理由。
    const route = await routeConversation({
      dataDirectory: context.dataDirectory,
      text,
      turnId,
      ...(routeContext === undefined ? {} : { context: routeContext }),
    });
    sendJson(response, 200, route);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/main-agent/stream") {
    const body = await readJsonBody(request);
    const overrides = parseTurnModelAndEffort(body);
    if (!overrides.ok) {
      sendJson(response, 400, { error: overrides.error });
      return;
    }
    const conversation = parseConversationId(body.conversationId);
    if (!conversation.ok) {
      sendJson(response, 400, { error: conversation.error });
      return;
    }
    const attachments = parseAttachments(body.attachments);
    if (!attachments.ok) {
      sendJson(response, 400, { error: attachments.error });
      return;
    }
    const text = normalizeMainAgentRequestText(body.text);
    const turnId = typeof body.turnId === "string" && body.turnId.trim().length > 0
      ? body.turnId.trim()
      : randomUUID();
    const callerKind = typeof request.headers["x-clone-caller"] === "string" ? request.headers["x-clone-caller"] : undefined;
    const callerSession = typeof request.headers["x-clone-caller-session"] === "string" ? request.headers["x-clone-caller-session"] : undefined;
    // A request that names no caller is the owner talking through the desktop
    // app, not an anonymous client. Recording "unknown" made every owner turn
    // in the audit unreadable.
    // 未声明调用方的请求就是所有者通过桌面 App 在说话，而不是匿名客户端。记录成 "unknown" 会让
    // 审计里每一次所有者回合都读不出是谁。
    const invocation = {
      surface: callerKind === "whatsapp" ? "mobile" as const : "desktop" as const,
      caller: {
        kind: callerKind ?? "desktop",
        ...(callerSession === undefined ? {} : { sessionId: callerSession }),
      },
      // The running workspace, not the daemon's cwd. The prompt, the briefing
      // and the invocation ledger all belong to the workspace the owner chose.
      // 运行中的工作区，而不是守护进程的 cwd。Prompt、简报与调用台账都属于所有者选择的工作区。
      workspacePath: context.workspacePath,
    };
    if (text.length === 0 && attachments.images.length === 0 && attachments.documents.length === 0 && attachments.binaryDocuments.length === 0) {
      sendJson(response, 400, { error: "Please enter a request before sending." });
      return;
    }
    // A hidden conversation does not accept new turns until it is restored:
    // the owner removed it from the sidebar, and a send from a stale tab must
    // not revive it silently.
    // 隐藏的对话在恢复前不接受新回合：所有者已把它从侧栏移除，陈旧标签页的发送不得悄悄复活它。
    if (await context.sessions.isConversationDeleted(conversation.id)) {
      sendJson(response, 409, { error: "This conversation was hidden. Restore it before sending." });
      return;
    }
    const reservation = turnKey(context.dataDirectory, turnId);
    if (inFlightTurns.has(reservation)) {
      sendJson(response, 409, { error: "This turn is already running." });
      return;
    }
    const resolvedAttachments = await resolveAttachmentDocuments(attachments);
    if (!resolvedAttachments.ok) {
      sendJson(response, 400, { error: resolvedAttachments.error });
      return;
    }
    const documents = resolvedAttachments.documents;
    // Delay the SSE headers until the Main Agent lock is held. A busy
    // conversation must remain a readable 409, not an already-open stream. A
    // turn waiting for a capacity slot is not a collision: it waits for another
    // task to finish and may still start.
    // 等到拿到 Main Agent 锁再发 SSE 头。对话正忙时必须仍是可读的 409，而不是已经打开的流。
    // 等待容量槽位的回合不是碰撞：它在等另一个任务结束，仍可能开始。
    let streamOpen = false;
    // A client that goes away must not leave the model running. The abort is
    // passed to the turn, which cancels the stream and every in-flight tool.
    // 客户端断开后不能让模型继续跑。这个 abort 会传给回合，取消流与所有在途工具。
    const abortController = new AbortController();
    const abortOnClose = (): void => {
      if (!response.writableEnded) abortController.abort(new Error("The client disconnected."));
    };
    response.on("close", abortOnClose);
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
      if (response.writableEnded || response.destroyed) return;
      ensureStream();
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Waiting for a capacity slot is visible: the client gets a queued event
    // (which also opens the SSE stream) and keeps resetting its stall timer.
    // 等待容量槽位是可见的：客户端收到 queued 事件（它也打开 SSE 流），并持续重置停滞计时器。
    let lastQueuedAt = 0;
    inFlightTurns.add(reservation);
    try {
      const result = await runRecordedMainAgentTurn(context.dataDirectory, text, turnId, {
        conversationId: conversation.id,
        onDelta: (delta) => send("delta", { delta }),
        onQueued: (info) => {
          const now = Date.now();
          if (now - lastQueuedAt < 2_000) return;
          lastQueuedAt = now;
          send("queued", info);
        },
        ...(attachments.images.length === 0 ? {} : { images: attachments.images }),
        ...(documents.length === 0 ? {} : { documents }),
        ...(overrides.model === undefined ? {} : { model: overrides.model }),
        ...(overrides.effort === undefined ? {} : { effort: overrides.effort }),
        ...invocation,
        signal: abortController.signal,
        onToolEvent: (event) => send("tool", event),
      });
      send("done", {
        ...result,
        ...(resolvedAttachments.reports.length === 0 ? {} : { attachmentReports: resolvedAttachments.reports }),
      });
    } catch (error: unknown) {
      if (!streamOpen) {
        const busy = error instanceof MainAgentBusyError;
        const capacity = error instanceof MainAgentCapacityError;
        sendJson(response, busy ? 409 : capacity ? 503 : 500, {
          error: error instanceof Error ? error.message : "The Main Agent failed.",
        });
        return;
      }
      const message = error instanceof Error ? error.message : "The Main Agent failed.";
      const display = describeFailureForOwner(message);
      send("failed", {
        error: message,
        errorSummary: display.summary,
        errorGuidance: display.guidance,
      });
    } finally {
      inFlightTurns.delete(reservation);
      response.off("close", abortOnClose);
      if (streamOpen) response.end();
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/main-agent/query") {
    const body = await readJsonBody(request);
    const overrides = parseTurnModelAndEffort(body);
    if (!overrides.ok) {
      sendJson(response, 400, { error: overrides.error });
      return;
    }
    const conversation = parseConversationId(body.conversationId);
    if (!conversation.ok) {
      sendJson(response, 400, { error: conversation.error });
      return;
    }
    const attachments = parseAttachments(body.attachments);
    if (!attachments.ok) {
      sendJson(response, 400, { error: attachments.error });
      return;
    }
    const text = normalizeMainAgentRequestText(body.text);
    const turnId = typeof body.turnId === "string" && body.turnId.trim().length > 0
      ? body.turnId.trim()
      : randomUUID();
    const callerKind = typeof request.headers["x-clone-caller"] === "string" ? request.headers["x-clone-caller"] : undefined;
    const callerSession = typeof request.headers["x-clone-caller-session"] === "string" ? request.headers["x-clone-caller-session"] : undefined;
    // A request that names no caller is the owner talking through the desktop
    // app, not an anonymous client. Recording "unknown" made every owner turn
    // in the audit unreadable.
    // 未声明调用方的请求就是所有者通过桌面 App 在说话，而不是匿名客户端。记录成 "unknown" 会让
    // 审计里每一次所有者回合都读不出是谁。
    const invocation = {
      surface: callerKind === "whatsapp" ? "mobile" as const : "desktop" as const,
      caller: {
        kind: callerKind ?? "desktop",
        ...(callerSession === undefined ? {} : { sessionId: callerSession }),
      },
      // The running workspace, not the daemon's cwd. The prompt, the briefing
      // and the invocation ledger all belong to the workspace the owner chose.
      // 运行中的工作区，而不是守护进程的 cwd。Prompt、简报与调用台账都属于所有者选择的工作区。
      workspacePath: context.workspacePath,
    };
    if (text.length === 0 && attachments.images.length === 0 && attachments.documents.length === 0 && attachments.binaryDocuments.length === 0) {
      sendJson(response, 400, { error: "Please enter a request before sending." });
      return;
    }
    if (await context.sessions.isConversationDeleted(conversation.id)) {
      sendJson(response, 409, { error: "This conversation was hidden. Restore it before sending." });
      return;
    }
    const reservation = turnKey(context.dataDirectory, turnId);
    if (inFlightTurns.has(reservation)) {
      sendJson(response, 409, { error: "This turn is already running.", deduplicated: true });
      return;
    }
    // A remote channel can retry after its own timeout. Reusing a terminal
    // turn id returns the original result instead of running the request again.
    // 远程通道可能在自身超时后重试；终态回合复用原 id 时返回原结果，而不是再次执行。
    const existingTurn = (await readMainAgentTurnRecords(context.dataDirectory))
      .find((record) => record.id === turnId && conversationIdOf(record.conversationId) === conversation.id);
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
    const resolvedAttachments = await resolveAttachmentDocuments(attachments);
    if (!resolvedAttachments.ok) {
      sendJson(response, 400, { error: resolvedAttachments.error });
      return;
    }
    const abortController = new AbortController();
    const abortOnClose = (): void => {
      if (!response.writableEnded) abortController.abort(new Error("The client disconnected."));
    };
    response.on("close", abortOnClose);
    inFlightTurns.add(reservation);
    try {
      const result = await runRecordedMainAgentTurn(context.dataDirectory, text, turnId, {
        conversationId: conversation.id,
        ...(attachments.images.length === 0 ? {} : { images: attachments.images }),
        ...(resolvedAttachments.documents.length === 0 ? {} : { documents: resolvedAttachments.documents }),
        ...(overrides.model === undefined ? {} : { model: overrides.model }),
        ...(overrides.effort === undefined ? {} : { effort: overrides.effort }),
        ...invocation,
        signal: abortController.signal,
      });
      sendJson(response, 200, {
        ...result,
        ...(resolvedAttachments.reports.length === 0 ? {} : { attachmentReports: resolvedAttachments.reports }),
      });
    } catch (error: unknown) {
      if (error instanceof MainAgentBusyError) {
        sendJson(response, 409, { error: error.message });
        return;
      }
      if (error instanceof MainAgentCapacityError) {
        sendJson(response, 503, { error: error.message });
        return;
      }
      throw error;
    } finally {
      inFlightTurns.delete(reservation);
      response.off("close", abortOnClose);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/main-agent/prompt-snapshots") {
    // Recent prompt provenance, newest first. The full material lives in the
    // content-addressed file named by `locator`; this listing carries hashes,
    // model, and effort so a change can be spotted without opening it.
    // 最近的提示词溯源，新的在前。完整材料在 `locator` 指向的内容寻址文件里；此列表
    // 只带哈希、模型与强度，不打开文件就能看出变化。
    const requested = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const take = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20;
    const events = await context.journal.list();
    const snapshots = events
      .filter((event) => event.type === "main_agent.prompt_snapshot")
      .slice(-take)
      .reverse()
      .map((event) => ({ sequence: event.sequence, occurredAt: event.occurredAt, ...asRecord(event.payload) }));
    sendJson(response, 200, { snapshots });
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
    const conversation = parseConversationId(body.conversationId);
    if (!conversation.ok) {
      sendJson(response, 400, { error: conversation.error });
      return;
    }
    if (turnId.length === 0 || text.length === 0 || error.length === 0) {
      sendJson(response, 400, { error: "An interruption record needs turnId, text, and error." });
      return;
    }
    const record = await recordMainAgentTurnInterrupted(context.dataDirectory, {
      turnId,
      text,
      error,
      conversationId: conversation.id,
      ...(startedAt === undefined ? {} : { startedAt }),
    });
    // Only a turn that started can be interrupted; a rejected or queued
    // request must not invent a conversation row.
    // 只有开始过的回合才能被中断；被拒绝或仍在排队的请求不得凭空造出对话行。
    sendJson(response, 202, record === undefined
      ? { recorded: false, reason: "This turn never started, so there is nothing to interrupt." }
      : { recorded: true, turn: record });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch?.[1] !== undefined) {
    const runId = decodeURIComponent(sessionMatch[1]);
    if (await isKnownConversation(context.dataDirectory, runId)) {
      if (await context.sessions.isConversationDeleted(runId)) {
        sendJson(response, 404, { error: "This conversation was hidden together with its tasks." });
        return;
      }
      sendJson(response, 200, await buildMainAgentConversation(context.dataDirectory, runId, {
        runIds: await context.sessions.deletedRunIds(),
        conversationIds: new Set((await context.sessions.deletedConversations()).map((entry) => entry.id)),
      }));
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
    if (await isKnownConversation(context.dataDirectory, runId)) {
      // Hiding a conversation hides the tasks it spawned, in one step. 隐藏对话时一并隐藏它派生出的任务。
      const view = await loadRuntimeView(context.dataDirectory);
      const children = [...mainAgentRunConversations(view.events)]
        .filter(([id, conversationId]) => conversationId === runId && view.runs.some((run) => run.id === id))
        .map(([id]) => id);
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
    if (await isKnownConversation(context.dataDirectory, target)) await context.sessions.restoreConversation(target);
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
    sendJson(response, 409, { error: "No worker CLI can be installed; the native worker runs in-process." });
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

  const progressMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/progress$/);
  if (request.method === "GET" && progressMatch?.[1] !== undefined) {
    const runId = decodeURIComponent(progressMatch[1]);
    try {
      sendJson(response, 200, context.runtime.getRunProgress(runId));
    } catch (error: unknown) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : "Unknown run." });
    }
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


  if (request.method === "GET" && url.pathname === "/api/approvals/pending") {
    // What the phone bridge needs to ask about: runs paused on a decision, with
    // enough context to be answerable from a notification.
    // 手机桥需要询问的对象：停在决定上的 Run，附带足以在通知里作答的上下文。
    const view = await loadRuntimeView(context.dataDirectory);
    const pending = view.runs
      .filter((run) => run.status === "waiting_approval" && run.activeStepId !== undefined)
      .map((run) => ({
        runId: run.id,
        stepId: run.activeStepId!,
        title: view.tasks[run.taskId]?.title ?? "未命名任务",
        ...(run.planId === undefined ? {} : { planId: run.planId }),
        updatedAt: run.updatedAt,
      }));
    sendJson(response, 200, { approvals: pending });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/approvals/requested") {
    const body = await readJsonBody(request);
    const runId = typeof body.runId === "string" ? body.runId : "";
    const stepId = typeof body.stepId === "string" ? body.stepId : "";
    if (runId.length === 0 || stepId.length === 0) {
      sendJson(response, 400, { error: "runId and stepId are required." });
      return;
    }
    try {
      // Read the journal rather than the daemon's in-memory projection: the run
      // may have been created by another process a moment ago.
      // 读 Journal 而不是守护进程的内存投影：这个 Run 可能刚刚由另一个进程创建。
      const view = await loadRuntimeView(context.dataDirectory);
      const run = view.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        sendJson(response, 404, { error: "Unknown run." });
        return;
      }
      if (run.status !== "waiting_approval") {
        sendJson(response, 409, { error: "The run is not waiting for approval." });
        return;
      }
      await context.journal.append({
        type: "approval.requested",
        taskId: run.taskId,
        runId,
        payload: {
          stepId,
          channel: "whatsapp",
          ...(typeof body.codeId === "string" ? { codeId: body.codeId } : {}),
          ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {}),
          requestedAt: new Date().toISOString(),
        },
      });
      sendJson(response, 200, { recorded: true });
    } catch (error: unknown) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : "Unknown run." });
    }
    return;
  }

  const approvalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/approve$/);
  if (request.method === "POST" && approvalMatch?.[1] !== undefined) {
    try {
      // An approval issued for one step must not approve another.
      // 针对某一步签发的审批不得批准另一步。
      const body = await readJsonBody(request);
      const expectedStepId = typeof body.stepId === "string" && body.stepId.trim().length > 0 ? body.stepId.trim() : undefined;
      const result = await approveQueryRun(
        context.dataDirectory,
        decodeURIComponent(approvalMatch[1]),
        await context.agentSettings.get(),
        { workspacePath: context.workspacePath },
        expectedStepId,
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
  const turns = await readMainAgentTurnRecords(dataDirectory);
  const deletedRunIds = await sessions.deletedRunIds();
  // A run belongs to the conversation its trigger named. When that conversation
  // is hidden, runs spawned after the delete must hide with it too, not only the
  // snapshot taken at delete time.
  // Run 属于其 Trigger 点名的对话。该对话被隐藏时，删除之后才派发的 Run 也必须一起隐藏，
  // 而不只是删除时刻快照里的那些。
  const derived = mainAgentRunConversations(events);
  const deletedConversationIds = new Set((await sessions.deletedConversations()).map((entry) => entry.id));
  const visibleRuns = runs.filter((run) => !deletedRunIds.has(run.id)
    && !deletedConversationIds.has(derived.get(run.id) ?? ""));
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
  // Every conversation is a row; the Runs its turns dispatched are its
  // children. The row is the thread, so the owner reads one kind at the top
  // level instead of a row that is a conversation or a task depending on
  // whether this request dispatched work. The main conversation stays the
  // fixed control surface and never becomes a row; its tasks are grouped under
  // a non-row header by the UI.
  // 每个对话都是行，回合派发的 Run 是它的子行。顶层只有一种行，所有者不必先判断这次请求
  // 有没有派发工作。主对话仍是固定操作面，永不成行；它的任务由界面放在不可点击的分组标题下。
  const taskSessions: DashboardSession[] = taskRuns.map((run) => {
    const conversationId = derived.get(run.id);
    return {
      ...toSessionSummary(run, tasks, describeRunFailure(run, eventsByRun.get(run.id) ?? []).reason),
      updatedAtMs: Date.parse(run.updatedAt),
      ...(conversationId === undefined ? {} : { conversationId, parentId: conversationId }),
    };
  });
  const childrenByConversation = new Map<string, DashboardSession[]>();
  for (const session of taskSessions) {
    if (session.parentId === undefined) continue;
    const list = childrenByConversation.get(session.parentId) ?? [];
    list.push(session);
    childrenByConversation.set(session.parentId, list);
  }
  // The main conversation is a row like any other, pinned by the UI at the top
  // of 最近: it is where the owner's original thread and the tasks it dispatched
  // live. An empty main conversation is not a row — it would open the same
  // welcome as 新请求 and recreate the duplication this merge removes. It
  // appears once it has a turn, a dispatched task, or legacy history on disk,
  // and stays hidden when the owner hid it.
  // 主对话与其他对话一样是一行，由界面固定在 最近 顶部：所有者最初的线程与它派发的任务
  // 都在这里。空的主对话不是一行——它与 新请求 打开同一个欢迎面，会重建本次合并要去掉的
  // 重复。它有回合、派发过任务或磁盘上有旧历史时才出现；被所有者隐藏时保持隐藏。
  const mainRecords = turns.filter((turn) => conversationIdOf(turn.conversationId) === MAIN_AGENT_SESSION_ID);
  const mainChildren = childrenByConversation.get(MAIN_AGENT_SESSION_ID) ?? [];
  const showMainRow = !deletedConversationIds.has(MAIN_AGENT_SESSION_ID)
    && (mainRecords.length > 0 || mainChildren.length > 0 || await hasStoredMainConversation(dataDirectory));
  const mainRows = showMainRow
    ? [conversationRow(MAIN_AGENT_SESSION_ID, mainRecords, mainChildren)]
    : [];
  const conversationSessions = [
    ...conversationRowsFromTurns(turns, {
      excludeConversationIds: deletedConversationIds,
      childrenByConversation,
    }),
    ...mainRows,
  ];
  // Runs the Main Agent proposed are tasks of the conversation that asked for
  // them, not sibling chats: one request must not read as two conversations in
  // the sidebar, and a task spawned from a new task stays under that task.
  // 主 Agent 提案的 Run 是请求它们的对话的任务，而不是同级对话：一次请求不应在侧栏读成两个
  // 对话，由新任务派生的任务也应留在该任务下。`derived` is computed before the visibility
  // filter so a hidden conversation takes its later runs with it.
  // 列表是对话与它的任务，不是同级会话。
  const allSessions: DashboardSession[] = [...conversationSessions, ...taskSessions]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  // Legacy builds created a fresh Run every time the owner accepted the same
  // failed-task card. Group those identical failures so the sidebar reflects
  // the one problem that still needs attention, not a wall of copies.
  // 旧版本在所有者每次接受同一张失败任务卡时都会新建 Run。把相同失败聚合起来，
  // 让侧栏显示真正需要处理的那个问题，而不是一墙副本。
  const groupedSessions = groupDuplicateFailures(allSessions);

  const approvals = mainConversationApprovals(visibleRuns, tasks);
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
  const decidedCandidateIds = new Set(events
    .filter((event) => event.type === "memory.candidate.promoted" || event.type === "memory.candidate.rejected")
    .map((event) => String(asRecord(event.payload).candidateId ?? "")));
  const memories = events
    // Only undecided proposals are current: a rejected candidate is history,
    // and showing it here would keep a work-order copy alive through an API
    // that refreshes on every dashboard poll.
    // 只有未决定的提案才是当前候选：被拒绝的候选属于历史；把它显示在这里会让一份工作单
    // 复制通过每次刷新 Dashboard 都会调用的 API 继续存活。
    .filter((event) => event.type === "memory.candidate.proposed"
      && !decidedCandidateIds.has(String(asRecord(event.payload).id ?? "")))
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
    sessions: capSessionRows(groupedSessions, 40).map(({ updatedAtMs: _updatedAtMs, duplicateCount: _duplicateCount, ...summary }) => summary),
    deletedConversations: (await sessions.deletedConversations())
      .map((entry) => {
        const latest = turns
          .filter((turn) => conversationIdOf(turn.conversationId) === entry.id)
          .sort((left, right) => Date.parse(right.completedAt ?? right.startedAt) - Date.parse(left.completedAt ?? left.startedAt))
          .at(0);
        return {
          id: entry.id,
          title: latest === undefined ? "已隐藏的对话" : plainText(latest.text).slice(0, 80) || "已隐藏的对话",
          childCount: entry.childRunIds.length,
          at: entry.at,
        };
      }),
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
    // A conversation is a container, not a failed task: merging two tasks with
    // the same title must never make a whole conversation disappear.
    // 对话是容器，不是失败任务：合并两个同名任务绝不能让整个对话消失。
    if (session.kind === "conversation" || !isFailure) {
      result.push(session);
      continue;
    }
    const key = `${session.parentId ?? ""}\u0000${session.status}\u0000${session.title.replace(/\s+/g, " ").trim()}\u0000${session.preview.slice(0, 90)}`;
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

const MAIN_AGENT_SESSION_ID = MAIN_AGENT_DEFAULT_CONVERSATION_ID;

/**
 * Turns this process is currently running, keyed by home and turn id. The
 * ledger row is written only after a capacity slot is granted, so without this
 * reservation a retry during the queue would start a second turn with the same
 * id.
 * 本进程正在运行的回合，以 home 与回合 id 为键。台账行只有在拿到容量槽位后才写入，因此没有
 * 这个预留时，排队期间的重试会以同一 id 启动第二个回合。
 */
const inFlightTurns = new Set<string>();

function turnKey(dataDirectory: string, turnId: string): string {
  return `${dataDirectory}\u0000${turnId}`;
}

type OwnerHistoryMessage = Awaited<ReturnType<typeof readConversation>>[number];

function summarizeOwnerConversation(
  history: OwnerHistoryMessage[],
  turns: MainAgentTurnRecord[],
  conversationId: string = MAIN_AGENT_SESSION_ID,
): DashboardSession | undefined {
  if (history.length === 0) {
    const latestTurn = [...turns]
      .sort((left, right) => Date.parse(left.completedAt ?? left.startedAt) - Date.parse(right.completedAt ?? right.startedAt))
      .at(-1);
    return latestTurn === undefined ? undefined : toMainAgentTurnSummary(latestTurn, conversationId);
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
    id: conversationId,
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

function toMainAgentTurnSummary(
  turn: MainAgentTurnRecord,
  conversationId: string = MAIN_AGENT_SESSION_ID,
): SessionSummary & { updatedAtMs: number } {  const updatedAt = turn.completedAt ?? turn.startedAt;
  const display = turn.status === "failed" || turn.status === "interrupted"
    ? describeFailureForOwner(turn.error)
    : undefined;
  return {
    id: conversationId,
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

/**
 * One row for every conversation, with the Runs it dispatched as children.
 *
 * The row's title is the first request, so the sidebar does not rename a thread
 * every turn; the preview and status follow the latest turn or child. The main
 * conversation is not built here: `buildDashboard` adds it as the pinned row.
 * A hidden conversation stays hidden.
 * 每个对话一行，派发的 Run 作为子行。
 *
 * 标题取第一个请求，侧栏不会每回合重命名线索；预览与状态跟随最近的回合或子任务。主对话
 * 不在这里构建：由 `buildDashboard` 作为固定行补上。被隐藏的对话保持隐藏。
 */
function conversationRowsFromTurns(
  turns: readonly MainAgentTurnRecord[],
  options: {
    excludeConversationIds: ReadonlySet<string>;
    childrenByConversation: ReadonlyMap<string, readonly DashboardSession[]>;
  },
): DashboardSession[] {
  const turnsByConversation = new Map<string, MainAgentTurnRecord[]>();
  for (const turn of turns) {
    const id = conversationIdOf(turn.conversationId);
    if (id === MAIN_AGENT_SESSION_ID || options.excludeConversationIds.has(id)) continue;
    const list = turnsByConversation.get(id) ?? [];
    list.push(turn);
    turnsByConversation.set(id, list);
  }
  // Only the turn ledger can open a conversation view. A run whose derived
  // conversation has no turn row is shown as a standalone task by the UI, not
  // as a conversation row that would 404 when selected.
  // 只有回合台账能打开对话视图。派生对话没有回合行的 Run 由界面按独立任务显示，
  // 而不是生成一条点开就 404 的对话行。
  const ids = new Set(turnsByConversation.keys());
  ids.delete(MAIN_AGENT_SESSION_ID);
  return [...ids].map((conversationId) => conversationRow(
    conversationId,
    turnsByConversation.get(conversationId) ?? [],
    options.childrenByConversation.get(conversationId) ?? [],
  ));
}

/**
 * One conversation row built from its ledger turns and dispatched children.
 * Every conversation uses it, the pinned main conversation included, so the
 * sidebar has one row shape rather than a special case for the owner's original
 * thread. An empty main conversation gets an empty preview; the UI names it and
 * supplies its own empty hint.
 * 一个由台账回合与派发子行构建的对话行。所有对话都用它，包括固定的主对话，因此侧栏
 * 只有一种行形态，而不是为所有者最初的线程准备特例。空的主对话得到空预览；界面负责
 * 命名它并给出空状态提示。
 */
function conversationRow(
  conversationId: string,
  records: readonly MainAgentTurnRecord[],
  children: readonly DashboardSession[],
): DashboardSession {
  const ordered = [...records]
    .sort((left, right) => Date.parse(left.completedAt ?? left.startedAt) - Date.parse(right.completedAt ?? right.startedAt));
  const first = ordered[0];
  const latest = ordered.at(-1);
  const sortedChildren = [...children]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  // Children are sorted newest first, so the earliest one is last and names
  // a thread that has runs but no turn ledger row.
  // 子行按最新在前排序，最早的一条在末尾；没有回合台账行的线程用它命名。
  const firstChild = sortedChildren.at(-1);
  const title = first === undefined
    ? firstChild?.title ?? "Main Agent 对话"
    : toMainAgentTurnSummary(first, conversationId).title;
  const status = conversationStatus(latest, sortedChildren);
  const updatedAtMs = Math.max(
    latest === undefined ? 0 : Date.parse(latest.completedAt ?? latest.startedAt),
    ...sortedChildren.map((child) => child.updatedAtMs),
  );
  return {
    id: conversationId,
    title,
    status,
    updatedAt: new Date(updatedAtMs).toISOString(),
    preview: ordered.length === 0 && sortedChildren.length === 0
      ? ""
      : conversationPreview(status, ordered, sortedChildren),
    kind: "conversation" as const,
    childCount: sortedChildren.length,
    updatedAtMs,
  };
}

/** A Run still occupying a slot or waiting on the owner. 仍占槽位或等待所有者的 Run 状态。 */
const ACTIVE_RUN_STATUSES = new Set(["planning", "queued", "running", "verifying"]);

/**
 * The row status is an aggregate, in the order that matters to the owner:
 * a pending decision, then work in flight, then the newest outcome.
 * 行状态是聚合状态，按所有者关心的顺序：待决定、进行中、最新结果。
 */
function conversationStatus(
  latestTurn: MainAgentTurnRecord | undefined,
  children: readonly { status: string; updatedAtMs: number }[],
): string {
  if (children.some((child) => child.status === "waiting_approval")) return "waiting_approval";
  if (children.some((child) => child.status === "waiting_review")) return "waiting_review";
  // The conversation's own last turn is what the owner needs to see; an active
  // child it spawned is still running, but the turn did not answer. Waiting
  // children still outrank the failure, because they need a decision.
  // 对话自己的上一回合才是所有者需要看到的状态；它派发的活跃子任务仍在运行，但回合没有给出
  // 回答。等待中的子任务仍然优先于失败，因为它们需要决定。
  if (latestTurn !== undefined
    && (latestTurn.status === "failed" || latestTurn.status === "interrupted")) return "failed";
  if (children.some((child) => ACTIVE_RUN_STATUSES.has(child.status))) return "running";
  const latestChild = [...children].sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  const childAt = latestChild?.updatedAtMs ?? 0;
  const turnAt = latestTurn === undefined ? 0 : Date.parse(latestTurn.completedAt ?? latestTurn.startedAt);
  // An older child failure followed by a completed turn is history, not the
  // row's current state. 子任务较早的失败之后回合已完成，那是历史，不是行当前的状态。
  if (latestChild !== undefined && childAt >= turnAt
    && (latestChild.status === "failed" || latestChild.status === "cancelled")) return "failed";
  if (latestTurn?.status === "started") return "running";
  return "completed";
}

function conversationPreview(
  status: string,
  records: readonly MainAgentTurnRecord[],
  children: readonly DashboardSession[],
): string {
  const waitingApproval = children.filter((child) => child.status === "waiting_approval").length;
  if (waitingApproval > 0) return `${waitingApproval} 个任务等待你的确认`;
  const waitingReview = children.filter((child) => child.status === "waiting_review").length;
  if (waitingReview > 0) return `${waitingReview} 个任务等待你的复核`;
  const active = children.filter((child) => ACTIVE_RUN_STATUSES.has(child.status)).length;
  const latestTurn = records.at(-1);
  // A failed turn is the conversation's latest answer, even while a child it
  // spawned keeps working. Say both instead of letting the active count hide
  // the failure. 失败回合是对话最新的回答，即使它派发的子任务仍在工作。两者都说出来，
  // 而不是让活跃计数藏起失败。
  if (latestTurn !== undefined
    && (latestTurn.status === "failed" || latestTurn.status === "interrupted")) {
    const failure = toMainAgentTurnSummary(latestTurn).preview;
    return active > 0 ? `${failure} · ${active} 个任务仍在执行` : failure;
  }
  if (active > 0) return `${active} 个任务正在执行`;
  const latestChild = [...children].sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  const turnAt = latestTurn === undefined ? 0 : Date.parse(latestTurn.completedAt ?? latestTurn.startedAt);
  if (latestChild !== undefined && latestChild.updatedAtMs > turnAt) return latestChild.preview;
  if (latestTurn === undefined) return "这轮对话没有返回文字";
  return toMainAgentTurnSummary(latestTurn).preview;
}

/**
 * Cap root sessions, not rows: a conversation's children travel with it so a
 * slice cannot orphan a task. The main conversation is pinned — it is always
 * kept even when it falls outside the recent window, because it is the fixed
 * entry to the owner's original thread.
 * 按根会话截断，而不是按行：对话的子行随它一起保留，切片不会让任务失去父行。主对话是
 * 固定的：即使落在最近窗口之外也始终保留，因为它是所有者最初线程的固定入口。
 */
function capSessionRows(sessions: readonly DashboardSession[], limit: number): DashboardSession[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const hasConversationParent = (session: DashboardSession): boolean =>
    session.parentId !== undefined
    && byId.get(session.parentId)?.kind === "conversation";
  const roots = sessions.filter((session) => !hasConversationParent(session));
  const orderedRoots = [...roots]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  const keptRoots = orderedRoots.slice(0, limit);
  const pinned = orderedRoots.find((session) => session.id === MAIN_AGENT_SESSION_ID);
  if (pinned !== undefined && !keptRoots.includes(pinned)) keptRoots.push(pinned);
  const keptIds = new Set(keptRoots.map((session) => session.id));
  const children = sessions.filter((session) => {
    const parentId = session.parentId;
    return parentId !== undefined && hasConversationParent(session) && keptIds.has(parentId);
  });
  return [...keptRoots, ...children].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

async function buildMainAgentConversation(
  dataDirectory: string,
  conversationId: string = MAIN_AGENT_SESSION_ID,
  hidden: { runIds?: ReadonlySet<string>; conversationIds?: ReadonlySet<string> } = {},
): Promise<SessionView> {
  const [ownerHistory, turnRecords, runtimeView] = await Promise.all([
    readConversation(dataDirectory, 500, conversationId),
    readMainAgentTurnRecords(dataDirectory),
    loadRuntimeView(dataDirectory),
  ]);
  // History is already scoped to this conversation; legacy Pi files appear only
  // for the main conversation inside readConversation.
  // 历史已按本对话过滤；旧 Pi 文件只会在主对话的 readConversation 结果中出现。
  const history = ownerHistory;
  const isMainConversation = conversationId === MAIN_AGENT_SESSION_ID;
  const { runs, tasks, state, events: journalEvents } = runtimeView;
  const derived = mainAgentRunConversations(journalEvents);
  // A hidden run, or a run whose whole conversation is hidden, is not this
  // conversation's control surface even if its record still exists.
  // 被隐藏的 Run，或其整个对话被隐藏的 Run，即使记录仍在，也不属于本对话的操作面。
  const visibleRuns = runs.filter((run) => !(hidden.runIds?.has(run.id) ?? false)
    && !(hidden.conversationIds?.has(derived.get(run.id) ?? "") ?? false));
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id));
  const auditByTurn = new Map(projectTurnAudits(journalEvents).map((turn) => [turnAuditKey(turn.conversationId, turn.turnId), turn]));
  const runById = new Map(visibleRuns.map((run) => [run.id, run]));
  const turns = turnRecords
    .filter((record) => conversationIdOf(record.conversationId) === conversationId)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  // The log is the main pane for a conversation: one entry per turn, with the
  // context the model was given and the work the turn dispatched. The ledger is
  // the index (it survives a journal outage); the journal adds tools, prompt
  // materials and compactions. The newest turns are enough for the pane; older
  // ones stay searchable in the audit tab, so the session poll stays bounded.
  // 日志是对话的主界面：每个回合一条，带模型拿到的上下文与本回合派发的工作。台账是索引
  // （Journal 故障时仍在）；Journal 补充工具、提示词材料与压缩。面板只需最近的回合；更早的
  // 仍可在审计页搜索，因此会话轮询的大小是有界的。
  const visibleTurns = turns.slice(-TURN_LOG_LIMIT);
  const turnsOmitted = Math.max(0, turns.length - visibleTurns.length);
  const turnLog: MainAgentTurnLogEntry[] = [];
  let priorCompletedTurns = turns.slice(0, turnsOmitted)
    .filter((record) => record.status === "completed" && (record.reply ?? "").trim().length > 0).length;
  for (const record of visibleTurns) {
    const audit = auditByTurn.get(turnAuditKey(conversationId, record.id));
    const durationMs = audit?.durationMs
      ?? (record.completedAt === undefined ? undefined : Math.max(0, Date.parse(record.completedAt) - Date.parse(record.startedAt)));
    const failure = record.status === "failed" || record.status === "interrupted"
      ? describeFailureForOwner(record.error)
      : undefined;
    turnLog.push({
      id: record.id,
      kind: "turn",
      input: capTurnLogText(record.text),
      status: record.status,
      startedAt: record.startedAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(record.reply === undefined ? {} : { reply: capTurnLogText(record.reply) }),
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(failure === undefined ? {} : { errorSummary: failure.summary, errorGuidance: failure.guidance }),
      ...(audit?.modelId === undefined ? {} : { modelId: audit.modelId }),
      ...(audit?.provider === undefined ? {} : { provider: audit.provider }),
      ...(audit?.effort === undefined ? {} : { effort: audit.effort }),
      ...(audit?.promptMaterialHash === undefined ? {} : { promptMaterialHash: audit.promptMaterialHash }),
      ...(audit?.snapshot === undefined ? {} : { snapshot: audit.snapshot }),
      compactions: audit?.compactions ?? [],
      toolCalls: audit?.toolCalls ?? [],
      priorTurns: Math.min(priorCompletedTurns, MAIN_AGENT_HISTORY_TURNS),
      priorTurnsOmitted: Math.max(0, priorCompletedTurns - MAIN_AGENT_HISTORY_TURNS),
      // A run hidden from the sidebar is still evidence of a dispatch, but it
      // has no openable session: the entry says so instead of rendering a
      // button that leads to a 404.
      // 从侧栏隐藏的 Run 仍是派发的证据，但没有可打开的会话：条目标明这一点，而不是渲染一个
      // 指向 404 的按钮。
      spawnedRuns: (audit?.spawnedRunIds ?? []).map((id) => {
        const run = runById.get(id);
        return run === undefined
          ? { id, hidden: true as const }
          : { id, title: plainText(titleFor(run, tasks)).slice(0, 90), status: run.status };
      }),
      journaled: audit !== undefined,
    });
    if (record.status === "completed" && (record.reply ?? "").trim().length > 0) priorCompletedTurns += 1;
  }
  // Legacy Pi history predates the turn ledger: no turn id, no tools, no prompt
  // snapshot, but still the main conversation's record. A history message is
  // covered only when a turn's ledger row actually reproduces it — same role,
  // same text, inside a clamped window. Time alone is not identity: an old Pi
  // writer finishing during a native turn must not lose its answer.
  // 旧 Pi 历史早于回合台账：没有回合 id、没有工具、没有提示词快照，但仍是主对话的记录。
  // 只有台账行真正复现的旧消息才算被覆盖——角色与文本相同，且落在夹紧的窗口内。时间不是
  // 身份：旧 Pi 写入者在原生回合进行期间完成时，它的回答不能丢。
  const turnWindows = turns.flatMap((record) => {
    const start = Date.parse(record.startedAt);
    if (!Number.isFinite(start)) return [];
    const completed = record.completedAt === undefined ? Date.now() : Date.parse(record.completedAt);
    const end = Number.isFinite(completed) ? completed : start;
    return [{
      start: Math.min(start, end),
      end: Math.max(start, end) + 10_000,
      user: record.text.trim(),
      assistant: (record.reply ?? "").trim(),
    }];
  });
  const legacyHistory = history.filter((message) => {
    const at = Date.parse(message.at);
    if (!Number.isFinite(at)) return true;
    const text = message.text.trim();
    // The synthetic ledger entry is capped at MAX_TEXT_PER_ENTRY, so a long
    // turn's history row is a prefix of the ledger text; that prefix still
    // identifies the same message.
    // 合成台账条目有 MAX_TEXT_PER_ENTRY 上限，因此长回合的历史行是台账文本的前缀；这个
    // 前缀仍标识同一条消息。
    const matches = (candidate: string): boolean => candidate === text
      || (text.length > 0 && candidate.startsWith(text));
    return !turnWindows.some((window) => at >= window.start && at <= window.end
      && (message.speaker === "user" ? matches(window.user) : matches(window.assistant)));
  });
  turnLog.push(...legacyHistoryLog(legacyHistory));
  turnLog.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
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
    const hasStoredUserMessage = history.some((message) => (
      message.speaker === "user"
      && Date.parse(message.at) >= started
      && Date.parse(message.at) <= ended
    ));
    // The native ledger is the task's transcript, including what the owner
    // asked. Legacy Pi files supply their own user messages, so a turn window
    // that already has one does not add a second copy.
    // 原生台账就是任务的转录，包括所有者问了什么。旧 Pi 文件自带 user 消息，因此回合窗口里
    // 已有 user 消息时不再补第二份。
    if (!hasStoredUserMessage && turn.text.trim().length > 0) {
      messages.push({
        id: `turn-user-${turn.id}`,
        role: "person",
        text: turn.text,
        occurredAt: turn.startedAt,
      });
    }
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
  // Each update belongs to the conversation whose run settled; a legacy update
  // without an id belongs to the main conversation.
  // 工作更新按时间合入同一条线程：所有者不在时完成的任务读起来是对话的一部分，而不是状态。
  // 每条更新属于其 Run 落定的对话；没有 id 的旧更新属于主对话。
  for (const update of await readWorkUpdates(dataDirectory)) {
    if (conversationIdOf(update.conversationId) !== conversationId) continue;
    messages.push({
      id: `work-${update.id}`,
      role: "clone",
      text: describeWorkUpdate(update),
      occurredAt: update.at,
      ...(update.status === "failed" || update.status === "waiting_review" ? { tone: "warning" as const } : {}),
      workStatus: update.status,
    });
  }
  messages.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const summary = summarizeOwnerConversation(history, turns, conversationId);
  const sessionSummary: SessionSummary = summary === undefined
    ? {
        id: conversationId,
        title: "新的对话",
        kind: "conversation",
        status: "completed",
        updatedAt: new Date().toISOString(),
        preview: "从一个清晰的意图开始",
      }
    : (() => {
        const { updatedAtMs: _updatedAtMs, duplicateCount: _duplicateCount, ...value } = summary;
        return { ...value, kind: "conversation" as const };
      })();
  // The sidebar row and this view must agree on the thread's current state.
  // The row aggregates the latest turn with the Runs' states; the pane uses the
  // same rule and the first request as its stable name. The main conversation
  // stays the control surface with its own turn status.
  // 侧栏行与本视图必须对线程的当前状态给出一致答案。行把最近回合与 Run 状态聚合；面板用同一
  // 规则，并以第一个请求作为稳定名称。主对话仍是操作面，沿用自身回合状态。
  if (!isMainConversation) {
    const conversationRuns = visibleRuns.filter((run) => derived.get(run.id) === conversationId);
    sessionSummary.status = conversationStatus(
      turns.at(-1),
      conversationRuns.map((run) => ({ status: run.status, updatedAtMs: Date.parse(run.updatedAt) })),
    );
    sessionSummary.childCount = conversationRuns.length;
    sessionSummary.title = plainText(turns[0]?.text ?? sessionSummary.title).slice(0, 80) || sessionSummary.title;
    const latestRunAt = conversationRuns.reduce((latest, run) => Math.max(latest, Date.parse(run.updatedAt) || 0), 0);
    const updatedAtMs = Math.max(Date.parse(sessionSummary.updatedAt) || 0, latestRunAt);
    sessionSummary.updatedAt = new Date(updatedAtMs).toISOString();
  }
  const latestUser = [...history].reverse().find((message) => message.speaker === "user");
  // The main conversation is the owner's control surface: every waiting run and
  // every visible subagent is shown here, so a child task record is for reading,
  // not for finding the decision. A task conversation lists only its own
  // subagents; decisions stay central.
  // 主对话是所有者的操作面：所有等待中的 Run 与可见 subagent 都在这里出现，子任务记录只用于
  // 阅读，不再用来寻找决定。任务对话只列出自己的 subagent；决定仍集中在主对话。
  // Decisions belong to the task record that owns the run. The conversation is
  // the place the owner talks, not a decision inbox; the dashboard keeps the
  // cross-task count.
  // 决定属于拥有该 Run 的任务记录。对话是所有者在说话的地方，不是决定收件箱；跨任务的计数
  // 仍留在仪表盘。
  const approvals: SessionView["approvals"] = [];
  const reviews: NonNullable<SessionView["reviews"]> = [];
  const conversationRunIds = new Set(
    [...derived].filter(([, owner]) => owner === conversationId).map(([runId]) => runId),
  );
  const subagents = Object.values(state.subagents)
    .filter((subagent) => visibleRunIds.has(subagent.runId)
      && (isMainConversation || conversationRunIds.has(subagent.runId)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map((subagent) => ({
      // The record this row belongs to. A conversation aggregates subagents
      // from several runs; without the run id the UI cannot open the one whose
      // record explains a failure. 这一行所属的记录。对话会聚合多个 Run 的子 Agent；
      // 没有 Run id，界面无法打开解释失败的记录。
      runId: subagent.runId,
      id: subagent.id,
      title: subagent.title,
      agentId: subagent.agentId,
      role: subagent.role,
      providerId: subagent.providerId ?? "unknown",
      status: subagent.status,
      ...(subagent.summary === undefined ? {} : { summary: subagent.summary }),
      updatedAt: subagent.updatedAt,
    }));
  const finalSummary = approvals.length === 0 && reviews.length === 0
    ? sessionSummary
    : {
        ...sessionSummary,
        status: approvals.length > 0 ? "waiting_approval" : "waiting_review",
        preview: approvals.length > 0
          ? `${approvals.length} 个任务等待你的确认。`
          : `${reviews.length} 个任务等待你的复核。`,
      };
  return {
    ...finalSummary,
    query: latestUser?.text ?? turns.at(-1)?.text ?? "",
    evidenceCount: 0,
    evidence: [],
    subagents,
    approvals,
    reviews,
    messages,
    turns: turnLog,
    turnsOmitted,
    recalledMemories: [],
    activity: [],
    trace: [],
  };
}

/**
 * Legacy history messages, folded into log entries: a user message opens an
 * entry and the assistant messages after it are its reply. An assistant message
 * with no preceding user message is its own entry, so nothing is dropped.
 * 旧历史消息折叠成日志条目：user 消息开启条目，其后的 assistant 消息是它的回复。没有前置
 * user 消息的 assistant 消息自成一条，因此什么都不会丢。
 */
function legacyHistoryLog(messages: ReadonlyArray<{ session: string; at: string; speaker: "user" | "assistant"; text: string }>): MainAgentTurnLogEntry[] {
  const entries: MainAgentTurnLogEntry[] = [];
  let current: MainAgentTurnLogEntry | undefined;
  const open = (message: { session: string; at: string; text: string }, input: string): MainAgentTurnLogEntry => ({
    id: `history-${message.session}-${message.at}`,
    kind: "history",
    input,
    status: "info",
    startedAt: message.at,
    compactions: [],
    toolCalls: [],
    priorTurns: 0,
    priorTurnsOmitted: 0,
    spawnedRuns: [],
    journaled: false,
  });
  for (const message of messages) {
    if (message.speaker === "user") {
      if (current !== undefined) entries.push(current);
      current = open(message, message.text);
      continue;
    }
    if (current === undefined) {
      current = { ...open(message, ""), reply: message.text };
      continue;
    }
    current.reply = current.reply === undefined ? message.text : `${current.reply}\n\n${message.text}`;
  }
  if (current !== undefined) entries.push(current);
  return entries;
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
      runId: subagent.runId,
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
  // The conversation that asked for this run travels on the trigger, so a
  // message sent from this task record reaches that task's context.
  // 请求该 Run 的对话保存在 Trigger 上，从本任务记录发送的消息因此进入该任务的上下文。
  const triggerPayload = asRecord(asRecord(trigger?.payload).payload);
  // A missing conversation is only "the main conversation" when the Main Agent
  // dispatched the run and omitted the id (legacy rows). A scheduled, repair or
  // desktop request has no conversation; defaulting it to the main one sent a
  // follow-up into the wrong thread.
  // 只有 Main Agent 派发且省略了 id 的 Run（旧记录）才把缺省值当主对话。定时、修复或桌面
  // 请求没有对话；把它们默认成主对话，会把追问送进错误的线程。
  const conversationId = typeof triggerPayload.conversationId === "string" && triggerPayload.conversationId.length > 0
    ? triggerPayload.conversationId
    : triggerPayload.source === "main-agent"
      ? MAIN_AGENT_DEFAULT_CONVERSATION_ID
      : undefined;
  // Only a run the Main Agent proposed has a dispatcher to show. A task created
  // by a desktop request has no Main Agent conversation.
  // 只有 Main Agent 提案的 Run 才有可显示的派发者。桌面请求创建的任务没有 Main Agent 对话。
  const dispatchedBy = triggerPayload.source === "main-agent" ? conversationId : undefined;
  const activeStep = run.activeStepId === undefined ? undefined : plan?.steps.find((step) => step.id === run.activeStepId);
  const approvals = run.status === "waiting_approval" && run.activeStepId !== undefined
    ? [{
        runId: run.id,
        stepId: run.activeStepId,
        ...(activeStep === undefined ? {} : { title: displayPlanStepTitle(activeStep.title) }),
        description: activeStep?.risk === "external_side_effect" || activeStep?.risk === "irreversible"
          ? "这一步会影响外部系统；确认后才会继续。"
          : "下一步需要你的确认才会继续。",
      }]
    : [];
  const resultByRun = runResultByRun(events);
  // A task record owns its own review: the criteria, the worker's answer, and
  // the accept/reject pair. The main conversation no longer carries these.
  // 任务记录拥有自己的复核：标准、Worker 的回答与接受/拒绝按钮。主对话不再承载它们。
  const verification = state.verificationByRun[run.id];
  const reviews = run.status === "waiting_review" && verification !== undefined
    ? [{
        runId: run.id,
        title: plainText(titleFor(run, tasks)).slice(0, 90),
        verification,
        ...(resultByRun[run.id] === undefined ? {} : { result: resultByRun[run.id]!.summary }),
      }]
    : undefined;
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

  const evidence = (state.evidenceByRun[run.id] ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    summary: item.summary,
    ...(item.locator === undefined ? {} : { locator: item.locator }),
    ...(item.workOrderId === undefined ? {} : { workOrderId: item.workOrderId }),
    createdAt: item.createdAt,
  }));
  return {
    ...toSessionSummary(run, tasks, describeRunFailure(run, runEvents).reason),
    ...(conversationId === undefined ? {} : { conversationId, parentId: conversationId }),
    ...(dispatchedBy === undefined ? {} : { dispatchedBy }),
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
          ...(step.agentId === undefined ? {} : { agentId: step.agentId }),
          delegated: step.subagents !== undefined,
        })),
      },
    subagents,
    approvals,
    ...(reviews === undefined ? {} : { reviews }),
    ...(state.verificationByRun[run.id] === undefined ? {} : { verification: state.verificationByRun[run.id] }),
    messages: buildConversation(run, query, subagents.length, evidenceCount, runEvents, recalledMemories.length),
    recalledMemories,
    evidence,
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

  // The step's own answer is what the owner is being asked to accept. It was
  // durable for a subagent but dropped for a single-agent step; both now reach
  // the record, before the status line that asks for a decision.
  // 步骤自己的回答正是所有者被要求接受的东西。subagent 的回答是持久的，单 Agent 步骤的回答
  // 却被丢掉；现在两者都进入记录，并排在请求你决定的那条消息之前。
  const result = runResultByRun(events)[run.id];
  if (result !== undefined && (run.status === "waiting_review" || run.status === "completed")) {
    messages.push({
      id: `result-${run.id}`,
      role: "clone",
      text: result.summary,
      occurredAt: result.occurredAt,
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

export interface MainConversationApproval {
  runId: string;
  stepId: string;
  title: string;
  description: string;
}

type ApprovalRun = Pick<Run, "id" | "status" | "activeStepId" | "taskId">;

/**
 * Every waiting run that needs the owner, keyed by the run id the decision must
 * be posted to. The main conversation and the dashboard share this function so
 * their counts can never disagree.
 * 所有需要所有者决定的等待中 Run，带提交决定所需的 Run id。主对话与仪表盘共用此函数，
 * 两处数量因此不会分歧。
 */
export function mainConversationApprovals(
  runs: ReadonlyArray<ApprovalRun>,
  tasks: Record<string, Pick<Task, "title">>,
): MainConversationApproval[] {
  return runs
    .filter((run) => run.status === "waiting_approval" && run.activeStepId !== undefined)
    .map((run) => ({
      runId: run.id,
      stepId: run.activeStepId!,
      title: tasks[run.taskId]?.title ?? "Unnamed work",
      description: "The next step can affect an external system and needs your approval.",
    }));
}

export interface MainConversationReview {
  runId: string;
  title: string;
  verification: VerificationResult;
  /** What the worker concluded, when the run recorded it. 当 Run 记录时，Worker 得出的结论。 */
  result?: string;
}

/**
 * Waiting reviews joined to the verification that asks for them, so the main
 * conversation can show criteria and accept/reject the same way a task record
 * does. The worker's own answer travels with the criteria: a decision without
 * the result is a decision about nothing.
 * 等待复核的 Run 与其验证结果连在一起，使主对话能像任务记录一样显示标准并接受/拒绝。
 * Worker 自己的回答随标准一起出现：没有结果的复核，是对空白的决定。
 */
export function mainConversationReviews(
  runs: ReadonlyArray<ApprovalRun>,
  tasks: Record<string, Pick<Task, "title">>,
  verificationByRun: Record<string, VerificationResult>,
  resultByRun: Record<string, { summary: string }> = {},
): MainConversationReview[] {
  return runs.flatMap((run) => {
    if (run.status !== "waiting_review") return [];
    const verification = verificationByRun[run.id];
    if (verification === undefined) return [];
    const result = resultByRun[run.id];
    return [{
      runId: run.id,
      title: tasks[run.taskId]?.title ?? "Unnamed work",
      verification,
      ...(result === undefined ? {} : { result: result.summary }),
    }];
  });
}

/**
 * The last durable answer per run. A single-agent step journals
 * `execution.completed`; a subagent run journals one `subagent.completed` per
 * work order, joined here when no step-level answer exists.
 * 每个 Run 最后一条持久回答。单 Agent 步骤写 `execution.completed`；subagent Run 为每个
 * 工作单写一条 `subagent.completed`，在没有步骤级回答时在此合并。
 */
export function runResultByRun(
  events: ReadonlyArray<JournalEvent>,
): Record<string, { summary: string; occurredAt: string }> {
  const results: Record<string, { summary: string; occurredAt: string }> = {};
  const subagentSummaries = new Map<string, { summaries: string[]; occurredAt: string }>();
  for (const event of events) {
    if (event.runId === undefined) continue;
    const summary = asRecord(event.payload).summary;
    if (typeof summary !== "string" || summary.trim().length === 0) continue;
    if (event.type === "execution.completed") {
      results[event.runId] = { summary, occurredAt: event.occurredAt };
    } else if (event.type === "subagent.completed") {
      const existing = subagentSummaries.get(event.runId);
      subagentSummaries.set(event.runId, {
        summaries: [...(existing?.summaries ?? []), summary],
        occurredAt: event.occurredAt,
      });
    }
  }
  for (const [runId, entry] of subagentSummaries) {
    if (results[runId] !== undefined) continue;
    results[runId] = { summary: entry.summaries.slice(0, 3).join("\n\n"), occurredAt: entry.occurredAt };
  }
  return results;
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
    "execution.completed": "完成步骤",
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
    "main_agent.prompt_snapshot": "记录提示词快照",
    "main_agent.turn_started": "主 Agent 回合开始",
    "main_agent.turn_completed": "主 Agent 回合结束",
    "audit.labeled": "人工判定",
    "authority.changed": "修改权限",
    "recommendation.applied": "应用评审改动",
    "approval.requested": "请求审批",
    "selfcheck.completed": "自检回路一轮",
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
  if (type === "recommendation.applied") {
    const from = payload.from === null || payload.from === undefined ? "默认" : String(payload.from);
    const to = payload.to === null || payload.to === undefined ? "默认" : String(payload.to);
    return `${payload.reverted === true ? "撤销" : "应用"} ${String(payload.kind ?? "")}${payload.target === undefined ? "" : ` · ${String(payload.target)}`}：${from} → ${to}`;
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
  if (type === "execution.completed" && typeof payload.summary === "string") {
    return payload.summary.slice(0, 160);
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
  if (type === "main_agent.turn_started") {
    const input = typeof payload.input === "string" ? payload.input.slice(0, 120) : "";
    const model = typeof payload.modelId === "string" ? ` · ${payload.modelId}` : "";
    return `${input}${model}`;
  }
  if (type === "main_agent.turn_completed") {
    const status = typeof payload.status === "string" ? payload.status : "";
    const tools = Array.isArray(payload.toolCalls) ? payload.toolCalls.length : 0;
    const reply = typeof payload.reply === "string" ? payload.reply.slice(0, 100) : "";
    return `${status} · ${tools} 个工具${reply ? ` · ${reply}` : ""}`;
  }
  if (type === "main_agent.prompt_snapshot") {
    const model = typeof payload.modelId === "string" ? payload.modelId : "默认模型";
    const effort = typeof payload.effort === "string" ? ` · 强度 ${payload.effort}` : "";
    const tools = Array.isArray(payload.toolNames) ? payload.toolNames.length : 0;
    const hash = typeof payload.promptHash === "string" ? payload.promptHash.slice(0, 8) : "?";
    return `${model}${effort} · ${tools} 个工具 · 提示词 ${hash}`;
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

/**
 * The request body cap. It has to clear the largest attachment set: four PDF or
 * Word files at 14 MB of base64 each, or a mix with 7 MB images. A 32 KB cap
 * rejected every real screenshot; 40 MB could still reject four 10 MB PDFs.
 * 请求体上限。它必须高于最大的附件组合：四个各 14 MB base64 的 PDF/Word，或与 7 MB
 * 图片混合。32 KB 的上限会拒绝每张真实截图；40 MB 仍可能拒绝四个 10 MB 的 PDF。
 */
const MAX_BODY_CHARACTERS = 60_000_000;
/** A rendered conversation table is small; this bounds an owner-initiated CSV write. 对话表格很小；这限制所有者发起的 CSV 写入。 */
const MAX_TABLE_CSV_BYTES = 5_000_000;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("The local request body is too large.");
    this.name = "RequestBodyTooLargeError";
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > MAX_BODY_CHARACTERS) {
      throw new RequestBodyTooLargeError();
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
  // A step mismatch is a conflict with the run's current state, not a server
  // error: the approval no longer describes what is waiting.
  // 步骤不匹配是与 Run 当前状态的冲突，而不是服务器错误：该审批已不再描述正在等待的东西。
  if (message.includes("was issued for step")) return 409;
  if (message.includes("is not waiting for an approval") || message.includes("is not waiting for review") || message.includes("cannot be cancelled")) return 409;
  return 500;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  // A client that disconnected while a turn waited for capacity still gets a
  // catch-path response attempt; writing to a destroyed socket must be a no-op.
  // 客户端在回合等待容量时断开，仍会走到 catch 里的响应尝试；向已销毁的 socket 写入必须是无操作。
  if (response.writableEnded || response.destroyed) return;
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
  /** The conversation that asked for this run; the task record uses it to route a follow-up. 请求该 Run 的对话；任务记录用它来路由后续消息。 */
  conversationId?: string;
  /** The Main Agent conversation that dispatched this run, when it was a Main Agent proposal. 派发该 Run 的 Main Agent 对话（当它由 Main Agent 提案时）。 */
  dispatchedBy?: string;
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
  /** The run status behind a work update, so the log badge matches the run. 工作更新背后的 Run 状态，使日志标签与 Run 一致。 */
  workStatus?: "completed" | "failed" | "cancelled" | "waiting_review";
}

interface SessionView extends SessionSummary {
  query: string;
  evidenceCount: number;  /**
   * What the run actually produced, not just how many items: the task record
   * lists these so the owner can see the files and reads behind a verdict.
   * Run 实际产出了什么，而不只是条数：任务记录列出它们，所有者才能看到结论背后的文件与读取。
   */
  evidence: Array<{ id: string; kind: string; summary: string; locator?: string; workOrderId?: string; createdAt: string }>;
  plan?: {
    summary: string;
    steps: Array<{ id: string; title: string; risk: string; delegated: boolean; agentId?: string }>;
  };
  subagents: Array<{ runId: string; id: string; title: string; agentId: string; role: string; providerId: string; status: string; summary?: string; updatedAt: string }>;
  approvals: Array<{ runId: string; stepId: string; title?: string; description: string }>;
  reviews?: Array<{ runId: string; title: string; verification: VerificationResult; result?: string }>;
  verification?: import("./core/contracts.ts").VerificationResult;
  messages: ConversationMessage[];
  /**
   * The conversation's Main Agent turns, oldest first, each with the context it
   * was given and the work it dispatched. A task record has none: its runs are
   * the record.
   * 对话的主 Agent 回合，旧的在前，每条带模型拿到的上下文与本回合派发的工作。任务记录没有：
   * 它的 Run 就是记录。
   */
  turns?: MainAgentTurnLogEntry[];
  /** How many older turns the pane did not receive; they remain in the audit tab. 面板未接收的更早回合数；它们仍在审计页。 */
  turnsOmitted?: number;
  recalledMemories: Array<{ id: string; summary: string; score: number; matchedTerms: string[] }>;
  activity: Array<{ label: string; detail: string; occurredAt: string }>;
  trace: TraceItem[];
}

/**
 * How many of a conversation's newest turns the pane receives. Older turns
 * stay in the ledger and in the searchable audit tab; returning all of them
 * made one session poll grow with the whole history.
 * 面板接收一个对话最近的多少个回合。更早的回合留在台账与可搜索的审计页；返回全部会让一次
 * 会话轮询随整段历史增长。
 */
const TURN_LOG_LIMIT = 60;
/** Per-field cap for one turn in the session payload; the ledger keeps the full text. 会话载荷中单回合单字段上限；台账保留全文。 */
const TURN_LOG_TEXT_LIMIT = 20_000;

function capTurnLogText(value: string): string {
  return value.length <= TURN_LOG_TEXT_LIMIT ? value : `${value.slice(0, TURN_LOG_TEXT_LIMIT)}\n…[truncated]`;
}

/**
 * One line of the conversation log. A turn carries its query, the context it
 * assembled, the tools it called and the runs it spawned; a legacy history
 * entry carries only text, because that is all the Pi session file recorded.
 * 对话日志的一行。回合带 query、组装出的上下文、调用的工具与派生的 Run；旧历史条目只有文本，
 * 因为 Pi 会话文件记录的只有这些。
 */
interface MainAgentTurnLogEntry {
  id: string;
  kind: "turn" | "history";
  input: string;
  status: "started" | "completed" | "failed" | "interrupted" | "info";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  reply?: string;
  error?: string;
  /** The owner-facing failure summary and next step, when the turn failed. 回合失败时面向所有者的原因摘要与下一步。 */
  errorSummary?: string;
  errorGuidance?: string;
  modelId?: string;
  provider?: string;
  effort?: string;
  promptMaterialHash?: string;
  snapshot?: MainAgentTurnAudit["snapshot"];
  compactions: MainAgentTurnAudit["compactions"];
  toolCalls: MainAgentTurnAudit["toolCalls"];
  /** Completed turns inside the model's history window. 模型历史窗口内的已完成回合数。 */
  priorTurns: number;
  /** Completed turns older than the window, not in the model's context. 窗口之外、未进入模型上下文的已完成回合数。 */
  priorTurnsOmitted: number;
  spawnedRuns: Array<{ id: string; title?: string; status?: string; hidden?: boolean }>;
  /** Whether the Journal has a record for this turn. Journal 中是否有本回合的记录。 */
  journaled: boolean;
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
