/**
 * AgentMemoryWorker: memory mining by a background black-box agent.
 *
 * After a user task completes, this worker dispatches a read-only mining
 * WorkOrder to a real provider CLI (pi by default). The provider reads the
 * task's evidence summaries and writes candidate memory entries as JSON to
 * out/candidates.json. The Kernel then validates every candidate: the type
 * must be a known class, the summary must be non-trivial, and every cited
 * evidence id must actually exist in the job — a hallucinated memory never
 * reaches the proposal queue.
 *
 * Failure is deliberately silent: mining must never break the main flow.
 *
 * AgentMemoryWorker：由后台黑盒 Agent 完成的记忆提炼。
 *
 * 一轮用户任务结束后，本 Worker 把一个只读提炼 WorkOrder 派发给真实 Provider CLI
 * （默认 pi）。Provider 阅读任务的 Evidence 摘要，把候选记忆条目以 JSON 写入
 * out/candidates.json。Kernel 随后校验每一条候选：类型必须是已知分类、摘要不能
 * 空泛、引用的每条 Evidence ID 必须真实存在于任务中——幻觉记忆永远进不了提案队列。
 *
 * 失败被刻意静默：提炼绝不能破坏主流程。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlackBoxCliWorker, type BlackBoxProviderConfig } from "../workers/black-box-cli-worker.ts";
import type { Evidence, MemoryCandidate, MemorySensitivity, MemoryType } from "../core/contracts.ts";
import type { MemoryWorker, PendingMemoryJob } from "./memory-pipeline.ts";

export interface AgentMemoryWorkerOptions {
  /** Launch recipe for the mining provider. Defaults to the built-in pi recipe. 提炼 Provider 的启动配方，默认内建 pi 配方。 */
  config?: BlackBoxProviderConfig;
  timeoutMs?: number;
  /** Hard cap on candidates per task. 每个任务候选条数上限。 */
  maxCandidates?: number;
}

const DEFAULT_CONFIG: BlackBoxProviderConfig = {
  id: "memory-miner",
  label: "Memory Miner",
  command: process.platform === "win32" ? "pi.cmd" : "pi",
  args: ["-p", "{{prompt}}"],
  env: ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR"],
  timeoutMs: 60_000,
};

const MEMORY_TYPES = new Set<MemoryType>(["fact", "preference", "procedure", "decision", "commitment"]);
const SENSITIVITIES = new Set<MemorySensitivity>(["public", "private", "secret"]);

export class AgentMemoryWorker implements MemoryWorker {
  readonly #config: BlackBoxProviderConfig;
  readonly #timeoutMs: number;
  readonly #maxCandidates: number;

  constructor(options: AgentMemoryWorkerOptions = {}) {
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxCandidates = options.maxCandidates ?? 3;
  }

  async extract(job: PendingMemoryJob): Promise<MemoryCandidate[]> {
    const workspace = await mkdtemp(join(tmpdir(), "clone-ai-memory-mine-"));
    try {
      const adapter = new BlackBoxCliWorker({
        agentId: "memory-miner",
        config: { ...this.#config, timeoutMs: this.#timeoutMs },
        workCapabilities: ["research", "filesystem_read", "filesystem_write"],
      });
      const createdAt = new Date().toISOString();
      for await (const _event of adapter.execute({
        run: { id: job.run.id, taskId: job.task.id, status: "running", createdAt, updatedAt: createdAt },
        task: job.task,
        step: {
          id: "mine-memory",
          title: "Mine memory candidates",
          instructions: "Extract durable memory candidates from the task evidence.",
          risk: "reversible_write",
          acceptanceCriteria: ["out/candidates.json exists"],
          agentId: "memory-miner",
          requiredCapabilities: ["research", "filesystem_read", "filesystem_write"],
        },
        executor: { agentId: "memory-miner", providerId: this.#config.id },
        workOrder: {
          id: "mine-memory",
          role: "researcher",
          title: "Mine memory candidates",
          objective: miningPrompt(job),
          inputs: [],
          requiredCapabilities: ["research", "filesystem_read", "filesystem_write"],
          expectedArtifacts: [{ id: "candidates", kind: "artifact", description: "out/candidates.json", required: true }],
          acceptanceCriteria: ["out/candidates.json contains a JSON array"],
          risk: "read_only",
          budget: { maxDurationMs: this.#timeoutMs, maxModelCalls: 6, maxToolCalls: 10, maxAttempts: 1 },
        },
        workspacePath: workspace,
      })) {
        // The mining WorkOrder either produces the file or fails; progress is noise.
        // 提炼 WorkOrder 要么产出文件要么失败；进度文本只是噪音。
      }
      const source = await readFile(join(workspace, "out", "candidates.json"), "utf8").catch(() => undefined);
      if (source === undefined) return [];
      return validateCandidates(source, job, this.#maxCandidates);
    } catch {
      return [];
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * The single mining prompt. Evidence summaries are the only input facts; the
 * provider must cite them, not invent.
 * 唯一的提炼 Prompt。Evidence 摘要是仅有的输入事实；Provider 必须引用它们，不得编造。
 */
export function miningPrompt(job: PendingMemoryJob): string {
  const evidenceLines = job.evidence.map((item) => (
    `- ${item.id}: [${item.kind}] ${item.summary}${item.locator === undefined ? "" : ` (${item.locator})`}`
  )).join("\n");
  return [
    "You are the memory miner for Clone AI. Extract durable memory candidates from the task evidence below.",
    "Write the result as JSON to out/candidates.json: an array of at most 3 objects.",
    "Each object: { \"type\": \"fact|preference|procedure|decision|commitment\", \"summary\": string,",
    "  \"confidence\": \"low|medium|high\", \"sensitivity\": \"public|private|secret\",",
    "  \"sourceEvidenceIds\": [ids you actually cite] }",
    "",
    "Rules:",
    "- Summaries are one sentence, 5-60 words, in the user's language.",
    "- sourceEvidenceIds must be ids from the list below. Never invent an id.",
    "- Only durable knowledge: preferences, standing procedures, decisions, project facts.",
    "- Skip one-off details, credentials, and anything already implied by the task itself.",
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
    });
  }
  return candidates;
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
