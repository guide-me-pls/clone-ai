import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import type { Connector, ConnectorReadResult, Observation } from "./connector.ts";

export interface FileConnectorOptions {
  id?: string;
  /** Directory the owner explicitly pointed at. 所有者显式指定的目录。 */
  root: string;
  /** File extensions worth observing. 值得观察的文件扩展名。 */
  extensions?: readonly string[];
  maxFiles?: number;
  maxBodyCharacters?: number;
}

const DEFAULT_EXTENSIONS = [".md", ".markdown", ".txt"] as const;
const IGNORED_DIRECTORIES = new Set([".git", ".clone", ".clone-ai", "node_modules", "dist", "build", ".venv"]);

/**
 * The first observation source: a directory of notes the owner chose to share.
 *
 * A directory is the honest place to start because it needs no credential, no
 * network, and no vendor — which keeps the first version of the boundary about
 * the boundary itself rather than about an integration. It reads and nothing
 * else; the runtime decides whether anything observed deserves a proposal.
 *
 * 第一个观察来源：所有者选择共享的笔记目录。
 *
 * 从目录开始是诚实的选择，因为它不需要凭据、不需要网络、不依赖任何厂商——这让这条边界的
 * 第一个版本聚焦于边界本身，而不是某个集成。它只读取，别的什么都不做；观察到的内容是否
 * 值得形成提案，由 Runtime 决定。
 */
export class FileConnector implements Connector {
  readonly id: string;
  readonly label = "Local notes";
  readonly scope: string;
  readonly #root: string;
  readonly #extensions: ReadonlySet<string>;
  readonly #maxFiles: number;
  readonly #maxBody: number;

  constructor(options: FileConnectorOptions) {
    this.id = options.id ?? "local-files";
    this.#root = resolve(options.root);
    this.scope = `Read-only: ${this.#root}`;
    this.#extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
    this.#maxFiles = options.maxFiles ?? 200;
    this.#maxBody = options.maxBodyCharacters ?? 400;
  }

  async read(options: { since?: string; limit?: number } = {}): Promise<ConnectorReadResult> {
    const observedAt = new Date().toISOString();
    const since = options.since === undefined ? undefined : Date.parse(options.since);
    const limit = Math.min(options.limit ?? this.#maxFiles, this.#maxFiles);
    const observations: Observation[] = [];

    try {
      await this.walk(this.#root, observations, since, limit);
    } catch (error: unknown) {
      // A missing or unreadable root is reported, not thrown: one broken
      // source must not blind every other connector.
      // 根目录缺失或不可读会被报告而不是抛出：单个来源出问题不能让其他 Connector 一起失明。
      return {
        connectorId: this.id,
        observedAt,
        observations: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    observations.sort((left, right) => (right.occurredAt ?? "").localeCompare(left.occurredAt ?? ""));
    return { connectorId: this.id, observedAt, observations: observations.slice(0, limit) };
  }

  private async walk(
    directory: string,
    into: Observation[],
    since: number | undefined,
    limit: number,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (into.length >= limit) return;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await this.walk(absolute, into, since, limit);
        continue;
      }
      if (!entry.isFile() || !this.#extensions.has(extname(entry.name).toLocaleLowerCase())) continue;

      const info = await stat(absolute);
      if (since !== undefined && info.mtimeMs <= since) continue;

      const relativePath = relative(this.#root, absolute).split(sep).join("/");
      into.push({
        externalId: relativePath,
        kind: "file",
        title: basename(entry.name, extname(entry.name)),
        body: await this.readHead(absolute),
        occurredAt: new Date(info.mtimeMs).toISOString(),
        locator: relativePath,
      });
    }
  }

  private async readHead(path: string): Promise<string | undefined> {
    try {
      const content = await readFile(path, "utf8");
      const head = content.slice(0, this.#maxBody).trim();
      return head.length === 0 ? undefined : head;
    } catch {
      return undefined;
    }
  }
}
