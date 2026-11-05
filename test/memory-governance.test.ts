import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { MemoryGovernance } from "../src/memory/memory-governance.ts";
import { GovernedMemorySource, MdMemoryStore } from "../src/memory/md-memory-store.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import type { JournalStore } from "../src/core/journal.ts";
import type { Evidence, MemoryCandidate } from "../src/core/contracts.ts";

async function setup(t: TestContext): Promise<{ governance: MemoryGovernance; store: MdMemoryStore; journal: JsonlJournalStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-governance-"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const governance = new MemoryGovernance({ journal, store });
  return { governance, store, journal, directory };
}

function candidate(id: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id,
    runId: "run-1",
    sourceEvidenceIds: ["ev-1"],
    summary: "用户偏好：发布前必须完成风险评审",
    confidence: "high",
    status: "proposed",
    createdAt: new Date().toISOString(),
    type: "preference",
    sensitivity: "private",
    ...overrides,
  };
}

async function journalEvidence(journal: JsonlJournalStore, ids: string[]): Promise<void> {
  for (const id of ids) {
    await journal.append({
      type: "evidence.recorded",
      runId: "run-1",
      payload: {
        id,
        runId: "run-1",
        stepId: "s1",
        producedBy: "worker",
        kind: "artifact",
        summary: `Evidence ${id}`,
        createdAt: new Date().toISOString(),
      } satisfies Evidence,
    });
  }
}

test("pendingCandidates lists proposed candidates until they are decided", async (t) => {
  const { governance, journal } = await setup(t);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-2") });

  assert.deepEqual((await governance.pendingCandidates()).map((item) => item.id).sort(), ["c-1", "c-2"]);

  await governance.reject("c-2", "not durable");
  assert.deepEqual((await governance.pendingCandidates()).map((item) => item.id), ["c-1"]);
});

test("promote writes the markdown file, the sqlite row, and the journal event", async (t) => {
  const { governance, store, journal, directory } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  const pending = await governance.pendingCandidates();
  assert.equal(pending.length, 1);

  const entry = await governance.promote(pending[0]!);

  assert.equal(entry.type, "preference");
  assert.deepEqual(entry.sourceEvidenceIds, ["ev-1"]);
  assert.equal((await governance.pendingCandidates()).length, 0);
  const events = await journal.list();
  const promoted = events.find((event) => event.type === "memory.candidate.promoted");
  assert.equal((promoted?.payload as { candidateId?: string }).candidateId, "c-1");
  assert.equal((promoted?.payload as { memoryId?: string }).memoryId, entry.id);
  // The content file exists and is readable.
  // 正文文件真实存在且可读。
  const file = await import("node:fs/promises").then((fs) => fs.readFile(join(directory, "memory", `${entry.id}.md`), "utf8"));
  assert.match(file, /发布前必须完成风险评审/);
});

test("promote refuses a candidate that matches an active memory", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1", "ev-2"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  await governance.promote((await governance.pendingCandidates())[0]!);
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-1",
    payload: candidate("c-dup", { sourceEvidenceIds: ["ev-2"], summary: "用户偏好：发布前必须完成风险评审" }),
  });

  await assert.rejects(
    governance.promote((await governance.pendingCandidates())[0]!),
    /matches an existing memory/,
  );
});

test("promote redacts PII and stores the memory as secret", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-1",
    payload: candidate("c-pii", {
      summary: "联系人是 owner@example.com，发布前必须完成风险评审",
      sensitivity: "public",
    }),
  });

  const entry = await governance.promote((await governance.pendingCandidates())[0]!);
  assert.equal(entry.sensitivity, "secret");
  assert.match(entry.summary, /\[redacted email\]/);
  assert.doesNotMatch(entry.summary, /owner@example.com/);
  const promoted = (await journal.list()).find((event) => event.type === "memory.candidate.promoted");
  assert.deepEqual((promoted?.payload as { piiRedacted?: string[] }).piiRedacted, ["email"]);
});

test("promote refuses a candidate citing evidence that does not exist", async (t) => {
  const { governance, journal } = await setup(t);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1", { sourceEvidenceIds: ["ghost"] }) });

  await assert.rejects(
    governance.promote((await governance.pendingCandidates())[0]!),
    /evidence that does not exist/,
  );
  assert.equal((await governance.pendingCandidates()).length, 1);
});

test("update and archive journal their decisions", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  const entry = await governance.promote((await governance.pendingCandidates())[0]!);

  await governance.update(entry.id, { summary: "修正后的偏好" });
  await governance.archive(entry.id, "manual");

  const events = await journal.list();
  const updated = events.find((event) => event.type === "memory.updated");
  assert.equal((updated?.payload as { memoryId?: string }).memoryId, entry.id);
  assert.deepEqual((updated?.payload as { fields?: string[] }).fields, ["summary"]);
  const archived = events.find((event) => event.type === "memory.archived");
  assert.equal((archived?.payload as { reason?: string }).reason, "manual");
  assert.equal((await governance.list({ status: "archived" }))[0]?.id, entry.id);
});

