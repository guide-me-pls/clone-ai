/**
 * The built-in skill market and its installer.
 *
 * Skills are plain `SKILL.md` files under the clone home's `skills/` directory;
 * the Main Agent lists them and loads a body only when the model invokes
 * `Skill(name)`. Shipping the market with the app instead of downloading from a
 * registry keeps the source reviewable and the install offline: every entry is
 * authored here, versioned with the code, and written as one file. A remote
 * registry needs a trust decision (who signed it, what may change between
 * versions) that this app does not have yet, so it is deliberately out of
 * scope; the entry shape is ready for a source URL when that decision exists.
 *
 * 内置技能市场与安装器。
 *
 * 技能是 clone home `skills/` 下的普通 `SKILL.md` 文件；Main Agent 只列出技能，模型调用
 * `Skill(name)` 时才加载正文。把市场随应用发布而不是从注册表下载，使来源可审查、安装可离线：
 * 每个条目都在本仓库撰写、随代码版本化，安装只写一个文件。远程注册表需要「谁签名、版本之间
 * 允许改什么」的信任决定，本应用尚未做出，因此刻意不在范围内；条目形状已为将来加入来源 URL
 * 留好位置。
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { loadSkills, skillRootsFor, type SkillDefinition } from "./skill-loader.ts";

export interface SkillText {
  "zh-CN": string;
  en: string;
}

export interface SkillRegistryEntry {
  /** The installed directory name and the SKILL.md `name`. 安装目录名与 SKILL.md 的 name。 */
  name: string;
  /** The one-line card text in the settings page. 设置页卡片的一行说明。 */
  summary: SkillText;
  /** The model-facing line stored in SKILL.md frontmatter. 写入 SKILL.md frontmatter 的模型可见说明。 */
  description: string;
  category: SkillText;
  /** Search terms in both languages. 双语搜索词。 */
  tags: string[];
  allowedTools: string[];
  body: string;
}

