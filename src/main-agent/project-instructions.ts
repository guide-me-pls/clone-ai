/**
 * Project instruction files: the repository's own rules, read by the Main Agent.
 *
 * Until this module existed nothing in `src/` read `AGENTS.md` or `CLAUDE.md`.
 * The only loader shipped was the skill loader, which accepts `SKILL.md` under
 * explicitly supplied roots. The result was visible in this repository: the
 * root `AGENTS.md` tells every agent to write a trade-off before an optimization
 * and to run `npm run gate`, and clone-main never saw it. A coding agent that
 * cannot read the repository's rules is answering a different question than the
 * one the files were written to answer.
 *
 * Three properties matter more than completeness:
 *   1. The text is labeled as project instructions, not as approved memory. It
 *      is owner-editable and unverifiable, so its provenance is stated where
 *      the model reads it.
 *   2. An `@path` import may not leave the workspace. A rules file that can
 *      import `~/.ssh/id_rsa` (or `../../secrets`) is an exfiltration primitive.
 *   3. It is bounded and switchable. `CLONE_AI_PROJECT_INSTRUCTIONS=0` turns the
 *      whole layer off; the total is capped, and truncation is stated rather
 *      than silent.
 *
 * 项目指令文件：仓库自己的规则，由主 Agent 读取。
 *
 * 在本模块出现之前，`src/` 里没有任何代码读取 `AGENTS.md` 或 `CLAUDE.md`。唯一的加载器是技能
 * 加载器，它只在显式提供的根目录下接受 `SKILL.md`。后果在本仓库就能看到：根目录的 `AGENTS.md`
 * 要求每个 Agent 在优化前写取舍、跑 `npm run gate`，而 clone-main 从未读到它。读不到仓库规则的
 * 编码 Agent，回答的是另一个问题。
 *
 * 有三条性质比"完整"更重要：
 *   1. 文本被标注为项目指令，而不是已审核的记忆。它可由所有者编辑、无法被运行时校验，因此来源
 *      要在模型读到它的地方写明。
 *   2. `@path` 导入不得离开工作区。一个能导入 `~/.ssh/id_rsa`（或 `../../secrets`）的规则文件
 *      就是一件外泄工具。
 *   3. 有上限、可关闭。`CLONE_AI_PROJECT_INSTRUCTIONS=0` 关闭整层；总量有上限，截断会被写明，
 *      而不是静默发生。
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";

import { containsPath, realTarget } from "../authority/path-contains.ts";

/** Total bytes of instruction text the Main Agent will accept. 主 Agent 接受的指令文本总量（字节）。 */
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 64 * 1024;
/** How deep an `@path` import may nest. `@path` 导入的最大嵌套深度。 */
export const PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH = 3;
/** Environment switch: `0` disables the whole layer. 环境开关：`0` 关闭整层。 */
export const PROJECT_INSTRUCTIONS_ENV = "CLONE_AI_PROJECT_INSTRUCTIONS";

/** Files read from the workspace root, in order. Duplicates are read once. 从工作区根读取的文件，按顺序；重复项只读一次。 */
const ROOT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Workspace-relative paths read after the root files. 根文件之后读取的工作区相对路径。 */
const NESTED_FILES = [join(".claude", "CLAUDE.md"), "CLAUDE.local.md"] as const;
const RULES_DIRECTORY = join(".claude", "rules");

export interface InstructionSource {
  /** Path relative to the workspace, as the owner would name it. 相对工作区的路径，所有者会这样称呼它。 */
  path: string;
  /** Bytes contributed after import expansion. 展开导入后贡献的字节数。 */
  bytes: number;
  /** Imported files, in the order they were expanded. 按展开顺序记录的导入文件。 */
  imports: string[];
}

export interface ProjectInstructions {
  /** The text to append to the system prompt; empty when nothing was read. 追加到系统提示词的文本；没有读到任何内容时为空。 */
  text: string;
  sources: InstructionSource[];
  /** Problems worth reporting: unreadable files, refused imports, a truncation. 值得报告的问题：不可读、被拒绝的导入、截断。 */
  warnings: string[];
}

