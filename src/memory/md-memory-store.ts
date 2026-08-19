/**
 * Memory storage: SQLite keeps the metadata and the bigram search index;
 * Markdown files keep the human-readable content. The user edits .md files
 * directly; syncFromFiles() folds those edits back into the index.
 *
 * 记忆存储：SQLite 保存元数据与大字符组（bigram）检索索引；Markdown 文件保存人可读
 * 的正文。用户直接编辑 .md 文件；syncFromFiles() 把这些编辑同步回索引。
 *
 * Why not FTS5 for Chinese: the trigram tokenizer needs three characters, so
 * two-character words (风险, 发布) never match. A plain bigram term table is
 * predictable, testable, and works for both CJK and Latin text.
 * 为什么不用 FTS5 处理中文：trigram 分词器最少需要三个字符，两个字的中文词（风险、
 * 发布）永远匹配不上。普通 bigram 词表可预测、可测试，且同时覆盖中日韩与拉丁文本。
 *
 * Governance philosophy: the journal is the truth; this SQLite index is a
 * rebuildable projection of the committed memory, and each .md file is the
 * content layer the owner may edit by hand.
 * 治理哲学：Journal 是真相；这个 SQLite 索引是已提交记忆的可重建投影；每个 .md 文件
 * 是所有者可以手改的内容层。
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MemorySensitivity, MemoryType } from "../core/contracts.ts";

export type MemoryStatus = "active" | "archived";
export type MemoryConfidence = "low" | "medium" | "high";

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  sensitivity: MemorySensitivity;
  sourceRunId?: string;
  sourceEvidenceIds: string[];
  /** One-line summary; also the first line of the .md file. 一句话摘要，也是 .md 文件首行。 */
  summary: string;
  /** Full human-readable content. 完整的人可读正文。 */
  content: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  accessCount: number;
  lastAccessedAt?: string;
}

export interface MemoryCommitInput {
  summary: string;
  content?: string;
  type: MemoryType;
  confidence: MemoryConfidence;
  sensitivity?: MemorySensitivity;
  sourceRunId?: string;
  sourceEvidenceIds?: string[];
  expiresAt?: string;
}

export interface MemoryRecallMatch {
  entry: MemoryEntry;
  score: number;
  matchedTerms: string[];
}

const DEFAULT_SENSITIVITY: MemorySensitivity = "private";

/**
 * Splits mixed CJK/Latin text into search terms: Latin words as-is, CJK runs
 * into sliding bigrams. Two-character words like 风险 must match, so trigram
 * tokenizers are out.
 *
 * 把中日韩/拉丁混合文本切成检索词：拉丁单词原样，中日韩连续段切成滑动 bigram。
 * 两个字的中文词（风险）必须能命中，因此 trigram 分词器不可用。
 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  const cjkRuns = text.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  const latin = text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0 && /[a-z0-9]/.test(word));
  for (const word of latin) tokens.add(word);
  return [...tokens];
}

export interface MemoryStoreOptions {
  dataDirectory: string;
  /** Name of the index database file. 索引数据库文件名。 */
  databaseFile?: string;
  /** Name of the markdown content directory. Markdown 正文目录名。 */
  contentDirectory?: string;
}

export class MdMemoryStore {
  readonly #directory: string;
  readonly #contentDirectory: string;
  readonly #db: DatabaseSync;

