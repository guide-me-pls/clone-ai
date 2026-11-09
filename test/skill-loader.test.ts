import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  loadSkills,
  parseSkill,
  skillInvocation,
  skillListing,
} from "../src/skills/skill-loader.ts";

const root = fileURLToPath(new URL("./fixtures/skills", import.meta.url));

test("a skill directory loads its frontmatter and body", async () => {
  const result = await loadSkills([root]);
  const skill = result.skills.find((item) => item.name === "release-notes");
  assert.ok(skill);
  assert.match(skill.description, /release note/i);
  assert.deepEqual(skill.allowedTools, ["read_file", "write_file"]);
  assert.equal(skill.disableModelInvocation, false);
  assert.equal(skill.userInvocable, true);
  assert.match(skill.body, /Never invent a change/);
});

test("a malformed skill is rejected without hiding the rest", async () => {
  const result = await loadSkills([root]);
  assert.equal(result.skills.some((skill) => skill.name === "release-notes"), true);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.reason, /frontmatter/);
});

test("the listing hides model-disabled skills and caps description length", async () => {
  const { skills } = await loadSkills([root]);
  const listing = skillListing(skills, { maxDescriptionChars: 40 });
  assert.match(listing, /release-notes/);
  assert.equal(listing.includes("hidden"), false);
  for (const line of listing.split("\n").slice(1)) {
    assert.ok(line.length <= 60, line);
  }
});

test("invocation carries the body and names the requested tools", async () => {
  const { skills } = await loadSkills([root]);
  const skill = skills.find((item) => item.name === "release-notes")!;
  const text = skillInvocation(skill);
  assert.match(text, /Skill: release-notes/);
  assert.match(text, /Never invent a change/);
  assert.match(text, /Kernel decides what is actually allowed/);
});

test("frontmatter parsing tolerates quotes, bracket lists, and a missing name", () => {
  const skill = parseSkill(`---
description: "Quoted description"
allowed-tools: read_file, write_file
---
Body.`, "/tmp/x/SKILL.md", "from-directory");
  assert.equal(skill.name, "from-directory");
  assert.equal(skill.description, "Quoted description");
  assert.deepEqual(skill.allowedTools, ["read_file", "write_file"]);
});
