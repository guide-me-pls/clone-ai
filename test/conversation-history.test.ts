/**
 * Reading back the part of the conversation the model can no longer see.
 *
 * Compaction is what makes a long conversation possible and what makes detail
 * disappear from context. These tests hold the line that "disappeared from
 * context" never means "gone": the entries stay on disk, they stay findable,
 * and they are labelled so the agent knows it is recovering something rather
 * than reading something it already has.
 *
 * 读回模型已经看不到的那部分对话。
 *
 * 压缩既是长对话得以成立的原因，也是细节从上下文中消失的原因。这些测试守住一条线：
 * "从上下文里消失"永远不等于"没了"——条目留在磁盘上、仍可检索，并且被标注出来，
 * 让 Agent 知道自己是在找回，而不是在读眼前已有的东西。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  describeHistory,
  mainAgentSessionDirectory,
  searchHistory,
} from "../src/main-agent/conversation-history.ts";

interface SeedEntry {
  id: string;
  role?: string;
  text?: string;
  compactionOf?: string;
}

/**
 * Writes a session file in the on-disk shape, rather than driving a live
 * agent: a compaction only happens after a real context overflow, which no
 * test should have to pay for to assert what compaction leaves behind.
 * 直接按磁盘格式写会话文件，而不是驱动一个真实 Agent：压缩只在真正的上下文溢出后
 * 发生，而任何测试都不该为断言"压缩之后留下了什么"去付那个代价。
 */
async function seedSession(dataDirectory: string, name: string, entries: readonly SeedEntry[]): Promise<void> {
  const directory = mainAgentSessionDirectory(dataDirectory);
  await mkdir(directory, { recursive: true });
  const lines = entries.map((entry, index) => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    if (entry.compactionOf !== undefined) {
      return JSON.stringify({
        type: "compaction", id: entry.id, parentId: null, timestamp,
        summary: entry.text ?? "", firstKeptEntryId: entry.compactionOf, tokensBefore: 41_000,
      });
    }
    return JSON.stringify({
      type: "message", id: entry.id, parentId: null, timestamp,
      message: { role: entry.role ?? "user", content: [{ type: "text", text: entry.text ?? "" }] },
    });
  });
  await writeFile(join(directory, `${name}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

async function scratch(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-history-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a detail compacted out of context is still findable on disk", async (t) => {
  const dataDirectory = await scratch(t);
  await seedSession(dataDirectory, "session-a", [
    { id: "e1", role: "user", text: "部署脚本的超时设置成 90 秒，不要用默认值" },
    { id: "e2", role: "assistant", text: "好的，已记下 90 秒。" },
    { id: "e3", text: "早前讨论了部署配置。", compactionOf: "e4" },
    { id: "e4", role: "user", text: "今天继续别的事情" },
  ]);

  const excerpts = await searchHistory(dataDirectory, "部署脚本 超时");
  assert.ok(excerpts.length > 0, "the compacted-away exchange must still be findable");
  const recovered = excerpts.find((item) => item.excerpt.includes("90 秒"));
  assert.ok(recovered !== undefined, "the specific value must survive in the excerpt");
  // The label is what stops the agent from treating a recovered line as
  // something it already had in front of it.
  // 这个标注正是阻止 Agent 把找回的内容当作眼前已有内容的东西。
  assert.equal(recovered.outOfContext, true, "an entry before the cut point must be marked as recovered");
  assert.equal(recovered.speaker, "user");
});

test("history search reports the shape of what it searched", async (t) => {
  const dataDirectory = await scratch(t);
  await seedSession(dataDirectory, "session-a", [
    { id: "e1", role: "user", text: "第一条" },
    { id: "e2", role: "assistant", text: "第二条" },
    { id: "e3", text: "摘要", compactionOf: "e4" },
    { id: "e4", role: "user", text: "第三条" },
  ]);

  const shape = await describeHistory(dataDirectory);
  assert.equal(shape.messageEntries, 3);
  assert.equal(shape.compactions.length, 1);
  assert.equal(shape.compactions[0]?.tokensBefore, 41_000);
  // e1 and e2 precede the cut. e3 is the compaction entry itself, and its
  // summary is what the model reads in their place, so it is not part of the gap.
  // e1 与 e2 在切点之前。e3 是压缩条目本身，模型读到的正是它的摘要，因此它不属于缺口。
  assert.equal(shape.entriesOutOfContext, 2);
});

test("only the newest cut point decides what is out of context", async (t) => {
  const dataDirectory = await scratch(t);
  await seedSession(dataDirectory, "session-a", [
    { id: "e1", role: "user", text: "最早" },
    { id: "e2", text: "第一次摘要", compactionOf: "e3" },
    { id: "e3", role: "user", text: "中间" },
    { id: "e4", text: "第二次摘要", compactionOf: "e5" },
    { id: "e5", role: "user", text: "最新" },
  ]);

  // A later compaction subsumes what an earlier one kept and merges the earlier
  // summary into its own, so e1, e2 and e3 are all gone from context — only the
  // newest summary (e4) is still read.
  // 后一次压缩会吞掉前一次保留的范围，并把更早的摘要并入自己，因此 e1、e2、e3 都已不在
  // 上下文中——只有最新的那段摘要（e4）仍被读到。
  assert.equal((await describeHistory(dataDirectory)).entriesOutOfContext, 3);
});

test("history search ranks recovered material ahead of what is still visible", async (t) => {
  const dataDirectory = await scratch(t);
  await seedSession(dataDirectory, "session-a", [
    { id: "e1", role: "user", text: "风险评审的负责人是谁" },
    { id: "e2", text: "摘要", compactionOf: "e3" },
    { id: "e3", role: "user", text: "风险评审的负责人是谁" },
  ]);

  const excerpts = await searchHistory(dataDirectory, "风险评审 负责人");
  assert.equal(excerpts.length, 2);
  assert.equal(excerpts[0]?.outOfContext, true, "at equal relevance the entry the model cannot see comes first");
});

test("a torn final line does not break the search", async (t) => {
  const dataDirectory = await scratch(t);
  const directory = mainAgentSessionDirectory(dataDirectory);
  await mkdir(directory, { recursive: true });
  const good = JSON.stringify({
    type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "可恢复的内容" }] },
  });
  // A session file is appended to while it is read; the last line can be half
  // written. 会话文件在被读取的同时也在被追加；最后一行可能只写了一半。
  await writeFile(join(directory, "session-a.jsonl"), `${good}\n{"type":"mess`, "utf8");

  const excerpts = await searchHistory(dataDirectory, "可恢复的内容");
  assert.equal(excerpts.length, 1);
});

test("searching a twin that has never been spoken to is empty, not an error", async (t) => {
  const dataDirectory = await scratch(t);
  assert.deepEqual(await searchHistory(dataDirectory, "任何东西"), []);
  const shape = await describeHistory(dataDirectory);
  assert.equal(shape.totalEntries, 0);
  assert.equal(shape.entriesOutOfContext, 0);
});