  constructor(options: MemoryStoreOptions) {
    this.#directory = resolve(options.dataDirectory);
    this.#contentDirectory = join(this.#directory, options.contentDirectory ?? "memory");
    const databasePath = join(this.#directory, options.databaseFile ?? "memory-index.db");
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        source_run_id TEXT,
        source_evidence_ids TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        content_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_terms (
        memory_id TEXT NOT NULL,
        term TEXT NOT NULL,
        PRIMARY KEY (memory_id, term)
      );
      CREATE INDEX IF NOT EXISTS idx_terms ON memory_terms (term);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);
    `);
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  /** Commits a memory: SQLite row + term index + .md file. 提交一条记忆：写 SQLite、词表与 .md 文件。 */
  async commit(input: MemoryCommitInput): Promise<MemoryEntry> {
    const summary = input.summary.trim();
    if (summary.length < 3) throw new Error("A memory needs at least three characters.");
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: `mem-${randomUUID().slice(0, 12)}`,
      type: input.type,
      status: "active",
      confidence: input.confidence,
      sensitivity: input.sensitivity ?? DEFAULT_SENSITIVITY,
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
      sourceEvidenceIds: input.sourceEvidenceIds ?? [],
      summary,
      content: input.content?.trim() ?? summary,
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      accessCount: 0,
    };
    await this.writeEntry(entry);
    return entry;
  }

  async list(options: { status?: MemoryStatus; type?: MemoryType } = {}): Promise<MemoryEntry[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.status !== undefined) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.type !== undefined) {
      clauses.push("type = ?");
      params.push(options.type);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.#db.prepare(`SELECT * FROM memories${where} ORDER BY updated_at DESC`).all(...params);
    return rows.map((row) => this.rowToEntry(row as Record<string, unknown>));
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const row = this.#db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row === undefined ? undefined : this.rowToEntry(row as Record<string, unknown>);
  }

  /**
   * Bigram lexical recall with governance filters. Scoring is the matched-term
   * ratio, nudged by recency and usage so a fresh, frequently used memory wins
   * ties.
   * bigram 词法召回，带治理过滤。评分是命中词占比，再以新鲜度和使用次数微调，使较新、
   * 常用的记忆在平分时胜出。
   */
  async recall(query: string, options: { maxResults?: number; includeSecret?: boolean } = {}): Promise<MemoryRecallMatch[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const now = new Date().toISOString();
    const placeholders = terms.map(() => "?").join(", ");
    const rows = this.#db.prepare(`
      SELECT t.memory_id, t.term
      FROM memory_terms t
      JOIN memories m ON m.id = t.memory_id
      WHERE t.term IN (${placeholders})
        AND m.status = 'active'
        AND (m.expires_at IS NULL OR m.expires_at > ?)
        AND (m.sensitivity != 'secret' OR ? = 1)
    `).all(...terms, now, options.includeSecret === true ? 1 : 0) as Array<{ memory_id: string; term: string }>;

    const byId = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = byId.get(row.memory_id) ?? new Set<string>();
      set.add(row.term);
      byId.set(row.memory_id, set);
    }

    const matches: MemoryRecallMatch[] = [];
    for (const [memoryId, matched] of byId) {
      const entry = await this.get(memoryId);
      if (entry === undefined) continue;
      const ratio = matched.size / terms.length;
      if (ratio < 0.2) continue;
      const recencyBoost = Math.max(0, 1 - (Date.now() - Date.parse(entry.updatedAt)) / (90 * 24 * 3600 * 1000));
      const usageBoost = Math.min(0.1, entry.accessCount * 0.01);
      matches.push({
        entry,
        score: Number((ratio + recencyBoost * 0.15 + usageBoost).toFixed(3)),
        matchedTerms: [...matched],
      });
      await this.touch(memoryId);
    }
    matches.sort((left, right) => right.score - left.score);
    const limit = options.maxResults ?? 4;
    return matches.slice(0, limit);
  }

  async update(id: string, update: Partial<Pick<MemoryEntry, "summary" | "content" | "type" | "confidence" | "sensitivity" | "expiresAt" | "status">>): Promise<MemoryEntry> {
    const entry = await this.requireEntry(id);
    const summary = update.summary?.trim() ?? entry.summary;
    if (summary.length < 3) throw new Error("A memory needs at least three characters.");
    const next: MemoryEntry = {
      ...entry,
      ...(update.summary === undefined ? {} : { summary }),
      ...(update.content === undefined ? {} : { content: update.content.trim() }),
      ...(update.type === undefined ? {} : { type: update.type }),
      ...(update.confidence === undefined ? {} : { confidence: update.confidence }),
      ...(update.sensitivity === undefined ? {} : { sensitivity: update.sensitivity }),
      ...(update.expiresAt === undefined ? {} : { expiresAt: update.expiresAt }),
      ...(update.status === undefined ? {} : { status: update.status }),
      updatedAt: new Date().toISOString(),
    };
    await this.writeEntry(next);
    return next;
  }

  async archive(id: string): Promise<MemoryEntry> {
    return this.update(id, { status: "archived" });
  }

  async restore(id: string): Promise<MemoryEntry> {
    return this.update(id, { status: "active" });
  }

  /** Moves expired memories to archived and returns their ids. 把过期记忆归档并返回其 id。 */
  async expireDue(): Promise<string[]> {
    const now = new Date().toISOString();
    const rows = this.#db.prepare("SELECT id FROM memories WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").all(now);
    const ids = rows.map((row) => (row as { id: string }).id);
    for (const id of ids) await this.archive(id);
    return ids;
  }

  /**
   * Folds owner edits made directly to the .md files back into the index.
   * Files present on disk but missing from the index are committed as
   * hand-authored memories; deleted files are archived.
   * 把所有者直接编辑 .md 文件的改动同步回索引：磁盘上有而索引里没有的文件按手写记忆
   * 提交；被删除的文件归档。
   */
  async syncFromFiles(): Promise<{ added: number; archived: number; updated: number }> {
    await mkdir(this.#contentDirectory, { recursive: true });
    const archivedDirectory = join(this.#contentDirectory, "archived");
    const seen = new Set<string>();
    const counters = { added: 0, archived: 0, updated: 0 };

    const scan = async (directory: string, status: MemoryStatus): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const path = join(directory, entry.name);
        const parsed = parseMemoryFile(await readFile(path, "utf8"));
        if (parsed === undefined) continue;
        const id = entry.name.replace(/\.md$/, "");
        seen.add(id);
        const existing = await this.get(id);
        if (existing === undefined) {
          await this.writeEntry({
            ...parsed,
            id,
            status,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            accessCount: 0,
          });
          counters.added += 1;
        } else if (existing.summary !== parsed.summary || existing.content !== parsed.content || existing.status !== status) {
          await this.writeEntry({ ...existing, ...parsed, id, status, updatedAt: new Date().toISOString() });
          counters.updated += 1;
        }
      }
    };

    await scan(this.#contentDirectory, "active");
    await scan(archivedDirectory, "archived");

    const known = await this.list();
    for (const entry of known) {
      if (!seen.has(entry.id) && entry.status === "active") {
        await this.archive(entry.id);
        counters.archived += 1;
      }
    }
    return counters;
  }

  async stats(): Promise<{ active: number; archived: number; total: number }> {
    const rows = this.#db.prepare("SELECT status, COUNT(*) AS count FROM memories GROUP BY status").all() as Array<{ status: string; count: number }>;
    const active = rows.find((row) => row.status === "active")?.count ?? 0;
    const archived = rows.find((row) => row.status === "archived")?.count ?? 0;
    return { active, archived, total: active + archived };
  }

  private async requireEntry(id: string): Promise<MemoryEntry> {
    const entry = await this.get(id);
    if (entry === undefined) throw new Error(`Memory ${id} does not exist.`);
    return entry;
  }

  private async writeEntry(entry: MemoryEntry): Promise<void> {
    const archived = entry.status === "archived";
    const directory = archived ? join(this.#contentDirectory, "archived") : this.#contentDirectory;
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${entry.id}.md`);
    const previousDirectory = archived ? this.#contentDirectory : join(this.#contentDirectory, "archived");
    const previous = join(previousDirectory, `${entry.id}.md`);
    if (previous !== target) {
      await rename(previous, target).catch(() => undefined);
    }
    await writeFile(target, renderMemoryFile(entry), "utf8");

