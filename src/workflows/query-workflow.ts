import { join } from "node:path";


import { createConfiguredAgentRegistry } from "../adapters/configured-agent-registry.ts";
import { workCapabilitiesForRole } from "../agents/capabilities.ts";
import type { AgentRegistry, TriggerKind } from "../core/contracts.ts";
import { loadOutcomeCatalog } from "../core/failure-analysis.ts";
import { JsonlJournalStore } from "../core/journal.ts";
import { DefaultPolicyEngine } from "../core/policy.ts";
import { CloneRuntime, type DispatchResult } from "../core/runtime.ts";
import { JsonWorkspaceCheckpointStore } from "../core/workspace-evidence.ts";
import { EvidenceVerifier } from "../core/verification.ts";
import { MemoryPipeline } from "../memory/memory-pipeline.ts";
import { LocalMemoryStore } from "../memory/memory-store.ts";
import { buildFallbackPlan } from "../planning/fallback-planner.ts";
import { createEnvironmentWorkPlanner, type PlanningAgent, type WorkPlanner } from "../planning/llm-planner.ts";
import { defaultAgentSettings, type CloneSettings } from "../settings/agent-settings.ts";

export interface QueryRunResult {
  runId: string;
  status: DispatchResult["status"];
  activeStepId?: string;
  subagentsCompleted: number;
  memoryCandidatesProposed: number;
}

export interface QueryWorkflowOptions {
  workspacePath?: string;
  /**
   * Test seam and future desktop setting: select an explicit planner.
   * 测试切口与未来桌面端设置：选择一个明确的 Planner。
   */
  planner?: WorkPlanner;
  /**
   * Explicit executor registry. Production leaves this unset so providers come
   * from settings; tests inject scripted adapters instead of reaching a real
   * provider. There is deliberately no implicit fake fallback.
   * 显式的执行者 Registry。生产环境不设置它，Provider 由 Settings 决定；测试注入脚本化
   * Adapter 以避免触达真实 Provider。这里刻意没有隐式的假 Registry 回退。
   */
  agents?: AgentRegistry;
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
export async function runQuery(
  dataDirectory: string,
  query: string,
  trigger: { kind?: TriggerKind; payload?: Record<string, unknown> } = {},
  settings?: CloneSettings,
  options: QueryWorkflowOptions = {},
): Promise<QueryRunResult> {
  const workspacePath = options.workspacePath ?? process.env.CLONE_AI_WORKSPACE ?? process.cwd();
  const { runtime, memory, failureCatalog } = await createRuntime(dataDirectory, workspacePath);
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
  // The LLM planner is opt-in. Without credentials the deterministic local
  // policy still produces a plan and states exactly why it chose that graph.
  // LLM Planner 是显式开启的。没有凭据时，确定性的本地策略仍会产出计划，
  // 并明确说明它为何选择当前任务图。
  const plan = planner === undefined
    ? buildFallbackPlan(query, new Set(agents.filter((agent) => agent.enabled).map((agent) => agent.id)), recalledMemories)
    : await planner.plan({
      query,
      recalledMemories,
      availableAgents: planningAgents(agents),
    });
  await runtime.attachPlan(run.id, plan);

  const registry = options.agents ?? await createConfiguredAgentRegistry(agents, {
    dataDirectory,
    workspacePath,
    failureCatalog,
  });
  const result = await runtime.execute(run.id, registry);
  const candidates = result.status === "completed" ? await memory.processNext() : [];
  return toQueryResult(runtime, result, candidates.length);
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

export async function approveQueryRun(
  dataDirectory: string,
  runId: string,
  settings?: CloneSettings,
  options: QueryWorkflowOptions = {},
): Promise<QueryRunResult> {
  const workspacePath = options.workspacePath ?? process.env.CLONE_AI_WORKSPACE ?? process.cwd();
  const { runtime, memory, failureCatalog } = await createRuntime(dataDirectory, workspacePath);
  const run = runtime.getRun(runId);
  if (run.status !== "waiting_approval" || run.activeStepId === undefined) {
    throw new Error(`Run ${runId} is not waiting for an approval.`);
  }

  await runtime.grantApproval(run.id, run.activeStepId, "Approved from the local desktop companion.");
  const registry = options.agents ?? await createConfiguredAgentRegistry((settings?.agents ?? defaultAgentSettings()), {
      dataDirectory,
      workspacePath,
      failureCatalog,
    });
  const result = await runtime.execute(run.id, registry);
  const candidates = result.status === "completed" ? await memory.processNext() : [];
  return toQueryResult(runtime, result, candidates.length);
}

function toQueryResult(runtime: CloneRuntime, result: DispatchResult, memoryCandidatesProposed: number): QueryRunResult {
  return {
    runId: result.run.id,
    status: result.status,
    activeStepId: result.run.activeStepId,
    subagentsCompleted: runtime.getSubagentsForRun(result.run.id).filter((subagent) => subagent.status === "completed").length,
    memoryCandidatesProposed,
  };
}

async function createRuntime(dataDirectory: string, workspacePath: string): Promise<{ runtime: CloneRuntime; memory: MemoryPipeline; failureCatalog: import("../core/failure-analysis.ts").OutcomeCatalog }> {
  const journal = new JsonlJournalStore(join(dataDirectory, "journal.jsonl"));
  const failureCatalog = await loadOutcomeCatalog(dataDirectory);
  const memory = new MemoryPipeline(journal);
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory,
    failureCatalog,
    // Workers receive the owner's reviewed memory through the Kernel, so
    // switching providers never means migrating memory into another tool.
    // Worker 经由 Kernel 收到所有者已审核的记忆，因此更换 Provider 从不意味着
    // 把记忆迁移进另一个工具。
    memorySource: new LocalMemoryStore(join(dataDirectory, "memory.json")),
    workspacePath,
    workspaceCheckpointStore: new JsonWorkspaceCheckpointStore(join(dataDirectory, "workspace-checkpoints")),
  });
  await runtime.hydrate();
  return { runtime, memory, failureCatalog };
}
