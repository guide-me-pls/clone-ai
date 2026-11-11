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
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MemorySensitivity, MemoryType } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";

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
  /**
   * When the remembered thing actually happened, e.g. the date of the
   * conversation it came from. Defaults to commit time. Recall's recency
   * signal reads this field: a memory mined today about last month must not
   * outrank one mined today about yesterday.
   * 被记住的事情实际发生的时间，例如它来源的那次对话的日期。默认为提交时间。召回的
   * 新鲜度信号读取此字段：今天从上月对话里挖出的记忆，不该压过今天从昨天对话里挖出的。
   */
  occurredAt?: string;
}

export type MemoryUpdate = Partial<Pick<MemoryEntry, "summary" | "content" | "type" | "confidence" | "sensitivity" | "expiresAt" | "status">>;

export interface MemoryRecallMatch {
  entry: MemoryEntry;
  score: number;
  matchedTerms: string[];
}

const DEFAULT_SENSITIVITY: MemorySensitivity = "private";
const RECALL_ALIASES: readonly (readonly string[])[] = [
  ["周报", "每周汇报", "工作汇报"],
  ["会议", "开会"],
  ["截止时间", "到期时间"],
];

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

function expandedRecallTerms(query: string, direct: ReadonlySet<string>): string[] {
  const terms = new Set<string>();
  for (const group of RECALL_ALIASES) {
    if (!group.some((phrase) => query.includes(phrase))) continue;
    for (const phrase of group) {
      for (const term of tokenize(phrase)) if (!direct.has(term)) terms.add(term);
    }
  }
  return [...terms].slice(0, 128);
}

/** A memory admitted on cosine alone (no bigram ratio) still needs this much. 只靠余弦（没有 bigram 比例）进入结果的记忆，仍需达到这个值。 */
export const COSINE_ONLY_FLOOR = 0.45;
/** The match floor applied to preference memories instead of the product default. 偏好记忆使用、替代产品默认值的命中下限。 */
export const PREFERENCE_MIN_RATIO = 0.08;

/**
 * Latin function words carry no retrieval signal, and a single shared "the"
 * used to be enough to admit an unrelated memory (1 of 5 terms = the 0.2 floor).
 * English LongMemEval questions made that visible. Chinese bigrams need no list:
 * a two-character function word is already rare enough to be informative.
 * 拉丁虚词不携带检索信号，而共享一个 "the" 过去就足以让无关记忆通过（5 个词命中 1 个即达到
 * 0.2 下限）。LongMemEval 的英文问题让这一点暴露出来。中文 bigram 不需要词表：二字的虚词本身
 * 已足够罕见，仍具信息量。
 */
/**
 * Chinese function bigrams. The Latin list exists because a shared "the" was
 * enough to admit an unrelated memory; the same is true of 必须, 应该 and 时候,
 * which appear in almost any sentence. Excluding them from the "substantive"
 * gate is what lets the preference floor be lowered without turning common
 * phrasing into matches.
 * 中文虚词 bigram。拉丁词表的存在是因为共享一个 "the" 就足以放进无关记忆；必须、应该、时候同理，
 * 它们几乎出现在任何句子里。把它们排除在"实词"判定之外，正是让偏好下限可以调低、而不会把常见措辞变成
 * 匹配的前提。
 */
const CJK_FUNCTION_WORDS = new Set([
  "我们", "你们", "他们", "这个", "那个", "已经", "因为", "所以", "但是", "如果",
  "就是", "不是", "没有", "必须", "需要", "可以", "应该", "什么", "怎么", "为什",
  "时候", "现在", "今天", "明天", "一个", "一些", "自己",
]);

