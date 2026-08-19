import assert from "node:assert/strict";
import test from "node:test";

import { buildFallbackPlan } from "../src/planning/fallback-planner.ts";

test("direct requests stay direct instead of creating child agents", () => {
  const plan = buildFallbackPlan("解释一下这个术语是什么意思");

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.agentId, "direct-responder");
  assert.equal(plan.steps[0]?.subagents, undefined);
});

test("drafting requests receive only the preparation role they need", () => {
  const plan = buildFallbackPlan("帮我写一封给客户的项目更新邮件草稿");
  const orders = plan.steps[0]?.subagents ?? [];

  assert.equal(orders.length, 1);
  assert.deepEqual(orders.map((order) => order.id), ["draft"]);
  assert.equal(plan.steps.length, 1);
});

test("complex external work uses a dependent review and a separate approval step", () => {
  const plan = buildFallbackPlan("调研三个供应商的报价和风险，比较后形成推荐方案，并发布最终采购结果给团队");
  const orders = plan.steps[0]?.subagents ?? [];

  assert.deepEqual(orders.map((order) => order.id), ["context", "draft", "review"]);
  assert.deepEqual(orders[2]?.dependsOn, ["context", "draft"]);
  assert.equal(plan.steps[1]?.id, "external-commitment");
  assert.equal(plan.steps[1]?.risk, "external_side_effect");
});
