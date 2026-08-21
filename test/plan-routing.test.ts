import assert from "node:assert/strict";
import test from "node:test";

import { assignWorkersPerStep } from "../src/main-agent/plan-routing.ts";
import type { DispatchDecision, WorkerDescriptor } from "../src/main-agent/dispatch-contracts.ts";
import type { PlanStep } from "../src/core/contracts.ts";

function worker(id: string, capabilities: string[], overrides: Partial<WorkerDescriptor> = {}): WorkerDescriptor {
  return {
    id,
    providerId: "pi",
    description: `${id} worker`,
    roles: ["research"],
    capabilities,
    enabled: true,
    installed: true,
    priority: 0,
    ...overrides,
  } as WorkerDescriptor;
}

const WORKERS = [
  worker("context-researcher", ["research", "filesystem_read"]),
  worker("draft-maker", ["drafting", "filesystem_read", "filesystem_write"]),
  worker("evidence-reviewer", ["review"]),
  worker("external-operator", ["external_action"]),
];

function decision(selectedAgentId: string, source: DispatchDecision["source"] = "rule"): DispatchDecision {
  return {
    taskId: "task-1",
    intent: { kind: "research", summary: "test task", requiredCapabilities: [], excludedAgentIds: [] },
    selectedAgentId,
    providerId: "pi",
    source,
    matchedRuleIds: [],
    usedMemoryIds: [],
    alternatives: [],
    reason: "test",
    sessionPolicy: "fresh",
    createdAt: new Date().toISOString(),
  };
}

function step(id: string, agentId: string, requiredCapabilities: string[]): PlanStep {
  return { id, title: id, instructions: id, risk: "read_only", acceptanceCriteria: ["done"], agentId, requiredCapabilities };
}

test("a plan spanning three roles keeps three different workers", () => {
  const plan = {
    summary: "Research, draft, review",
    steps: [
      step("s1", "context-researcher", ["research"]),
      step("s2", "draft-maker", ["drafting", "filesystem_write"]),
      step("s3", "evidence-reviewer", ["review"]),
    ],
  };

  const routed = assignWorkersPerStep(plan, decision("context-researcher"), WORKERS);

  assert.deepEqual(routed.plan.steps.map((s) => s.agentId), ["context-researcher", "draft-maker", "evidence-reviewer"]);
  assert.equal(routed.assignments.length, 3);
  assert.match(routed.assignments[1]!.reason, /draft-maker/);
});

test("a step the planner misassigned is moved to a worker that can run it", () => {
  // The planner asked a research worker to write files. Dispatching that would
  // fail on a capability the owner never chose.
  // Planner 让研究型 Worker 去写文件。照此派发会因所有者从未选择过的能力而失败。
  const plan = { summary: "Write", steps: [step("s1", "context-researcher", ["drafting", "filesystem_write"])] };

  const routed = assignWorkersPerStep(plan, decision("context-researcher"), WORKERS);

  assert.equal(routed.plan.steps[0]!.agentId, "draft-maker");
  assert.match(routed.assignments[0]!.reason, /cannot run this step/);
});

test("an explicit request from the owner pins every step to that worker", () => {
  const plan = {
    summary: "Research then draft",
    steps: [step("s1", "context-researcher", ["research"]), step("s2", "draft-maker", ["drafting"])],
  };

  const routed = assignWorkersPerStep(plan, decision("evidence-reviewer", "explicit"), WORKERS);

  assert.deepEqual(routed.plan.steps.map((s) => s.agentId), ["evidence-reviewer", "evidence-reviewer"]);
  for (const assignment of routed.assignments) {
    assert.match(assignment.reason, /explicitly requested/);
  }
});

