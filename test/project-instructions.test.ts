/**
 * Project instruction loading: what the Main Agent reads from the workspace.
 *
 * The properties under test are the ones that make the layer safe to have:
 * a file is read and labeled, an import cannot escape the workspace, a cycle
 * terminates, the byte budget truncates with a stated reason, and the switch
 * turns the whole thing off.
 *
 * 项目指令加载：主 Agent 从工作区读到什么。
 *
 * 被测的是让这一层可以安全存在的性质：文件被读取并标注、导入不能逃出工作区、循环会终止、
 * 字节预算截断时给出原因、开关能关闭整层。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import { realTarget } from "../src/authority/path-contains.ts";
import {
  discoverInstructionFiles,
  loadProjectInstructions,
  PROJECT_INSTRUCTIONS_HEADER,
  projectInstructionsEnabled,
} from "../src/main-agent/project-instructions.ts";

async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-instructions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("reads AGENTS.md before CLAUDE.md and labels the block as project instructions", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "AGENTS.md"), "# Team rules\n\nWrite a trade-off first.\n");
  await writeFile(join(root, "CLAUDE.md"), "# Editor rules\n\nPrefer TypeScript.\n");

  const loaded = await loadProjectInstructions({ workspacePath: root });
  assert.deepEqual(loaded.sources.map((source) => source.path), ["AGENTS.md", "CLAUDE.md"]);
  assert.match(loaded.text, /^Project instructions/);
  assert.match(loaded.text, /Write a trade-off first/);
  assert.match(loaded.text, /Prefer TypeScript/);
  assert.ok(loaded.text.indexOf("Write a trade-off first") < loaded.text.indexOf("Prefer TypeScript"), "AGENTS.md must come first");
  // The label is not cosmetic: it is the only thing that tells the model this
  // text is an unverified workspace file rather than approved memory.
  // 标注不是装饰：它是唯一告诉模型这段文本是未经验证的工作区文件、而非已审核记忆的东西。
  assert.ok(loaded.text.startsWith(PROJECT_INSTRUCTIONS_HEADER));
});

test("finds .claude/CLAUDE.md, CLAUDE.local.md and sorted rules", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, ".claude", "rules"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "root");
  await writeFile(join(root, "CLAUDE.local.md"), "local");
  await writeFile(join(root, ".claude", "CLAUDE.md"), "nested");
  await writeFile(join(root, ".claude", "rules", "b.md"), "rule b");
  await writeFile(join(root, ".claude", "rules", "a.md"), "rule a");

  const { files } = await discoverInstructionFiles(root);
  // The discovered paths are resolved (macOS /var -> /private/var), so compare
  // relative to the resolved root rather than to the raw temp path.
  // 发现到的路径是解析后的（macOS 上 /var -> /private/var），因此相对解析后的根比较，而不是原始临时路径。
  const resolvedRoot = realTarget(root);
  assert.deepEqual(files.map((file) => relative(resolvedRoot, file)), [
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/rules/a.md",
    ".claude/rules/b.md",
  ]);
});

test("expands an @import, but refuses one that leaves the workspace", async (t) => {
  const root = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), "clone-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.md"), "OUTSIDE-SECRET");
  await writeFile(join(root, "notes.md"), "IN-WORKSPACE-NOTE");
  await writeFile(join(root, "AGENTS.md"), [
    "Read these rules.",
    "@notes.md",
    `@${join(outside, "secret.md")}`,
    "End.",
  ].join("\n"));

  const loaded = await loadProjectInstructions({ workspacePath: root });
  assert.match(loaded.text, /IN-WORKSPACE-NOTE/);
  assert.doesNotMatch(loaded.text, /OUTSIDE-SECRET/);
  assert.ok(loaded.warnings.some((warning) => /outside the workspace/.test(warning)), "an escaping import must be reported");
  assert.deepEqual(loaded.sources[0]?.imports, ["notes.md"]);
});

test("refuses a symlinked import that points outside the workspace", async (t) => {
  const root = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), "clone-outside-link-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.md"), "LINKED-SECRET");
  await symlink(join(outside, "secret.md"), join(root, "linked.md"));
  await writeFile(join(root, "AGENTS.md"), "@linked.md\n");

  const loaded = await loadProjectInstructions({ workspacePath: root });
  assert.doesNotMatch(loaded.text, /LINKED-SECRET/);
  assert.ok(loaded.warnings.some((warning) => /outside the workspace/.test(warning)));
});

test("a self-import cycle terminates and is reported", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "AGENTS.md"), "Top.\n@AGENTS.md\n");

  const loaded = await loadProjectInstructions({ workspacePath: root });
  assert.match(loaded.text, /Top\./);
  assert.ok(loaded.warnings.length > 0);
});

test("the byte budget truncates and says so", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "AGENTS.md"), `${"x".repeat(500)}\n${"y".repeat(500)}\n`);

  const loaded = await loadProjectInstructions({ workspacePath: root, maxBytes: 300 });
  assert.ok(Buffer.byteLength(loaded.text, "utf8") < 500, "the text must not exceed the budget");
  assert.ok(loaded.warnings.some((warning) => /truncated/.test(warning)), "a truncation must be stated, not silent");
});

test("the switch turns the layer off, and a missing file is not an error", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "AGENTS.md"), "rules");
  const off = await loadProjectInstructions({ workspacePath: root, environment: { CLONE_AI_PROJECT_INSTRUCTIONS: "0" } });
  assert.equal(off.text, "");
  assert.deepEqual(off.sources, []);
  assert.equal(projectInstructionsEnabled({ CLONE_AI_PROJECT_INSTRUCTIONS: "0" }), false);
  assert.equal(projectInstructionsEnabled({}), true);

  const empty = await workspace(t);
  const none = await loadProjectInstructions({ workspacePath: empty });
  assert.equal(none.text, "");
  assert.deepEqual(none.warnings, []);
});
