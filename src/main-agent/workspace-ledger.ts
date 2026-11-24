/**
 * A bounded daily ledger of what changed in the folders the twin has learned.
 *
 * The 2026-11-19 "today's changes" tool stops at file names, mtimes and Git.
 * That is enough to say *that* a document changed, not *what* changed inside
 * it, and a folder outside Git leaves no content record at all. The owner
 * asked for a day to be readable as a diff; a diff needs a before state, and
 * the filesystem offers none for an arbitrary folder. So the twin keeps its
 * own: a per-folder state map (path -> content identity), a per-day JSONL file
 * of the changes it observed, and a content-addressed blob for every text
 * version it can afford to keep.
 *
 * Capture is incremental and belongs to the daemon's maintenance loop, not to
 * a turn: stat the known files, ask Spotlight for new ones, and pay the bounded
 * full walk only for the first baseline. The digest tool only reads.
 *
 * 分身学会的文件夹的有界每日变更台账。
 *
 * 2026-11-19 的"今天改了什么"止步于文件名、mtime 与 Git。它能说明某份文档变过，却说明不了
 * 里面改了什么；不在 Git 里的文件夹更是没有任何内容记录。所有者要求把一天读成 diff；
 * diff 需要之前的状态，而文件系统对任意文件夹不提供它。因此分身自己保留：每文件夹一份
 * 状态表（路径 -> 内容身份）、每天一份观察到的变更 JSONL，以及每个负担得起的文本版本
 * 的内容寻址块。
 *
 * 采集是增量的，属于守护进程的维护循环而不是某个回合：对已知文件做 stat、用 Spotlight
 * 查新文件，只有第一次基线才付有界的全量遍历。digest 工具只读。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, basename, join, relative } from "node:path";

import { canonicalPath, isForbiddenPath } from "../authority/scope.ts";
import { workspaceExecutionLock } from "../core/workspace-lock.ts";
import { cachedGitIgnoreIndex, isNoisePath } from "./workspace-noise.ts";
import { findRepositories, scanFiles, walkFiles } from "./tools/recent-changes.ts";

export const WORKSPACE_LEDGER_DIRECTORY = "workspace-history";

/** Five learned folders are enough; the tool already caps at five. 五个已学会文件夹足够；工具本身也以五为上限。 */
export const MAX_LEDGER_FOLDERS = 5;
/** A folder larger than this is tracked newest-first; the rest is reported as truncated. 超过此数的文件夹按最新优先跟踪；其余标记为截断。 */
export const MAX_LEDGER_FILES = 20_000;
/** Content is kept only for text files below this size; larger files stay metadata-only. 只保留此大小以下文本文件的内容；更大的文件只留元数据。 */
export const MAX_LEDGER_TEXT_BYTES = 512 * 1024;
/** Total blob budget. When full, identities keep working; content diffs say they have no baseline. 块总量预算。用满后身份识别仍工作；内容 diff 会说明没有基线。 */
export const MAX_LEDGER_TOTAL_BYTES = 512 * 1024 * 1024;
/** One day never needs more than this many recorded changes per folder. 每文件夹每天最多记录这么多变更。 */
export const MAX_LEDGER_DAY_CHANGES = 5_000;
/** Day files older than this are pruned; blobs only they referenced are collected. 早于此天数的日文件会被清理；只被它们引用的块随之回收。 */
export const LEDGER_RETENTION_DAYS = 90;
/** Capture cadence in the daemon. The tool never captures. 守护进程的采集节奏；工具从不采集。 */
export const LEDGER_CAPTURE_INTERVAL_MS = 30 * 60_000;
/** Baseline walk bounds: one-time cost, so it may run longer than a turn scan. 基线遍历上限：一次性成本，可比回合内扫描跑得更久。 */
const BASELINE_WALK_DEADLINE_MS = 60_000;
const BASELINE_WALK_MAX_DIRECTORIES = 50_000;
/** How many bytes of file content one capture may read while hashing. 一次采集为哈希最多读取的字节数。 */
const MAX_CAPTURE_READ_BYTES = 128 * 1024 * 1024;

/** Extensions that are worth reading as text; anything else stays metadata-only. 值得按文本读取的扩展名；其余只留元数据。 */
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".text", ".rst", ".org", ".log",
  ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".properties", ".xml", ".html", ".htm",
  ".css", ".scss", ".less", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cpp",
  ".hpp", ".cc", ".cs", ".swift", ".php", ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".sql", ".graphql", ".gql", ".vue", ".svelte", ".astro", ".tex",
  ".bib", ".r", ".m", ".lua", ".pl", ".ex", ".exs", ".erl", ".clj", ".scala",
  ".dart", ".dockerfile", ".gitignore", ".gitattributes", ".editorconfig",
]);

/**
 * Credential-shaped files are tracked by identity but never read into a blob:
 * a daily diff is not a good reason to copy `~/.npmrc` or a `.env` into
 * another file the model may later quote.
 * 凭据形态的文件只跟踪身份、绝不读入块：每日 diff 不足以成为把 `~/.npmrc` 或 `.env`
 * 复制到另一个可能被模型引用的文件的理由。
 */
