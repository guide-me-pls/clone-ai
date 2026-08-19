import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MdMemoryStore, parseMemoryFile, renderMemoryFile, tokenize, type MemoryEntry } from "../src/memory/md-memory-store.ts";

async function openStore(t: { after(callback: () => void | Promise<void>): void }): Promise<{ store: MdMemoryStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-md-memory-"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, directory };
}

async function seed(store: MdMemoryStore): Promise<MemoryEntry[]> {
  const release = await store.commit({
    summary: "产品发布前先准备风险清单并保留回滚方案",
    content: "发布流程必须包含风险评审；回滚方案必须可执行。",
    type: "procedure",
    confidence: "high",
    sourceRunId: "run-1",
    sourceEvidenceIds: ["ev-1", "ev-2"],
  });
  const preference = await store.commit({
    summary: "代码提交前必须先跑完整测试",
    type: "preference",
    confidence: "medium",
  });
  const secret = await store.commit({
    summary: "服务器生产数据库密码存放在保险柜",
    type: "fact",
    confidence: "high",
    sensitivity: "secret",
  });
  return [release, preference, secret];
}

test("tokenize splits CJK into bigrams and keeps Latin words", () => {
  const tokens = tokenize("发布流程与 risk check");
  assert.ok(tokens.includes("发布"));
  assert.ok(tokens.includes("流程"));
  assert.ok(tokens.includes("risk"));
  assert.ok(tokens.includes("check"));
});

test("commit writes the markdown file with front matter and the sqlite row", async (t) => {
  const { store, directory } = await openStore(t);
  const entry = (await seed(store))[0];

  const file = await readFile(join(directory, "memory", `${entry.id}.md`), "utf8");
  assert.match(file, /^---\n/);
  assert.match(file, /type: procedure/);
  assert.match(file, /sourceEvidenceIds: \["ev-1","ev-2"\]/);
  assert.match(file, /产品发布前先准备风险清单并保留回滚方案/);
  assert.ok((await store.list()).some((item) => item.id === entry.id));
});

test("recall matches Chinese bigrams and Latin words with governance filters", async (t) => {
  const { store } = await openStore(t);
  const [release, preference, secret] = await seed(store);

  const releaseHits = await store.recall("发布 风险 回滚");
  assert.deepEqual(releaseHits.map((hit) => hit.entry.id), [release.id]);
  assert.ok(releaseHits[0]!.matchedTerms.includes("发布"));

  const testHits = await store.recall("跑测试");
  assert.deepEqual(testHits.map((hit) => hit.entry.id), [preference.id]);

  // secret memories stay out unless explicitly requested
  // secret 记忆默认不召回，除非显式要求。
  const secretHits = await store.recall("数据库 密码 保险柜");
  assert.deepEqual(secretHits, []);
  const secretIncluded = await store.recall("数据库 密码 保险柜", { includeSecret: true });
  assert.deepEqual(secretIncluded.map((hit) => hit.entry.id), [secret.id]);
});

test("recall ranks better matches first and records access counts", async (t) => {
  const { store } = await openStore(t);
  await seed(store);
  await store.commit({ summary: "风险预案与发布无关的日常清单", type: "fact", confidence: "low" });

  const hits = await store.recall("发布 风险 回滚");
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.entry.summary, "产品发布前先准备风险清单并保留回滚方案");
  assert.ok(hits[0]!.score >= hits[1]!.score);
  assert.equal((await store.get(hits[0]!.entry.id))?.accessCount, 1);
});

test("archived and expired memories are filtered from recall", async (t) => {
  const { store } = await openStore(t);
  const [release, preference] = await seed(store);

  await store.archive(preference.id);
  assert.deepEqual(await store.recall("跑测试"), []);

  await store.restore(preference.id);
  assert.deepEqual((await store.recall("跑测试")).map((hit) => hit.entry.id), [preference.id]);

  await store.update(release.id, { expiresAt: "2020-01-01T00:00:00.000Z" });
  assert.deepEqual(await store.recall("发布 风险"), []);
  assert.deepEqual(await store.expireDue(), [release.id]);
  assert.equal((await store.get(release.id))?.status, "archived");
});

test("update rewrites the markdown file and rebuilds terms", async (t) => {
  const { store, directory } = await openStore(t);
  const [release] = await seed(store);

  await store.update(release.id, { summary: "发布前必须完成风险评审", content: "流程要求双人评审后归档。" });
  const file = await readFile(join(directory, "memory", `${release.id}.md`), "utf8");
  assert.match(file, /发布前必须完成风险评审/);
  assert.match((await store.recall("发布 风险"))[0]?.entry.summary ?? "", /发布前必须完成风险评审/);
  // Old content terms are gone from the index; shared bigrams like 发布/风险
  // legitimately still match, so assert on the old content's unique terms.
  // 旧正文的独有词已从索引移除；发布/风险这类共享 bigram 仍会命中，因此只断言旧正文
  // 的独有词不再命中。
  assert.deepEqual(await store.recall("回滚方案必须可执行"), []);
});

test("owner-edited markdown files are folded back by syncFromFiles", async (t) => {
  const { store, directory } = await openStore(t);
  const [release] = await seed(store);

  // Simulate an owner editing the file by hand, then syncing.
  // 模拟所有者手改文件后再同步。
  const contentDirectory = join(directory, "memory");
  const path = join(contentDirectory, `${release.id}.md`);
  const edited = (await readFile(path, "utf8")).replace("产品发布前先准备风险清单并保留回滚方案", "手工修正：发布前必须双人评审");
  await import("node:fs/promises").then((fs) => fs.writeFile(path, edited, "utf8"));

  const result = await store.syncFromFiles();
  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
  assert.match((await store.get(release.id))?.summary ?? "", /手工修正/);
  assert.deepEqual((await store.recall("双人评审")).map((hit) => hit.entry.id), [release.id]);
  // The old summary's unique terms no longer match.
  // 旧摘要的独有词不再命中。
  assert.deepEqual(await store.recall("先准备"), []);
});

test("deleting the markdown file archives the memory", async (t) => {
  const { store, directory } = await openStore(t);
  const [, preference] = await seed(store);

  await rm(join(directory, "memory", `${preference.id}.md`));
  const result = await store.syncFromFiles();
  assert.equal(result.archived, 1);
  assert.equal((await store.get(preference.id))?.status, "archived");
});

test("renderMemoryFile and parseMemoryFile round-trip", () => {
  const entry: MemoryEntry = {
    id: "mem-1",
    type: "decision",
    status: "active",
    confidence: "high",
    sensitivity: "private",
    sourceRunId: "run-9",
    sourceEvidenceIds: ["ev-a"],
    summary: "结论：采用黑盒 Worker 边界",
    content: "详细论证……",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    accessCount: 2,
  };
  const parsed = parseMemoryFile(renderMemoryFile(entry));
  assert.equal(parsed?.summary, "结论：采用黑盒 Worker 边界");
  assert.equal(parsed?.type, "decision");
  assert.equal(parsed?.sourceRunId, "run-9");
  assert.deepEqual(parsed?.sourceEvidenceIds, ["ev-a"]);
  assert.match(parsed?.content ?? "", /详细论证/);
});
