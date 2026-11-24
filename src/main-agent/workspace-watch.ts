/**
 * The daemon's file-system watch: one recursive FSEvents stream per learned
 * folder, recording operations (created / modified / removed) into the daily
 * ledger's event files.
 *
 * The 30-minute content capture answers "what changed inside the file"; this
 * watcher answers "that an operation happened, and when" at kernel cost. It
 * never reads file content: the file may already be gone, and reading it in
 * the listener would block the stream. Every event is filtered by the same
 * noise rules as the capture, deduplicated per path, and appended under the
 * day the event belongs to.
 *
 * The runtime is already a resident launchd LaunchAgent, so watching here also
 * covers the window being closed. Mac sleep/off cannot be covered by a
 * user-space watcher; the next capture's mtime backfill handles that gap.
 *
 * Daemon 的文件系统监听：每个已学会文件夹一条递归 FSEvents 流，把操作（创建 / 修改 /
 * 删除）记入每日台账的事件文件。
 *
 * 30 分钟的内容采集回答"文件里面改了什么"；这个监听器以内核级成本回答"发生过一次操作，
 * 在何时"。它绝不读取文件内容：文件可能已经没了，而且在监听器里读取会阻塞事件流。
 * 每个事件都过与采集相同的噪声规则、按路径去重，并按事件所属的那一天追加。
 *
 * 运行时已经是常驻 launchd LaunchAgent，因此这里的监听也覆盖窗口关闭的情形。Mac 休眠/
 * 关机期间用户态监听无法覆盖；下一次采集的 mtime 回填处理这个缺口。
 */
