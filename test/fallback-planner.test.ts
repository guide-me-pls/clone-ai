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

test("the draft order carries the owner's request, because the worker sees only the objective", () => {
  // The worker reads `workOrder.objective` and nothing else of the request
  // (`buildInstructions` prefers it). A generic objective is why a concrete
  // build request produced zero files in the Forbidden City benchmark.
  // Worker 只读 `workOrder.objective`，看不到请求其余部分（`buildInstructions` 优先用它）。
  // 通用的 objective 正是故宫基准里具体构建请求产出 0 个文件的原因。
  const request = "用 Three.js 实现一个紫禁城 3D 场景，交付 index.html、src/ 与 README.md，并截图自查。";
  const plan = buildFallbackPlan(request);
  const draft = (plan.steps[0]?.subagents ?? []).find((order) => order.id === "draft");
  assert.ok(draft, "a drafting request must produce a draft order");
  assert.ok(draft.objective.includes("紫禁城"), `the objective must name the task, got: ${draft.objective}`);
  assert.ok(draft.acceptanceCriteria.some((criterion) => criterion.includes("紫禁城")), "the criterion must too");
  assert.doesNotMatch(draft.objective, /^只在本地准备可修改、可回退的结果。?$/, "the generic sentence must not stand alone");
});

test("a very long request is truncated at a sentence boundary and says so", () => {
  const long = `${"请按以下规格实现系统。".repeat(120)}最后交付。`;
  const plan = buildFallbackPlan(`实现${long}`);
  const draft = (plan.steps[0]?.subagents ?? []).find((order) => order.id === "draft");
  assert.ok(draft);
  assert.ok(draft.objective.length < 1_600, `objective should be bounded, got ${draft.objective.length}`);
  assert.match(draft.objective, /truncated/);
});

test("a one-line modelling request goes to a worker, not a written answer", () => {
  // "give me a 3D model of X" is a delivery request even without a verb like
  // 实现/写. The direct responder would answer in prose and create no files,
  // which is why the one-line prompt produced nothing before.
  // "给我一个 X 的 3D 模型"即使没有"实现/写"这类动词也是交付请求。direct responder 只会
  // 用散文回答、不创建任何文件——这正是一句话提示此前产出为空的原因。
  for (const request of ["给我一个故宫的3d建模结构图", "做一个极其好看的故宫 3D 模型", "生成一个 3D 故宫模型"]) {
    const plan = buildFallbackPlan(request);
    assert.equal(plan.steps[0]?.agentId, undefined, `${request} must not go to the direct responder`);
    assert.ok((plan.steps[0]?.subagents ?? []).some((order) => order.id === "draft"), `${request} must reach a worker`);
  }
  // A genuine question still gets a direct answer.
  // 真正的问题仍然直接回答。
  assert.equal(buildFallbackPlan("解释一下这个术语是什么意思").steps[0]?.agentId, "direct-responder");
});