test("expireDue archives expired memories with the expired reason", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1", { expiresAt: "2020-01-01T00:00:00.000Z" }) });
  const entry = await governance.promote((await governance.pendingCandidates())[0]!);

  assert.deepEqual(await governance.expireDue(), [entry.id]);
  const archived = (await journal.list()).find((event) => event.type === "memory.archived");
  assert.equal((archived?.payload as { reason?: string }).reason, "expired");
});

test("stats reports active, archived, and pending counts", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  const pending = await governance.pendingCandidates();
  await governance.promote(pending[0]!);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-2") });

  const stats = await governance.stats();
  // The content directory travels with the stats for the GUI; assert the counts.
  // contentDirectory 随 stats 一起提供给 GUI；这里断言计数部分。
  assert.equal(stats.active, 1);
  assert.equal(stats.archived, 0);
  assert.equal(stats.total, 1);
  assert.equal(stats.pending, 1);
});

test("a failed journal append never exposes a newly authored memory", async (t) => {
  const { store, journal } = await setup(t);
  const failing: JournalStore = {
    list: () => journal.list(),
    append: async () => { throw new Error("simulated journal failure"); },
  };
  const governance = new MemoryGovernance({ journal: failing, store });
  await assert.rejects(governance.author({ summary: "每周五提交工作汇报" }), /simulated journal failure/);
  assert.deepEqual(await store.list({ status: "active" }), []);
  assert.deepEqual(await store.recall("提交工作汇报"), []);
});

test("a journaled memory whose file write failed is recovered exactly once", async (t) => {
  const { governance, store, journal, directory } = await setup(t);
  const blockingPath = join(directory, "memory");
  await writeFile(blockingPath, "not a directory", "utf8");
  await assert.rejects(governance.author({ summary: "应当在重启后恢复的记忆" }));
  assert.equal((await journal.list()).filter((event) => event.type === "memory.authored").length, 1);
  assert.deepEqual(await store.list({ status: "active" }), []);
  await unlink(blockingPath);
  const recovered = await governance.list({ status: "active" });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.summary, "应当在重启后恢复的记忆");
  assert.equal((await governance.list({ status: "active" })).length, 1);
  assert.equal((await journal.list()).filter((event) => event.type === "memory.authored").length, 1);
});

test("worker recall repairs a journaled but interrupted memory before reading", async (t) => {
  const { governance, journal, directory } = await setup(t);
  const blockingPath = join(directory, "memory");
  await writeFile(blockingPath, "not a directory", "utf8");
  await assert.rejects(governance.author({ summary: "待恢复的周报习惯" }));
  await unlink(blockingPath);
  const source = new GovernedMemorySource(directory, 4, journal);
  const matches = await source.recall("待恢复的周报习惯", "run-2");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.memory.summary, "待恢复的周报习惯");
});

test("a failed journal append does not apply an update to an existing memory", async (t) => {
  const { governance, store, journal } = await setup(t);
  const entry = await governance.author({ summary: "用户原来的偏好" });
  const failing: JournalStore = {
    list: () => journal.list(),
    append: async () => { throw new Error("simulated journal failure"); },
  };
  const blocked = new MemoryGovernance({ journal: failing, store });
  await assert.rejects(blocked.update(entry.id, { summary: "未记入日志的修改" }), /simulated journal failure/);
  assert.equal((await store.get(entry.id))?.summary, "用户原来的偏好");
});

test("recovery does not overwrite a file the owner edited after a recorded update", async (t) => {
  const { governance, store, directory } = await setup(t);
  const entry = await governance.author({ summary: "原始的个人偏好" });
  const originalApply = store.applyMutation.bind(store);
  store.applyMutation = async () => { throw new Error("simulated interruption"); };
  await assert.rejects(governance.update(entry.id, { summary: "日志中的更新" }), /simulated interruption/);
  store.applyMutation = originalApply;
  const path = join(directory, "memory", `${entry.id}.md`);
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace("原始的个人偏好", "用户手动编辑的新内容"), "utf8");
  await assert.rejects(governance.list(), /changed on disk during recovery/);
  assert.match(await readFile(path, "utf8"), /用户手动编辑的新内容/);
  const conflict = (await governance.inspectPending()).conflicts[0]!;
  await governance.keepConflictingFile(conflict.id);
  await governance.syncFromFiles();
  assert.equal((await governance.list())[0]?.summary, "用户手动编辑的新内容");
});

