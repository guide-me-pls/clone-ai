import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Read a JSON document without hiding malformed user configuration.
 * 读取 JSON 文档，但不吞掉用户配置中的格式错误。
 */
export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/**
 * Replace a JSON document atomically so a desktop crash cannot leave a half
 * written settings file. 用原子替换写入 JSON，避免桌面进程崩溃留下半个设置文件。
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
