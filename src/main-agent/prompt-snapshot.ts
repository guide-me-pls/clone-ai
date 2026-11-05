/**
 * Prompt provenance for the Main Agent: what it was told, before it answered.
 *
 * A failed turn is only debuggable if the inputs can be reconstructed. The
 * journal already records what the agent did (tools, runs, memory recalls);
 * this module records what it read — the charter, the compiled situation
 * briefing, and the exact tool table — as content-addressed material plus a
 * journal event carrying the hashes, model, and effort.
 *
 * Why a file instead of an event payload: the same prompt is usually sent many
 * times, and storing the full briefing in every row would grow the journal
 * without adding information. The hash names the file, so identical material
 * is written once and every turn points at the same bytes.
 *
 * 主 Agent 的提示词溯源：它在回答之前究竟读到了什么。
 *
 * 只有输入可重建，失败的一轮才可调试。Journal 已经记录了 Agent 做了什么（工具、Run、
 * 记忆召回）；本模块记录它读了什么——charter、编译后的情境简报，以及完整的工具表——
 * 以内容寻址的文件加一条携带哈希、模型与强度的 Journal 事件来保存。
 *
 * 为什么用文件而不是事件载荷：同一份提示词通常会被发送很多次，把完整简报写进每一行
 * 只会让 Journal 变大而不增加信息。哈希即文件名，因此相同材料只写一次，每一轮都指向
 * 同一份字节。
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createJournalStore } from "../core/sqlite-journal.ts";
import { logJson } from "../observability/json-log.ts";

/** Bump when the snapshot file or event shape changes. 快照文件或事件结构变化时递增。 */
export const PROMPT_SNAPSHOT_SCHEMA_VERSION = 1;

/** Directory under the clone home that holds content-addressed prompt material. 存放内容寻址提示词材料的 clone home 子目录。 */
export const PROMPT_SNAPSHOT_DIRECTORY = "prompt-snapshots";

/**
 * One tool as it was registered with the Pi session. Execute functions are
 * deliberately excluded: they are behavior, not something the model reads.
 * 注册到 Pi 会话的一个工具。刻意排除 execute 函数：它是行为，不是模型读到的内容。
 */
export interface RegisteredToolSnapshot {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Everything that shaped one Main Agent turn's instructions.
 * 塑造一次主 Agent 回合指令的全部内容。
 */
export interface MainAgentPromptMaterials {
  charter: string;
  /** Semantic version of the charter, bumped by a human when its meaning changes. charter 的语义版本，含义变化时由人递增。 */
  charterVersion: number;
  /** Compiled situation briefing, when it was readable. 编译后的情境简报，可读时存在。 */
  briefing?: string;
  /** Why the briefing was unavailable; the agent ran on the charter alone. 简报不可用的原因；此时 Agent 仅凭 charter 运行。 */
  briefingError?: string;
  /** The exact system prompt handed to the SDK. 交给 SDK 的完整系统提示词。 */
  systemPrompt: string;
  tools: readonly RegisteredToolSnapshot[];
  modelId?: string;
  provider?: string;
  effort?: string;
}

/**
 * The journal payload for one turn. The hashes answer "did the prompt change?"
 * without reading the file; the locator answers "what exactly changed?".
 * 一次回合的 Journal 载荷。哈希回答"提示词变了吗"而无须读文件；定位符回答"具体变了什么"。
 */
export interface MainAgentPromptSnapshot {
  schemaVersion: number;
  charterVersion: number;
  charterHash: string;
  briefingHash: string;
  promptHash: string;
  toolsHash: string;
  materialHash: string;
  toolNames: string[];
  modelId?: string;
  provider?: string;
  effort?: string;
  /** Path relative to the clone home. 相对 clone home 的路径。 */
  locator: string;
  capturedAt: string;
}

export interface PromptSnapshotEvent extends MainAgentPromptSnapshot {
  /** Correlates the snapshot with the desktop turn ledger, when there is one. 有桌面回合账本时，用它把快照与回合对应起来。 */
  turnId?: string;
}

/**
 * A stable hash over JSON-like data: object keys are sorted so two structurally
 * equal values always hash the same, regardless of construction order.
 * 对类 JSON 数据计算稳定哈希：对象键会排序，因此两个结构相等的值无论构造顺序如何，
 * 总是得到同一个哈希。
 */
export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value) ?? null)).digest("hex");
}

