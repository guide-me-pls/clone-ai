/**
 * Plain-file conversation index for the built-in Main Agent.
 *
 * Reading the owner's saved conversations must not load Pi or any Agent SDK.
 * The ledger remains authoritative for native turns; these helpers only keep
 * the existing JSONL index and current-conversation pointer readable.
 *
 * 内置 Main Agent 的纯文件对话索引。
 *
 * 读取所有者保存的对话不应加载 Pi 或任何 Agent SDK。原生回合仍以账本为权威；
 * 这些辅助函数只负责继续读取既有 JSONL 索引与当前对话指针。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const POINTER_FILE = "current-session.json";

export async function readCurrentSessionPointer(directory: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, POINTER_FILE), "utf8")) as { sessionFile?: unknown };
    if (typeof parsed.sessionFile !== "string") return undefined;
    await stat(parsed.sessionFile);
    return parsed.sessionFile;
  } catch {
    return undefined;
  }
}

export async function writeCurrentSessionPointer(directory: string, sessionFile: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, POINTER_FILE), `${JSON.stringify({ sessionFile })}\n`, "utf8");
}

export async function listOwnerConversations(
  dataDirectory: string,
): Promise<Array<{ path: string; mtimeMs: number; messages: number; preview: string }>> {
  const directory = join(dataDirectory, "pi-sessions", "main-agent");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const rows = await Promise.all(names.map(async (name) => {
    const path = join(directory, name);
    const info = await stat(path);
    const source = await readFile(path, "utf8").catch(() => "");
    const lines = source.split("\n").filter((line) => line.trim().length > 0);
    const messages = lines.filter((line) => line.includes('"type":"message"')).length;
    let preview = "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (parsed.type !== "message" || parsed.message?.role !== "user") continue;
        const content = parsed.message.content;
        preview = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join(" ")
            : "";
        if (preview.trim().length > 0) break;
      } catch {
        continue;
      }
    }
    return { path, mtimeMs: info.mtimeMs, messages, preview: preview.replace(/\s+/g, " ").slice(0, 60) };
  }));
  return rows.sort((left, right) => right.mtimeMs - left.mtimeMs);
}
