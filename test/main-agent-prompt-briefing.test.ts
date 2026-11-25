/**
 * The learned-folder block is delivered on demand, not in every turn.
 *
 * The owner asked why folders the twin merely remembers ride along with every
 * request. The per-turn prompt now omits them; the same compiler still renders
 * them for the Settings API and `get_situation`, whose `foldersOnly` mode
 * returns the list without sweeping connectors or the rest of the briefing.
 *
 * 已知文件夹按需投递，而不是每回合都带上。
 *
 * 所有者问过：分身只是"记得"的文件夹，为什么要跟着每个请求走。现在每回合提示词不再携带
 * 它们；同一个编译器仍为设置页 API 与 `get_situation` 渲染这份列表，后者的 `foldersOnly`
 * 模式只返回列表，不扫 Connector，也不返回简报其余部分。
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { compileMainAgentPrompt } from "../src/main-agent/prompt.ts";
import { compileBriefing } from "../src/main-agent/situation-briefing.ts";
import { kernelToolDefinitions } from "../src/main-agent/tools/kernel-tools.ts";
import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";

async function seededHome(t: TestContext): Promise<{ dataDirectory: string; project: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-prompt-brief-"));
  const project = await mkdtemp(join(tmpdir(), "clone-prompt-project-"));
  t.after(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  await writeFile(join(project, "README.md"), "# fixture\n", "utf8");
  await prepareCloneHome(resolveClonePaths({ dataDirectory }));
  // Taught in another conversation: the folder is learned, but this turn's
  // history does not contain its path.
  // 在另一个对话中教会：文件夹已被学到，但本回合历史不含它的路径。
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "seed-lesson",
    text: `整理 ${project} 里的资料。`,
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    conversationId: "seed-folder-lesson",
    reply: "好。",
  });
  return { dataDirectory, project };
}

test("the per-turn prompt omits the learned folders while the list stays available", async (t) => {
  const { dataDirectory, project } = await seededHome(t);
  const canonicalProject = await realpath(project);

  const compiled = await compileMainAgentPrompt({
    dataDirectory,
    conversationId: "main-agent-conversation",
    query: "收到",
  });
  assert.doesNotMatch(compiled.systemPrompt, /Folders you have worked in/);
  assert.ok(!compiled.systemPrompt.includes(canonicalProject), "the path must not ride along every turn");

  // The same compiler still renders the list for the callers that want it.
  // 同一个编译器仍为需要它的调用方渲染列表。
  const journal = createJournalStore(dataDirectory);
  try {
    const included = await compileBriefing({
      journal,
      dataDirectory,
      workspacePath: dataDirectory,
      includeObservations: false,
    });
    assert.match(included.text, /Folders you have worked in/);
    assert.equal(included.folders[0]?.path, canonicalProject);

    const gated = await compileBriefing({
      journal,
      dataDirectory,
      workspacePath: dataDirectory,
      includeObservations: false,
      includeFolders: false,
    });
    assert.doesNotMatch(gated.text, /Folders you have worked in/);
    assert.equal(gated.folders[0]?.path, canonicalProject, "gating the text must not drop the data");
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});

test("get_situation returns the learned folders on demand without the rest of the briefing", async (t) => {
  const { dataDirectory, project } = await seededHome(t);
  const canonicalProject = await realpath(project);
  const tools = kernelToolDefinitions({ dataDirectory, workspacePath: dataDirectory });
  const situation = tools.find((tool) => tool.name === "get_situation");
  assert.ok(situation, "get_situation must be registered");

  const result = await situation.execute("call-folders", { foldersOnly: true });
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.match(text, /Folders you have worked in/);
  assert.ok(text.includes(canonicalProject), "the learned folder is named");
  assert.doesNotMatch(text, /Current situation/);
  assert.doesNotMatch(text, /Recently finished background work/);
});

test("get_situation's description advertises the folder lookup", async (t) => {
  const { dataDirectory } = await seededHome(t);
  const tools = kernelToolDefinitions({ dataDirectory, workspacePath: dataDirectory });
  const situation = tools.find((tool) => tool.name === "get_situation");
  assert.ok(situation);
  assert.match(situation.description, /folders the twin learned/);
  assert.match(situation.description, /foldersOnly/);
});