const LATIN_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does", "for",
  "from", "had", "has", "have", "he", "her", "his", "how", "i", "if", "in", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
]);

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
      -- Sparse lexical vector per memory: term -> local weight, used for cosine.
      -- Term rows answer "which memories contain this token" quickly; without the
      -- weight an IDF-blind hit counts as much as a distinctive one.
      -- 每条记忆的稀疏词法向量：term -> 局部权重，用于余弦相似度。term 行快速回答
      -- "哪些记忆包含这个词"；没有权重时，一个毫无区分度的命中会与一个特征词等值。
      CREATE TABLE IF NOT EXISTS memory_term_weights (
        memory_id TEXT NOT NULL,
        term TEXT NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY (memory_id, term)
      );
      CREATE INDEX IF NOT EXISTS idx_term_weights ON memory_term_weights (term);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);
      CREATE TABLE IF NOT EXISTS memory_mutations (
        id TEXT PRIMARY KEY,
        entry TEXT NOT NULL
      );
    `);
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  /**
   * Where the .md files live. The owner is meant to open this folder, so the
   * path is part of the store's public surface rather than a private detail.
   * .md 文件所在目录。所有者本就应该能打开这个文件夹，因此路径属于 Store 的公开接口，
   * 而不是私有细节。
   */
  get contentDirectory(): string {
    return this.#contentDirectory;
  }

  get governanceLockPath(): string {
    return join(this.#directory, "memory-governance-lock");
  }

  /** Commits a memory: SQLite row + term index + .md file. 提交一条记忆：写 SQLite、词表与 .md 文件。 */
  async commit(input: MemoryCommitInput): Promise<MemoryEntry> {
    const entry = this.prepareCommit(input);
    await this.writeEntry(entry);
    return entry;
  }

  prepareCommit(input: MemoryCommitInput): MemoryEntry {
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
      content: input.content?.trim() || summary,
      // createdAt is when the thing happened, not when we wrote it down.
      // createdAt 是事情发生的时间，不是我们把它写下的时间。
      createdAt: input.occurredAt ?? now,
      updatedAt: now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      accessCount: 0,
    };
    return entry;
  }

  async prepareUpdate(id: string, update: MemoryUpdate): Promise<MemoryEntry> {
    const entry = await this.requireEntry(id);
    const summary = update.summary?.trim() ?? entry.summary;
    if (summary.length < 3) throw new Error("A memory needs at least three characters.");
    return {
      ...entry,
      ...(update.summary === undefined ? {} : { summary }),
      content: update.content === undefined ? (entry.content.trim() || summary) : (update.content.trim() || summary),
      ...(update.type === undefined ? {} : { type: update.type }),
      ...(update.confidence === undefined ? {} : { confidence: update.confidence }),
      ...(update.sensitivity === undefined ? {} : { sensitivity: update.sensitivity }),
      ...(update.expiresAt === undefined ? {} : { expiresAt: update.expiresAt }),
      ...(update.status === undefined ? {} : { status: update.status }),
      updatedAt: new Date().toISOString(),
    };
  }

  stageMutation(entry: MemoryEntry, options: { acceptFileEdit?: boolean } = {}): string {
    const row = this.#db.prepare("SELECT * FROM memories WHERE id = ?").get(entry.id);
    const previous = row === undefined ? undefined : this.rowToEntry(row as Record<string, unknown>);
    const sourceStatus = previous?.status ?? entry.status;
    const source = this.memoryPath(entry.id, sourceStatus);
    const target = this.memoryPath(entry.id, entry.status);
    const sourceText = readOptionalFile(source);
    const targetText = source === target ? sourceText : readOptionalFile(target);
    if (previous !== undefined && !options.acceptFileEdit) {
      const parsed = sourceText === undefined ? undefined : parseMemoryFile(sourceText);
      if (parsed === undefined || parsed.summary !== previous.summary || parsed.content !== (previous.content || previous.summary)
        || parsed.type !== previous.type || parsed.sensitivity !== previous.sensitivity || parsed.status !== previous.status) {
        throw new Error(`Memory ${entry.id} changed on disk; sync the file before updating it.`);
      }
    }
    if (!options.acceptFileEdit && source !== target && targetText !== undefined && hashOptional(targetText) !== hashOptional(renderMemoryFile(entry))) {
      throw new Error(`Memory ${entry.id} already has a conflicting file at its destination.`);
    }
    const id = randomUUID();
    this.#db.prepare("INSERT INTO memory_mutations (id, entry) VALUES (?, ?)").run(id, JSON.stringify({
      entry, sourceStatus, sourceHash: hashOptional(sourceText), targetHash: hashOptional(targetText),
    }));
    return id;
  }

  pendingMutationIds(): string[] {
    const rows = this.#db.prepare("SELECT id FROM memory_mutations ORDER BY rowid").all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  pendingMutations(): Array<{ id: string; memoryId: string; summary: string }> {
    const rows = this.#db.prepare("SELECT id, entry FROM memory_mutations ORDER BY rowid").all() as Array<{ id: string; entry: string }>;
    return rows.map((row) => {
      const staged = JSON.parse(row.entry) as { entry: MemoryEntry };
      return { id: row.id, memoryId: staged.entry.id, summary: staged.entry.summary };
    });
  }

  discardMutation(id: string): void {
    this.#db.prepare("DELETE FROM memory_mutations WHERE id = ?").run(id);
  }

  async applyMutation(id: string): Promise<MemoryEntry | undefined> {
    const row = this.#db.prepare("SELECT entry FROM memory_mutations WHERE id = ?").get(id) as { entry: string } | undefined;
    if (row === undefined) return undefined;
    const staged = JSON.parse(row.entry) as {
      entry: MemoryEntry;
      sourceStatus: MemoryStatus;
      sourceHash: string | null;
      targetHash: string | null;
    };
    const entry = staged.entry;
    const source = this.memoryPath(entry.id, staged.sourceStatus);
    const target = this.memoryPath(entry.id, entry.status);
    const sourceHash = hashOptional(readOptionalFile(source));
    const targetHash = source === target ? sourceHash : hashOptional(readOptionalFile(target));
    const desiredHash = hashOptional(renderMemoryFile(entry));
    const unchanged = sourceHash === staged.sourceHash && targetHash === staged.targetHash;
    const alreadyWritten = targetHash === desiredHash && (source === target || sourceHash === staged.sourceHash || sourceHash === null);
    if (!unchanged && !alreadyWritten) {
      throw new Error(`Memory ${entry.id} changed on disk during recovery; inspect the file before continuing.`);
    }
    await this.writeEntry(entry, staged.sourceStatus);
    this.#db.prepare("DELETE FROM memory_mutations WHERE id = ?").run(id);
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
   * Read one entry on demand and count it as use, the way a recall does. This is
   * the second disclosure level: a recall returns summaries, and the body is only
   * opened when something actually asks for it.
   * 按需读取一条记忆，并像召回一样计为一次使用。这是第二个披露层级：召回只返回摘要，
   * 只有当真有东西来要时，才打开正文。
   */
  async read(id: string): Promise<MemoryEntry | undefined> {
    const entry = await this.get(id);
    if (entry === undefined) return undefined;
    await this.touch(id);
    return { ...entry, accessCount: entry.accessCount + 1, lastAccessedAt: new Date().toISOString() };
  }

  /** The owner-editable .md file behind an entry; absent for an unknown id. 条目对应、所有者可编辑的 .md 文件；未知 id 返回 undefined。 */
  filePathFor(id: string, status: MemoryStatus): string {
    return this.memoryPath(id, status);
  }

  /**
   * Bigram lexical recall with governance filters. Scoring is the matched-term
   * ratio, nudged by recency and usage so a fresh, frequently used memory wins
   * ties. Recency decays from when the remembered thing happened (createdAt),
   * not from when the row was last edited.
   * bigram 词法召回，带治理过滤。评分是命中词占比，再以新鲜度和使用次数微调，使较新、
   * 常用的记忆在平分时胜出。新鲜度从“事情发生的时间”（createdAt）起算，而不是从行
   * 最后被编辑的时间起算。
   *
   * minRatio lowers the match floor for long natural-language questions. The
   * default 0.2 assumes keyword-style queries where 20% term overlap is
   * meaningful; a 30-token sentence sharing 3 tokens with a memory is a 10%
   * overlap and would be dropped. The memory benchmark exposes it so the
   * floor's cost is measured rather than assumed.
   * minRatio 为长自然语言问题下调命中下限。默认 0.2 假定关键词式查询——20% 的词命中
   * 才有意义；而一句 30 个词的话与记忆共享 3 个词只有 10%，会被丢掉。记忆基准把它
   * 暴露出来，让下限的代价被测量，而不是被默认。
   */
  async recall(query: string, options: { maxResults?: number; includeSecret?: boolean; minRatio?: number } = {}): Promise<MemoryRecallMatch[]> {
    const terms = tokenize(query).slice(0, 128);
    if (terms.length === 0) return [];
    const direct = new Set(terms);
    const expanded = new Set(expandedRecallTerms(query, direct));
    const searchTerms = [...terms, ...expanded];
    const now = new Date().toISOString();
    const placeholders = searchTerms.map(() => "?").join(", ");
    const rows = this.#db.prepare(`
      SELECT t.memory_id, t.term
      FROM memory_terms t
      JOIN memories m ON m.id = t.memory_id
      WHERE t.term IN (${placeholders})
        AND m.status = 'active'
        AND (m.expires_at IS NULL OR m.expires_at > ?)
        AND (m.sensitivity != 'secret' OR ? = 1)
    `).all(...searchTerms, now, options.includeSecret === true ? 1 : 0) as Array<{ memory_id: string; term: string }>;

    const byId = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = byId.get(row.memory_id) ?? new Set<string>();
      set.add(row.term);
      byId.set(row.memory_id, set);
    }
    const { idf, df, total } = this.termDocumentFrequency(searchTerms);
    const queryVector = new Map<string, number>();
    for (const term of searchTerms) queryVector.set(term, 1 / Math.sqrt(searchTerms.length));

    const matches: MemoryRecallMatch[] = [];
    for (const [memoryId, matched] of byId) {
      const entry = await this.get(memoryId);
      if (entry === undefined) continue;
      const directMatches = [...matched].filter((term) => direct.has(term)).length;
      // Alias-expanded terms count as substantive too: they were derived from a
      // phrase the query did contain ("周报" -> "汇报"), not matched by accident.
      // 别名展开的词也算实词：它们由查询里确实出现的短语推导而来（"周报" -> "汇报"），不是偶然命中。
      const substantive = [...matched].filter((term) => (direct.has(term) || expanded.has(term))
        && !LATIN_STOPWORDS.has(term) && !CJK_FUNCTION_WORDS.has(term)).length;
      let expandedMatches = matched.size - directMatches;
      if (query.includes("周报") && !/(周报|每周|周[一二三四五六日天末]|星期[一二三四五六日天末])/.test(`${entry.summary} ${entry.content}`)) {
        expandedMatches *= 0.5;
      }
      const ratio = Math.min(1, (directMatches + expandedMatches * 0.5) / terms.length);
      // Hybrid: a cosine over IDF-weighted terms measures how much of the
      // query this memory explains, which the plain hit ratio cannot: the ratio
      // treats every matched term as equally informative. The cosine can only
      // promote a memory that already shared a term, so it never brings in an
      // unrelated one.
      // 混合：对经 IDF 加权的词计算余弦，衡量这条记忆解释了查询的多大一部分，而纯命中比例做不到——
      // 比例把每个命中词都当成同等有信息量。余弦只会提升已经共享词项的记忆，不会引入无关记忆。
      const cosine = await this.cosine(memoryId, queryVector, idf);
      const preferenceBoost = entry.type === "preference" ? 0.03 : 0;
      // A memory that shares only function words was never a match, whatever the ratio says.
      // 只共享虚词的记忆从来就不是匹配，无论比例算出多少。
      if (substantive === 0) continue;
      // A stated preference may be recalled on a lower floor. It is rare, it is
      // the owner's own words, and it is the class a long natural-language
      // question most easily buries: "这周的周报应该怎么写" shares one bigram with
      // "我偏好周报用简洁的要点列表", a 0.1 ratio that the 0.2 product floor drops.
      // Measured: at 0.08 it is recalled; unrelated queries ("今天天气怎么样",
      // "帮我订一张去上海的机票") still return nothing at that floor.
      // 所有者声明的偏好可用更低的下限召回。它罕见、出自所有者本人，也正是长自然语言问题最容易埋没的
      // 一类："这周的周报应该怎么写"与"我偏好周报用简洁的要点列表"只共享一个 bigram，比例 0.1，会被
      // 0.2 的产品下限丢弃。实测：0.08 时可召回；无关查询在该下限下仍返回空。
      // The lower floor is only for a *distinctive* match: a term shared by a
      // quarter of the library says as little as a function word, and letting it
      // through made idle memories look used. A rare term is what a buried
      // preference is actually recognised by.
      // 更低的下限只给"有区分度"的命中：一个被库中四分之一记忆共享的词，信息量与虚词无异，放它进来
      // 会让闲置记忆显得被用过。真正让被埋没的偏好被认出的，是稀有的词。
      const distinctive = [...matched].some((term) => direct.has(term)
        && !LATIN_STOPWORDS.has(term) && !CJK_FUNCTION_WORDS.has(term)
        && (df.get(term) ?? total) <= Math.max(1, Math.floor(total * 0.25)));
      const floor = entry.type === "preference" && distinctive
        ? Math.min(options.minRatio ?? 0.2, PREFERENCE_MIN_RATIO)
        : (options.minRatio ?? 0.2);
      if (ratio < floor && cosine < COSINE_ONLY_FLOOR) continue;
      const recencyBoost = Math.min(1, Math.max(0, 1 - (Date.now() - Date.parse(entry.createdAt)) / (90 * 24 * 3600 * 1000)));
      const usageBoost = Math.min(0.1, entry.accessCount * 0.01);
      matches.push({
        entry,
        score: Number((ratio + cosine * 0.25 + recencyBoost * 0.15 + usageBoost + preferenceBoost).toFixed(3)),
        matchedTerms: [...matched],
      });
    }
    matches.sort((left, right) => right.score - left.score || Number(right.entry.type === "preference") - Number(left.entry.type === "preference"));
    const limit = Math.max(0, Math.min(100, Math.floor(options.maxResults ?? 4)));
    const selected = matches.slice(0, limit);
    for (const match of selected) await this.touch(match.entry.id);
    return selected;
  }

  /**
   * Cosine between the query's term vector and one memory's stored weights.
   * The tiny floor keeps a repeated stopword from dominating a short query.
   * 查询词向量与某条记忆存储权重之间的余弦。极小的下限防止重复的停用词主导短查询。
   */
  private async cosine(memoryId: string, queryVector: ReadonlyMap<string, number>, idf: ReadonlyMap<string, number>): Promise<number> {
    const rows = this.#db.prepare("SELECT term, weight FROM memory_term_weights WHERE memory_id = ?").all(memoryId) as Array<{ term: string; weight: number }>;
    if (rows.length === 0) return 0;
    let intersection = 0;
    let norm = 0;
    for (const row of rows) {
      const weight = (row.weight + 1e-3) * (idf.get(row.term) ?? 1);
      norm += weight * weight;
      const queryWeight = queryVector.get(row.term);
      if (queryWeight !== undefined) intersection += weight * queryWeight;
    }
    const queryNorm = Math.sqrt([...queryVector.values()].reduce((sum, value) => sum + value * value, 0));
    return norm === 0 || queryNorm === 0 ? 0 : intersection / (Math.sqrt(norm) * queryNorm);
  }

  /** Document frequency over the whole active library for the query's terms. 针对查询词，在整个活跃库上计算文档频率。 */
  private termDocumentFrequency(terms: readonly string[]): { idf: Map<string, number>; df: Map<string, number>; total: number } {
    if (terms.length === 0) return { idf: new Map(), df: new Map(), total: 0 };
    const placeholders = terms.map(() => "?").join(", ");
    const total = (this.#db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'").get() as { count: number }).count;
    const rows = this.#db.prepare(`SELECT term, COUNT(*) AS count FROM memory_terms WHERE term IN (${placeholders}) GROUP BY term`).all(...terms) as Array<{ term: string; count: number }>;
    const idf = new Map<string, number>();
    const df = new Map<string, number>();
    for (const row of rows) {
      idf.set(row.term, Math.log(1 + total / Math.max(1, row.count)));
      df.set(row.term, row.count);
    }
    return { idf, df, total };
  }

  async update(id: string, update: MemoryUpdate): Promise<MemoryEntry> {
    const next = await this.prepareUpdate(id, update);
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
  async syncFromFiles(apply: (entry: MemoryEntry, action: "added" | "updated" | "archived") => Promise<void> = async (entry) => this.writeEntry(entry)): Promise<{ added: number; archived: number; updated: number }> {
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
          await apply({
            ...parsed,
            id,
            status,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            accessCount: 0,
          }, "added");
          counters.added += 1;
        } else if (existing.summary !== parsed.summary || existing.content !== parsed.content || existing.status !== status) {
          await apply({ ...existing, ...parsed, id, status, updatedAt: new Date().toISOString() }, "updated");
          counters.updated += 1;
        }
      }
    };

    await scan(this.#contentDirectory, "active");
    await scan(archivedDirectory, "archived");

    const known = await this.list();
    for (const entry of known) {
      if (!seen.has(entry.id) && entry.status === "active") {
        await apply(await this.prepareUpdate(entry.id, { status: "archived" }), "archived");
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

  private memoryPath(id: string, status: MemoryStatus): string {
    return join(this.#contentDirectory, ...(status === "archived" ? ["archived"] : []), `${id}.md`);
  }

  private async writeEntry(entry: MemoryEntry, sourceStatus?: MemoryStatus): Promise<void> {
    const archived = entry.status === "archived";
    const directory = archived ? join(this.#contentDirectory, "archived") : this.#contentDirectory;
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${entry.id}.md`);
    const existing = this.#db.prepare("SELECT status FROM memories WHERE id = ?").get(entry.id) as { status: MemoryStatus } | undefined;
    const oldStatus = sourceStatus ?? existing?.status;
    const previous = oldStatus === undefined || oldStatus === entry.status ? undefined : this.memoryPath(entry.id, oldStatus);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, renderMemoryFile(entry), "utf8");
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }

    const terms = tokenize(`${entry.summary} ${entry.content}`);
    // One transaction per commit, not one per term: without it every indexed
    // term becomes its own fsync, and committing a memory with a few hundred
    // terms turns into a few hundred disk flushes. (Bulk benchmark ingestion
    // made this visible; owners hit it every time a batch is promoted.)
    // 每次提交一个事务，而不是每个词一个事务：否则每个索引词都是一次独立 fsync，
    // 提交一条几百词的记忆就变成几百次磁盘刷写。（基准的批量写入暴露了这一点；所有者
    // 每次批量提升记忆时都会撞上它。）
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM memory_terms WHERE memory_id = ?").run(entry.id);
      const insertTerm = this.#db.prepare("INSERT OR IGNORE INTO memory_terms (memory_id, term) VALUES (?, ?)");
      for (const term of terms) insertTerm.run(entry.id, term);
      this.#db.prepare("DELETE FROM memory_term_weights WHERE memory_id = ?").run(entry.id);
      const insertWeight = this.#db.prepare("INSERT INTO memory_term_weights (memory_id, term, weight) VALUES (?, ?, ?)");
      for (const [term, weight] of termWeights(entry.summary, entry.content)) insertWeight.run(entry.id, term, weight);

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
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    if (previous !== undefined) {
      await unlink(previous).catch((error: unknown) => {
        if (!isMissingMemoryFile(error)) throw error;
      });
    }
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

