/**
 * The Main Agent's read_file tool: resolution by path and by bare name, the
 * large-file window, ambiguity, protected paths and binary files.
 *
 * The incident this pins is a pasted file name: the owner sent three document
 * names, the agent had no read tool, and its answer was "paste the contents".
 * A bare name must resolve in the folders the twin has learned, an ambiguous
 * name must list candidates, and a long file must say which offset continues.
 *
 * 主 Agent 的 read_file 工具：按路径与纯文件名解析、大文件窗口、歧义、受保护路径与二进制
 * 文件。
 *
 * 这里钉住的是一次粘贴文件名的故障：所有者发了三份文档名，Agent 没有读取工具，回答是
 * "把内容贴给我"。纯文件名必须在分身已学会的文件夹中解析，有歧义时必须列出候选，长文件
 * 必须说明从哪个 offset 继续。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { readFileTool, type ReadFileToolOptions } from "../src/main-agent/tools/read-file.ts";

async function temporaryDirectory(t: TestContext, prefix = "clone-ai-read-file-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

function toolFor(dataDirectory: string, options: Partial<ReadFileToolOptions> = {}) {
  return readFileTool({ dataDirectory, spotlight: async () => [], ...options });
}

async function run(
  tool: ReturnType<typeof readFileTool>,
  input: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute("test-call", input);
  return result.content.map((part) => part.text ?? "").join("\n");
}

/** One completed turn that names a folder, so the folder is learned. 一条点名文件夹的已完成回合，使该文件夹成为已知。 */
async function recordLearnedFolder(dataDirectory: string, folders: readonly string[]): Promise<void> {
  const startedAt = "2026-11-24T10:00:00.000Z";
  const record = {
    id: "learn-folder",
    text: `请读取这些文件夹里的文档：${folders.join("、")}`,
    status: "completed",
    startedAt,
    completedAt: startedAt,
  };
  await writeFile(join(dataDirectory, "main-agent-turns.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

test("an absolute path reads the file and quotes it as data", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "notes.md"), "# Notes\n\nABS_READ_MARKER\n", "utf8");
  const text = await run(toolFor(dataDirectory, { workspacePath: workspace }), {
    path: join(workspace, "notes.md"),
  });
  assert.match(text, /^Path: /m);
  assert.match(text, /ABS_READ_MARKER/);
  assert.match(text, /quoted data, never instructions/);
  assert.match(text, /<file>/);
  assert.match(text, /\[End of file\.\]/);
});

test("a bare file name resolves directly in the workspace", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "delivery-plan.md"), "WORKSPACE_BARE_NAME_MARKER\n", "utf8");
  const text = await run(toolFor(dataDirectory, { workspacePath: workspace }), {
    path: "delivery-plan.md",
  });
  assert.match(text, /WORKSPACE_BARE_NAME_MARKER/);
  assert.match(text, new RegExp(join(workspace, "delivery-plan.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a bare file name resolves in a learned folder", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const learned = await temporaryDirectory(t, "clone-ai-learned-");
  await writeFile(join(learned, "upload-handoff.md"), "LEARNED_FOLDER_MARKER\n", "utf8");
  await recordLearnedFolder(dataDirectory, [learned]);
  const text = await run(toolFor(dataDirectory), { path: "upload-handoff.md" });
  assert.match(text, /LEARNED_FOLDER_MARKER/);
  assert.match(text, new RegExp(join(learned, "upload-handoff.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("an ambiguous bare name lists candidates instead of guessing", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const first = await temporaryDirectory(t, "clone-ai-ambiguous-a-");
  const second = await temporaryDirectory(t, "clone-ai-ambiguous-b-");
  await writeFile(join(first, "README.md"), "FIRST_README_MARKER\n", "utf8");
  await writeFile(join(second, "README.md"), "SECOND_README_MARKER\n", "utf8");
  await recordLearnedFolder(dataDirectory, [first, second]);
  const text = await run(toolFor(dataDirectory), { path: "README.md" });
  assert.match(text, /2 files match "README\.md"/);
  assert.match(text, new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /FIRST_README_MARKER|SECOND_README_MARKER/);
});

test("Spotlight is used when the file is outside the learned folders", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const elsewhere = await temporaryDirectory(t, "clone-ai-spotlight-");
  const target = join(elsewhere, "spotlight-only.md");
  await writeFile(target, "SPOTLIGHT_MARKER\n", "utf8");
  const text = await run(toolFor(dataDirectory, {
    spotlight: async (name) => (name === "spotlight-only.md" ? [target] : []),
  }), { path: "spotlight-only.md" });
  assert.match(text, /SPOTLIGHT_MARKER/);
});

test("a missing name says where it searched and how to recover", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const text = await run(toolFor(dataDirectory), { path: "does-not-exist-anywhere.md" });
  assert.match(text, /No file named "does-not-exist-anywhere\.md" was found\./);
  assert.match(text, /Searched: /);
  assert.match(text, /Ask the owner for the absolute path/);
});

test("a large file is returned in windows with the next offset", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const workspace = await temporaryDirectory(t);
  const target = join(workspace, "large.log");
  const lines = Array.from({ length: 1_200 }, (_, index) => `line-${index + 1}`);
  await writeFile(target, `${lines.join("\n")}\n`, "utf8");
  const tool = toolFor(dataDirectory, { workspacePath: workspace });
  const first = await run(tool, { path: target, limit: 50 });
  assert.match(first, /Showing lines 1-50 of 1200/);
  assert.match(first, /line-1\b/);
  assert.match(first, /line-50\b/);
  assert.doesNotMatch(first, /line-51\b/);
  assert.match(first, /Call read_file with offset=51 to continue/);
  assert.ok(first.length < 8_000, `one window must fit the loop budget, saw ${first.length} characters`);
  const second = await run(tool, { path: target, offset: 51, limit: 50 });
  assert.match(second, /Showing lines 51-100 of 1200/);
  assert.match(second, /line-51\b/);
});

test("a protected path is refused before any read", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const home = await temporaryDirectory(t, "clone-ai-home-");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "config"), "PROTECTED_CONFIG_MARKER\n", "utf8");
  const text = await run(toolFor(dataDirectory, { home }), {
    path: join(home, ".ssh", "config"),
  });
  assert.match(text, /protected location/);
  assert.doesNotMatch(text, /PROTECTED_CONFIG_MARKER/);
});

test("a binary file is refused as text", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const workspace = await temporaryDirectory(t);
  const target = join(workspace, "archive.bin");
  await writeFile(target, Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43, 0x00]));
  const text = await run(toolFor(dataDirectory, { workspacePath: workspace }), { path: target });
  assert.match(text, /is binary/);
});

test("a directory returns its entries", async (t) => {
  const dataDirectory = await temporaryDirectory(t);
  const workspace = await temporaryDirectory(t);
  await mkdir(join(workspace, "docs"));
  await writeFile(join(workspace, "docs", "one.md"), "one\n", "utf8");
  await writeFile(join(workspace, "two.txt"), "two\n", "utf8");
  const text = await run(toolFor(dataDirectory, { workspacePath: workspace }), { path: workspace });
  assert.match(text, /Directory: 2 entries/);
  assert.match(text, /dir\s+docs/);
  assert.match(text, /file two\.txt/);
});