/**
 * AgentMemoryWorker: memory mining by our own model client.
 *
 * After a task or a conversation turn, this worker asks the configured
 * OpenAI-compatible endpoint for candidate memories as JSON, then validates
 * every candidate against facts the Kernel already holds: the type must be a
 * known class, the summary must be non-trivial, and every cited evidence id must
 * exist in the job. A hallucinated memory never reaches the proposal queue.
 *
 * There is no provider CLI any more. The model call is injected, so the
 * validation and prompt are testable without a network, and a missing endpoint
 * fails the mining job instead of silently skipping it.
 *
 * AgentMemoryWorker：用我们自己的模型客户端提炼记忆。
 *
 * 一个任务或一轮对话结束后，本 Worker 向已配置的 OpenAI 兼容端点索取 JSON 形式的候选
 * 记忆，再用 Kernel 已有的事实校验每一条：类型必须是已知分类、摘要不能空泛、引用的每条
 * Evidence ID 必须存在于任务中。幻觉记忆永远进不了提案队列。
 *
 * 不再有 Provider CLI。模型调用是注入的，因此校验与 Prompt 无需网络即可测试；端点缺失
 * 会让提炼作业失败，而不是静默跳过。
 */
import { randomUUID } from "node:crypto";

import type { Evidence, MemoryCandidate, MemorySensitivity, MemoryType } from "../core/contracts.ts";
import { readNativeMainAgentEndpoint } from "../main-agent/native-runtime.ts";
import type { MemoryWorker, PendingMemoryJob } from "./memory-pipeline.ts";

export interface AgentMemoryWorkerOptions {
  /** Injected completion; defaults to the configured native endpoint. 注入的补全；默认使用已配置的原生端点。 */
  complete?: (prompt: string) => Promise<string>;
  /** Hard cap on candidates per task. 每个任务候选条数上限。 */
  maxCandidates?: number;
}

const MEMORY_TYPES = new Set<MemoryType>(["fact", "preference", "procedure", "decision", "commitment"]);
const SENSITIVITIES = new Set<MemorySensitivity>(["public", "private", "secret"]);

export class AgentMemoryWorker implements MemoryWorker {
  readonly #complete: (prompt: string) => Promise<string>;
  readonly #maxCandidates: number;

  constructor(options: AgentMemoryWorkerOptions = {}) {
    this.#complete = options.complete ?? completeWithNativeEndpoint;
    this.#maxCandidates = options.maxCandidates ?? 3;
  }

  /** The model's raw output, before validation; used by workers that need their own prompt. 校验前的模型原始输出；供需要自己 Prompt 的 Worker 使用。 */
  async extractRaw(job: PendingMemoryJob): Promise<string | undefined> {
    const prompt = job.promptOverride ?? miningPrompt(job);
    const raw = await this.#complete(prompt).catch((error: unknown) => {
      throw new Error(`Memory mining failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return raw.trim().length === 0 ? undefined : raw;
  }

  async extract(job: PendingMemoryJob): Promise<MemoryCandidate[]> {
    const source = await this.extractRaw(job);
    if (source === undefined) throw new Error("Memory mining did not produce a candidate list.");
    if (parseJsonArray(source) === undefined) throw new Error("Memory mining produced invalid JSON.");
    return validateCandidates(source, job, this.#maxCandidates);
  }
}

/**
 * The default completion: a tool-free chat call to the same endpoint the Main
 * Agent uses. A missing endpoint is a mining failure, reported as such.
 * 默认补全：向主 Agent 使用的同一端点发起一次无工具的 chat 调用。端点缺失即为提炼失败，
 * 并如实报告。
 */
async function completeWithNativeEndpoint(prompt: string): Promise<string> {
  const { endpoint, missing } = readNativeMainAgentEndpoint();
  if (endpoint === undefined) {
    throw new Error(`the endpoint is not configured (${missing.join(", ")})`);
  }
  const response = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` }),
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(endpoint.timeoutMs ?? 60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`the endpoint answered ${response.status}: ${detail.slice(0, 300)}`);
  }
  const body = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

/**
 * The single mining prompt. Evidence summaries are the only input facts; the
 * model must cite them, not invent.
 * 唯一的提炼 Prompt。Evidence 摘要是仅有的输入事实；模型必须引用它们，不得编造。
 */
