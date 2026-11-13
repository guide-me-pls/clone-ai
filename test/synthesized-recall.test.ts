/**
 * Synthesized recall: one grounded paragraph instead of a list of weak matches.
 *
 * Two guarantees are tested without a model. Every cited id must have been
 * given (a paragraph cannot cite `mem-invented`), and every sentence must carry
 * a citation (a fluent paragraph with one bibliography at the end is the
 * model's own knowledge, not a synthesis). A refused synthesis falls back to
 * the list, so the tests also pin that recall never depends on it.
 *
 * 合成召回：一段有依据的话，而不是一列弱命中。
 *
 * 两条保证无需模型即可测试。每个被引用的 id 必须是给过它的（段落不能引用 `mem-invented`），
 * 每一句都必须带引用（一段通篇流畅、结尾挂一份参考文献的文字是模型自己的知识，不是合成）。
 * 被拒绝的合成会退回列表，因此测试也钉住"召回从不依赖它"。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { JsonlJournalStore } from "../src/core/journal.ts";
import { MdMemoryStore, type MemoryEntry } from "../src/memory/md-memory-store.ts";
import {
  SYNTHESIS_MIN_MEMORIES,
  synthesisCandidates,
  synthesisPrompt,
  synthesizeRecall,
  validateSynthesis,
} from "../src/memory/synthesized-recall.ts";
import { pushRelevantMemories } from "../src/main-agent/memory-push.ts";

function entry(id: string, summary: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    type: "preference",
    status: "active",
    confidence: "high",
    sensitivity: "private",
    sourceEvidenceIds: [],
    summary,
    content: summary,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    accessCount: 0,
    ...overrides,
  };
}

test("a paragraph that cites only memories it was given passes", () => {
  const memories = [
    { entry: entry("mem-a", "周报用要点列表") },
    { entry: entry("mem-b", "周报每周五提交") },
    { entry: entry("mem-c", "周报抄送团队") },
  ];
  const result = validateSynthesis("周报用要点列表 [mem-a]。每周五提交 [mem-b]。抄送团队 [mem-c]。", memories);
  assert.deepEqual(result.citedIds.sort(), ["mem-a", "mem-b", "mem-c"]);
  assert.equal(result.rejected, undefined);
});

test("a paragraph that cites an id it was not given is refused whole", () => {
  const memories = [{ entry: entry("mem-a", "周报用要点列表") }];
  const result = validateSynthesis("周报用要点列表 [mem-a]。也在群里同步 [mem-invented]。", memories);
  assert.equal(result.text, "");
  assert.match(result.rejected ?? "", /was not given|not given/);
});

test("a sentence with no citation is refused, even when the paragraph cites elsewhere", () => {
  const memories = [
    { entry: entry("mem-a", "周报用要点列表") },
    { entry: entry("mem-b", "周报每周五提交") },
  ];
  const result = validateSynthesis("周报用要点列表 [mem-a]。另外记得早点下班。", memories);
  assert.equal(result.text, "");
  assert.match(result.rejected ?? "", /no citation/);
});

test("NO_ANSWER and empty output are refused as answers, not returned as text", () => {
  const memories = [{ entry: entry("mem-a", "x") }];
  assert.match(validateSynthesis("NO_ANSWER", memories).rejected ?? "", /do not answer/);
  assert.match(validateSynthesis("   ", memories).rejected ?? "", /returned nothing/);
});

test("synthesis needs at least three non-secret memories", async () => {
  const two = [entry("mem-a", "a"), entry("mem-b", "b")];
  const refused = await synthesizeRecall(
    { query: "q", memories: two.map((item) => ({ entry: item, score: 0.5 })) },
    { complete: async () => "should not be called [mem-a]。" },
  );
  assert.equal(refused.text, "");
  assert.match(refused.rejected ?? "", new RegExp(`Fewer than ${SYNTHESIS_MIN_MEMORIES}`));

  const withSecret = [entry("mem-a", "a"), entry("mem-b", "b"), entry("mem-secret", "s", { sensitivity: "secret" })];
  const refusedSecret = await synthesizeRecall(
    { query: "q", memories: withSecret.map((item) => ({ entry: item, score: 0.5 })) },
    { complete: async () => "[mem-a] x [mem-b] y [mem-secret] z" },
  );
  assert.equal(refusedSecret.text, "", "a secret memory must not count toward the minimum");
});

test("the prompt never contains a secret memory", async () => {
  const memories = [
    { entry: entry("mem-a", "a", { sensitivity: "public" }), score: 0.5 },
    { entry: entry("mem-b", "b"), score: 0.4 },
    { entry: entry("mem-c", "c"), score: 0.3 },
    { entry: entry("mem-secret", "TOP-SECRET-TEXT", { sensitivity: "secret" }), score: 0.9 },
  ];
  const prompt = synthesisPrompt({ query: "q", memories });
  assert.doesNotMatch(prompt, /TOP-SECRET-TEXT/);
  assert.doesNotMatch(prompt, /mem-secret/);
});

test("a provider failure is a refused synthesis, not a failed recall", async () => {
  const memories = [entry("mem-a", "a"), entry("mem-b", "b"), entry("mem-c", "c")];
  const result = await synthesizeRecall(
    { query: "q", memories: memories.map((item) => ({ entry: item, score: 0.5 })) },
    { complete: async () => { throw new Error("endpoint down"); } },
  );
  assert.equal(result.text, "");
  assert.match(result.rejected ?? "", /endpoint down/);
});

async function seed(t: TestContext): Promise<{ directory: string; journal: JsonlJournalStore; store: MdMemoryStore }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-synthesis-"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  // The push recalls from the governed store, so the memories must really be there.
  // 推送从受治理的 Store 召回，因此记忆必须真的在里面。
  for (const [index, summary] of ["周报用要点列表", "周报每周五提交", "周报抄送团队"].entries()) {
    await store.commit({ summary, type: "preference", confidence: "high", sensitivity: "private", occurredAt: `2026-11-0${index + 1}T00:00:00.000Z` });
  }
  return { directory, journal, store };
}

test("the push carries the synthesized paragraph and journals the mode", async (t) => {
  const { directory, journal } = await seed(t);
  const pushed = await pushRelevantMemories({
    dataDirectory: directory,
    query: "周报怎么弄",
    journal,
    synthesize: true,
    complete: async (prompt) => {
      const ids = [...prompt.matchAll(/\[(mem-[a-z0-9-]+)\]/g)].map((match) => match[1]!);
      return `周报用要点列表，每周五提交，抄送团队 [${ids[0]}]。按时发出即可 [${ids[1]}]。`;
    },
  });
  assert.ok(pushed !== undefined);
  assert.match(pushed.text, /Background summary synthesized/);
  assert.ok(pushed.synthesis !== undefined);
  const events = await journal.list();
  const recalled = events.find((event) => event.type === "memory.recalled" && (event.payload as { mode?: string }).mode === "synthesize");
  assert.ok(recalled !== undefined, "the journal must record that this turn used synthesis");
});

test("without synthesis the push is exactly the list, as before", async (t) => {
  const { directory, journal } = await seed(t);
  const pushed = await pushRelevantMemories({
    dataDirectory: directory,
    query: "周报怎么弄",
    journal,
    complete: async () => { throw new Error("must not be called"); },
  });
  assert.ok(pushed !== undefined);
  assert.equal(pushed.synthesis, undefined);
  assert.doesNotMatch(pushed.text, /synthesized/);
  assert.match(pushed.text, /Owner-approved background facts/);
});

test("candidates rank preferences first and never include secrets", () => {
  const ranked = synthesisCandidates([
    { entry: entry("mem-fact", "事实", { type: "fact" }), score: 0.8 },
    { entry: entry("mem-pref", "偏好", { type: "preference" }), score: 0.6 },
    { entry: entry("mem-secret", "秘密", { sensitivity: "secret" }), score: 0.99 },
  ]);
  assert.deepEqual(ranked.map((item) => item.entry.id), ["mem-pref", "mem-fact"]);
});
