/**
 * Everything the twin knows, in one portable archive.
 *
 * A personal agent holds a person's history: conversations, memories,
 * decisions, and the journal that explains them. The owner must be able to take
 * it out — to move machines, to inspect it, to leave. Dot's owner got a
 * "request your data" button when the product shut down; a local-first system
 * should not need a shutdown to offer the same.
 *
 * The archive is a directory tree plus a manifest, not a database dump: SQLite
 * files are copied as-is so they can be opened directly, and the manifest
 * records what each file is and when the export was taken. Nothing is
 * redacted: it is the owner's own data, going to the owner's own disk.
 *
 * 分身所知的一切，打成一个可迁移的归档。
 *
 * 个人 Agent 持有一个人的历史：对话、记忆、决策，以及解释它们的 Journal。所有者必须能把它带走——
 * 换机器、检查它、离开。Dot 关停时用户得到的是"索取你的数据"按钮；一个本地优先的系统不应等到关停
 * 才提供同样的能力。
 *
 * 归档是目录树加清单，而不是数据库导出：SQLite 文件原样复制以便直接打开，清单记录每个文件是什么、
 * 何时导出。不做任何脱敏：这是所有者自己的数据，去往所有者自己的磁盘。
 */
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

export interface ExportManifest {
  format: "clone-ai-export/1";
  exportedAt: string;
  /** Files copied, relative to the archive root, with their size. 已复制的文件，相对于归档根目录，附大小。 */
  files: Array<{ path: string; bytes: number }>;
  /** What the owner should know before handing this archive to anyone. 在把归档交给任何人之前所有者应知道的事。 */
  notice: string;
}

const NOTICE = "This archive contains your conversations, memories and audit journal in readable form. It is not encrypted.";

/**
 * Copies the owner's data directory into `destination`.
 *
 * Sessions are excluded by default: they are a cache of the running interface,
 * and copying them doubles the size without adding anything a restart needs.
 * 把所有者数据目录复制到 `destination`。
 *
 * 默认排除会话缓存：它们只是运行界面的缓存，复制它们会让体积翻倍，却不会带来重启需要的东西。
 */
export async function exportOwnerData(input: {
  dataDirectory: string;
  destination: string;
  includeSessions?: boolean;
  skip?: readonly string[];
}): Promise<ExportManifest> {
  const skip = new Set(input.skip ?? []);
  if (input.includeSessions !== true) skip.add("pi-sessions");
  const files: Array<{ path: string; bytes: number }> = [];
  await mkdir(input.destination, { recursive: true });

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const path = relative(input.dataDirectory, source);
      if (skip.has(path) || skip.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await walk(source);
        continue;
      }
      if (!entry.isFile()) continue;
      // Lock and WAL files are the database's own bookkeeping, not data; copying
      // them next to a copied database can make the copy look mid-write.
      // 锁文件与 WAL 是数据库自身的簿记而非数据；把它们放在复制来的数据库旁，会让副本看起来像写到一半。
      if (/-(journal|wal|shm)$/.test(entry.name)) continue;
      const target = join(input.destination, path);
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(source, target);
      files.push({ path, bytes: (await stat(target)).size });
    }
  };
  await walk(input.dataDirectory);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest: ExportManifest = {
    format: "clone-ai-export/1",
    exportedAt: new Date().toISOString(),
    files,
    notice: NOTICE,
  };
  await writeFile(join(input.destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/** A one-line summary for the CLI. 供 CLI 使用的单行摘要。 */
export function describeExport(manifest: ExportManifest, destination: string): string {
  const bytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  return `Exported ${manifest.files.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) to ${basename(destination)}. ${manifest.notice}`;
}

/** Paths an export deliberately leaves out, for the CLI to print. 导出刻意跳过的路径，供 CLI 打印。 */
export const EXPORT_EXCLUDES = ["pi-sessions (conversation cache)", "*-journal/-wal/-shm (database bookkeeping)"] as const;