/** Whether the layer is on. Unset or any value other than `0` means on. 这一层是否开启。未设置或非 `0` 即开启。 */
export function projectInstructionsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[PROJECT_INSTRUCTIONS_ENV]?.trim().toLowerCase();
  return value !== "0" && value !== "off" && value !== "false";
}

/**
 * Find the instruction files that exist in a workspace.
 *
 * The result is deterministic and ordered: root files first (`AGENTS.md` before
 * `CLAUDE.md`), then `.claude/CLAUDE.md`, `CLAUDE.local.md`, then
 * `.claude/rules/*.md` sorted by name. A file that is not a regular file is
 * skipped with a warning — a dangling symlink must not silently vanish.
 *
 * 找出工作区里存在的指令文件。
 *
 * 结果是确定且有序的：先根文件（`AGENTS.md` 先于 `CLAUDE.md`），再 `.claude/CLAUDE.md`、
 * `CLAUDE.local.md`，最后按名称排序的 `.claude/rules/*.md`。不是普通文件的条目会被跳过并给出
 * 警告——悬空的符号链接不能静默消失。
 */
export async function discoverInstructionFiles(workspacePath: string): Promise<{ files: string[]; warnings: string[] }> {
  const root = realTarget(resolve(workspacePath));
  const files: string[] = [];
  const warnings: string[] = [];
  for (const name of ROOT_FILES) files.push(join(root, name));
  for (const name of NESTED_FILES) files.push(join(root, name));
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(root, RULES_DIRECTORY), { withFileTypes: true });
    const ruleNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    for (const name of ruleNames) files.push(join(root, RULES_DIRECTORY, name));
  } catch (error: unknown) {
    if (!isMissingFile(error)) warnings.push(`Could not read .claude/rules: ${reasonOf(error)}`);
  }
  const regular: string[] = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      if (info.isFile()) regular.push(file);
    } catch (error: unknown) {
      if (!isMissingFile(error)) warnings.push(`Could not stat ${relative(root, file)}: ${reasonOf(error)}`);
    }
  }
  return { files: regular, warnings };
}

/**
 * Read instruction files with imports expanded and a hard byte budget.
 *
 * The budget is shared by every file: a workspace with a 60 KiB `AGENTS.md` and
 * a 60 KiB `CLAUDE.md` yields the first 64 KiB and a stated truncation, not a
 * 120 KiB prompt. Imports count against the same budget.
 *
 * 读取指令文件，展开导入并施加硬性字节预算。
 *
 * 预算由所有文件共享：60 KiB 的 `AGENTS.md` 加 60 KiB 的 `CLAUDE.md` 会产出前 64 KiB 并明确
 * 说明截断，而不是 120 KiB 的提示词。导入计在同一预算内。
 */
export async function loadProjectInstructions(options: {
  workspacePath: string;
  environment?: NodeJS.ProcessEnv;
  maxBytes?: number;
  maxImportDepth?: number;
}): Promise<ProjectInstructions> {
  if (!projectInstructionsEnabled(options.environment)) return { text: "", sources: [], warnings: [] };
  const root = realTarget(resolve(options.workspacePath));
  const maxBytes = options.maxBytes ?? PROJECT_INSTRUCTIONS_MAX_BYTES;
  const maxImportDepth = options.maxImportDepth ?? PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH;
  const { files, warnings } = await discoverInstructionFiles(root);
  if (files.length === 0) return { text: "", sources: [], warnings };

  const budget = { remaining: maxBytes };
  const seen = new Set<string>();
  const sources: InstructionSource[] = [];
  const sections: string[] = [];
  for (const file of files) {
    const expanded = await expandFile(file, root, { budget, seen, warnings, depth: 0, maxImportDepth });
    if (expanded === undefined) continue;
    sources.push({ path: relative(root, file), bytes: expanded.bytes, imports: expanded.imports });
    sections.push(`### ${relative(root, file)}\n\n${expanded.text}`);
  }
  if (sections.length === 0) return { text: "", sources, warnings };

  const header = [
    "Project instructions (owner-editable files in this workspace; organizational rules, not reviewed memories):",
    "Follow them when they apply to the work. If a rule conflicts with the owner's current message, say so and ask which wins.",
  ].join("\n");
  const text = `${header}\n\n${sections.join("\n\n")}`;
  return { text, sources, warnings };
}