export const SKILL_REGISTRY: readonly SkillRegistryEntry[] = Object.freeze([
  {
    name: "weekly-review",
    summary: {
      "zh-CN": "把一周的工作整理成完成、受阻、下一步三段复盘。",
      en: "Turn a week of work into done / blocked / next.",
    },
    description: "把一周的工作整理成完成、受阻、下一步三段的复盘，每条都要有出处。",
    category: { "zh-CN": "复盘", en: "Review" },
    tags: ["周报", "复盘", "总结", "weekly", "review", "retro", "summary"],
    allowedTools: ["read_file", "search_text", "git_log"],
    body: `# 周复盘

把这一周的工作整理成三段：完成了什么、卡在哪里、下周先做什么。每条都要有出处，没有依据的进展不写。

## 步骤

1. 确定范围：默认最近 7 天；所有者给了日期或项目时以他给的为准。
2. 收集材料（按本回合可用的工具选择）：
   - 有任务或对话记录时，读本周的 Run 结果与失败原因；
   - 有 \`read_file\` / \`search_text\` / \`git_log\` 时，核对本周改动的文件与提交；
   - 材料不足时，列出缺口并请所有者补充，不要猜测。
3. 按三段整理，每条先写结论，再写依据（文件、提交、日期或对话）：
   - **已完成**：交付了什么，是否验收通过；
   - **受阻**：卡在哪一步，缺什么决定或输入；
   - **下一步**：下周最重要的三件事，按优先级排序，每件写成可执行动作。
4. 最后列出「需要所有者决定」的条目；没有就写「无」。

## 输出要求

- 用 Markdown，三段各一个二级标题。
- 一条不超过两行；不写「继续推进」这类空话。
- 不把计划写成已完成。`,
  },
  {
    name: "document-review",
    summary: {
      "zh-CN": "从结构、证据与读者角度审阅文档，给出可执行的修改清单。",
      en: "Review a document for structure, evidence and audience.",
    },
    description: "从结构、证据与读者三个角度审阅一份文档，输出可执行的修改清单。",
    category: { "zh-CN": "写作", en: "Writing" },
    tags: ["文档", "审阅", "写作", "修改", "document", "review", "writing", "edit"],
    allowedTools: ["read_file", "search_text"],
    body: `# 文档审阅

从结构、证据、读者三个角度审阅一份文档，给出可直接执行的修改清单，而不是重写整篇。

## 步骤

1. 读文档：有 \`read_file\` 时读全文；所有者只贴了片段时，先确认范围。
2. 明确目的与读者：文档要让谁做什么决定？找不到就写出来，请所有者确认。
3. 按三个角度逐项检查：
   - **结构**：开头是否说清结论；章节是否按读者的决策顺序排列；有没有重复或缺失的环节；
   - **证据**：每个关键结论是否有数据、引用或来源；数字是否可复核；有没有把推测写成事实；
   - **读者**：术语是否解释；一句话是否只有一个意思；长句能否拆短。
4. 输出修改清单，按影响排序：先列三个最重要的问题，再列逐条修改（引用原句 → 建议改法）。

## 输出要求

- 每条修改都指向原文的具体位置或原句。
- 不编造文档里没有的事实；缺证据的地方标为「需补充」。
- 所有者要求改写时，才给完整改写稿。`,
  },
  {
    name: "release-notes",
    summary: {
      "zh-CN": "把一组改动整理成面向用户的发布说明。",
      en: "Turn a set of changes into user-facing release notes.",
    },
    description: "把一组改动整理成面向用户的发布说明，按影响分组，不编造。",
    category: { "zh-CN": "研发", en: "Engineering" },
    tags: ["发布", "更新日志", "变更", "release", "notes", "changelog", "changes"],
    allowedTools: ["read_file", "search_text", "git_log", "git_diff"],
    body: `# 发布说明

把一组改动整理成面向用户的发布说明，按影响分组，不编造改动列表里没有的内容。

## 步骤

1. 收集改动：优先读 \`git_log\` / \`git_diff\`；没有 Git 工具时读变更清单或 CHANGELOG。
2. 按用户可见影响分组：新增、修复、变更（不兼容或行为变化）、内部（可省略）。
3. 每组写一到两句话，说明用户能感知到什么，而不是内部实现。
4. 为关键条目附上依据（提交、文件或问题编号）；找不到依据的条目不写。

## 输出要求

- 面向用户，不写文件路径和内部函数名。
- 不把重构、测试、依赖升级写成用户收益，除非它们改变行为。
- 末尾列出仍已知的问题；没有就写「无」。`,
  },
  {
    name: "deliverable-check",
    summary: {
      "zh-CN": "交付前按验收标准逐条自检，给出证据与结论。",
      en: "Check a deliverable against its acceptance criteria.",
    },
    description: "交付前按验收标准逐条自检，给出通过、未通过与未验证的证据。",
    category: { "zh-CN": "交付", en: "Delivery" },
    tags: ["验收", "自检", "交付", "质量", "acceptance", "check", "verify", "delivery"],
    allowedTools: ["read_file", "search_text"],
    body: `# 交付自检

交付前按验收标准逐条自检，给出通过、未通过或未验证，并附证据。没有证据就不算通过。

## 步骤

1. 列出验收标准：从任务说明、对话或文档中逐条摘出；有歧义时先写你的理解。
2. 为每条找证据：用 \`read_file\` / \`search_text\` 查看产物，或引用对话中的确认；记录文件、行号或日期。
3. 判定：
   - **通过**：证据直接支持该条；
   - **未通过**：证据表明不满足，写明差距；
   - **未验证**：找不到证据，写明缺什么。
4. 给出结论：可以交付 / 需要修复 / 需要所有者决定；列出必须修复的项。

## 输出要求

- 用表格或清单，一条一行，结论在前、证据在后。
- 不把「未验证」写成「通过」。
- 不修改产物，除非所有者要求你顺手修复。`,
  },
]);

