/**
 * A minimal `SKILL.md` loader with progressive disclosure.
 *
 * A skill is a directory with a `SKILL.md`: YAML-like frontmatter (`name`,
 * `description`, `allowed-tools`, `disable-model-invocation`, `user-invocable`)
 * and a Markdown body. Only the listing (`name: description`) is sent to the
 * model; the body is injected when the skill is invoked. This is the mechanism
 * that lets reusable procedures exist without inflating every prompt.
 *
 * 极简的 `SKILL.md` 加载器，支持渐进披露。
 *
 * 一个技能是一个带 `SKILL.md` 的目录：类 YAML 的 frontmatter（`name`、`description`、
 * `allowed-tools`、`disable-model-invocation`、`user-invocable`）与 Markdown 正文。
 * 模型只看到列表（`name: description`）；正文在被调用时才注入。这正是让可复用流程存在
 * 而不膨胀每个 Prompt 的机制。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SkillDefinition {
  name: string;
  description: string;
  /** Tools the skill is allowed to use while active; empty means no narrowing. 技能激活时允许使用的工具；为空表示不缩小。 */
  allowedTools: string[];
  /** Hidden from the model but still invocable by the owner. 对模型隐藏，但所有者仍可调用。 */
  disableModelInvocation: boolean;
  /** Whether the owner can invoke it as a slash command. 所有者能否以斜杠命令调用。 */
  userInvocable: boolean;
  /** Absolute path to the SKILL.md file. SKILL.md 的绝对路径。 */
  path: string;
  /** The Markdown body, injected only on invocation. Markdown 正文，仅在调用时注入。 */
  body: string;
}

export interface SkillLoadResult {
  skills: SkillDefinition[];
  /** Files that looked like skills but could not be parsed. 看起来像技能但解析失败的文件。 */
  rejected: Array<{ path: string; reason: string }>;
}

/**
 * Load every `SKILL.md` directly under the given roots (`<root>/<name>/SKILL.md`).
 * A malformed frontmatter drops only that skill; one bad file cannot hide the
 * rest of the library.
 * 加载给定根目录下的每个 `<root>/<name>/SKILL.md`。格式错误的 frontmatter 只丢弃该技能；
 * 一个坏文件不能藏起整个库。
 */
export async function loadSkills(roots: readonly string[]): Promise<SkillLoadResult> {
  const skills: SkillDefinition[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "SKILL.md");
      let source: string;
      try {
        source = await readFile(path, "utf8");
      } catch {
        continue;
      }
      try {
        const skill = parseSkill(source, path, entry.name);
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        skills.push(skill);
      } catch (error: unknown) {
        rejected.push({ path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { skills, rejected };
}

/** Parse one SKILL.md. 解析一个 SKILL.md。 */
export function parseSkill(source: string, path: string, directoryName: string): SkillDefinition {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("SKILL.md must start with a frontmatter block.");
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed.");
  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  const fields = parseFrontmatter(frontmatter);
  const name = fields.get("name")?.trim() || directoryName;
  const description = fields.get("description")?.trim();
  if (description === undefined || description.length === 0) {
    throw new Error("SKILL.md needs a description.");
  }
  const allowedTools = splitList(fields.get("allowed-tools") ?? fields.get("allowedTools"));
  return {
    name,
    description,
    allowedTools,
    disableModelInvocation: parseBoolean(fields.get("disable-model-invocation") ?? fields.get("disableModelInvocation")),
    userInvocable: parseBoolean(fields.get("user-invocable"), true),
    path,
    body,
  };
}

/**
 * The listing the model sees. It is intentionally small: one line per skill,
 * with the description capped, so a large library does not become a prompt tax.
 * 模型看到的列表。它刻意很小：每个技能一行，描述有上限，因此大库不会变成 Prompt 税。
 */
export function skillListing(skills: readonly SkillDefinition[], options: { maxDescriptionChars?: number; maxChars?: number } = {}): string {
  const perDescription = Math.max(40, options.maxDescriptionChars ?? 1_536);
  const total = Math.max(200, options.maxChars ?? 8_000);
  const lines: string[] = [];
  let used = 0;
  for (const skill of skills) {
    if (skill.disableModelInvocation) continue;
    const description = skill.description.length <= perDescription
      ? skill.description
      : `${skill.description.slice(0, perDescription - 1)}…`;
    const line = `- ${skill.name}: ${description}`;
    if (used + line.length + 1 > total) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length === 0 ? "" : `Skills available (invoke by name; their instructions load on use):\n${lines.join("\n")}`;
}

/** The skill's body with a small boundary preamble. 技能正文加上一小段边界说明。 */
export function skillInvocation(skill: SkillDefinition): string {
  const lines = [
    `Skill: ${skill.name}`,
    skill.description,
    "",
    skill.body.trim(),
  ];
  if (skill.allowedTools.length > 0) {
    // This is guidance to the model; the Kernel still enforces the real gate.
    // 这是给模型的指引；真正的闸门仍由 Kernel 执行。
    lines.push("", `This skill asks for these tools: ${skill.allowedTools.join(", ")}. The Kernel decides what is actually allowed.`);
  }
  return lines.join("\n");
}

function parseFrontmatter(source: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    fields.set(match[1]!, stripQuotes(match[2]!.trim()));
  }
  return fields;
}

function splitList(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) return [];
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner.split(",").map((item) => stripQuotes(item.trim())).filter((item) => item.length > 0);
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return /^(true|yes|1)$/i.test(value.trim());
}
