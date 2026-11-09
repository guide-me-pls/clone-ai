import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSelfReview, loadReview } from "../src/audit/self-review.ts";
import { applyReviewAction, revertReviewAction } from "../src/audit/apply-review.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";

async function fixture(t: test.TestContext): Promise<{ directory: string; journal: JsonlJournalStore }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-review-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  return { directory, journal };
}

test("a failed model call yields a facts-only review instead of a blank one", async (t) => {
  const { directory, journal } = await fixture(t);
  const review = await runSelfReview(directory, journal, { ask: async () => { throw new Error("gateway unreachable"); } });
  assert.equal(review.ai, false);
  assert.match(review.summary, /AI 评审不可用/);
  assert.match(review.summary, /gateway unreachable/);
  assert.deepEqual(review.actions, []);
});

test("applying the Main Agent effort lands in config.json and reverts to the previous value", async (t) => {
  const { directory, journal } = await fixture(t);
  const reply = JSON.stringify({
    summary: "主 Agent 强度调整为 high。",
    findings: [],
    actions: [{ kind: "main-agent-effort", value: "high", title: "主 Agent 强度", reason: "" }],
  });
  await runSelfReview(directory, journal, { ask: async () => reply });
  const [action] = (await loadReview(directory))!.actions;
  await applyReviewAction(directory, journal, action.id);
  const applied = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as { mainAgentEffort?: string };
  assert.equal(applied.mainAgentEffort, "high");
  await revertReviewAction(directory, journal, action.id);
  const reverted = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as { mainAgentEffort?: string };
  assert.equal(reverted.mainAgentEffort, undefined);
});