    const terms = tokenize(`${entry.summary} ${entry.content}`);
    this.#db.prepare("DELETE FROM memory_terms WHERE memory_id = ?").run(entry.id);
    const insertTerm = this.#db.prepare("INSERT OR IGNORE INTO memory_terms (memory_id, term) VALUES (?, ?)");
    for (const term of terms) insertTerm.run(entry.id, term);

    this.#db.prepare(`
      INSERT INTO memories (id, type, status, confidence, sensitivity, source_run_id, source_evidence_ids,
        summary, content, content_path, created_at, updated_at, expires_at, access_count, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        type = excluded.type, status = excluded.status, confidence = excluded.confidence,
        sensitivity = excluded.sensitivity, source_run_id = excluded.source_run_id,
        source_evidence_ids = excluded.source_evidence_ids, summary = excluded.summary,
        content = excluded.content, content_path = excluded.content_path, updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      entry.id, entry.type, entry.status, entry.confidence, entry.sensitivity,
      entry.sourceRunId ?? null, JSON.stringify(entry.sourceEvidenceIds),
      entry.summary, entry.content, `${entry.id}.md`, entry.createdAt, entry.updatedAt,
      entry.expiresAt ?? null, entry.accessCount, entry.lastAccessedAt ?? null,
    );
  }

  private async touch(id: string): Promise<void> {
    this.#db.prepare(`
      UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  private rowToEntry(row: Record<string, unknown>): MemoryEntry {
    return {
      id: String(row.id),
      type: row.type as MemoryType,
      status: row.status as MemoryStatus,
      confidence: row.confidence as MemoryConfidence,
      sensitivity: row.sensitivity as MemorySensitivity,
      ...(row.source_run_id == null ? {} : { sourceRunId: String(row.source_run_id) }),
      sourceEvidenceIds: JSON.parse(String(row.source_evidence_ids)) as string[],
      summary: String(row.summary),
      content: String(row.content),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.expires_at == null ? {} : { expiresAt: String(row.expires_at) }),
      accessCount: Number(row.access_count),
      ...(row.last_accessed_at == null ? {} : { lastAccessedAt: String(row.last_accessed_at) }),
    };
  }
}

