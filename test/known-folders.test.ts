/**
 * The twin learns folders by use, not by a setting.
 *
 * A path the owner names is reduced to the folder that holds a project, then
 * remembered in the turn ledger itself. These tests pin the reduction rules so
 * "~/work" cannot silently become "~/work/knowledge_base" (one repository) or
 * "~/Documents" (the whole personal container).
 *
 * 分身通过使用来学习文件夹，而不是通过设置。
 *
 * 所有者点名的路径会被归到容纳项目的文件夹，然后记在回合台账本身。这些测试固定归并规则，
 * 使 "~/work" 不会悄悄变成 "~/work/knowledge_base"（一个仓库）或 "~/Documents"（整个个人容器）。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";
import { extractFolders, folderCollection, knownOwnerFolders, renderKnownFolders } from "../src/main-agent/known-folders.ts";

async function home(t: TestContext): Promise<{ home: string; dataDirectory: string }> {
  const home = await mkdtemp(join(tmpdir(), "clone-folders-home-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-folders-data-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { home, dataDirectory };
}

test("a project path teaches the folder that holds it, not the file or the whole container", async (t) => {
  const { home: root } = await home(t);
  const canonical = await realpath(root);
  const project = join(root, "work", "knowledge_base");
  const notes = join(root, "Documents", "notes");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(notes, { recursive: true });
  await mkdir(join(root, "work", "doc_translate"), { recursive: true });
  await writeFile(join(project, "README.md"), "# 知识库", "utf8");
  await writeFile(join(root, "work", "doc_translate", "main.py"), "print(1)", "utf8");
  await writeFile(join(notes, "todo.md"), "笔记", "utf8");

  assert.equal(folderCollection(join(project, "README.md"), root), join(canonical, "work"));
  assert.equal(folderCollection(join(root, "work", "doc_translate", "main.py"), root), join(canonical, "work"));
  // Documents is a noisy container; its project is remembered as its own folder. Documents 是杂乱容器，其项目记成自己的文件夹。
  assert.equal(folderCollection(join(notes, "todo.md"), root), join(canonical, "Documents", "notes"));
  // A missing path is not remembered just because it was typed. 缺失的路径不会仅因被输入就被记住。
  assert.equal(folderCollection(join(root, "missing", "x.md"), root), undefined);
});

test("quoted paths and folder phrases resolve to an existing folder", async (t) => {
  const { home: root } = await home(t);
  const canonical = await realpath(root);
  await mkdir(join(root, "work", "proj", ".git"), { recursive: true });
  await mkdir(join(root, "study", "repo", ".git"), { recursive: true });
  await writeFile(join(root, "work", "proj", "README.md"), "x", "utf8");

  const folders = extractFolders(
    "只读取 `" + join(root, "work", "proj", "README.md") + "`；整理 work文件夹 下的修改，不要碰 study文件夹。",
    root,
  );
  assert.deepEqual(new Set(folders), new Set([join(canonical, "work"), join(canonical, "study")]));
});

test("a protected location is never learned", async (t) => {
  const { home: root } = await home(t);
  await mkdir(join(root, ".ssh"), { recursive: true });
  await writeFile(join(root, ".ssh", "config"), "Host *", "utf8");

  assert.deepEqual(extractFolders("读取 ~/.ssh/config", root), []);
});

test("remembered folders come from the persisted turn ledger, newest first", async (t) => {
  const { home: root, dataDirectory } = await home(t);
  const canonical = await realpath(root);
  await mkdir(join(root, "work", "proj", ".git"), { recursive: true });
  await mkdir(join(root, "study", "repo", ".git"), { recursive: true });
  const workFile = join(root, "work", "proj", "README.md");
  const studyFile = join(root, "study", "repo", "main.ts");
  await writeFile(workFile, "x", "utf8");
  await writeFile(studyFile, "x", "utf8");
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "turn-1", text: `只读 ${workFile}，说明项目。`, status: "completed",
    startedAt: "2026-11-18T09:00:00.000Z", completedAt: "2026-11-18T09:00:05.000Z",
    conversationId: "conversation-a",
  });
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "turn-2", text: `再看 ${workFile} 的测试。`, status: "completed",
    startedAt: "2026-11-18T10:00:00.000Z", completedAt: "2026-11-18T10:00:05.000Z",
    conversationId: "conversation-a",
  });
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "turn-3", text: `审查 ${studyFile}。`, status: "completed",
    startedAt: "2026-11-19T09:00:00.000Z", completedAt: "2026-11-19T09:00:05.000Z",
    conversationId: "conversation-b",
  });

  const remembered = await knownOwnerFolders(dataDirectory, { home: root, limit: 5 });
  assert.deepEqual(remembered.map((folder) => folder.path), [join(canonical, "study"), join(canonical, "work")]);
  assert.equal(remembered[1]?.uses, 2);
  // A folder named in the current request is known on this turn, not the next. 当前请求点名的文件夹在本回合就已知。
  const withQuery = await knownOwnerFolders(dataDirectory, {
    home: root,
    query: `整理 ${join(root, "work", "proj")} 的修改`,
    now: "2026-11-20T00:00:00.000Z",
    limit: 5,
  });
  assert.equal(withQuery[0]?.path, join(canonical, "work"));
  assert.match(renderKnownFolders(remembered), /Folders you have worked in/);
  assert.match(renderKnownFolders(remembered), new RegExp(join(canonical, "work").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
