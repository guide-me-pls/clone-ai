/**
 * The built-in skill market must produce files the loader can read, install
 * only inside the clone home, and refuse to overwrite or escape it.
 *
 * 内置技能市场必须产出加载器能读的文件，只安装到 clone home 内，并拒绝覆盖或逃逸。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { loadSkills, parseSkill } from "../src/skills/skill-loader.ts";
import {
  installRegistrySkill,
  removeInstalledSkill,
  searchSkillRegistry,
  SKILL_REGISTRY,
  skillMarkdown,
} from "../src/skills/skill-registry.ts";

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-skill-registry-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("every built-in skill is a valid SKILL.md with both UI languages", () => {
  assert.ok(SKILL_REGISTRY.length >= 4);
  const names = new Set<string>();
  for (const entry of SKILL_REGISTRY) {
    assert.match(entry.name, /^[a-z0-9][a-z0-9-]*$/, entry.name);
    assert.equal(names.has(entry.name), false, `duplicate skill ${entry.name}`);
    names.add(entry.name);
    assert.ok(entry.summary["zh-CN"].length > 0 && entry.summary.en.length > 0, `${entry.name} needs both summaries`);
    assert.ok(entry.category["zh-CN"].length > 0 && entry.category.en.length > 0, `${entry.name} needs both categories`);
    assert.equal(entry.description.includes("\n"), false, `${entry.name}'s frontmatter description must be one line`);
    assert.ok(entry.body.trim().length > 40, `${entry.name} needs a real body`);
    const parsed = parseSkill(skillMarkdown(entry), `/skills/${entry.name}/SKILL.md`, entry.name);
    assert.equal(parsed.name, entry.name);
    assert.equal(parsed.description, entry.description);
    assert.deepEqual(parsed.allowedTools, entry.allowedTools);
    assert.equal(parsed.body.trim(), entry.body.trim());
  }
});

test("the skill market searches Chinese and English terms", () => {
  assert.deepEqual(searchSkillRegistry("周报").map((entry) => entry.name), ["weekly-review"]);
  assert.deepEqual(searchSkillRegistry("document").map((entry) => entry.name), ["document-review"]);
  assert.deepEqual(searchSkillRegistry("交付").map((entry) => entry.name), ["deliverable-check"]);
  assert.deepEqual(searchSkillRegistry("   ").map((entry) => entry.name), SKILL_REGISTRY.map((entry) => entry.name));
  assert.deepEqual(searchSkillRegistry("no-such-skill"), []);
});

test("installing writes one readable SKILL.md and never overwrites an existing one", async (t) => {
  const dataDirectory = await tempDir(t);
  const path = await installRegistrySkill(dataDirectory, "weekly-review");
  assert.equal(path, join(dataDirectory, "skills", "weekly-review", "SKILL.md"));
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  assert.match(await readFile(path, "utf8"), /^---\nname: weekly-review\n/);
  const loaded = await loadSkills([join(dataDirectory, "skills")]);
  assert.deepEqual(loaded.skills.map((skill) => skill.name), ["weekly-review"]);
  assert.match(loaded.skills[0]?.body ?? "", /周复盘/);
  await assert.rejects(() => installRegistrySkill(dataDirectory, "weekly-review"), /remove it before installing again/);
});

test("removing deletes only a direct child of the clone home's skills root", async (t) => {
  const dataDirectory = await tempDir(t);
  await installRegistrySkill(dataDirectory, "document-review");
  await removeInstalledSkill(dataDirectory, "document-review");
  assert.deepEqual((await loadSkills([join(dataDirectory, "skills")])).skills, []);
  await assert.rejects(() => removeInstalledSkill(dataDirectory, "document-review"), /No installed skill/);
  await assert.rejects(() => removeInstalledSkill(dataDirectory, "../escape"), /No installed skill/);
  await assert.rejects(() => installRegistrySkill(dataDirectory, "../escape"), /No built-in skill/);
});