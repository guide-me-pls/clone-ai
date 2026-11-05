import assert from "node:assert/strict";
import test from "node:test";

import { CONSISTENCY_SCENARIOS, INTERRUPTION_SCENARIOS, runConsistencySuite, runRestraintSuite } from "../src/eval/memory-consistency.ts";
import { applySupersedes } from "../src/memory/conflict.ts";
import { looksActionable } from "../src/opportunity/attention.ts";

test("every consistency scenario passes and no stale memory contaminates a context", async () => {
  const report = await runConsistencySuite();
  const failed = report.scenarios.filter((scenario) => !scenario.passed);
  assert.deepEqual(failed.map((scenario) => `${scenario.id}: ${scenario.missingTruth ? "truth missing" : `stale ${scenario.contaminated.join(",")}`}`), []);
  assert.equal(report.contaminationRate, 0);
  assert.ok(CONSISTENCY_SCENARIOS.length >= 4);
});

test("the twin stays quiet on noise and speaks once for a message that asks for a decision", () => {
  const report = runRestraintSuite();
  assert.equal(report.falsePositiveRate, 0);
  assert.ok(INTERRUPTION_SCENARIOS.length >= 2);
});

test("an explicit replacement verb retires the older statement in the context", () => {
  const kept = applySupersedes([
    { id: "old", summary: "周五下午三点和产品团队开会", type: "fact", createdAt: "2026-10-26T09:00:00Z" },
    { id: "new", summary: "周五的会议已经改到周四下午两点", type: "fact", createdAt: "2026-11-04T09:00:00Z" },
    { id: "unrelated", summary: "服务器密码放在保险柜", type: "fact", createdAt: "2026-10-01T09:00:00Z" },
  ]);
  assert.deepEqual(kept.map((item) => item.id).sort(), ["new", "unrelated"]);
});

test("without a replacement verb both statements stay: similarity alone is not supersession", () => {
  const kept = applySupersedes([
    { id: "a", summary: "周五下午和产品开会", type: "fact", createdAt: "2026-10-01T09:00:00Z" },
    { id: "b", summary: "周五下午和设计开会", type: "fact", createdAt: "2026-10-02T09:00:00Z" },
  ]);
  assert.equal(kept.length, 2);
});

test("an undated memory is never treated as superseded", () => {
  const kept = applySupersedes([
    { id: "old", summary: "周报模板使用蓝色", type: "preference" },
    { id: "new", summary: "周报模板改用绿色", type: "preference", createdAt: "2026-11-03T09:00:00Z" },
  ]);
  assert.equal(kept.length, 2);
});

test("observations only look actionable when their text asks for a decision", () => {
  assert.equal(looksActionable({ title: "限时优惠：本周全场五折" }), false);
  assert.equal(looksActionable({ title: "项目群：中午吃什么" }), false);
  assert.equal(looksActionable({ title: "每周同步会" }), false);
  assert.equal(looksActionable({ title: "请确认本季度发票抬头", body: "需要在周五前确认" }), true);
  assert.equal(looksActionable({ title: "Invoice due tomorrow" }), true);
});