/**
 * Local term weights (sublinear tf over the memory's own text, plus the type as
 * a prior). Document frequency is applied at query time over the whole library,
 * so the index does not need to be rewritten when other memories change.
 * 局部词权重（对记忆自身文本做次线性词频，并把类型作为先验）。文档频率在查询时对整个库计算，
 * 因此其他记忆变化时不必重写索引。
 */
function termWeights(summary: string, content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenize(`${summary} ${summary} ${content}`)) counts.set(term, (counts.get(term) ?? 0) + 1);
  const weights = new Map<string, number>();
  for (const [term, count] of counts) weights.set(term, 1 + Math.log(count));
  return weights;
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (isMissingMemoryFile(error)) return undefined;
    throw error;
  }
}

function isMissingMemoryFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function hashOptional(value: string | undefined): string | null {
  return value === undefined ? null : createHash("sha256").update(value).digest("hex");
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
  // Windows editors save CRLF. A memory the owner edited in Notepad must not be
  // silently ignored because of line endings.
  // Windows 编辑器保存的是 CRLF。所有者用记事本改过的记忆，不能因为换行符就被静默忽略。
  const normalized = source.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
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

/**
 * The Kernel's recall port, backed by the governed store.
 *
 * Only promoted memories are here: a mined candidate stays a candidate until
 * the owner promotes it, so nothing reaches a worker that the owner has not
 * accepted. That is the whole point of governance — a second, ungoverned
 * store that also feeds recall would quietly undo it.
 *
 * Kernel 的召回端口，由受治理的 Store 支撑。
 *
 * 这里只有已提升的记忆：提炼出的候选在所有者提升之前一直只是候选，因此不会有任何
 * 未经所有者接受的内容到达 Worker。这正是治理的全部意义——另一个不受治理、却同样
 * 供给召回的 Store，会悄悄把它抵消掉。
 */
export class GovernedMemorySource {
  readonly #dataDirectory: string;
  readonly #maxResults: number;
  readonly #journal?: JournalStore;

  constructor(dataDirectory: string, maxResults = 4, journal?: JournalStore) {
    this.#dataDirectory = dataDirectory;
    this.#maxResults = maxResults;
    this.#journal = journal;
  }

  /**
   * Opens the index for the length of one recall. Recall happens once per
   * dispatch, so a short-lived connection costs nothing measurable and keeps
   * the Kernel from holding a database handle for the life of the process —
   * a handle that would block the owner from moving or deleting their own
   * clone home.
   * 只在一次召回期间打开索引。每次派发才召回一次，因此短连接的开销可以忽略，同时
   * 避免 Kernel 在整个进程生命周期里握着数据库句柄——那样会妨碍所有者移动或删除
   * 自己的 clone home。
   */
  async recall(query: string, _runId: string): Promise<Array<{ memory: MemoryEntry; score: number; matchedTerms: string[] }>> {
    const store = new MdMemoryStore({ dataDirectory: this.#dataDirectory });
    const { MemoryGovernance } = await import("./memory-governance.ts");
    const ownedJournal = this.#journal === undefined
      ? (await import("../core/sqlite-journal.ts")).createJournalStore(this.#dataDirectory)
      : undefined;
    const governance = new MemoryGovernance({ store, journal: this.#journal ?? ownedJournal! });
    try {
      const matches = await governance.recall(query, { maxResults: this.#maxResults });
      // The whole entry crosses the boundary, not just its id and summary: the
      // context builder classifies by `type`, orders supersedes by `createdAt`
      // and drops `secret` by `sensitivity`. Narrowing it here is why every
      // recalled memory used to land in one class.
      // 整条记录越界，而不只是 id 与摘要：上下文构建器按 `type` 分类、按 `createdAt` 排序
      // 取代关系、按 `sensitivity` 丢弃 `secret`。在这里收窄，正是所有召回记忆都落入同一类别的
      // 原因。
      return matches.map((match) => ({
        memory: match.entry,
        score: match.score,
        matchedTerms: match.matchedTerms,
      }));
    } finally {
      await governance.close();
      (ownedJournal as { close?: () => void } | undefined)?.close?.();
    }
  }
}