interface ExpandOptions {
  budget: { remaining: number };
  seen: Set<string>;
  warnings: string[];
  depth: number;
  maxImportDepth: number;
}

/**
 * Read one file, replacing `@path` lines with the imported file's content.
 *
 * An import is expanded only when the target resolves inside the workspace.
 * The budget is checked before every read, so a hostile file cannot make the
 * loader read gigabytes by importing itself in a loop — the depth limit stops
 * recursion and the byte budget stops breadth.
 *
 * 读取一个文件，把 `@path` 行替换成被导入文件的内容。
 *
 * 只有当目标解析后位于工作区内时，导入才会展开。每次读取前都检查预算，因此恶意文件无法通过
 * 循环导入自己让加载器读取无限内容——深度限制阻止递归，字节预算阻止广度。
 */
async function expandFile(
  file: string,
  root: string,
  options: ExpandOptions,
): Promise<{ text: string; bytes: number; imports: string[] } | undefined> {
  const real = realTarget(file);
  if (options.seen.has(real)) {
    options.warnings.push(`Refused a repeated import of ${relative(root, real)}; a cycle cannot expand forever.`);
    return undefined;
  }
  if (!containsPath(root, real)) {
    options.warnings.push(`Refused ${relative(root, file)}: it resolves outside the workspace.`);
    return undefined;
  }
  let source: string;
  try {
    source = await readFile(real, "utf8");
  } catch (error: unknown) {
    options.warnings.push(`Could not read ${relative(root, file)}: ${reasonOf(error)}`);
    return undefined;
  }
  options.seen.add(real);

  const imports: string[] = [];
  const lines: string[] = [];
  let bytes = 0;
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const target = importTarget(line);
    if (target === undefined) {
      const size = Buffer.byteLength(`${line}\n`, "utf8");
      if (size > options.budget.remaining) {
        options.warnings.push(`Project instructions were truncated at ${relative(root, file)}; the ${optionsRemaining(options.budget)}-byte budget ran out.`);
        return { text: lines.join("\n"), bytes, imports };
      }
      options.budget.remaining -= size;
      bytes += size;
      lines.push(line);
      continue;
    }
    if (options.depth >= options.maxImportDepth) {
      options.warnings.push(`Not expanded (depth limit ${options.maxImportDepth}): ${line.trim()}`);
      continue;
    }
    const candidate = isAbsolute(target) ? target : join(dirname(real), target);
    const candidateReal = realTarget(candidate);
    if (!containsPath(root, candidateReal)) {
      options.warnings.push(`Not expanded (outside the workspace): ${line.trim()}`);
      continue;
    }
    const nested = await expandFile(candidateReal, root, { ...options, depth: options.depth + 1 });
    if (nested === undefined) continue;
    imports.push(relative(root, candidateReal), ...nested.imports);
    bytes += nested.bytes;
    lines.push(`<!-- imported ${relative(root, candidateReal)} -->`, nested.text);
  }
  return { text: lines.join("\n"), bytes, imports };
}

/** `@path` alone on a line is an import; anything else is ordinary Markdown. 单独成行的 `@path` 是导入；其余都是普通 Markdown。 */
function importTarget(line: string): string | undefined {
  const match = line.trim().match(/^@\s*(\S.*)$/);
  if (match === null) return undefined;
  const target = match[1]!.trim();
  // A trailing comment would make the path unmatchable; refuse it rather than
  // guess what the author meant.
  // 尾随注释会让路径无法匹配；直接拒绝，而不是猜作者的意思。
  if (target.includes(" ")) return undefined;
  return target;
}

function optionsRemaining(budget: { remaining: number }): number {
  return Math.max(0, budget.remaining);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code: string }).code === "ENOENT";
}

export const PROJECT_INSTRUCTIONS_HEADER = "Project instructions (owner-editable files in this workspace; organizational rules, not reviewed memories):";