test("concurrent promotions of the same candidate result in one governed memory", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  const proposed = candidate("c-concurrent");
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: proposed });
  const results = await Promise.allSettled([governance.promote(proposed), governance.promote(proposed)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await governance.list({ status: "active" })).length, 1);
  assert.equal((await journal.list()).filter((event) => event.type === "memory.candidate.promoted").length, 1);
});

test("a candidate cannot be rejected after promotion or invented at the decision boundary", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  const proposed = candidate("c-decided");
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: proposed });
  const entry = await governance.promote({ ...proposed, summary: "未经提案的伪造内容" });
  assert.equal(entry.summary, proposed.summary);
  await assert.rejects(governance.reject(proposed.id), /already decided|not pending/i);
  await assert.rejects(governance.reject("never-proposed"), /not pending/i);
  await assert.rejects(governance.promote(candidate("never-proposed")), /not pending/i);
  assert.equal((await journal.list()).filter((event) => event.type === "memory.candidate.rejected").length, 0);
});

test("a candidate cannot cite evidence belonging to another run", async (t) => {
  const { governance, journal } = await setup(t);
  await journal.append({
    type: "evidence.recorded", runId: "other-run",
    payload: { id: "foreign", runId: "other-run", stepId: "s", producedBy: "worker", kind: "observation", summary: "foreign evidence", createdAt: new Date().toISOString() },
  });
  const proposed = candidate("c-foreign", { sourceEvidenceIds: ["foreign"] });
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: proposed });
  await assert.rejects(governance.promote(proposed), /evidence.*run/i);
});

test("recovery honors a keep-file decision recorded just before interruption", async (t) => {
  const { governance, store, journal, directory } = await setup(t);
  const entry = await governance.author({ summary: "冲突前的记忆" });
  const apply = store.applyMutation.bind(store);
  store.applyMutation = async () => { throw new Error("simulated write interruption"); };
  await assert.rejects(governance.update(entry.id, { summary: "待处理的更新" }), /simulated write interruption/);
  store.applyMutation = apply;
  const path = join(directory, "memory", `${entry.id}.md`);
  await writeFile(path, (await readFile(path, "utf8")).replace("冲突前的记忆", "所有者保留的版本"), "utf8");
  const conflict = (await governance.inspectPending()).conflicts[0]!;
  const discard = store.discardMutation.bind(store);
  store.discardMutation = () => { throw new Error("simulated crash after decision"); };
  await assert.rejects(governance.keepConflictingFile(conflict.id), /simulated crash after decision/);
  store.discardMutation = discard;
  assert.equal((await journal.list()).filter((event) => event.type === "memory.mutation.discarded").length, 1);
  await governance.syncFromFiles();
  assert.equal((await governance.list())[0]?.summary, "所有者保留的版本");
  assert.equal(store.pendingMutationIds().length, 0);
});

test("an empty memory body stays editable after it is normalized", async (t) => {
  const { governance } = await setup(t);
  const entry = await governance.author({ summary: "有摘要没有正文", content: "" });
  const updated = await governance.update(entry.id, { summary: "更新后的摘要" });
  assert.equal(updated.summary, "更新后的摘要");
});

test("a promoted candidate without an expiry gets the 90 day default, the miner's own expiry wins", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-2", { summary: "临时约定：本周五之前冻结发布分支", expiresAt: soon }) });
  const [first, second] = await governance.pendingCandidates();
  const defaulted = await governance.promote(first!);
  const explicit = await governance.promote(second!);
  const days = (Date.parse(defaulted.expiresAt!) - Date.now()) / 86_400_000;
  assert.ok(days > 89.9 && days <= 90, `expected about 90 days, got ${days}`);
  assert.equal(explicit.expiresAt, soon);
});

test("archiveIdle archives memories unused for 90 days and spares recalled ones", async (t) => {
  const { governance, store, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  const idle = await governance.author({ summary: "闲置的旧偏好：周报使用蓝色模板" });
  const used = await governance.author({ summary: "常用的偏好：周报每周五发送" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(60 * 86_400_000);
  await store.recall("周报每周五发送");
  t.mock.timers.tick(40 * 86_400_000);

  assert.deepEqual(await governance.archiveIdle(), [idle.id]);
  const archived = (await journal.list()).find((event) => event.type === "memory.archived");
  assert.equal((archived?.payload as { reason?: string }).reason, "idle");
  assert.equal((await governance.list({ status: "active" })).some((entry) => entry.id === used.id), true);
  // A restored memory counts as touched, so it is not archived again at once.
  // 被恢复的记忆视为刚被使用，不会立刻再次被归档。
  await governance.restore(idle.id);
  assert.deepEqual(await governance.archiveIdle(), []);
});
