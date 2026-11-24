/**
 * The model and effort a conversation keeps between opens.
 *
 * The desktop composer used to keep this in the page's local storage. The app
 * loads the daemon at an ephemeral 127.0.0.1 port, and local storage is scoped
 * to that origin, so every daemon restart gave the owner a different origin and
 * silently dropped the choice. The conversation is the right scope; this small
 * owner-data file keeps it there.
 *
 * 对话在两次打开之间保留的模型与强度。
 *
 * 桌面输入框过去把它放在页面的 local storage。应用从守护进程的临时 127.0.0.1 端口加载，
 * 而 local storage 按 origin 隔离，因此每次 Daemon 重启都会换一个 origin，悄悄丢掉选择。
 * 对话才是正确的范围；这份小的所有者数据文件把选择留在那里。
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export const TURN_CHOICES_FILE = "turn-choices.json";
const MAX_CHOICES = 500;
const MAX_MODEL_LENGTH = 200;
const MAX_EFFORT_LENGTH = 64;

export interface TurnChoice {
  model: string;
  effort: string;
  updatedAt: string;
}

export interface TurnChoiceUpdate {
  /** Omit to keep the stored model; an empty string clears it. 省略表示保留已存模型；空串表示清除。 */
  model?: string;
  /** Omit to keep the stored effort; an empty string clears it. 省略表示保留已存强度；空串表示清除。 */
  effort?: string;
}

interface StoredFile {
  version: 1;
  choices: Record<string, TurnChoice>;
}

export function turnChoicesFile(dataDirectory: string): string {
  return join(dataDirectory, TURN_CHOICES_FILE);
}

function validId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && !id.includes("\u0000");
}

async function readFile(dataDirectory: string): Promise<StoredFile> {
  let source: string;
  try {
    source = await fs.readFile(turnChoicesFile(dataDirectory), "utf8");
  } catch {
    return { version: 1, choices: {} };
  }
  try {
    const parsed = JSON.parse(source) as Partial<StoredFile>;
    if (parsed.version !== 1 || typeof parsed.choices !== "object" || parsed.choices === null) {
      return { version: 1, choices: {} };
    }
    const choices: Record<string, TurnChoice> = {};
    for (const [id, value] of Object.entries(parsed.choices)) {
      if (!validId(id) || typeof value !== "object" || value === null) continue;
      const entry = value as Partial<TurnChoice>;
      if (typeof entry.model !== "string" || typeof entry.effort !== "string" || typeof entry.updatedAt !== "string") continue;
      if (entry.model.length > MAX_MODEL_LENGTH || entry.effort.length > MAX_EFFORT_LENGTH) continue;
      if (!entry.model && !entry.effort) continue;
      choices[id] = { model: entry.model, effort: entry.effort, updatedAt: entry.updatedAt };
    }
    return { version: 1, choices };
  } catch {
    return { version: 1, choices: {} };
  }
}

export async function readTurnChoices(dataDirectory: string): Promise<Record<string, TurnChoice>> {
  return (await readFile(dataDirectory)).choices;
}

export async function readTurnChoice(dataDirectory: string, conversationId: string): Promise<TurnChoice | undefined> {
  if (!validId(conversationId)) return undefined;
  return (await readTurnChoices(dataDirectory))[conversationId];
}

const writeQueues = new Map<string, Promise<void>>();

/**
 * Merge one update and write the file atomically. A partial update keeps the
 * field it omits; two empty fields remove the entry, so "follow Settings" is
 * stored as an absence rather than as an override with empty strings.
 * 合并一次更新并原子写文件。部分更新保留它省略的字段；两个字段都为空则删除条目，因此
 * "跟随设置"以缺失保存，而不是用空串覆盖。
 */
export async function writeTurnChoice(
  dataDirectory: string,
  conversationId: string,
  update: TurnChoiceUpdate,
  now: Date = new Date(),
): Promise<TurnChoice | undefined> {
  if (!validId(conversationId)) return undefined;
  const path = turnChoicesFile(dataDirectory);
  const previous = writeQueues.get(path) ?? Promise.resolve();
  let result: TurnChoice | undefined;
  const write = previous.then(async () => {
    const stored = await readFile(dataDirectory);
    const current = stored.choices[conversationId];
    const model = update.model === undefined ? current?.model ?? "" : update.model.trim().slice(0, MAX_MODEL_LENGTH);
    const effort = update.effort === undefined ? current?.effort ?? "" : update.effort.trim().slice(0, MAX_EFFORT_LENGTH);
    if (!model && !effort) {
      delete stored.choices[conversationId];
      result = undefined;
    } else {
      result = { model, effort, updatedAt: now.toISOString() };
      stored.choices[conversationId] = result;
    }
    const rows = Object.entries(stored.choices);
    if (rows.length > MAX_CHOICES) {
      rows.sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt));
      stored.choices = Object.fromEntries(rows.slice(0, MAX_CHOICES));
    }
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, path);
  }).catch(() => undefined);
  writeQueues.set(path, write);
  await write;
  if (writeQueues.get(path) === write) writeQueues.delete(path);
  return result;
}
