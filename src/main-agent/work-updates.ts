/**
 * Work updates: what background runs finished, written where the conversation
 * can read them.
 *
 * The Kernel already journals every run, but the chat is a record of turns: a
 * task that finished while the owner was away left no message behind, so the
 * next thing the owner saw was a sidebar status with no explanation. This file
 * is the bridge — the daemon appends one line per settled run, and the
 * conversation renders it as a message.
 *
 * 工作更新：后台 Run 完成了什么，写在对话能读到的地方。
 *
 * Kernel 已经为每个 Run 写入 Journal，但对话是一份回合记录：所有者不在时完成的任务不会
 * 留下任何消息，他回来只看到侧栏状态、没有解释。这个文件就是桥——守护进程为每个落定的
 * Run 追加一行，对话把它渲染成一条消息。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkUpdate {
  id: string;
  runId: string;
  title: string;
  status: "completed" | "failed" | "cancelled" | "waiting_review";
  /** One sentence a person can read without opening anything. 一句不用打开任何东西就能读懂的话。 */
  summary: string;
  at: string;
  evidenceCount: number;
}

export async function appendWorkUpdate(dataDirectory: string, update: WorkUpdate): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(join(dataDirectory, "work-updates.jsonl"), `${JSON.stringify(update)}\n`, "utf8");
}

export async function readWorkUpdates(dataDirectory: string, limit = 50): Promise<WorkUpdate[]> {
  let source: string;
  try {
    source = await readFile(join(dataDirectory, "work-updates.jsonl"), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, WorkUpdate>();
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value = JSON.parse(trimmed) as Partial<WorkUpdate>;
      if (typeof value.id !== "string" || typeof value.runId !== "string" || typeof value.at !== "string") continue;
      if (value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled" && value.status !== "waiting_review") continue;
      byId.set(value.id, {
        id: value.id,
        runId: value.runId,
        title: typeof value.title === "string" ? value.title : "任务",
        status: value.status,
        summary: typeof value.summary === "string" ? value.summary : "",
        at: value.at,
        evidenceCount: typeof value.evidenceCount === "number" ? value.evidenceCount : 0,
      });
    } catch {
      continue;
    }
  }
  return [...byId.values()].sort((left, right) => left.at.localeCompare(right.at)).slice(-limit);
}

/** The sentence the conversation shows. 对话里显示的那句话。 */
export function describeWorkUpdate(update: WorkUpdate): string {
  const label = { completed: "已完成", failed: "失败", cancelled: "已取消", waiting_review: "等待你复核" }[update.status];
  const evidence = update.evidenceCount > 0 ? `，${update.evidenceCount} 条证据` : "";
  return `任务「${update.title}」${label}${update.summary ? `：${update.summary}` : ""}${evidence}。`;
}