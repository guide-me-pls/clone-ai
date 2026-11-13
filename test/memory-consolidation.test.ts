/**
 * Consolidation: same-type memories that say the same thing become one suggestion.
 *
 * `conflict.ts` could measure this already but nothing called it. These tests
 * pin what makes the suggestion trustworthy: it names both memories, it never
 * quotes a secret memory, it never proposes merging a statement with the one it
 * explicitly replaced, and approving it goes through the governed path so the
 * sources are archived (recoverable) rather than deleted.
 *
 * 巩固：说同一件事的同类型记忆变成一条建议。
 *
 * `conflict.ts` 早就能度量它，但没有任何调用方。这些测试钉住让建议可信的性质：它点名两条记忆、
 * 从不引用 secret 记忆、从不提议把一条陈述与它明确取代的那条合并、批准它走受治理路径，使来源被
 * 归档（可恢复）而不是删除。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { JsonlJournalStore } from "../src/core/journal.ts";
import { MdMemoryStore } from "../src/memory/md-memory-store.ts";
import { MemoryGovernance } from "../src/memory/memory-governance.ts";
import { findMergeCandidates, type ConsolidationCandidate } from "../src/memory/consolidation.ts";
import { ImprovementService } from "../src/improvement/improvement-service.ts";

function candidate(id: string, summary: string, overrides: Partial<ConsolidationCandidate> = {}): ConsolidationCandidate {
  return {
    id,
    summary,
    type: "preference",
    status: "active",
    sensitivity: "private",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

test("two reworded statements of one rule become one merge suggestion", () => {
  const suggestions = findMergeCandidates([
    candidate("mem-old", "报告的模板用蓝色", { createdAt: "2026-10-01T00:00:00.000Z" }),
    candidate("mem-new", "报告模板使用蓝色", { createdAt: "2026-11-01T00:00:00.000Z" }),
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]!.kind, "merge");
  assert.equal(suggestions[0]!.keepId, "mem-new", "the newer statement is kept");
  assert.deepEqual(suggestions[0]!.retireIds, ["mem-old"]);
  assert.match(suggestions[0]!.rationale, /overlap/);
});

test("unrelated memories and different types are left alone", () => {
  assert.deepEqual(findMergeCandidates([
    candidate("mem-a", "报告的模板用蓝色"),
    candidate("mem-b", "周报每周五提交"),
  ]), []);
  assert.deepEqual(findMergeCandidates([
    candidate("mem-a", "报告的模板用蓝色", { type: "preference" }),
    candidate("mem-b", "报告模板使用蓝色", { type: "fact" }),
  ]), []);
});

test("a statement that explicitly replaces another is a revision, not a duplicate", () => {
  // Measured: this pair scores high on overlap, so without the revision rule it
  // would be merged — and the merge would erase the "changed to" that is the
  // newer statement's whole content.
  // 实测：这一对重叠分很高，没有修订规则就会被合并——而合并会抹掉"改到"这个新陈述的全部内容。
  const suggestions = findMergeCandidates([
    candidate("mem-old", "报告模板使用蓝色", { createdAt: "2026-10-01T00:00:00.000Z" }),
    candidate("mem-new", "报告模板改用绿色", { createdAt: "2026-11-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(suggestions, []);
});

test("a secret memory never appears in a merge suggestion", () => {
  const suggestions = findMergeCandidates([
    candidate("mem-old", "报告的模板用蓝色"),
    candidate("mem-new", "报告模板使用蓝色", { sensitivity: "secret" }),
  ]);
  assert.deepEqual(suggestions, []);
});

test("approving a merge authors the merged memory and archives the sources as retired", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-merge-"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const governance = new MemoryGovernance({ journal, store });
  const older = await governance.author({ summary: "报告的模板用蓝色" });
  const newer = await governance.author({ summary: "报告模板使用蓝色" });
  const service = new ImprovementService({ journal, governance });

  await service.sweep();
  const pending = (await service.pending()).filter((item) => item.kind === "merge");
  assert.equal(pending.length, 1);
  const merge = pending[0]!;
  assert.deepEqual(new Set([merge.target, ...(merge.retireIds ?? [])]), new Set([older.id, newer.id]));

  const { applied } = await service.approve(merge.id);
  assert.match(applied, /Merged/);
  const active = await governance.list({ status: "active" });
  assert.equal(active.length, 1, "one memory survives a merge of two");
  assert.ok(active[0]!.summary.includes("报告"), "the merged memory carries the statement");
  const archived = await governance.list({ status: "archived" });
  assert.equal(archived.length, 2, "the sources are archived, so the merge is reversible");
  // The archive reason is in the journal, not just in the status.
  // 归档原因在 Journal 里，而不只是状态字段。
  const reasons = (await journal.list())
    .filter((event) => event.type === "memory.archived")
    .map((event) => (event.payload as { reason?: string }).reason);
  assert.deepEqual(reasons, ["retired", "retired"]);
});