/**
 * Writes the full material to a content-addressed file and returns the
 * snapshot metadata. The file is written once per material hash; a later turn
 * with identical inputs reuses it and keeps the first capture time.
 * 把完整材料写入内容寻址文件并返回快照元数据。每个材料哈希只写一次；之后输入完全
 * 相同的回合复用该文件，并保留首次捕获的时间。
 */
export async function capturePromptSnapshot(
  dataDirectory: string,
  materials: MainAgentPromptMaterials,
  capturedAt = new Date(),
): Promise<MainAgentPromptSnapshot> {
  const material = {
    schemaVersion: PROMPT_SNAPSHOT_SCHEMA_VERSION,
    charterVersion: materials.charterVersion,
    charter: materials.charter,
    ...(materials.briefing === undefined ? {} : { briefing: materials.briefing }),
    ...(materials.briefingError === undefined ? {} : { briefingError: materials.briefingError }),
    systemPrompt: materials.systemPrompt,
    tools: materials.tools,
  };
  const materialHash = hashCanonical(material);
  const directory = join(dataDirectory, PROMPT_SNAPSHOT_DIRECTORY);
  const path = join(directory, `${materialHash}.json`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(
      path,
      `${JSON.stringify({ ...material, capturedAt: capturedAt.toISOString() }, null, 2)}\n`,
      // "wx" makes creation atomic: two turns capturing the same material race
      // to create the file, and the loser reads the winner's identical bytes.
      // "wx" 让创建是原子的：两轮捕获同一材料时争相创建，落败者读到的是胜者完全相同的字节。
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
  }
  return {
    schemaVersion: PROMPT_SNAPSHOT_SCHEMA_VERSION,
    charterVersion: materials.charterVersion,
    charterHash: hashCanonical(materials.charter),
    briefingHash: hashCanonical(materials.briefing ?? materials.briefingError ?? ""),
    promptHash: hashCanonical(materials.systemPrompt),
    toolsHash: hashCanonical(materials.tools),
    materialHash,
    toolNames: materials.tools.map((tool) => tool.name),
    ...(materials.modelId === undefined ? {} : { modelId: materials.modelId }),
    ...(materials.provider === undefined ? {} : { provider: materials.provider }),
    ...(materials.effort === undefined ? {} : { effort: materials.effort }),
    locator: `${PROMPT_SNAPSHOT_DIRECTORY}/${materialHash}.json`,
    capturedAt: capturedAt.toISOString(),
  };
}

/**
 * Captures and journals one turn's prompt. Failure is logged, never thrown:
 * missing provenance must not cost the owner the answer they are waiting for.
 * 捕获并写入一轮的提示词。失败只记日志、绝不抛出：缺少溯源不能让所有者付出得不到
 * 他正在等待的答案的代价。
 */
export async function recordPromptSnapshot(
  dataDirectory: string,
  materials: MainAgentPromptMaterials,
  options: { turnId?: string } = {},
): Promise<PromptSnapshotEvent | undefined> {
  try {
    const snapshot = await capturePromptSnapshot(dataDirectory, materials);
    const event: PromptSnapshotEvent = {
      ...snapshot,
      ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    };
    const journal = createJournalStore(dataDirectory);
    try {
      await journal.append({ type: "main_agent.prompt_snapshot", payload: event });
    } finally {
      (journal as { close?: () => void }).close?.();
    }
    return event;
  } catch (error: unknown) {
    logJson("warn", "main_agent.prompt_snapshot failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  // Functions and symbols are behavior, not content; JSON drops them too.
  // 函数与符号属于行为而非内容；JSON 同样会丢弃它们。
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code: string }).code === "EEXIST";
}
