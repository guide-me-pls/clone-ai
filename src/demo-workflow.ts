import { join } from "node:path";

import { createDemoAgentRegistry } from "./adapters/demo-adapter.ts";
import { createConfiguredAgentRegistry } from "./adapters/configured-agent-registry.ts";
import { workCapabilitiesForRole } from "./agents/capabilities.ts";
import type { TriggerKind } from "./core/contracts.ts";
import { JsonlJournalStore } from "./core/journal.ts";
import { DefaultPolicyEngine } from "./core/policy.ts";
import { CloneRuntime, type DispatchResult } from "./core/runtime.ts";
import { EvidenceVerifier } from "./core/verification.ts";
import { MemoryPipeline } from "./memory/memory-pipeline.ts";
import { LocalMemoryStore } from "./memory/memory-store.ts";
import { buildDemoPlan } from "./planning/demo-planner.ts";
import { createEnvironmentWorkPlanner, type PlanningAgent, type WorkPlanner } from "./planning/llm-planner.ts";
import { defaultAgentSettings, type CloneSettings } from "./settings/agent-settings.ts";

export interface DemoRunResult {
  runId: string;
  status: DispatchResult["status"];
  activeStepId?: string;
  subagentsCompleted: number;
  memoryCandidatesProposed: number;
}

export interface DemoWorkflowOptions {
  workspacePath?: string;
  /**
   * Test seam and future desktop setting: select an explicit planner.
   * 测试切口与未来桌面端设置：选择一个明确的 Planner。
   */
  planner?: WorkPlanner;
}

/**
 * Runs the current Query-to-outcome path: durable trigger, memory recall,
 * planning, Runtime execution, verification, then asynchronous memory work.
 * The function coordinates components; it never lets a planner or worker own
 * the parent Run.
 *
 * 运行当前从 Query 到结果的主链路：持久化触发、记忆召回、规划、Runtime 执行、验证，最后
 * 才异步处理记忆。这个函数只负责协调组件，不会让 Planner 或 Worker 拥有父 Run 的控制权。
 */
export async function startDemoWorkflow(
  dataDirectory: string,
  query: string,
  trigger: { kind?: TriggerKind; payload?: Record<string, unknown> } = {},
  settings?: CloneSettings,
  options: DemoWorkflowOptions = {},
): Promise<DemoRunResult> {
  const { runtime, memory } = await createRuntime(dataDirectory);
  const { run } = await runtime.acceptTrigger({
    kind: trigger.kind ?? "query",
    summary: query,
    payload: { source: "desktop-client", ...trigger.payload },
  });

  const memoryStore = new LocalMemoryStore(join(dataDirectory, "memory.json"));
  const recalled = await memoryStore.recall(query, run.id);
  await runtime.recordMemoryRecall(run.id, query, recalled.map((item) => ({
    id: item.memory.id,
    summary: item.memory.summary,
    score: item.score,
    matchedTerms: item.matchedTerms,
  })));

  const agents = settings?.agents ?? defaultAgentSettings();
  const recalledMemories = recalled.map((item) => item.memory.summary);
  const planner = options.planner ?? createEnvironmentWorkPlanner();
  // The LLM planner is opt-in. Without credentials, the transparent local
  // policy keeps the demo runnable and teaches exactly why it chose a graph.
  // LLM Planner 是显式开启的。没有凭据时，透明本地策略仍能让 Demo 可运行，
  // 也能清楚解释它为何选择当前任务图。
  const plan = planner === undefined
    ? buildDemoPlan(query, new Set(agents.filter((agent) => agent.enabled).map((agent) => agent.id)), recalledMemories)
    : await planner.plan({
      query,
      recalledMemories,
      availableAgents: planningAgents(agents),
    });
  await runtime.attachPlan(run.id, plan);

  const registry = settings === undefined
    ? createDemoAgentRegistry()
    : createConfiguredAgentRegistry(agents, {
      dataDirectory,
      workspacePath: options.workspacePath ?? process.env.CLONE_AI_WORKSPACE ?? process.cwd(),
    });
  const result = await runtime.execute(run.id, registry);
  const candidates = result.status === "completed" ? await memory.processNext() : [];
  return toDemoResult(runtime, result, candidates.length);
}

function planningAgents(agents: CloneSettings["agents"]): PlanningAgent[] {
  return agents
    .filter((agent) => agent.enabled)
    .map((agent) => ({
      id: agent.id,
      providerId: agent.providerId,
      role: agent.role,
      capabilities: workCapabilitiesForRole(agent.role),
    }));
}

export async function approveDemoWorkflow(
  dataDirectory: string,
  runId: string,
  settings?: CloneSettings,
  options: DemoWorkflowOptions = {},
): Promise<DemoRunResult> {
  const { runtime, memory } = await createRuntime(dataDirectory);
  const run = runtime.getRun(runId);
  if (run.status !== "waiting_approval" || run.activeStepId === undefined) {
    throw new Error(`Run ${runId} is not waiting for an approval.`);
  }

  await runtime.grantApproval(run.id, run.activeStepId, "Approved from the local desktop companion.");
  const registry = settings === undefined
    ? createDemoAgentRegistry()
    : createConfiguredAgentRegistry(settings.agents, {
      dataDirectory,
      workspacePath: options.workspacePath ?? process.env.CLONE_AI_WORKSPACE ?? process.cwd(),
    });
  const result = await runtime.execute(run.id, registry);
  const candidates = result.status === "completed" ? await memory.processNext() : [];
  return toDemoResult(runtime, result, candidates.length);
}

function toDemoResult(runtime: CloneRuntime, result: DispatchResult, memoryCandidatesProposed: number): DemoRunResult {
  return {
    runId: result.run.id,
    status: result.status,
    activeStepId: result.run.activeStepId,
    subagentsCompleted: runtime.getSubagentsForRun(result.run.id).filter((subagent) => subagent.status === "completed").length,
    memoryCandidatesProposed,
  };
}

async function createRuntime(dataDirectory: string): Promise<{ runtime: CloneRuntime; memory: MemoryPipeline }> {
  const journal = new JsonlJournalStore(join(dataDirectory, "journal.jsonl"));
  const memory = new MemoryPipeline(journal);
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory,
    // Workers receive the owner's reviewed memory through the Kernel, so
    // switching providers never means migrating memory into another tool.
    // Worker 经由 Kernel 收到所有者已审核的记忆，因此更换 Provider 从不意味着
    // 把记忆迁移进另一个工具。
    memorySource: new LocalMemoryStore(join(dataDirectory, "memory.json")),
  });
  await runtime.hydrate();
  return { runtime, memory };
}
