import assert from "node:assert/strict";
import test from "node:test";

import { buildFallbackPlan } from "../src/planning/fallback-planner.ts";
import { LlmWorkPlanner, type PlanningAgent, type StructuredPlannerModel } from "../src/planning/llm-planner.ts";
import { attachMainAgentBrief, normalizeWorkerBrief, WORKER_BRIEF_MAX_CHARS } from "../src/planning/worker-brief.ts";
import { MAIN_AGENT_CHARTER, MAIN_AGENT_CHARTER_VERSION } from "../src/main-agent/prompt.ts";
import { validateDispatchTask } from "../src/main-agent/tools/dispatch-task.ts";
import { ensureWriteScopes } from "../src/authority/write-scopes.ts";
import type { ExecutionAssignment, SubagentWorkOrder } from "../src/core/contracts.ts";
import { buildInstructions } from "../src/workers/native-agent-worker.ts";
import { systemPrompt } from "../src/workers/native-worker-prompt.ts";

/**
 * A Main-Agent-authored brief is the worker's task prompt; the Kernel appends
 * only the execution contract and the facts it resolved after planning.
 * 主 Agent 编写的简报就是 Worker 的任务提示词；Kernel 只追加执行契约与规划之后解析出的事实。
 */
function assignment(workerBrief?: string): ExecutionAssignment {
  const workOrder: SubagentWorkOrder = {
    id: "draft",
    role: "maker",
    title: "Draft the report",
    objective: "Write out/report.md.",
    ...(workerBrief === undefined ? {} : { workerBrief }),
    inputs: [{ name: "request", description: "The owner's request.", required: true }],
    requiredCapabilities: ["filesystem_write"],
    expectedArtifacts: [{
      id: "report",
      kind: "artifact",
      description: "A report at out/report.md.",
      required: true,
      locatorRequired: true,
    }],
    acceptanceCriteria: ["out/report.md exists and names the project."],
    risk: "reversible_write",
    budget: { maxDurationMs: 60_000, maxAttempts: 1 },
  };
  return {
    run: { id: "run-1", taskId: "task-1", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "task-1", triggerId: "t", title: "t", objective: "Write the report.", acceptanceCriteria: [], createdAt: "" },
    step: { id: "s1", title: "s1", instructions: "Plan the report.", risk: "reversible_write", acceptanceCriteria: ["report exists"] },
    workOrder,
    executor: { agentId: "native", providerId: "native" },
    workspacePath: "/tmp/worker-brief-workspace",
    memoryContext: {
      items: [{ id: "mem-1", summary: "The owner prefers short reports." }],
      selectedBy: { query: "Write the report." },
    },
  };
}

test("the Main Agent's brief becomes the worker's task prompt", () => {
  const brief = "Write a three-paragraph report about the project to out/report.md. Stop after the file is written and verified.";
  const prompt = systemPrompt(brief, [{ name: "read_file" }, { name: "write_file" }]);

  assert.ok(prompt.startsWith(brief), "the brief must be the first thing the worker reads");
  // The execution contract is the tool ABI, not task prose. It must still name
  // the gate, the tool table and the stop condition.
  // 执行契约是工具 ABI，不是任务正文。它仍必须写明闸门、工具表与停止条件。
  assert.match(prompt, /Execution contract \(fixed by the Kernel/);
  assert.match(prompt, /Reads may reach any readable location/);
  assert.match(prompt, /Available tools: read_file, write_file\./);
  assert.match(prompt, /stop calling tools/);
  // A brief that names a project must not be replaced by the workspace's files.
  // 点名项目的简报不得用工作区里的文件顶替。
  assert.match(prompt, /do not review this workspace in its place/);
  // The legacy template must not leak into the brief path.
  // 旧模板不得泄漏进简报路径。
  assert.doesNotMatch(prompt, /You are a worker inside Clone AI/);
});

test("the brief path carries only Kernel-resolved facts in the user message", () => {
  const brief = "Write a three-paragraph report about the project to out/report.md.";
  const text = buildInstructions(assignment(brief), ["files:/protected (too broad)"]);

  assert.match(text, /Runtime facts/);
  assert.match(text, /Objective: Write out\/report\.md\./);
  assert.match(text, /Workspace: \/tmp\/worker-brief-workspace\./);
  assert.match(text, /Required inputs: request\./);
  assert.match(text, /Required evidence contract/);
  assert.match(text, /report \[artifact, durable locator required\]/);
  assert.match(text, /Relevant background facts/);
  assert.match(text, /The owner prefers short reports\./);
  assert.match(text, /Scopes the Kernel refused: files:\/protected \(too broad\)\./);
  // The Kernel verifies the step's criteria; the work order's criteria are the
  // subagent supervisor's contract. Both are facts, so both are shown.
  // Kernel 验证步骤标准；工作单标准是子 Agent 监督者的契约。两者都是事实，因此都显示。
  assert.match(text, /Step acceptance criteria \(the Kernel verifies these\):/);
  assert.match(text, /- report exists/);
  assert.match(text, /Work order acceptance criteria:/);
  assert.match(text, /- out\/report\.md exists and names the project\./);
  // The brief is the system message, so it must not be repeated here.
  // 简报是 system 消息，因此不得在这里重复。
  assert.doesNotMatch(text, /Write a three-paragraph report about the project/);
  // The legacy boundary prose belongs to the no-brief path.
  // 旧边界文案只属于无简报路径。
  assert.doesNotMatch(text, /do not review this workspace in its place/);
});

test("dependency evidence is rendered as a required input", () => {
  const text = buildInstructions({
    ...assignment("BRIEF"),
    dependencyEvidence: [{
      kind: "observation",
      summary: "The draft names the budget.",
      locator: "out/draft.md",
      stepId: "s1",
      workOrderId: "draft",
    }],
  } as ExecutionAssignment, []);

  assert.match(text, /Verified evidence from dependencies/);
  assert.match(text, /\[observation\] The draft names the budget\. \(out\/draft\.md\)/);
});

test("a work order without a brief keeps the previous template", () => {
  const text = buildInstructions(assignment(), []);
  const prompt = systemPrompt(undefined, [{ name: "read_file" }]);

  assert.match(text, /Write out\/report\.md\./);
  assert.match(text, /do not review this workspace in its place/);
  assert.match(prompt, /You are a worker inside Clone AI/);
});

test("the dispatch validator trims, omits and bounds the brief", () => {
  const trimmed = validateDispatchTask({
    objective: "Write the report.",
    acceptanceCriteria: ["report exists"],
    workerBrief: "  Write out/report.md.  ",
  });
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.ok && trimmed.task.workerBrief, "Write out/report.md.");

  const omitted = validateDispatchTask({ objective: "Write.", acceptanceCriteria: ["exists"], workerBrief: "   " });
  assert.equal(omitted.ok, true);
  assert.equal(omitted.ok && omitted.task.workerBrief, undefined);

  const tooLong = validateDispatchTask({
    objective: "Write.",
    acceptanceCriteria: ["exists"],
    workerBrief: "x".repeat(WORKER_BRIEF_MAX_CHARS + 1),
  });
  assert.equal(tooLong.ok, false);

  const malformed = validateDispatchTask({
    objective: "Write.",
    acceptanceCriteria: ["exists"],
    workerBrief: ["write out/report.md"],
  });
  assert.equal(malformed.ok, false, "a non-string brief is rejected, not silently dropped");
});