test("a disabled or uninstalled worker is never assigned a step", () => {
  const workers = [
    worker("context-researcher", ["research", "filesystem_read"]),
    worker("draft-maker", ["drafting", "filesystem_write"], { enabled: false }),
    worker("backup-drafter", ["drafting", "filesystem_write"], { installed: false }),
  ];
  const plan = { summary: "Draft", steps: [step("s1", "draft-maker", ["drafting", "filesystem_write"])] };

  const routed = assignWorkersPerStep(plan, decision("context-researcher"), workers);

  // Nothing available covers the step, so it falls back to the routed worker
  // and the Kernel refuses at dispatch naming the missing capability.
  // 没有可用 Worker 覆盖该步骤，于是回退到路由选定的 Worker，由 Kernel 在派发时指名
  // 缺失的能力并拒绝。
  assert.equal(routed.plan.steps[0]!.agentId, "context-researcher");
  assert.match(routed.assignments[0]!.reason, /No available worker covers/);
});

test("subagent orders inside one step are routed independently", () => {
  const plan = {
    summary: "Parallel work",
    steps: [{
      id: "s1",
      title: "Fan out",
      instructions: "Do both",
      risk: "read_only" as const,
      acceptanceCriteria: ["done"],
      subagents: [
        { id: "o1", title: "Research", instructions: "look", agentId: "draft-maker", requiredCapabilities: ["research"], acceptanceCriteria: ["done"] },
        { id: "o2", title: "Review", instructions: "check", agentId: "draft-maker", requiredCapabilities: ["review"], acceptanceCriteria: ["done"] },
      ],
    }],
  };

  const routed = assignWorkersPerStep(plan as never, decision("draft-maker"), WORKERS);

  assert.deepEqual(routed.plan.steps[0]!.subagents!.map((o) => o.agentId), ["context-researcher", "evidence-reviewer"]);
  assert.deepEqual(routed.assignments.map((a) => a.orderId), ["o1", "o2"]);
});

test("a step declaring no capabilities inherits the assigned worker's own", () => {
  const plan = { summary: "Open", steps: [step("s1", "context-researcher", [])] };

  const routed = assignWorkersPerStep(plan, decision("context-researcher"), WORKERS);

  assert.deepEqual(routed.plan.steps[0]!.requiredCapabilities, ["research", "filesystem_read"]);
});

test("the most specialised covering worker wins over a broader one", () => {
  const workers = [
    worker("generalist", ["research", "drafting", "review", "filesystem_read", "filesystem_write"]),
    worker("reviewer", ["review"]),
  ];
  const plan = { summary: "Review", steps: [step("s1", "generalist", ["review"])] };

  // The planner named the generalist and it does cover the step, so it is kept:
  // a plannable, capable choice is not second-guessed.
  // Planner 指定了通才且它确实覆盖该步骤，因此予以保留：一个可派发且有能力的选择不会被否决。
  assert.equal(assignWorkersPerStep(plan, decision("generalist"), workers).plan.steps[0]!.agentId, "generalist");

  // With no plannable choice, the specialist is preferred.
  // 没有可用的计划选择时，优先选择专精者。
  const unplanned = { summary: "Review", steps: [step("s1", "nobody", ["review"])] };
  assert.equal(assignWorkersPerStep(unplanned, decision("generalist"), workers).plan.steps[0]!.agentId, "reviewer");
});

test("a pinned worker's own capabilities replace what the plan declared", () => {
  // A template plan declares what the work needs ("direct_response"); the
  // worker the owner named may not list it. Dispatching on the declared
  // capability would fail and override the owner with a template's guess.
  // 模板计划声明的是工作所需（如 "direct_response"）；所有者点名的 Worker 可能并未列出
  // 它。按声明能力派发会失败，等于用模板的猜测推翻所有者的决定。
  const plan = { summary: "Review", steps: [step("s1", "direct-responder", ["direct_response"])] };

  const routed = assignWorkersPerStep(plan, decision("evidence-reviewer", "explicit"), WORKERS);

  assert.equal(routed.plan.steps[0]!.agentId, "evidence-reviewer");
  assert.deepEqual(routed.plan.steps[0]!.requiredCapabilities, ["review"]);
});