import { watch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { canonicalPath, isForbiddenPath } from "../authority/scope.ts";
import { knownOwnerFolders } from "./known-folders.ts";
import { cachedGitIgnoreIndex, isNoisePath, resetNoiseCache } from "./workspace-noise.ts";
import { findRepositories } from "./tools/recent-changes.ts";
import { recordWorkspaceEvent, type WorkspaceOperationKind } from "./workspace-ledger.ts";

export interface WorkspaceWatcherOptions {
  dataDirectory: string;
  home?: string;
  now?: () => Date;
  /** One record per path per window; a save usually emits several events. 每路径每个窗口一条记录；一次保存通常发出多个事件。 */
  dedupeMs?: number;
  /** Tests pass the folders directly; the daemon reads the learned set. 测试直接传入文件夹；Daemon 读取已学会集合。 */
  folders?: readonly string[];
  onError?: (message: string, error: unknown) => void;
}

const MAX_WATCHED_FOLDERS = 5;
const DEFAULT_DEDUPE_MS = 30_000;
const FOLDER_REFRESH_MS = 5 * 60_000;
const TURN_LEDGER_REFRESH_MS = 1_000;

export class WorkspaceWatcher {
  readonly #options: WorkspaceWatcherOptions;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #lastEvent = new Map<string, number>();
  readonly #repositories = new Map<string, { at: number; repos: string[] }>();
  readonly #inFlight = new Set<Promise<void>>();
  #folders: string[] = [];
  #refreshTimer: NodeJS.Timeout | undefined;
  #refreshDebounce: NodeJS.Timeout | undefined;
  #refreshInFlight: Promise<void> | undefined;
  #closed = false;
  #writes: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceWatcherOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    await this.refreshFolders();
    if (this.#closed) return;
    // A newly learned folder must be watched without waiting for the next
    // maintenance pass; the turn ledger is where a chat request lands first.
    // 新学会的文件夹必须在下一次维护之前被监听；聊天请求最先落在回合台账。
    const turnLedger = resolve(this.#options.dataDirectory, "main-agent-turns.jsonl");
    try {
      watchFile(turnLedger, { interval: TURN_LEDGER_REFRESH_MS, persistent: false }, (current, previous) => {
        if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) this.scheduleRefresh();
      });
    } catch (error: unknown) {
      this.#options.onError?.("Could not watch the turn ledger for newly learned folders", error);
    }
    this.#refreshTimer = setInterval(() => this.scheduleRefresh(), FOLDER_REFRESH_MS);
    this.#refreshTimer.unref();
  }

  /** Refresh the watched set from the owner's learned folders. 从所有者已学会的文件夹刷新监听集合。 */
  async refreshFolders(): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshInFlight !== undefined) return this.#refreshInFlight;
    this.#refreshInFlight = this.#refresh().finally(() => { this.#refreshInFlight = undefined; });
    return this.#refreshInFlight;
  }

  async #refresh(): Promise<void> {
    const home = this.#options.home ?? homedir();
    let folders: string[];
    if (this.#options.folders !== undefined) {
      folders = [...this.#options.folders];
    } else {
      const learned = await knownOwnerFolders(this.#options.dataDirectory, {
        ...(this.#options.home === undefined ? {} : { home: this.#options.home }),
        limit: MAX_WATCHED_FOLDERS,
      }).catch(() => []);
      folders = learned.map((folder) => folder.path);
    }
    const canonical: string[] = [];
    for (const folder of folders.slice(0, MAX_WATCHED_FOLDERS)) {
      let path: string;
      try {
        path = canonicalPath(folder, home);
        const info = await fs.stat(path);
        if (!info.isDirectory() || isForbiddenPath(path, home)) continue;
      } catch {
        continue;
      }
      if (!canonical.includes(path)) canonical.push(path);
    }
    this.#folders = canonical;

    for (const watched of this.#watchers.keys()) {
      if (!canonical.includes(watched)) {
        this.#watchers.get(watched)?.close();
        this.#watchers.delete(watched);
      }
    }
    for (const folder of canonical) {
      if (!this.#watchers.has(folder)) this.#watchFolder(folder);
    }
  }

  #watchFolder(folder: string): void {
    try {
      const watcher = watch(folder, { recursive: true, persistent: false }, (eventType, filename) => {
        const task = this.#handle(folder, eventType, filename);
        this.#inFlight.add(task);
        void task.finally(() => { this.#inFlight.delete(task); });
      });
      watcher.on("error", (error) => {
        this.#options.onError?.(`Folder watch failed for ${folder}`, error);
        watcher.close();
        this.#watchers.delete(folder);
      });
      this.#watchers.set(folder, watcher);
      // Warm the .gitignore cache so the first burst is already filtered.
      // 预热 .gitignore 缓存，使第一批事件已被过滤。
      void this.#refreshIgnore(folder);
    } catch (error: unknown) {
      this.#options.onError?.(`Could not watch folder ${folder}`, error);
    }
  }

  async #refreshIgnore(folder: string): Promise<void> {
    const repositories = await this.#repositoriesFor(folder);
    await cachedGitIgnoreIndex(repositories, (this.#options.now?.() ?? new Date()).getTime()).catch(() => undefined);
  }

  async #repositoriesFor(folder: string): Promise<string[]> {
    const now = (this.#options.now?.() ?? new Date()).getTime();
    const cached = this.#repositories.get(folder);
    if (cached !== undefined && now - cached.at < 5 * 60_000) return cached.repos;
    const repos = await findRepositories(folder).catch(() => []);
    this.#repositories.set(folder, { at: now, repos });
    return repos;
  }

  async #handle(folder: string, eventType: string, filename: string | Buffer | null): Promise<void> {
    if (this.#closed || filename === null) return;
    const name = typeof filename === "string" ? filename : filename.toString("utf8");
    if (name.length === 0) return;
    const absolute = resolve(folder, name);
    if (!absolute.startsWith(`${folder}/`)) return;
    if (isNoisePath(absolute, folder)) return;

    if (name === ".gitignore" || name.endsWith("/.gitignore")) {
      resetNoiseCache();
      void this.#refreshIgnore(folder);
    }

    let kind: WorkspaceOperationKind;
    try {
      const info = await fs.lstat(absolute);
      if (info.isDirectory() || info.isSymbolicLink()) return;
      kind = eventType === "rename" ? "created" : "modified";
    } catch {
      kind = "removed";
    }

    const repositories = await this.#repositoriesFor(folder);
    const ignore = await cachedGitIgnoreIndex(repositories, (this.#options.now?.() ?? new Date()).getTime());
    if (ignore.matches(absolute)) return;
    if (this.#closed) return;

    const now = (this.#options.now?.() ?? new Date()).getTime();
    const dedupeMs = this.#options.dedupeMs ?? DEFAULT_DEDUPE_MS;
    const previous = this.#lastEvent.get(absolute);
    if (previous !== undefined && now - previous < dedupeMs) return;
    this.#lastEvent.set(absolute, now);
    if (this.#lastEvent.size > 5_000) {
      for (const [path, at] of this.#lastEvent) {
        if (now - at > dedupeMs * 2) this.#lastEvent.delete(path);
      }
    }

    const relativePath = absolute.slice(folder.length + 1).split("\\").join("/");
    const at = new Date(now).toISOString();
    this.#writes = this.#writes.then(async () => {
      await recordWorkspaceEvent({
        dataDirectory: this.#options.dataDirectory,
        folder,
        event: { at, path: relativePath, kind },
      }).catch((error: unknown) => {
        this.#options.onError?.("Could not record a workspace operation", error);
      });
    });
    await this.#writes;
  }

  scheduleRefresh(): void {
    if (this.#closed) return;
    // Trailing debounce: a burst of turn-ledger writes refreshes once.
    // 尾随去抖：一串回合台账写入只刷新一次。
    clearTimeout(this.#refreshDebounce);
    this.#refreshDebounce = setTimeout(() => { void this.refreshFolders(); }, 500);
    this.#refreshDebounce.unref?.();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#refreshDebounce);
    if (this.#refreshTimer !== undefined) clearInterval(this.#refreshTimer);
    try {
      unwatchFile(resolve(this.#options.dataDirectory, "main-agent-turns.jsonl"));
    } catch {
      // Not watching the turn ledger. 没有在监听回合台账。
    }
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    await Promise.allSettled([...this.#inFlight]);
    await this.#writes.catch(() => undefined);
  }

  /** Read-only view for tests and the daemon: the folders currently watched. 供测试与 Daemon 只读查看当前监听的文件夹。 */
  watchedFolders(): string[] {
    return [...this.#watchers.keys()];
  }
}
