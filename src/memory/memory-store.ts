import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { MemoryCandidate } from "../core/contracts.ts";

export type LocalMemoryStatus = "active" | "archived";

export interface LocalMemory {
  id: string;
  summary: string;
  confidence: MemoryCandidate["confidence"];
  sourceRunId: string;
  sourceEvidenceIds: string[];
  status: LocalMemoryStatus;
  createdAt: string;
  updatedAt: string;
  useCount: number;
  lastUsedAt?: string;
}

interface MemoryFile {
  memories: LocalMemory[];
  settings: LocalMemorySettings;
}

export interface LocalMemorySettings {
  enabled: boolean;
  maxRecall: number;
}

export interface MemoryMatch {
  memory: LocalMemory;
  score: number;
  matchedTerms: string[];
}

export interface MemoryRecall extends MemoryMatch {
  runId: string;
  recalledAt: string;
}

const defaultSettings: LocalMemorySettings = { enabled: true, maxRecall: 4 };

/**
 * Human-readable working memory. Runtime events remain the provenance source;
 * this store is the curated layer that people can inspect and edit directly.
 *
 * 人可读的工作记忆。Runtime Event 仍然是来源证明；这个 Store 是人可以直接查看、编辑的
 * 筛选层。
 */
export class LocalMemoryStore {
  readonly #path: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async list(): Promise<LocalMemory[]> {
    return [...(await this.load()).memories].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async settings(): Promise<LocalMemorySettings> {
    return (await this.load()).settings;
  }

  async updateSettings(update: Partial<LocalMemorySettings>): Promise<LocalMemorySettings> {
    const file = await this.load();
    const maxRecall = update.maxRecall ?? file.settings.maxRecall;
    if (!Number.isInteger(maxRecall) || maxRecall < 1 || maxRecall > 8) {
      throw new Error("Memory recall limit must be between 1 and 8.");
    }
    const settings = { enabled: update.enabled ?? file.settings.enabled, maxRecall };
    await this.write({ ...file, settings });
    return settings;
  }

  async sync(candidates: MemoryCandidate[]): Promise<void> {
    const file = await this.load();
    const existing = new Map(file.memories.map((memory) => [memory.id, memory]));
    let changed = false;
    for (const candidate of candidates) {
      if (existing.has(candidate.id)) continue;
      existing.set(candidate.id, {
        id: candidate.id,
        summary: candidate.summary,
        confidence: candidate.confidence,
        sourceRunId: candidate.runId,
        sourceEvidenceIds: candidate.sourceEvidenceIds,
        status: "active",
        createdAt: candidate.createdAt,
        updatedAt: candidate.createdAt,
        useCount: 0,
      });
      changed = true;
    }
    if (changed) await this.write({ ...file, memories: [...existing.values()] });
  }

  async update(id: string, update: { summary?: string; status?: LocalMemoryStatus }): Promise<LocalMemory> {
    const file = await this.load();
    const memory = file.memories.find((candidate) => candidate.id === id);
    if (memory === undefined) throw new Error("The requested local memory does not exist.");
    const summary = update.summary === undefined ? memory.summary : update.summary.trim();
    if (summary.length < 3) throw new Error("A memory needs at least three characters.");
    const next = { ...memory, summary, status: update.status ?? memory.status, updatedAt: new Date().toISOString() };
    await this.write({ ...file, memories: file.memories.map((candidate) => candidate.id === id ? next : candidate) });
    return next;
  }

  async create(summary: string): Promise<LocalMemory> {
    const text = summary.trim();
    if (text.length < 3) throw new Error("A memory needs at least three characters.");
    const now = new Date().toISOString();
    const memory: LocalMemory = {
      id: randomUUID(),
      summary: text,
      confidence: "high",
      sourceRunId: "owner",
      sourceEvidenceIds: [],
      status: "active",
      createdAt: now,
      updatedAt: now,
      useCount: 0,
    };
    const file = await this.load();
    await this.write({ ...file, memories: [memory, ...file.memories] });
    return memory;
  }

  async search(query: string): Promise<MemoryMatch[]> {
    const file = await this.load();
    return rankMemories(file.memories, query);
  }

  async recall(query: string, runId: string): Promise<MemoryRecall[]> {
    const file = await this.load();
    if (!file.settings.enabled) return [];
    const matches = rankMemories(file.memories, query).slice(0, file.settings.maxRecall);
    if (matches.length === 0) return [];

    const recalledAt = new Date().toISOString();
    const recalledIds = new Set(matches.map((match) => match.memory.id));
    const memories = file.memories.map((memory) => recalledIds.has(memory.id)
      ? { ...memory, useCount: memory.useCount + 1, lastUsedAt: recalledAt }
      : memory,
    );
    await this.write({ ...file, memories });
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    return matches.map((match) => ({ ...match, memory: byId.get(match.memory.id)!, runId, recalledAt }));
  }

  private async load(): Promise<MemoryFile> {
    try {
      const source = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(source) as Partial<MemoryFile>;
      return {
        memories: Array.isArray(parsed.memories) ? parsed.memories.filter(isMemory).map(normalizeMemory) : [],
        settings: normalizeSettings(parsed.settings),
      };
    } catch (error: unknown) {
      if (isMissingFile(error)) return { memories: [], settings: defaultSettings };
      throw error;
    }
  }

  private async write(file: MemoryFile): Promise<void> {
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    });
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
  }
}

function isMemory(value: unknown): value is LocalMemory {
  return typeof value === "object" && value !== null && "id" in value && "summary" in value && "status" in value;
}

function normalizeMemory(memory: LocalMemory): LocalMemory {
  return { ...memory, useCount: Number.isInteger(memory.useCount) && memory.useCount >= 0 ? memory.useCount : 0 };
}

function normalizeSettings(value: unknown): LocalMemorySettings {
  if (typeof value !== "object" || value === null) return { ...defaultSettings };
  const settings = value as Partial<LocalMemorySettings>;
  return {
    enabled: typeof settings.enabled === "boolean" ? settings.enabled : defaultSettings.enabled,
    maxRecall: Number.isInteger(settings.maxRecall) && settings.maxRecall! >= 1 && settings.maxRecall! <= 8
      ? settings.maxRecall!
      : defaultSettings.maxRecall,
  };
}

function rankMemories(memories: LocalMemory[], query: string): MemoryMatch[] {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return [];
  return memories
    .filter((memory) => memory.status === "active")
    .map((memory) => {
      const haystack = memory.summary.toLocaleLowerCase();
      const matchedTerms = queryTerms.filter((term) => haystack.includes(term));
      return { memory, score: matchedTerms.length / queryTerms.length, matchedTerms };
    })
    .filter((match) => match.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score || right.memory.useCount - left.memory.useCount || right.memory.updatedAt.localeCompare(left.memory.updatedAt));
}

function terms(value: string): string[] {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const words = normalized.split(/\s+/).filter((term) => term.length >= 2);
  const cjk = [...normalized.replace(/[^\u3400-\u9fff]/g, "")];
  for (let index = 0; index < cjk.length - 1; index += 1) words.push(`${cjk[index]}${cjk[index + 1]}`);
  return [...new Set(words)].slice(0, 24);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