/** One entry by name. 按名字取一个条目。 */
export function skillRegistryEntry(name: string): SkillRegistryEntry | undefined {
  return SKILL_REGISTRY.find((entry) => entry.name === name);
}

/** Every term must appear in the name, summaries, description, category or tags. 每个词都须出现在名称、摘要、说明、类别或标签里。 */
export function searchSkillRegistry(query: string): SkillRegistryEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return [...SKILL_REGISTRY];
  return SKILL_REGISTRY.filter((entry) => {
    const haystack = [
      entry.name,
      entry.summary["zh-CN"],
      entry.summary.en,
      entry.description,
      entry.category["zh-CN"],
      entry.category.en,
      ...entry.tags,
    ].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** The SKILL.md a market install writes. 市场安装写入的 SKILL.md。 */
export function skillMarkdown(entry: SkillRegistryEntry): string {
  const tools = entry.allowedTools.length > 0 ? `allowed-tools: [${entry.allowedTools.join(", ")}]\n` : "";
  return `---\nname: ${entry.name}\ndescription: ${entry.description}\n${tools}---\n\n${entry.body.trim()}\n`;
}

/** The clone home's installable skills root. clone home 中可安装技能的根目录。 */
export function installedSkillsRoot(dataDirectory: string): string {
  return join(dataDirectory, "skills");
}

/**
 * Write one built-in skill into `<clone home>/skills/<name>/SKILL.md`.
 * Refuses an existing directory so an install never overwrites an owner's
 * edits; the owner removes the old one first.
 * 把一个内置技能写入 `<clone home>/skills/<name>/SKILL.md`。已存在目录时拒绝，安装因此
 * 永不覆盖所有者的修改；所有者先移除旧技能。
 */
export async function installRegistrySkill(dataDirectory: string, name: string): Promise<string> {
  const entry = skillRegistryEntry(name);
  if (entry === undefined) throw new Error(`No built-in skill is named "${name}".`);
  const root = installedSkillsRoot(dataDirectory);
  const directory = join(root, entry.name);
  const path = join(directory, "SKILL.md");
  if (existsSync(directory)) {
    throw new Error(`A skill directory already exists at ${directory}; remove it before installing again.`);
  }
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, skillMarkdown(entry), { encoding: "utf8", mode: 0o644 });
  await rename(temporary, path);
  return path;
}

/**
 * Remove one installed skill from the clone home. The skill is located by its
 * frontmatter name, so a directory with a different name is still removed; the
 * directory itself must be a direct child of the skills root, never a symlink.
 * 从 clone home 移除一个已安装技能。按 frontmatter 名称定位，因此目录名不同也能移除；
 * 目录本身必须是技能根的直接子目录，且不是符号链接。
 */
export async function removeInstalledSkill(dataDirectory: string, name: string): Promise<void> {
  const root = resolve(installedSkillsRoot(dataDirectory));
  const loaded = await loadSkills([root]);
  const skill = loaded.skills.find((candidate) => candidate.name === name);
  if (skill === undefined) throw new Error(`No installed skill is named "${name}".`);
  const directory = resolve(dirname(skill.path));
  const relativePath = relative(root, directory);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.includes("/") || relativePath.includes("\\")) {
    throw new Error(`The skill "${name}" is not a direct child of ${root}.`);
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`The skill "${name}" is not a plain directory; refusing to remove it.`);
  }
  await rm(directory, { recursive: true, force: false });
}

/** An installed skill with its body, for the settings detail page. 带正文的已安装技能，供设置详情页。 */
export async function readInstalledSkill(dataDirectory: string, workspacePath: string, name: string): Promise<SkillDefinition | undefined> {
  const loaded = await loadSkills(skillRootsFor(dataDirectory, workspacePath));
  return loaded.skills.find((skill) => skill.name === name);
}