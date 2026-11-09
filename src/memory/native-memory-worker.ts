/**
 * Memory mining through Clone AI's own OpenAI-compatible endpoint.
 *
 * The model returns one JSON array; no external coding Agent, shell, or Pi
 * process is involved. Candidate validation stays in AgentMemoryWorker so the
 * native and legacy paths enforce exactly the same evidence rules.
 *
 * 通过 Clone AI 自己的 OpenAI 兼容端点提炼记忆。
 *
 * 模型直接返回一个 JSON 数组，不启动外部编码 Agent、Shell 或 Pi 进程。候选校验仍复用
 * AgentMemoryWorker，使原生路径与旧路径执行完全相同的证据规则。
 */
import { randomUUID } from "node:crypto";

import type { MemoryCandidate } from "../core/contracts.ts";
import { resolveNativeMainAgentEndpoint } from "../main-agent/native-runtime.ts";
import { miningPrompt, parseJsonArray, validateCandidates } from "./agent-memory-worker.ts";
import type { MemoryWorker, PendingMemoryJob } from "./memory-pipeline.ts";

export interface NativeMemoryWorkerOptions {
  dataDirectory: string;
  timeoutMs?: number;
  maxCandidates?: number;
  fetchImpl?: typeof fetch;
}

export class NativeMemoryWorker implements MemoryWorker {
  readonly #dataDirectory: string;
  readonly #timeoutMs: number;
  readonly #maxCandidates: number;
  readonly #fetch: typeof fetch;

  constructor(options: NativeMemoryWorkerOptions) {
    this.#dataDirectory = options.dataDirectory;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxCandidates = options.maxCandidates ?? 3;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async extract(job: PendingMemoryJob): Promise<MemoryCandidate[]> {
    const resolved = await resolveNativeMainAgentEndpoint(this.#dataDirectory);
    if (resolved.endpoint === undefined) {
      throw new Error(`Memory mining needs ${resolved.missing.join(" and ")}.`);
    }
    const endpoint = resolved.endpoint;
    const prompt = (job.promptOverride ?? miningPrompt(job)).replace(
      "Write the result as JSON to out/candidates.json:",
      "Return the JSON array directly in your response:",
    );
    const response = await this.#fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` }),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: "system", content: "You are a memory miner. Return only a JSON array." },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Memory mining request failed with HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const body = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const source = body.choices?.[0]?.message?.content ?? "";
    if (parseJsonArray(source) === undefined) {
      throw new Error(`Memory mining produced invalid JSON (request ${randomUUID()}).`);
    }
    return validateCandidates(source, job, this.#maxCandidates);
  }
}