test("normalizeWorkerBrief rejects an oversized brief and accepts a bounded one", () => {
  assert.equal(normalizeWorkerBrief("  brief  "), "brief");
  assert.equal(normalizeWorkerBrief(undefined), undefined);
  assert.throws(() => normalizeWorkerBrief("x".repeat(WORKER_BRIEF_MAX_CHARS + 1)), /at most/);
});

test("the fallback planner places a dispatch brief on the draft order", () => {
  const plan = buildFallbackPlan("写一份报告到 out/report.md");
  const steps = attachMainAgentBrief(plan.steps, "BRIEF");
  const draft = steps[0]?.subagents?.find((order) => order.id === "draft");
  assert.equal(draft?.workerBrief, "BRIEF");
  assert.equal(steps[0]?.workerBrief, undefined, "the step keeps its own text when it supervises orders");
});

test("the fallback planner places a read-only brief on the single step", () => {
  const plan = buildFallbackPlan("只读取 README.md，用三句话说明这个项目。");
  const steps = attachMainAgentBrief(plan.steps, "BRIEF");
  assert.equal(steps[0]?.workerBrief, "BRIEF");
});

test("the LLM planner decodes a per-step brief, and the runtime places the Main Agent's", async () => {
  const agents: PlanningAgent[] = [
    { id: "native", providerId: "native", role: "draft", capabilities: ["filesystem_write"] },
  ];
  const proposal = {
    summary: "Write the report.",
    steps: [{
      id: "write",
      title: "Write",
      instructions: "Write the report.",
      workerBrief: "Planner's brief.",
      risk: "reversible_write",
      acceptanceCriteria: ["report exists"],
      execution: { kind: "single", agentId: "native", requiredCapabilities: ["filesystem_write"], orders: [] },
    }],
  };
  const model: StructuredPlannerModel = { async createWorkPlan() { return proposal; } };
  const plan = await new LlmWorkPlanner(model).plan({
    query: "Write the report.",
    recalledMemories: [],
    availableAgents: agents,
    workerBrief: "Main Agent's brief.",
  });

  assert.equal(plan.steps[0]?.workerBrief, "Planner's brief.", "the planner decodes its own brief");
  const placed = attachMainAgentBrief(plan.steps, "Main Agent's brief.");
  assert.equal(placed[0]?.workerBrief, "Main Agent's brief.", "the runtime's brief wins over the planner's");
});

