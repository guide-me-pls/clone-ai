/**
 * BadCaseLog: every failure the runtime records, appended to a local file.
 *
 * The owner drives optimization from this file: run real agents, read what
 * actually fails, fix the causes, repeat. Email and Langfuse can come later;
 * the local log is the source the later integrations read from.
 *
 * BadCaseLog：把 Runtime 记录的每一次失败追加到本地文件。
 *
 * 所有者从这份文件驱动优化循环：跑真实 Agent、读实际失败、修原因、再跑。邮件和
 * Langfuse 可以以后接；本地日志是后续集成读取的源头。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { JournalEvent } from "../core/contracts.ts";

export interface BadCaseRecord {
  sequence: number;
  type: string;
  occurredAt: string;
  runId?: string;
  workOrderId?: string;
  agentId?: string;
  message: string;
}

const BAD_TYPES = new Set([
  "run.status_changed", // only failed/cancelled
  "subagent.failed",
  "dispatch.blocked",
  "agent.install_failed",
  "verification.completed", // only when not passed
]);

/** Extracts the bad cases from a journal slice, newest first. 从一段 Journal 中提取坏案例，新的在前。 */
export function collectBadCases(events: readonly JournalEvent[]): BadCaseRecord[] {
  const records: BadCaseRecord[] = [];
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "run.status_changed" && payload.status !== "failed" && payload.status !== "cancelled") continue;
    if (event.type === "verification.completed" && payload.passed !== false) continue;
    if (!BAD_TYPES.has(event.type)) continue;
    records.push({
      sequence: event.sequence,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(typeof payload.workOrderId === "string" ? { workOrderId: payload.workOrderId } : {}),
      ...(typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
      message: String(
        payload.reason ?? payload.message ?? payload.summary ?? event.type,
      ),
    });
  }
  return records.sort((left, right) => left.sequence - right.sequence);
}

export interface BadCaseLogOptions {
  dataDirectory: string;
  /** Maximum log file size before rotation; the file is trimmed from the head. 日志文件超过该大小后轮转（从头截断）。 */
  maxBytes?: number;
}

/**
 * Appends new bad cases to <dataDirectory>/reporting/bad-cases.md. The marker
 * file remembers the last appended sequence, so restarting never duplicates
 * and never misses. 把新坏案例追加到 <dataDirectory>/reporting/bad-cases.md。
 * 标记文件记住最后追加的 sequence，因此重启不会重复也不会遗漏。
 */
export class BadCaseLog {
  readonly #logPath: string;
  readonly #markerPath: string;
  readonly #maxBytes: number;

  constructor(options: BadCaseLogOptions) {
    this.#logPath = join(options.dataDirectory, "reporting", "bad-cases.md");
    this.#markerPath = join(options.dataDirectory, "reporting", "bad-cases-seq.json");
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  }

  /** Appends bad cases newer than the last append; returns what was appended. 追加比上次更新的坏案例，返回追加的内容。 */
  async appendNew(events: readonly JournalEvent[]): Promise<BadCaseRecord[]> {
    const lastSequence = await this.#lastSequence();
    const fresh = collectBadCases(events).filter((record) => record.sequence > lastSequence);
    if (fresh.length === 0) return [];
    await mkdir(dirname(this.#logPath), { recursive: true });
    const block = fresh.map((record) => {
      const who = [record.agentId, record.workOrderId, record.runId].filter(Boolean).join(" / ");
      return `- [seq ${record.sequence}] ${record.type}${who === "" ? "" : ` (${who})`} @ ${record.occurredAt}\n  ${record.message.replace(/\n/g, " ").slice(0, 300)}`;
    }).join("\n");
    await appendFile(this.#logPath, `## ${fresh[0]!.occurredAt.slice(0, 10)}\n${block}\n`, "utf8");
    await appendFile(this.#markerPath, "", "utf8").catch(() => undefined);
    const maxSequence = fresh.at(-1)!.sequence;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(this.#markerPath, `${JSON.stringify({ sequence: maxSequence })}\n`, "utf8");
    await this.#rotateIfNeeded();
    return fresh;
  }

  async readLog(): Promise<string> {
    try {
      return await readFile(this.#logPath, "utf8");
    } catch {
      return "";
    }
  }

  async #lastSequence(): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(this.#markerPath, "utf8")) as { sequence?: unknown };
      return typeof parsed.sequence === "number" ? parsed.sequence : 0;
    } catch {
      return 0;
    }
  }

  async #rotateIfNeeded(): Promise<void> {
    const { stat } = await import("node:fs/promises");
    try {
      const info = await stat(this.#logPath);
      if (info.size <= this.#maxBytes) return;
    } catch {
      return;
    }
    const source = await this.readLog();
    const lines = source.split("\n");
    // Keep roughly the newest half. 大致保留最新的一半。
    const kept = lines.slice(Math.floor(lines.length / 2));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(this.#logPath, kept.join("\n"), "utf8");
  }
}