export function miningPrompt(job: PendingMemoryJob): string {
  const evidenceLines = job.evidence.map((item) => (
    `- ${item.id}: [${item.kind}] ${item.summary}${item.locator === undefined ? "" : ` (${item.locator})`}`
  )).join("\n");
  return [
    "You are the memory miner for Clone AI. Extract durable memory candidates from the task evidence below.",
    "Answer with JSON only (an array of at most 3 objects, no prose, no code fence) to out/candidates.json: the worker writes that file from your answer.",
    "Each object: { \"type\": \"fact|preference|procedure|decision|commitment\", \"summary\": string,",
    "  \"confidence\": \"low|medium|high\", \"sensitivity\": \"public|private|secret\",",
    "  \"sourceEvidenceIds\": [ids you actually cite], \"expiresAt\": optional ISO-8601 date }",
    "",
    "Rules:",
    "- Summaries are one sentence, 5-60 words, in the user's language.",
    "- sourceEvidenceIds must be ids from the list below. Never invent an id.",
    "- Only durable knowledge: preferences, standing procedures, decisions, project facts.",
    "- Skip one-off details, credentials, and anything already implied by the task itself.",
    "- Set expiresAt only for time-bound knowledge (a deadline, a temporary setting, a current-state fact);",
    "  leave it out for stable preferences and standing procedures.",
    ...(job.outcome === "failed" ? [
      "- This task FAILED. Extract lessons instead: type \"procedure\", one sentence on what went wrong and what to do",
      "  differently next time, grounded in the cited evidence. If the evidence shows no clear cause, return [].",
    ] : []),
    "",
    `Parent task: ${job.task.objective}`,
    "Evidence:",
    evidenceLines || "- (none)",
  ].join("\n");
}

/**
 * Validates raw provider output into MemoryCandidates. Anything that does not
 * parse or fails validation is dropped; nothing is thrown, so a chatty or
 * broken provider cannot break the pipeline.
 *
 * 把 Provider 原始输出校验为 MemoryCandidate。任何无法解析或校验失败的条目都会被丢弃，
 * 不抛异常——话多或损坏的 Provider 不能破坏流水线。
 */
export function validateCandidates(source: string, job: PendingMemoryJob, maxCandidates: number): MemoryCandidate[] {
  const knownEvidence = new Set(job.evidence.map((item) => item.id));
  const parsed = parseJsonArray(source);
  if (parsed === undefined) return [];

  const candidates: MemoryCandidate[] = [];
  for (const raw of parsed) {
    if (candidates.length >= maxCandidates) break;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    const type = record.type;
    const confidence = record.confidence;
    if (!isMemoryType(type) || !isConfidence(confidence)) continue;
    if (summary.length < 3 || summary.length > 300) continue;
    const evidenceIds = Array.isArray(record.sourceEvidenceIds)
      ? record.sourceEvidenceIds.filter((id): id is string => typeof id === "string" && knownEvidence.has(id))
      : [];
    if (evidenceIds.length === 0) continue;
    candidates.push({
      id: randomUUID(),
      runId: job.run.id,
      sourceEvidenceIds: evidenceIds,
      summary,
      confidence,
      status: "proposed",
      createdAt: new Date().toISOString(),
      type,
      ...(isSensitivity(record.sensitivity) ? { sensitivity: record.sensitivity } : {}),
      ...(futureIsoDate(record.expiresAt) === undefined ? {} : { expiresAt: futureIsoDate(record.expiresAt)! }),
    });
  }
  return candidates;
}

/** An unparseable or already-past expiry is dropped, never trusted. 无法解析或已过去的过期时间会被丢弃而不是信任。 */
function futureIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) || time <= Date.now() ? undefined : new Date(time).toISOString();
}

/** Tolerates markdown code fences around the JSON and trailing prose. 容忍 JSON 外围的 Markdown 代码块与尾部文字。 */
export function parseJsonArray(source: string): unknown[] | undefined {
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? source).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(body.slice(start, end + 1)) as unknown;
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && MEMORY_TYPES.has(value as MemoryType);
}

function isSensitivity(value: unknown): value is MemorySensitivity {
  return typeof value === "string" && SENSITIVITIES.has(value as MemorySensitivity);
}

function isConfidence(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}