const SENSITIVE_BASENAMES = new Set([
  ".env", ".env.local", ".env.development", ".env.production", ".env.test",
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".htpasswd",
  ".pgpass", ".my.cnf", ".dockerconfigjson", "credentials", "credentials.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "authorized_keys", "known_hosts",
  "secrets", "secrets.json", "secrets.yaml", "secrets.yml",
]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx", ".gpg", ".asc"]);

function isSensitivePath(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (SENSITIVE_EXTENSIONS.has(extname(base))) return true;
  // `.env.local`, `.env.production.local` and friends. `.environment.md` is a
  // document, so the prefix only counts when the remainder is another suffix.
  // 例如 `.env.local`、`.env.production.local` 等。`.environment.md` 是文档，
  // 因此只有剩余部分仍是后缀时，这个前缀才算数。
  return base.startsWith(".env.") && !base.endsWith(".md") && !base.endsWith(".txt");
}

const SAFE_HASH_PATTERN = /^(?:[0-9a-f]{64}|meta:\d+:\d+(?:\.\d+)?|unreadable)$/;
const TEXT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export interface LedgerFileState {
  /** sha256 of the content for a text file, `meta:<size>:<mtimeMs>` otherwise. 文本文件为内容 sha256，其余为 `meta:<size>:<mtimeMs>`。 */
  hash: string;
  size: number;
  mtimeMs: number;
  /** True when a content blob may exist for this state. 可能为此状态保存了内容块时为真。 */
  text: boolean;
}

export interface LedgerFolderState {
  folder: string;
  updatedAt: string;
  baselineAt: string;
  truncated: boolean;
  files: Record<string, LedgerFileState>;
}

export interface WorkspaceDayChange {
  at: string;
  path: string;
  change: "added" | "modified" | "deleted";
  before?: LedgerFileState;
  after?: LedgerFileState;
}

export interface WorkspaceDay {
  changes: WorkspaceDayChange[];
  truncated: boolean;
}

export type WorkspaceOperationKind = "created" | "modified" | "removed";

export interface WorkspaceOperationEvent {
  at: string;
  path: string;
  kind: WorkspaceOperationKind;
}

export interface WorkspaceOperationDay {
  events: WorkspaceOperationEvent[];
  truncated: boolean;
}

export interface LocalDayWindow {
  /** Local `YYYY-MM-DD`. 本机日历日。 */
  dayKey: string;
  start: Date;
  /** Exclusive end: the next local midnight. 不含的结束：下一个本地午夜。 */
  end: Date;
  label: string;
}

export interface CaptureFolderOptions {
  dataDirectory: string;
  folder: string;
  home?: string;
  now?: Date;
  force?: boolean;
  minIntervalMs?: number;
  maxFiles?: number;
  maxDayChanges?: number;
  /**
   * Shutdown seam: an aborted capture writes no state, so the next pass redoes
   * the work instead of recording a partial tree as a baseline.
   * 关停切口：被中止的采集不写状态，因此下一轮重做，而不是把不完整的树记成基线。
   */
  signal?: AbortSignal;
}

export interface CaptureFolderResult {
  folder: string;
  captured: boolean;
  baseline: boolean;
  changes: number;
  truncated: boolean;
  /** Generated/gitignored paths this capture skipped. 本次采集跳过的生成/gitignore 路径。 */
  filtered: number;
  error?: string;
}

export interface CaptureLedgerOptions {
  dataDirectory: string;
  folders: readonly string[];
  home?: string;
  now?: Date;
  force?: boolean;
  minIntervalMs?: number;
  maxFiles?: number;
  maxDayChanges?: number;
  signal?: AbortSignal;
}

export interface LedgerCoverage {
  folder: string;
  baselineAt?: string;
  lastCaptureAt?: string;
  truncated: boolean;
  trackedFiles: number;
  /** Paths the last capture skipped as generated or gitignored. 最近一次采集作为生成/忽略路径跳过的数量。 */
  filtered: number;
}

interface LedgerCheck {
  folder: string;
  /** The last time the folder was looked at, including checks with no changes. 最近一次查看该文件夹的时间，包括没有变化的检查。 */
  checkedAt: string;
  truncated: boolean;
  /** Coverage without parsing the full state map. 无需解析完整状态表即可得到的覆盖信息。 */
  baselineAt: string;
  trackedFiles: number;
  filtered: number;
}

interface LedgerPaths {
  root: string;
  stateDirectory: string;
  daysDirectory: string;
  blobsDirectory: string;
  usageFile: string;
  lockFile: string;
}

interface LedgerUsage {
  blobBytes: number;
  lastPruneAt?: string;
}

function ledgerPaths(dataDirectory: string): LedgerPaths {
  const root = join(dataDirectory, WORKSPACE_LEDGER_DIRECTORY);
  return {
    root,
    stateDirectory: join(root, "state"),
    daysDirectory: join(root, "days"),
    blobsDirectory: join(root, "blobs"),
    usageFile: join(root, "usage.json"),
    lockFile: join(root, "ledger.sqlite3"),
  };
}

/** Stable per-folder key: a path can contain separators, but a directory name cannot. 稳定的每文件夹键：路径可含分隔符，目录名不能。 */
export function ledgerFolderKey(folder: string): string {
  return createHash("sha256").update(folder).digest("hex").slice(0, 16);
}

export function ledgerStateFile(dataDirectory: string, folder: string): string {
  return join(ledgerPaths(dataDirectory).stateDirectory, `${ledgerFolderKey(folder)}.json`);
}

export function ledgerDayFile(dataDirectory: string, folder: string, dayKey: string): string {
  return join(ledgerPaths(dataDirectory).daysDirectory, ledgerFolderKey(folder), `${dayKey}.jsonl`);
}

export function ledgerEventsFile(dataDirectory: string, folder: string, dayKey: string): string {
  return join(ledgerPaths(dataDirectory).daysDirectory, ledgerFolderKey(folder), `${dayKey}.events.jsonl`);
}

function ledgerCheckFile(dataDirectory: string, folder: string): string {
  return join(ledgerPaths(dataDirectory).stateDirectory, `${ledgerFolderKey(folder)}.check.json`);
}

function blobPath(dataDirectory: string, hash: string): string {
  return join(ledgerPaths(dataDirectory).blobsDirectory, hash.slice(0, 2), hash);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localStamp(value: string | Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${localDayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/**
 * One local calendar day. A bare `YYYY-MM-DD` is local midnight; an instant
 * belongs to the local day that contains it. `today` and `yesterday` follow
 * the owner's calendar, not UTC.
 * 一个本机日历日。裸 `YYYY-MM-DD` 取自本地午夜；一个时刻属于包含它的本地日。
 * `today` 与 `yesterday` 跟随所有者的日历，而不是 UTC。
 */
export function localDayWindow(value: string | undefined, now: Date): LocalDayWindow {
  const raw = (value ?? "today").trim().toLowerCase();
  const startOf = (date: Date): Date => {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    return start;
  };
  let day: Date;
  if (raw === "" || raw === "today" || raw === "今天") {
    day = startOf(now);
  } else if (raw === "yesterday" || raw === "昨天") {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    day = startOf(yesterday);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, datePart] = raw.split("-").map(Number);
    const parsed = new Date(year!, month! - 1, datePart!);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Unrecognized day "${value}". Use YYYY-MM-DD, "today" or "yesterday".`);
    day = startOf(parsed);
  } else {
    const parsed = new Date(value ?? "");
    if (Number.isNaN(parsed.getTime())) throw new Error(`Unrecognized day "${value}". Use YYYY-MM-DD, "today" or "yesterday".`);
    day = startOf(parsed);
  }
  const tomorrow = new Date(day);
  tomorrow.setDate(tomorrow.getDate() + 1);
  // The end is the next local midnight, including for today: a file written a
  // millisecond before the digest ran still belongs to today. Nothing can
  // exist after now, so the wider bound only removes a boundary race.
  // 结束是下一个本地午夜，今天也一样：在摘要运行前一毫秒写入的文件仍属于今天。现在之后
  // 不可能有内容，因此放宽这一端只是消除边界竞争。
  return { dayKey: localDayKey(day), start: day, end: tomorrow, label: localDayKey(day) };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as T;
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    // A truncated write is not a reason to stop the ledger: the next capture
    // rebuilds the baseline from what the disk actually holds.
    // 写入被截断不应让台账停下：下一次采集会按磁盘实际内容重建基线。
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, path);
}

async function readFolderState(dataDirectory: string, folder: string): Promise<LedgerFolderState | undefined> {
  const state = await readJson<LedgerFolderState>(ledgerStateFile(dataDirectory, folder));
  if (
    state === undefined
    || typeof state.files !== "object"
    || state.files === null
    || typeof state.updatedAt !== "string"
    || !Number.isFinite(Date.parse(state.updatedAt))
    || typeof state.baselineAt !== "string"
  ) {
    // A malformed state is treated as "no baseline": the next capture rebuilds
    // it, and the gap is reported instead of producing timestamp-NaN scans.
    // 损坏的状态当作"没有基线"：下一次采集重建它，并报告缺口，而不是产生 NaN 时间戳扫描。
    return undefined;
  }
  // A hand-edited or crafted state must not be able to point the ledger at a
  // path outside its folder or at a non-content hash.
  // 手改或伪造的状态不得把台账指向文件夹之外的路径或非内容哈希。
  const files: Record<string, LedgerFileState> = {};
  for (const [path, file] of Object.entries(state.files)) {
    if (isSafeRelativePath(path) && isFileState(file)) files[path] = file;
  }
  return { ...state, files };
}

async function readCheck(dataDirectory: string, folder: string): Promise<LedgerCheck | undefined> {
  const check = await readJson<LedgerCheck>(ledgerCheckFile(dataDirectory, folder));
  if (
    check === undefined
    || typeof check.checkedAt !== "string"
    || !Number.isFinite(Date.parse(check.checkedAt))
    || typeof check.truncated !== "boolean"
    || typeof check.baselineAt !== "string"
    || typeof check.trackedFiles !== "number"
    || typeof check.filtered !== "number"
  ) {
    return undefined;
  }
  return check;
}

export async function readLedgerCoverage(dataDirectory: string, folder: string): Promise<LedgerCoverage> {
  // The check file is small; the state map can be megabytes. A digest that
  // only needs coverage must not parse every tracked path.
  // 检查文件很小；状态表可能有几 MB。只需要覆盖信息的摘要不该解析每个跟踪路径。
  const check = await readCheck(dataDirectory, folder);
  if (check !== undefined) {
    return {
      folder,
      baselineAt: check.baselineAt,
      lastCaptureAt: check.checkedAt,
      truncated: check.truncated,
      trackedFiles: check.trackedFiles,
      filtered: check.filtered,
    };
  }
  const state = await readFolderState(dataDirectory, folder);
  if (state === undefined) return { folder, truncated: false, trackedFiles: 0, filtered: 0 };
  return {
    folder: state.folder,
    baselineAt: state.baselineAt,
    lastCaptureAt: state.updatedAt,
    truncated: state.truncated,
    trackedFiles: Object.keys(state.files).length,
    filtered: 0,
  };
}

/**
 * One file's identity. Text files below the cap are read so a later day can
 * show what changed inside them; everything else is identified by size and
 * mtime, exactly like the checkpoint store's large-file rule.
 * 一个文件的身份。上限以下的文本文件会被读取，以便之后某天能显示里面改了什么；
 * 其余用大小与 mtime 识别，与检查点存储的大文件规则相同。
 */
async function readFileState(
  path: string,
  info: { size: number; mtimeMs: number },
  budget: { readBytes: number },
): Promise<{ state: LedgerFileState; content?: string }> {
  const extension = extname(path).toLowerCase();
  const extensionless = extension.length === 0;
  const mayBeText = TEXT_EXTENSIONS.has(extension) || (extensionless && info.size <= 128 * 1024);
  if (isSensitivePath(path) || !mayBeText || info.size > MAX_LEDGER_TEXT_BYTES || budget.readBytes >= MAX_CAPTURE_READ_BYTES) {
    return { state: { hash: `meta:${info.size}:${info.mtimeMs}`, size: info.size, mtimeMs: info.mtimeMs, text: false } };
  }
  try {
    const content = await fs.readFile(path, "utf8");
    // A NUL byte means this is not text. Reading it as one would store a
    // binary blob and produce a diff of replacement characters.
    // NUL 字节意味着它不是文本。按文本读取会保存二进制块，并产出一堆替换字符的 diff。
    if (content.includes("\u0000")) {
      return { state: { hash: `meta:${info.size}:${info.mtimeMs}`, size: info.size, mtimeMs: info.mtimeMs, text: false } };
    }
    budget.readBytes += Buffer.byteLength(content, "utf8");
    return {
      state: { hash: sha256(content), size: info.size, mtimeMs: info.mtimeMs, text: true },
      content,
    };
  } catch {
    return { state: { hash: "unreadable", size: info.size, mtimeMs: info.mtimeMs, text: false } };
  }
}

async function storeBlob(
  dataDirectory: string,
  hash: string,
  content: string,
  usage: LedgerUsage,
): Promise<void> {
  if (!TEXT_HASH_PATTERN.test(hash)) return;
  const target = blobPath(dataDirectory, hash);
  const bytes = Buffer.byteLength(content, "utf8");
  try {
    await fs.access(target);
    return;
  } catch {
    // absent; write it below. 不存在；在下面写入。
  }
  if (usage.blobBytes + bytes > MAX_LEDGER_TOTAL_BYTES) return;
  await fs.mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  try {
    await fs.rename(temporary, target);
    usage.blobBytes += bytes;
  } catch {
    await fs.rm(temporary, { force: true });
  }
}

export async function readWorkspaceBlob(dataDirectory: string, hash: string): Promise<string | undefined> {
  // A day file is on disk and could be edited by hand or by a granted write;
  // only a content hash may name a blob, never a path.
  // 日文件在磁盘上，可能被手工或获准的写入修改；只有内容哈希能指向块，路径不行。
  if (!TEXT_HASH_PATTERN.test(hash)) return undefined;
  try {
    return await fs.readFile(blobPath(dataDirectory, hash), "utf8");
  } catch {
    return undefined;
  }
}

async function readUsage(dataDirectory: string): Promise<LedgerUsage> {
  const usage = await readJson<LedgerUsage>(ledgerPaths(dataDirectory).usageFile);
  if (usage === undefined || typeof usage.blobBytes !== "number") return { blobBytes: 0 };
  return usage;
}

async function writeUsage(dataDirectory: string, usage: LedgerUsage): Promise<void> {
  await writeJsonAtomic(ledgerPaths(dataDirectory).usageFile, usage);
}

async function countDayLines(path: string): Promise<number> {
  try {
    const source = await fs.readFile(path, "utf8");
    return source.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function appendDayChanges(
  dataDirectory: string,
  folder: string,
  dayKey: string,
  changes: readonly WorkspaceDayChange[],
  maxDayChanges: number,
): Promise<{ recorded: number; truncated: boolean }> {
  if (changes.length === 0) return { recorded: 0, truncated: false };
  const path = ledgerDayFile(dataDirectory, folder, dayKey);
  await fs.mkdir(dirname(path), { recursive: true });
  const existing = await countDayLines(path);
  const room = Math.max(0, maxDayChanges - existing);
  if (room === 0) return { recorded: 0, truncated: true };
  const recorded = changes.slice(0, room);
  await fs.appendFile(path, `${recorded.map((change) => JSON.stringify(change)).join("\n")}\n`, "utf8");
  if (recorded.length < changes.length) {
    await fs.appendFile(path, `${JSON.stringify({ truncated: true, at: new Date().toISOString(), omitted: changes.length - recorded.length })}\n`, "utf8");
    return { recorded: recorded.length, truncated: true };
  }
  return { recorded: recorded.length, truncated: false };
}

/**
 * The incremental capture itself. It starts from the previous state map, so
 * a deleted file is noticed by its absence and a modified one by a changed
 * size/mtime; Spotlight only supplies paths the map has never seen.
 * 增量采集本身。它从上一份状态表出发，因此删除靠缺失发现、修改靠 size/mtime 变化发现；
 * Spotlight 只补充状态表从未见过的路径。
 */
async function captureLocked(
  options: CaptureFolderOptions,
  canonical: string,
  now: Date,
  home: string,
): Promise<CaptureFolderResult> {
  const dataDirectory = options.dataDirectory;
  const maxFiles = Math.max(1, Math.min(MAX_LEDGER_FILES, options.maxFiles ?? MAX_LEDGER_FILES));
  const maxDayChanges = Math.max(1, options.maxDayChanges ?? MAX_LEDGER_DAY_CHANGES);
  const previous = await readFolderState(dataDirectory, canonical);
  const baseline = previous === undefined;

  const usage = await readUsage(dataDirectory);
  const budget = { readBytes: 0 };
  const next = new Map<string, LedgerFileState>();
  const changes: WorkspaceDayChange[] = [];
  const captureAt = now.toISOString();
  const signal = options.signal;
  let mapChanged = baseline;
  let filtered = 0;
  const abortIfNeeded = (): void => {
    if (signal?.aborted === true) throw new Error("Capture aborted.");
  };
  abortIfNeeded();
  // Generated output is the owner's own definition when a repository ignores
  // it; the built-in patterns cover the folders that are not repositories.
  // 仓库忽略的生成物就是所有者自己的定义；内置模式覆盖不是仓库的文件夹。
  const repositories = await findRepositories(canonical).catch(() => []);
  const ignore = await cachedGitIgnoreIndex(repositories, now.getTime());

  // Known files: stat first. A stat is cheap; a read is not, so only a
  // changed identity earns one.
  // 已知文件先 stat。stat 便宜、读取不便宜，因此只有身份变化的文件才值得读。
  for (const [relativePath, before] of Object.entries(previous?.files ?? {})) {
    abortIfNeeded();
    if (!isSafeRelativePath(relativePath)) continue;
    const absolute = join(canonical, ...relativePath.split("/"));
    if (isNoisePath(absolute, canonical) || ignore.matches(absolute)) {
      filtered += 1;
      continue;
    }
    let info;
    try {
      info = await fs.lstat(absolute);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        // A deletion has no timestamp of its own; the capture time is the
        // honest upper bound, and the day file it lands in says so.
        // 删除没有自己的时间戳；采集时间是诚实上界，它落进哪一天的文件也说明了这一点。
        changes.push({ at: captureAt, path: relativePath, change: "deleted", before });
        mapChanged = true;
        continue;
      }
      next.set(relativePath, before);
      continue;
    }
    // A symlink is its own thing now. Following it here would write another
    // folder's (possibly protected) content into the ledger.
    // 符号链接现在只当作自身。跟随它会把别的文件夹（可能受保护）的内容写进台账。
    if (info.isSymbolicLink() || !info.isFile()) {
      changes.push({ at: captureAt, path: relativePath, change: "deleted", before });
      mapChanged = true;
      continue;
    }
    if (info.size === before.size && info.mtimeMs === before.mtimeMs) {
      next.set(relativePath, before);
      continue;
    }
    // A learned folder can contain a protected root (a home folder contains
    // ~/Library and its Keychains). The top-level check in the caller cannot
    // see that; refuse the content read here.
    // 一个已学会文件夹可能包含受保护根（home 文件夹包含 ~/Library 及其 Keychains）。
    // 调用方的顶层检查看不到这一点；在这里拒绝内容读取。
    if (isForbiddenPath(absolute, home)) continue;
    const read = await readFileState(absolute, info, budget);
    if (read.state.hash === before.hash) {
      next.set(relativePath, { ...read.state, mtimeMs: info.mtimeMs, size: info.size });
      mapChanged = true;
      continue;
    }
    if (read.content !== undefined) await storeBlob(dataDirectory, read.state.hash, read.content, usage);
    next.set(relativePath, read.state);
    mapChanged = true;
    // The change is filed under the day its mtime belongs to, not the day the
    // capture happened: a file edited while the app was closed must not appear
    // as work done on the day it was noticed.
    // 变更按其 mtime 所属的那一天归档，而不是采集发生的那一天：应用关闭期间的编辑不能
    // 被算作"被发现"的那天的工作。
    changes.push({ at: new Date(info.mtimeMs).toISOString(), path: relativePath, change: "modified", before, after: read.state });
  }

  // New paths. The baseline walks the whole folder once; later captures ask
  // Spotlight for files touched since the last capture. A gap that crosses a
  // day cannot use Spotlight's "today" query, so it gets the same deep walk as
  // the baseline instead of the turn-sized 8 s scan.
  // 新路径。基线遍历一次整个文件夹；之后的采集向 Spotlight 查询上次采集以来被触碰的文件。
  // 跨越一天的间隔用不了 Spotlight 的"今天"查询，因此走与基线相同的深遍历，而不是
  // 回合大小的 8 秒扫描。
  const sinceMs = previous === undefined ? 0 : new Date(previous.updatedAt).getTime();
  const gapCrossedMidnight = (() => {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return previous !== undefined
      && sinceMs < midnight.getTime()
      && now.getTime() - sinceMs > 2 * 3_600_000;
  })();
  const scan = previous === undefined || gapCrossedMidnight
    ? await walkFiles(canonical, sinceMs, maxFiles, {
      deadlineMs: BASELINE_WALK_DEADLINE_MS,
      maxDirectories: BASELINE_WALK_MAX_DIRECTORIES,
      ...(signal === undefined ? {} : { signal }),
    })
    : await scanFiles(canonical, sinceMs, maxFiles, now, Number.POSITIVE_INFINITY, signal);
  abortIfNeeded();
  filtered += scan.filtered;
  for (const file of scan.files) {
    abortIfNeeded();
    if (ignore.matches(file.path)) {
      filtered += 1;
      continue;
    }
    const relativePath = relative(canonical, file.path).split("\\").join("/");
    if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith("../") || next.has(relativePath)) continue;
    let info;
    try {
      info = await fs.lstat(file.path);
    } catch {
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    if (isForbiddenPath(file.path, home)) continue;
    const read = await readFileState(file.path, info, budget);
    if (read.content !== undefined) await storeBlob(dataDirectory, read.state.hash, read.content, usage);
    next.set(relativePath, read.state);
    mapChanged = true;
    // A first capture is a baseline, not a day full of "added" files.
    // 第一次采集是基线，不是一整天的"新增"文件。
    if (previous !== undefined) changes.push({ at: new Date(info.mtimeMs).toISOString(), path: relativePath, change: "added", after: read.state });
  }

  let truncated = scan.truncated;
  if (next.size > maxFiles) {
    const kept = [...next.entries()]
      .sort((left, right) => right[1].mtimeMs - left[1].mtimeMs)
      .slice(0, maxFiles);
    next.clear();
    for (const [path, state] of kept) next.set(path, state);
    truncated = true;
  }
  if (truncated !== (previous?.truncated ?? false)) mapChanged = true;
  if (Object.keys(previous?.files ?? {}).length !== next.size) mapChanged = true;

  // File the observed changes under the local day each one belongs to. A
  // capture after a gap can therefore repair several days at once, and the
  // digest for an older day still finds the change it missed live.
  // 把观察到的变更归档到各自所属的本地日。因此一次间隔之后的采集可以一次补齐好几天，
  // 更早那一天的摘要仍能找到当时没实时记录下的变更。
  let recordedCount = 0;
  let dayTruncated = false;
  const byDay = new Map<string, WorkspaceDayChange[]>();
  for (const change of changes) {
    const day = localDayKey(new Date(change.at));
    const list = byDay.get(day) ?? [];
    list.push(change);
    byDay.set(day, list);
  }
  for (const [day, list] of byDay) {
    const recorded = await appendDayChanges(dataDirectory, canonical, day, list, maxDayChanges);
    recordedCount += recorded.recorded;
    if (recorded.truncated) dayTruncated = true;
  }
  if (dayTruncated) truncated = true;
  abortIfNeeded();
  // A check with no map change writes only the small check file: rewriting a
  // 20k-entry map every 30 minutes for a folder nobody touched is pure disk
  // churn. The map's own updatedAt is the scan cutoff, so skipping it only
  // makes the next scan window slightly wider.
  // 没有地图变化的检查只写很小的检查文件：为没人动过的文件夹每 30 分钟重写 2 万条目的
  // 地图纯粹是磁盘浪费。地图自身的 updatedAt 是扫描截止时间，因此跳过一次只会让下一次
  // 扫描窗口稍宽。
  if (mapChanged) {
    await writeJsonAtomic(ledgerStateFile(dataDirectory, canonical), {
      folder: canonical,
      updatedAt: captureAt,
      baselineAt: previous?.baselineAt ?? captureAt,
      truncated,
      files: Object.fromEntries(next),
    } satisfies LedgerFolderState);
  }
  await writeJsonAtomic(ledgerCheckFile(dataDirectory, canonical), {
    folder: canonical,
    checkedAt: captureAt,
    truncated,
    baselineAt: previous?.baselineAt ?? captureAt,
    trackedFiles: next.size,
    filtered,
  } satisfies LedgerCheck);
  await writeUsage(dataDirectory, usage);
  return {
    folder: canonical,
    captured: true,
    baseline,
    changes: recordedCount,
    truncated,
    filtered,
  };
}

export async function captureWorkspaceFolder(options: CaptureFolderOptions): Promise<CaptureFolderResult> {
  const home = options.home ?? homedir();
  const now = options.now ?? new Date();
  if (options.signal?.aborted === true) {
    return { folder: options.folder, captured: false, baseline: false, changes: 0, truncated: false, filtered: 0, error: "Capture aborted." };
  }
  let canonical: string;
  try {
    canonical = canonicalPath(options.folder, home);
  } catch (error: unknown) {
    return { folder: options.folder, captured: false, baseline: false, changes: 0, truncated: false, filtered: 0, error: error instanceof Error ? error.message : String(error) };
  }
  if (isForbiddenPath(canonical, home)) {
    return { folder: canonical, captured: false, baseline: false, changes: 0, truncated: false, filtered: 0, error: "This is a protected location; no capture is allowed." };
  }
  let info;
  try {
    info = await fs.stat(canonical);
  } catch {
    return { folder: canonical, captured: false, baseline: false, changes: 0, truncated: false, filtered: 0, error: "This folder does not exist." };
  }
  if (!info.isDirectory()) {
    return { folder: canonical, captured: false, baseline: false, changes: 0, truncated: false, filtered: 0, error: "This path is a file, not a folder." };
  }

  const check = await readCheck(options.dataDirectory, canonical);
  if (!options.force && options.minIntervalMs !== 0 && check !== undefined) {
    const interval = options.minIntervalMs ?? LEDGER_CAPTURE_INTERVAL_MS;
    if (now.getTime() - new Date(check.checkedAt).getTime() < interval) {
      return { folder: canonical, captured: false, baseline: false, changes: 0, truncated: check.truncated, filtered: check.filtered };
    }
  }

  const paths = ledgerPaths(options.dataDirectory);
  await fs.mkdir(paths.root, { recursive: true });
  try {
    return await workspaceExecutionLock.run(canonical, () => captureLocked(options, canonical, now, home), {
      lockFile: paths.lockFile,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error: unknown) {
    return { folder: canonical, captured: false, baseline: false, changes: 0, truncated: false, filtered: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Capture the owner's folders. One folder failing must not stop the others:
 * a folder that disappeared or is protected is reported, not fatal.
 * 采集所有者的文件夹。一个文件夹失败不能停住其他：消失或受保护的文件夹只被报告，不致命。
 */
export async function captureWorkspaceLedger(options: CaptureLedgerOptions): Promise<CaptureFolderResult[]> {
  const results: CaptureFolderResult[] = [];
  for (const folder of options.folders.slice(0, MAX_LEDGER_FOLDERS)) {
    if (options.signal?.aborted === true) break;
    const result = await captureWorkspaceFolder({
      dataDirectory: options.dataDirectory,
      folder,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
      ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
      ...(options.maxDayChanges === undefined ? {} : { maxDayChanges: options.maxDayChanges }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    results.push(result);
  }
  // Retention is part of the bound the trade-off promises; the prune is
  // monthly and cheap, and runs only after the captures it must not block.
  // 保留期是取舍条目承诺的上限的一部分；清理每月一次、开销很小，并且只在本轮采集之后运行。
  if (options.signal?.aborted !== true) {
    await pruneWorkspaceLedger(options.dataDirectory, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }).catch(() => undefined);
  }
  return results;
}

/**
 * The day's records, reduced to the net effect per path: many saves of one
 * file read as one change from the day's first before to its last after.
 * 当天记录按路径归并为净效果：同一文件多次保存读作一次变更，从当天最初的"之前"到最后
 * 的"之后"。
 */
export async function readWorkspaceDay(dataDirectory: string, folder: string, dayKey: string): Promise<WorkspaceDay> {
  let source: string;
  try {
    source = await fs.readFile(ledgerDayFile(dataDirectory, folder, dayKey), "utf8");
  } catch {
    return { changes: [], truncated: false };
  }
  const records: WorkspaceDayChange[] = [];
  let truncated = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value = JSON.parse(trimmed) as Partial<WorkspaceDayChange> & { truncated?: unknown; omitted?: unknown };
      if (value.truncated === true) {
        truncated = true;
        continue;
      }
      if (typeof value.path !== "string" || typeof value.at !== "string") continue;
      if (!isSafeRelativePath(value.path)) continue;
      if (value.change !== "added" && value.change !== "modified" && value.change !== "deleted") continue;
      records.push({
        at: value.at,
        path: value.path,
        change: value.change,
        ...(isFileState(value.before) ? { before: value.before } : {}),
        ...(isFileState(value.after) ? { after: value.after } : {}),
      });
    } catch {
      continue;
    }
  }

  const byPath = new Map<string, WorkspaceDayChange>();
  for (const record of records) {
    const current = byPath.get(record.path);
    if (current === undefined) {
      byPath.set(record.path, { ...record });
      continue;
    }
    // First "before" and last "after" describe the day, regardless of how
    // many saves happened in between.
    // 第一个"之前"与最后一个"之后"描述这一天，不论中间保存了多少次。
    const merged: WorkspaceDayChange = {
      at: record.at,
      path: record.path,
      change: current.change,
      ...(current.before === undefined ? {} : { before: current.before }),
      ...(record.after === undefined ? {} : { after: record.after }),
    };
    if (merged.before === undefined && merged.after !== undefined) merged.change = "added";
    else if (merged.before !== undefined && merged.after === undefined) merged.change = "deleted";
    else if (merged.before !== undefined && merged.after !== undefined) merged.change = "modified";
    byPath.set(record.path, merged);
  }

  const changes = [...byPath.values()]
    .filter((change) => {
      // Created and deleted inside the day: the net effect is nothing.
      // 当天创建又删除：净效果为零。
      if (change.before === undefined && change.after === undefined) return false;
      if (change.change !== "modified") return true;
      // A file edited and reverted to the same content is not a change to
      // report; reporting it would pad every day with saves that meant nothing.
      // 改过又还原为相同内容的文件不算变更；报出来只会让每天都塞满没有意义的保存。
      return change.before?.hash !== change.after?.hash;
    })
    .sort((left, right) => right.at.localeCompare(left.at) || left.path.localeCompare(right.path));
  return { changes, truncated };
}

const MAX_DAY_EVENTS = 5_000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const eventWriteQueues = new Map<string, Promise<void>>();
const eventCapMarked = new Set<string>();

/**
 * One operation the watcher saw: what happened and when, never file content.
 * The content capture decides *what* changed; this line survives even when the
 * file itself was created and removed between two captures.
 * 监听器看到的一次操作：发生了什么、何时，绝不包含文件内容。内容采集决定"改了什么"；
 * 即使文件在两次采集之间创建又删除，这一行仍然存在。
 */
export async function recordWorkspaceEvent(options: {
  dataDirectory: string;
  folder: string;
  event: WorkspaceOperationEvent;
}): Promise<boolean> {
  const { dataDirectory, folder, event } = options;
  if (!isSafeRelativePath(event.path)) return false;
  if (event.kind !== "created" && event.kind !== "modified" && event.kind !== "removed") return false;
  const at = new Date(event.at);
  if (!Number.isFinite(at.getTime())) return false;
  const path = ledgerEventsFile(dataDirectory, folder, localDayKey(at));
  const previous = eventWriteQueues.get(path) ?? Promise.resolve();
  let recorded = false;
  const write = previous.then(async () => {
    try {
      const info = await fs.stat(path);
      if (info.size >= MAX_EVENT_BYTES) {
        // Leave one marker so the digest can say the day was capped instead
        // of presenting a full-looking list.
        // 留一个标记，使摘要能说明当天被截断，而不是呈现一份看起来完整的列表。
        if (!eventCapMarked.has(path)) {
          eventCapMarked.add(path);
          await fs.appendFile(path, `${JSON.stringify({ truncated: true, at: at.toISOString() })}\n`, "utf8");
        }
        return;
      }
    } catch {
      // First event of the day: there is no file to measure yet. 当天第一个事件：还没有文件可测量。
    }
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, `${JSON.stringify({ at: at.toISOString(), path: event.path, kind: event.kind })}\n`, "utf8");
    recorded = true;
  }).catch(() => undefined);
  eventWriteQueues.set(path, write);
  await write;
  if (eventWriteQueues.get(path) === write) eventWriteQueues.delete(path);
  return recorded;
}

export async function readWorkspaceEvents(
  dataDirectory: string,
  folder: string,
  dayKey: string,
): Promise<WorkspaceOperationDay> {
  let source: string;
  try {
    source = await fs.readFile(ledgerEventsFile(dataDirectory, folder, dayKey), "utf8");
  } catch {
    return { events: [], truncated: false };
  }
  const events: WorkspaceOperationEvent[] = [];
  let truncated = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (events.length >= MAX_DAY_EVENTS) {
      truncated = true;
      break;
    }
    try {
      const value = JSON.parse(trimmed) as Partial<WorkspaceOperationEvent> & { truncated?: unknown };
      if (value.truncated === true) {
        truncated = true;
        continue;
      }
      if (typeof value.at !== "string" || typeof value.path !== "string") continue;
      if (value.kind !== "created" && value.kind !== "modified" && value.kind !== "removed") continue;
      if (!isSafeRelativePath(value.path) || !Number.isFinite(Date.parse(value.at))) continue;
      events.push({ at: value.at, path: value.path, kind: value.kind });
    } catch {
      continue;
    }
  }
  events.sort((left, right) => left.at.localeCompare(right.at) || left.path.localeCompare(right.path));
  return { events, truncated };
}

function isFileState(value: unknown): value is LedgerFileState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<LedgerFileState>;
  if (typeof state.hash !== "string" || !SAFE_HASH_PATTERN.test(state.hash)) return false;
  if (state.text === true && !TEXT_HASH_PATTERN.test(state.hash)) return false;
  return typeof state.size === "number" && typeof state.mtimeMs === "number" && typeof state.text === "boolean";
}

/**
 * A bounded unified-style diff: common prefix/suffix trimmed, the middle shown
 * as one hunk. Not a minimal edit script, but the owner reads it as "what
 * changed", and it cannot spend a whole context on one file.
 * 有界的 unified 风格 diff：裁掉公共前后缀，中间作为一个 hunk 展示。不是最小编辑脚本，
 * 但所有者读得出"改了什么"，也不会在一个文件上耗尽整个上下文。
 */
export function renderUnifiedDiff(
  relativePath: string,
  beforeLabel: string,
  afterLabel: string,
  beforeText: string,
  afterText: string,
  options: { maxLines?: number; maxHunkLines?: number; contextLines?: number } = {},
): string {
  const maxLines = options.maxLines ?? 1_500;
  const maxHunkLines = options.maxHunkLines ?? 400;
  const contextLines = options.contextLines ?? 2;
  const split = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const before = split(beforeText);
  const after = split(afterText);
  if (before.length > maxLines || after.length > maxLines) {
    return `${relativePath}: too large to diff in a digest (${before.length} → ${after.length} lines).`;
  }

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const beforeLines = Math.min(maxHunkLines, removed.length);
  const afterLines = Math.min(maxHunkLines, added.length);
  const contextStart = Math.max(0, prefix - contextLines);
  const contextEndBefore = Math.min(before.length, before.length - suffix + contextLines);
  const contextEndAfter = Math.min(after.length, after.length - suffix + contextLines);

  const lines: string[] = [
    `--- a/${relativePath} (${beforeLabel})`,
    `+++ b/${relativePath} (${afterLabel})`,
    `@@ -${contextStart + 1},${contextEndBefore - contextStart} +${contextStart + 1},${contextEndAfter - contextStart} @@`,
  ];
  for (let index = contextStart; index < prefix; index += 1) lines.push(` ${before[index] ?? ""}`);
  for (let index = 0; index < beforeLines; index += 1) lines.push(`-${removed[index] ?? ""}`);
  if (removed.length > beforeLines) lines.push(`-… ${removed.length - beforeLines} more removed line(s)`);
  for (let index = 0; index < afterLines; index += 1) lines.push(`+${added[index] ?? ""}`);
  if (added.length > afterLines) lines.push(`+… ${added.length - afterLines} more added line(s)`);
  const suffixStart = Math.max(prefix, before.length - suffix);
  for (let index = suffixStart; index < contextEndBefore; index += 1) lines.push(` ${before[index] ?? ""}`);
  return lines.join("\n");
}

/**
 * Deletes day files past retention and the blobs nothing references any more.
 * A monthly pass is enough: the cap already stops growth; this reclaims the
 * versions that fell out of the retention window.
 * 删除超过保留期的日文件与不再被引用的块。每月一次足够：上限已经阻止增长；这一步回收
 * 掉出保留窗口的版本。
 */
export async function pruneWorkspaceLedger(
  dataDirectory: string,
  options: { now?: Date; retentionDays?: number; force?: boolean; signal?: AbortSignal } = {},
): Promise<{ removedDays: number; removedBlobs: number }> {
  const paths = ledgerPaths(dataDirectory);
  await fs.mkdir(paths.root, { recursive: true });
  // The same lock as capture: a prune that deletes a blob between its write and
  // the state/day row that references it would make the next diff look like
  // "content was never stored". Serializing costs one wait per month.
  // 与采集共用同一把锁：如果清理在块写入与引用它的状态/日行之间删掉块，下一次 diff 就会
  // 变成"内容从未保存过"。串行化的代价只是每月等一次。
  return workspaceExecutionLock.run(paths.root, () => pruneLocked(dataDirectory, options), {
    lockFile: paths.lockFile,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function pruneLocked(
  dataDirectory: string,
  options: { now?: Date; retentionDays?: number; force?: boolean; signal?: AbortSignal },
): Promise<{ removedDays: number; removedBlobs: number }> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? LEDGER_RETENTION_DAYS;
  const signal = options.signal;
  const abortIfNeeded = (): void => {
    if (signal?.aborted === true) throw new Error("Prune aborted.");
  };
  abortIfNeeded();
  const usage = await readUsage(dataDirectory);
  if (!options.force && usage.lastPruneAt !== undefined) {
    const last = new Date(usage.lastPruneAt).getTime();
    if (Number.isFinite(last) && now.getTime() - last < 30 * 24 * 3_600_000) {
      return { removedDays: 0, removedBlobs: 0 };
    }
  }
  const paths = ledgerPaths(dataDirectory);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffKey = localDayKey(cutoff);
  const referenced = new Set<string>();
  let removedDays = 0;

  const cutoffMs = cutoff.getTime();
  const stateEntries = await safeReaddir(paths.stateDirectory);
  for (const entry of stateEntries) {
    if (!entry.endsWith(".json") || entry.endsWith(".check.json")) continue;
    abortIfNeeded();
    const statePath = join(paths.stateDirectory, entry);
    const checkPath = join(paths.stateDirectory, `${entry.replace(/\.json$/, "")}.check.json`);
    const state = await readJson<LedgerFolderState>(statePath);
    const check = await readJson<LedgerCheck>(checkPath);
    if (state === undefined) {
      await fs.rm(statePath, { force: true }).catch(() => undefined);
      await fs.rm(checkPath, { force: true }).catch(() => undefined);
      continue;
    }
    const liveAt = typeof check?.checkedAt === "string" ? Date.parse(check.checkedAt) : Date.parse(state.updatedAt);
    if (Number.isFinite(liveAt) && liveAt < cutoffMs) {
      // A folder that rotated out of the learned set stops being checked; its
      // state must not pin the blob budget forever.
      // 轮出已学会集合的文件夹不再被检查；它的状态不能永远占住块预算。
      await fs.rm(statePath, { force: true }).catch(() => undefined);
      await fs.rm(checkPath, { force: true }).catch(() => undefined);
      continue;
    }
    for (const [path, file] of Object.entries(state.files ?? {})) {
      if (isSafeRelativePath(path) && isFileState(file)) addReference(referenced, file);
    }
  }
  for (const entry of stateEntries) {
    if (!entry.endsWith(".check.json")) continue;
    abortIfNeeded();
    const checkPath = join(paths.stateDirectory, entry);
    const check = await readJson<LedgerCheck>(checkPath);
    const checkedAt = typeof check?.checkedAt === "string" ? Date.parse(check.checkedAt) : Number.NaN;
    if (!Number.isFinite(checkedAt) || checkedAt < cutoffMs) {
      await fs.rm(checkPath, { force: true }).catch(() => undefined);
    }
  }

  const dayFolders = await safeReaddir(paths.daysDirectory);
  for (const folderEntry of dayFolders) {
    abortIfNeeded();
    const folderPath = join(paths.daysDirectory, folderEntry);
    let dayFiles: string[];
    try {
      dayFiles = await fs.readdir(folderPath);
    } catch {
      continue;
    }
    for (const dayFile of dayFiles) {
      const dayKey = dayFile.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? dayFile;
      if (dayKey < cutoffKey) {
        await fs.rm(join(folderPath, dayFile), { force: true }).catch(() => undefined);
        removedDays += 1;
        continue;
      }
      // Event logs contain paths and times, no content hashes. 事件日志只有路径与时间，没有内容哈希。
      if (dayFile.endsWith(".events.jsonl")) continue;
      const source = await fs.readFile(join(folderPath, dayFile), "utf8").catch(() => "");
      for (const line of source.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const value = JSON.parse(trimmed) as Partial<WorkspaceDayChange>;
          if (isFileState(value.before)) addReference(referenced, value.before);
          if (isFileState(value.after)) addReference(referenced, value.after);
        } catch {
          continue;
        }
      }
    }
  }

  let removedBlobs = 0;
  let blobBytes = 0;
  const blobShards = await safeReaddir(paths.blobsDirectory);
  for (const shard of blobShards) {
    abortIfNeeded();
    const shardPath = join(paths.blobsDirectory, shard);
    let blobs: string[];
    try {
      blobs = await fs.readdir(shardPath);
    } catch {
      continue;
    }
    for (const blob of blobs) {
      if (referenced.has(blob)) {
        blobBytes += (await fs.stat(join(shardPath, blob)).catch(() => undefined))?.size ?? 0;
        continue;
      }
      await fs.rm(join(shardPath, blob), { force: true }).catch(() => undefined);
      removedBlobs += 1;
    }
  }
  abortIfNeeded();
  await writeUsage(dataDirectory, { blobBytes, lastPruneAt: now.toISOString() });
  return { removedDays, removedBlobs };
}

function addReference(referenced: Set<string>, state: LedgerFileState): void {
  if (state.text && !state.hash.startsWith("meta:") && state.hash !== "unreadable") referenced.add(state.hash);
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}
