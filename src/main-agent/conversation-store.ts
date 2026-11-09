/**
 * Plain conversation pointers and legacy-session listing, without any agent SDK.
 *
 * The native Main Agent's transcript is the turn ledger; this module keeps the
 * small file-based pieces the CLI and desktop still use (the "current
 * conversation" pointer and a read-only listing of older session files). It
 * imports no SDK, so removing the Pi runtime does not remove the ability to
 * inspect what was already on disk.
 *
 * 不依赖任何 Agent SDK 的对话指针与旧会话列举。
 *
 * 原生主 Agent 的对话记录是回合台账；本模块保留 CLI 与桌面仍在用的小块文件能力
 * （“当前对话”指针，以及只读列举旧会话文件）。它不导入任何 SDK，因此移除 Pi 运行时
 * 并不会移除查看磁盘上已有记录的能力。
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const POINTER_FILE = "current-session.json";

/** The conversation both the CLI and the GUI continue. CLI 与 GUI 共同续跑的那段对话。 */
export async function readCurrentSessionPointer(directory: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, POINTER_FILE), "utf8")) as { sessionFile?: unknown };
    if (typeof parsed.sessionFile !== "string") return undefined;
    // A pointer to a file that never materialised (a new conversation with no
    // assistant turn yet) must not hide the real history.
    // 指向从未落盘的文件（尚无 assistant 回合的新对话）不能盖住真实历史。
    await stat(parsed.sessionFile);
    return parsed.sessionFile;
  } catch {
    return undefined;
  }
}

export async function writeCurrentSessionPointer(directory: string, sessionFile: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, POINTER_FILE), `${JSON.stringify({ sessionFile })}\n`, "utf8");
}

/** Conversations on disk, newest first. 磁盘上的对话，新的在前。 */
export async function listOwnerConversations(dataDirectory: string): Promise<Array<{ path: string; mtimeMs: number; messages: number; preview: string }>> {
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