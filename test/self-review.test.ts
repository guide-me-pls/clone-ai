import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSelfReview, loadReview } from "../src/audit/self-review.ts";
import { applyReviewAction, revertReviewAction } from "../src/audit/apply-review.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { listEffectiveProviderConfigs, readUserProviderConfigs } from "../src/config/provider-config-store.ts";

async function fixture(t: test.TestContext): Promise<{ directory: string; journal: JsonlJournalStore }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-review-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  return { directory, journal };
}

test("review validation keeps only actions the machine can actually perform", async (t) => {
  const { directory, journal } = await fixture(t);
  const reply = JSON.stringify({
    summary: "Pi 在失败后仍使用默认模型；建议固定模型并提高强度。",
    findings: [
      { severity: "high", area: "模型", evidence: "pi 失败 2 次，均为 400 unrecognized_model", recommendation: "固定到可用的模型" },
    ],
    actions: [
      { kind: "provider-effort", providerId: "pi", value: "high", title: "Pi 强度", reason: "失败集中在采样不稳定" },
      { kind: "provider-effort", providerId: "pi", value: "ultra", title: "无效档位", reason: "不在声明列表" },
      { kind: "provider-effort", providerId: "nope", value: "high", title: "未知 worker", reason: "" },
      { kind: "provider-model", providerId: "pi", value: "magpie/360/deepseek/deepseek-v4.1-flash", title: "固定模型", reason: "默认模型不可用" },
      { kind: "main-agent-effort", value: "high", title: "主 Agent 强度", reason: "" },
      { kind: "delete-code", value: "x", title: "越权动作", reason: "" },
    ],
  });
  const review = await runSelfReview(directory, journal, { ask: async () => reply });
  assert.equal(review.ai, true);
  assert.deepEqual(review.actions.map((action) => action.id), [
    "provider-effort:pi:high",
    "provider-model:pi:magpie/360/deepseek/deepseek-v4.1-flash",
    "main-agent-effort:main:high",
  ]);
  assert.equal((await loadReview(directory))?.summary, review.summary);
});

test("a failed model call yields a facts-only review instead of a blank one", async (t) => {
  const { directory, journal } = await fixture(t);
  const review = await runSelfReview(directory, journal, { ask: async () => { throw new Error("gateway unreachable"); } });
  assert.equal(review.ai, false);
  assert.match(review.summary, /AI 评审不可用/);
  assert.match(review.summary, /gateway unreachable/);
  assert.deepEqual(review.actions, []);
});

test("applying and reverting a worker effort is a single field, journaled with before and after", async (t) => {
  const { directory, journal } = await fixture(t);
  const reply = JSON.stringify({
    summary: "提高 Pi 的推理强度。",
    findings: [],
    actions: [{ kind: "provider-effort", providerId: "pi", value: "high", title: "Pi 强度", reason: "减少抖动" }],
  });
  await runSelfReview(directory, journal, { ask: async () => reply });
  const [action] = (await loadReview(directory))!.actions;
  assert.ok(action);

  const applied = await applyReviewAction(directory, journal, action.id);
  assert.equal(applied.from, undefined);
  const configured = (await listEffectiveProviderConfigs(directory)).find((provider) => provider.id === "pi");
  assert.equal(configured?.effort, "high");
  const events = await journal.list();
  const recorded = events.find((event) => event.type === "recommendation.applied");
  assert.deepEqual((recorded?.payload as { kind: string; from: unknown; to: string }), { actionId: action.id, kind: "provider-effort", target: "pi", from: null, to: "high", reviewGeneratedAt: (await loadReview(directory))!.generatedAt });

  const reverted = await revertReviewAction(directory, journal, action.id);
  assert.equal(reverted.to, "");
  assert.equal((await listEffectiveProviderConfigs(directory)).find((provider) => provider.id === "pi")?.effort, undefined);
  assert.deepEqual(await readUserProviderConfigs(directory), []);
  assert.equal((await journal.list()).filter((event) => event.type === "recommendation.applied").length, 2);
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