test("a maker order not named draft becomes the brief's primary execution", () => {
  // An LLM plan may name the writing order "write" and put a read-only
  // researcher first. The brief must follow the maker, not the researcher.
  // LLM 计划可能把写入工作单命名为 "write"，并把只读研究员排在前面。简报必须跟着 maker，
  // 而不是研究员。
  const [step] = attachMainAgentBrief([{
    id: "research",
    title: "Research",
    instructions: "Research first.",
    risk: "read_only",
    acceptanceCriteria: ["research done"],
    subagents: [
      {
        id: "research", role: "researcher", title: "Research", objective: "Read the notes.",
        inputs: [], requiredCapabilities: ["research"], expectedArtifacts: [], acceptanceCriteria: ["read"],
        risk: "read_only", budget: { maxDurationMs: 1_000, maxAttempts: 1 },
      },
      {
        id: "write", role: "maker", title: "Write", objective: "Write the report.",
        inputs: [], requiredCapabilities: ["filesystem_write"], expectedArtifacts: [], acceptanceCriteria: ["written"],
        risk: "reversible_write", budget: { maxDurationMs: 1_000, maxAttempts: 1 },
      },
    ],
  }], "BRIEF");

  assert.equal(step?.subagents?.find((order) => order.id === "research")?.workerBrief, undefined);
  assert.equal(step?.subagents?.find((order) => order.id === "write")?.workerBrief, "BRIEF");
});

test("a write target named only in the brief is still scoped", () => {
  const [step] = ensureWriteScopes([{
    id: "write",
    title: "Write",
    instructions: "No target is named here.",
    risk: "reversible_write",
    acceptanceCriteria: ["report exists"],
    agentId: "native",
    requiredCapabilities: ["filesystem_write"],
    workerBrief: "write /tmp/worker-brief-report.md",
  }], { requestText: "" });

  assert.ok(step?.scopes?.some((scope) => scope.domain === "files" && scope.access === "write"));
});

test("a write target named only in a subagent order's brief is still scoped", () => {
  const [step] = ensureWriteScopes([{
    id: "write",
    title: "Write",
    instructions: "No target is named here.",
    risk: "reversible_write",
    acceptanceCriteria: ["report exists"],
    subagents: [{
      id: "draft",
      role: "maker",
      title: "Draft",
      objective: "Write the report.",
      workerBrief: "write /tmp/worker-brief-order.md",
      inputs: [],
      requiredCapabilities: ["filesystem_write"],
      expectedArtifacts: [],
      acceptanceCriteria: ["report exists"],
      risk: "reversible_write",
      budget: { maxDurationMs: 1_000, maxAttempts: 1 },
    }],
  }], { requestText: "" });

  assert.ok(step?.scopes?.some((scope) => scope.domain === "files" && scope.access === "write"));
});

test("a prohibition in the brief is not a write grant", () => {
  // The brief states the boundary by naming the file not to touch. Scanning
  // that prohibition as a grant would let the worker overwrite it.
  // 简报通过点名不许触碰的文件来声明边界。把禁令当成授权，会让 Worker 覆盖它。
  const brief = "Read ~/project/notes.md and summarize it. Do not write ~/project/notes.md; write the summary to ~/project/summary.md.";
  const [scoped] = ensureWriteScopes([{
    id: "write",
    title: "Write",
    instructions: "Summarize the notes.",
    risk: "reversible_write",
    acceptanceCriteria: ["the summary exists"],
    agentId: "native",
    requiredCapabilities: ["filesystem_write"],
    workerBrief: brief,
  }], { requestText: "" });

  const resources = (scoped?.scopes ?? []).filter((scope) => scope.domain === "files").map((scope) => scope.resource);
  assert.ok(resources.some((resource) => resource.endsWith("summary.md")), "the positive target must be scoped");
  assert.ok(!resources.some((resource) => resource.endsWith("notes.md")), "the prohibited target must not be scoped");
});

test("a Chinese prohibition in the brief is not a write grant", () => {
  const brief = "读取 ~/project/notes.md 并总结。不要写入 ~/project/notes.md；把摘要写到 ~/project/summary.md。";
  const [scoped] = ensureWriteScopes([{
    id: "write",
    title: "Write",
    instructions: "总结笔记。",
    risk: "reversible_write",
    acceptanceCriteria: ["摘要存在"],
    agentId: "native",
    requiredCapabilities: ["filesystem_write"],
    workerBrief: brief,
  }], { requestText: "" });

  const resources = (scoped?.scopes ?? []).filter((scope) => scope.domain === "files").map((scope) => scope.resource);
  assert.ok(resources.some((resource) => resource.endsWith("summary.md")), "正向目标必须被纳入 Scope");
  assert.ok(!resources.some((resource) => resource.endsWith("notes.md")), "被禁止的目标不得被纳入 Scope");
});

test("the charter names the brief contract and its version moved", () => {
  // 9 adds the daily-digest guidance on top of the brief contract (8). 9 在 8 的简报契约之上
  // 增加了每日摘要指引。
  assert.equal(MAIN_AGENT_CHARTER_VERSION, 9);
  assert.match(MAIN_AGENT_CHARTER, /workerBrief/);
  assert.match(MAIN_AGENT_CHARTER, /complete prompt its worker receives/);
  assert.match(MAIN_AGENT_CHARTER, /absolute path or `~\/\.\.\.`/);
});
