import assert from "node:assert/strict";
import test from "node:test";

import { buildFallbackPlan, isReadOnlyRequest } from "../src/planning/fallback-planner.ts";

/** The one production executor after the worker roster collapsed. 名单收拢后唯一的执行者。 */
const PRODUCTION_AGENTS = new Set(["worker"]);

test("a read-only review of uncommitted files is not an external action", () => {
  // "未提交" contains the external-action term "提交", but it is a state word.
  // 未提交 含有外部动作词 提交，但它是一个状态词。
  const plan = buildFallbackPlan("只读审查这 9 个未提交的 ToolBox 文件；不要修改任何文件。", PRODUCTION_AGENTS);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.risk, "read_only");
  assert.equal(plan.steps[0]?.agentId, "worker");
});

test("a quoted external-action error does not make a read-only review external", () => {
  // The request quotes the old denial verbatim; the quote asks for nothing.
  // 请求原样引用了旧的拒绝文案；引用并没有请求任何动作。
  const plan = buildFallbackPlan(
    "只读审查这 9 个未提交的文件。上次原话：外部执行 Agent 已关闭，请先在设置中启用它，再提交这个外部动作。",
    PRODUCTION_AGENTS,
  );
  assert.equal(plan.steps[0]?.risk, "read_only");
  assert.equal(plan.steps[0]?.agentId, "worker");
});

test("a state word without a read-only marker still does not plan an external step", () => {
  const plan = buildFallbackPlan("看看这些未提交的文件，告诉我有什么风险。", PRODUCTION_AGENTS);
  assert.ok(plan.steps.every((step) => step.id !== "external-commitment"));
});

test("a genuine external request names the missing connector", () => {
  assert.throws(
    () => buildFallbackPlan("把结论发给团队。", PRODUCTION_AGENTS),
    /外部动作连接器尚未实现/,
  );
});

test("a named submission target after a read-only review is still external", () => {
  assert.throws(
    () => buildFallbackPlan("只读审查后提交 PR。", PRODUCTION_AGENTS),
    /外部动作连接器尚未实现/,
  );
});

test("direct requests stay direct instead of creating child agents", () => {
  const plan = buildFallbackPlan("解释一下这个术语是什么意思");

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.agentId, "worker");
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
  // A governed external operator is not part of the default roster; this unit
  // test supplies one to exercise the plan shape the Kernel would gate.
  // 受治理的外部执行者不在默认名单中；这个单元测试提供一个，以验证 Kernel 会校验的计划形状。
  const plan = buildFallbackPlan("调研三个供应商的报价和风险，比较后形成推荐方案，并发布最终采购结果给团队", new Set(["worker", "external-operator"]));
  const orders = plan.steps[0]?.subagents ?? [];

  assert.deepEqual(orders.map((order) => order.id), ["context", "draft", "review"]);
  assert.deepEqual(orders[2]?.dependsOn, ["context", "draft"]);
  assert.equal(plan.steps[1]?.id, "external-commitment");
  assert.equal(plan.steps[1]?.risk, "external_side_effect");
});

test("an explicit read-only request is one read-only step, not a draft artifact", () => {
  // This request used to contain "项目", land in DELIVERY_TERMS, and become a
  // draft work order whose required artifact a read-only worker cannot produce.
  // 这个请求以前因为含"项目"落入 DELIVERY_TERMS，变成 draft 工作单；只读 Worker 产不出
  // 它要求的工件，Run 以 Missing required artifact 失败。
  const plan = buildFallbackPlan("只读取工作区根目录的 README.md，用三句话说明这个项目是什么；不要修改任何文件。");
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0]!;
  assert.equal(step.risk, "read_only");
  assert.equal(step.agentId, "worker");
  assert.equal(step.subagents, undefined, "a read-only request must not create an artifact-bearing work order");
  assert.match(step.instructions ?? "", /README\.md/);
});

test("a read-only code review also stays one read-only step", () => {
  const plan = buildFallbackPlan("只读审查这个项目的代码，指出检索链路的优化空间，不要修改文件。");
  assert.equal(plan.steps[0]?.agentId, "worker");
  assert.equal(plan.steps[0]?.risk, "read_only");
  assert.equal(plan.steps[0]?.subagents, undefined);
});

test("a no-write phrase containing 写 does not turn a read-only request into delivery", () => {
  const plan = buildFallbackPlan("只读取 README.md，不要写任何文件，用三句话说明项目。");
  assert.equal(plan.steps[0]?.risk, "read_only");
  assert.equal(plan.steps[0]?.subagents, undefined);
});

test("a named output target still wins over a no-write constraint", () => {
  // "不要修改现有文件" constrains the existing tree, not the requested report.
  // "不要修改现有文件"约束的是已有文件，而不是被请求的报告。
  const plan = buildFallbackPlan("不要修改现有文件，但把报告写到 out/report.md。");
  assert.ok((plan.steps[0]?.subagents ?? []).some((order) => order.id === "draft"));
});

test("a report verb inside a read-only request does not become a report artifact", () => {
  // "如无法读取则如实报告" contains 报告 as a verb. A bare artifact noun must
  // not outrank the request's explicit read-only constraint.
  // "如无法读取则如实报告"里的"报告"是动词。裸的产物名词不得压过请求里显式的只读约束。
  const plan = buildFallbackPlan("仅读取当前工作区根目录的 README.md，基于其内容用中文三句话说明项目是什么；不要读取其他文件，也不要修改任何文件。如文件不存在或无法读取则如实报告。");
  const step = plan.steps[0];
  assert.equal(step?.id, "read-only-lookup");
  assert.equal(step?.risk, "read_only");
  assert.equal(step?.subagents, undefined);
});

test("the read-only classifier follows the deterministic plan", () => {
  // The classifier is the deterministic plan's own verdict, so the read-only
  // step id and the boolean cannot drift apart.
  // 分类器直接采用确定性计划的判定，因此只读步骤 id 与布尔值不会漂移。
  assert.equal(isReadOnlyRequest("仅读取当前工作区根目录的 README.md，用三句话说明项目；不要修改任何文件。"), true);
  assert.equal(isReadOnlyRequest("只读审查这个项目的代码，不要修改文件。"), true);
  assert.equal(isReadOnlyRequest("帮我写一份报告到 out/report.md"), false);
  assert.equal(isReadOnlyRequest("解释一下这个术语"), false);
});

test("an analysis request with no deliverable is read-only without a marker", () => {
  // "看一下这个项目有什么优化空间" asks for an answer, not a file, even
  // though it names a project and contains no 只读/不要修改 phrase.
  // "看一下这个项目有什么优化空间"要的是回答，不是文件——即使它点名了项目，也没有
  // 只读/不要修改之类的措辞。
  const plan = buildFallbackPlan("看一下 knowledge-base 这个项目，看一下 RAG 代码有什么优化的空间");
  const step = plan.steps[0];
  assert.equal(step?.id, "read-only-lookup");
  assert.equal(step?.risk, "read_only");
  assert.equal(step?.subagents, undefined);
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
  assert.equal(buildFallbackPlan("解释一下这个术语是什么意思").steps[0]?.agentId, "worker");
});