/** Renders an entry as a front-matter markdown file. 把条目渲染成带 front matter 的 Markdown 文件。 */
export function renderMemoryFile(entry: MemoryEntry): string {
  return [
    "---",
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    `status: ${entry.status}`,
    `confidence: ${entry.confidence}`,
    `sensitivity: ${entry.sensitivity}`,
    ...(entry.sourceRunId === undefined ? [] : [`sourceRunId: ${entry.sourceRunId}`]),
    `sourceEvidenceIds: ${JSON.stringify(entry.sourceEvidenceIds)}`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    ...(entry.expiresAt === undefined ? [] : [`expiresAt: ${entry.expiresAt}`]),
    `accessCount: ${entry.accessCount}`,
    "---",
    entry.summary,
    "",
    entry.content,
  ].join("\n");
}

/** Parses the front-matter subset used by memory files. 解析记忆文件使用的 front matter 子集。 */
export function parseMemoryFile(source: string): Omit<MemoryEntry, "id" | "accessCount" | "createdAt" | "updatedAt" | "lastAccessedAt"> | undefined {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match === null) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const type = fields.get("type");
  const confidence = fields.get("confidence");
  const sensitivity = fields.get("sensitivity");
  if (type === undefined || confidence === undefined || sensitivity === undefined) return undefined;
  const body = match[2]!.trim();
  const lines = body.split("\n");
  const summary = lines[0]?.trim() ?? "";
  const content = lines.slice(1).join("\n").trim();
  return {
    type: type as MemoryType,
    status: (fields.get("status") ?? "active") === "archived" ? "archived" : "active",
    confidence: confidence as MemoryConfidence,
    sensitivity: sensitivity as MemorySensitivity,
    ...(fields.get("sourceRunId") === undefined ? {} : { sourceRunId: fields.get("sourceRunId") }),
    sourceEvidenceIds: parseIds(fields.get("sourceEvidenceIds")),
    summary,
    content: content.length === 0 ? summary : content,
  };
}

function parseIds(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
