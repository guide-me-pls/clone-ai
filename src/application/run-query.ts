import { createConfiguredAgentRegistry } from "../workers/configured-worker-registry.ts";
import { workCapabilitiesForRole } from "../workers/capabilities.ts";
import { WorkerRegistry } from "../workers/worker-registry.ts";
import type { AgentRegistry, TriggerKind } from "../core/contracts.ts";
import { createRuntimeAssembly } from "../core/runtime-factory.ts";
import type { CloneRuntime, DispatchResult } from "../core/runtime.ts";
import { LocalMemoryStore } from "../memory/memory-store.ts";
import { buildFallbackPlan } from "../planning/fallback-planner.ts";
import { createEnvironmentWorkPlanner, type PlanningAgent, type WorkPlanner } from "../planning/llm-planner.ts";
import { defaultWorkerProfiles, type CloneSettings } from "../config/worker-settings.ts";
import { classifyIntent } from "../main-agent/intent-classifier.ts";
import { routeTask } from "../main-agent/agent-router.ts";
import { buildMemoryContextFromCandidates } from "../main-agent/memory-context-builder.ts";
import { describeWorkers } from "../main-agent/worker-descriptors.ts";
import { JournalDispatchRecorder } from "../main-agent/dispatch-recorder.ts";
import type { DispatchBlockedCode } from "../main-agent/dispatch-contracts.ts";

export interface QueryRunResult {
  runId: string;
  status: DispatchResult["status"] | "blocked";
  activeStepId?: string;
  subagentsCompleted: number;
  memoryCandidatesProposed: number;
  /** Present when routing refused rather than substituting a worker. 路由拒绝而非替换 Worker 时存在。 */
  blocked?: { code: DispatchBlockedCode; reason: string; requestedAgentId?: string };
  /** Which worker the router chose, and why. 路由器选择了哪个 Worker，以及原因。 */
  routing?: { selectedAgentId: string; source: string; usedMemoryIds: readonly string[] };
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
  const { runtime, memory, failureCatalog, paths, journal } = await createRuntimeAssembly({
    dataDirectory,
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  const workspacePath = paths.workspacePath;
  const { run } = await runtime.acceptTrigger({
    kind: trigger.kind ?? "query",
    summary: query,
    payload: { source: "desktop-client", ...trigger.payload },
  });

  const memoryStore = new LocalMemoryStore(paths.memoryFile);
  const recalled = await memoryStore.recall(query, run.id);
  await runtime.recordMemoryRecall(run.id, query, recalled.map((item) => ({
    id: item.memory.id,
    summary: item.memory.summary,
    score: item.score,
    matchedTerms: item.matchedTerms,
  })));
  // Reuses the recall above rather than opening a second store: two views of
  // memory could disagree, and only one of them would be journaled.
  // 复用上面的召回而不是另开一个存储：两份记忆视图可能互相矛盾，而只有一份会被记入 Journal。
  const memoryContext = buildMemoryContextFromCandidates(recalled.map((item) => ({
    id: item.memory.id,
    summary: item.memory.summary,
    score: item.score,
  })));

  const agents = settings?.agents ?? defaultWorkerProfiles();
  const recalledMemories = recalled.map((item) => item.memory.summary);

  // Routing happens before planning: a request the owner made explicitly must
  // be honoured or refused, and refusing after a plan exists would leave a run
  // that looks planned but can never legitimately execute.
  // 路由发生在规划之前：所有者显式提出的请求要么被满足要么被拒绝；若在计划已存在之后
  // 才拒绝，就会留下一个看似已规划、却永远无法合法执行的 Run。
  const intent = classifyIntent(query, { knownAgentIds: agents.map((agent) => agent.id) });
  // An injected registry is itself the statement of what can run here, so
  // probing the filesystem would contradict the caller. Only the production
  // path, which resolves providers from settings, asks what is installed.
  // 注入的 Registry 本身就声明了此处什么能运行，再去探测文件系统等于与调用方矛盾。
  // 只有从 Settings 解析 Provider 的生产路径才需要询问安装状态。
  const workerStatuses = options.agents === undefined
    ? await new WorkerRegistry(dataDirectory).list()
    : options.agents.list().map((adapter) => ({ id: adapter.id, installed: true }));
  const routed = routeTask({
    taskId: run.id,
    intent,
    workers: describeWorkers(agents, workerStatuses),
    ...(memoryContext === undefined ? {} : { memory: memoryContext }),
  });

  const recorder = new JournalDispatchRecorder(journal);
  if (routed.status === "blocked") {
    await recorder.recordBlocked(routed);
    await runtime.failRun(run.id, `${routed.code}: ${routed.reason}`);
    return {
      runId: run.id,
      status: "blocked",
      subagentsCompleted: 0,
      memoryCandidatesProposed: 0,
      blocked: {
        code: routed.code,
        reason: routed.reason,
        ...(routed.requestedAgentId === undefined ? {} : { requestedAgentId: routed.requestedAgentId }),
      },
    };
  }
  await recorder.recordDecision(routed.decision);

  // The planner may only assign the worker routing already settled on, so a
  // model cannot quietly reroute the owner's explicit choice.
  // Planner 只能指派路由已经确定的那个 Worker，因此模型无法悄悄改写所有者的显式选择。
  const selectedId = routed.decision.selectedAgentId;
  const routableAgents = agents.filter((agent) => agent.id === selectedId);
  const planner = options.planner ?? createEnvironmentWorkPlanner();
  // The LLM planner is opt-in. Without credentials the deterministic local
  // policy still produces a plan and states exactly why it chose that graph.
  // LLM Planner 是显式开启的。没有凭据时，确定性的本地策略仍会产出计划，
  // 并明确说明它为何选择当前任务图。
  const plan = planner === undefined
    ? buildFallbackPlan(query, new Set([selectedId]), recalledMemories)
    : await planner.plan({
      query,
      recalledMemories,
      availableAgents: planningAgents(routableAgents),
    });
  await runtime.attachPlan(run.id, plan);

  const registry = options.agents ?? await createConfiguredAgentRegistry(agents, {
    dataDirectory,
    workspacePath,
    failureCatalog,
  });
  const result = await runtime.execute(run.id, registry);
  const candidates = result.status === "completed" ? await memory.processNext() : [];
  return {
    ...toQueryResult(runtime, result, candidates.length),
    routing: {
      selectedAgentId: selectedId,
      source: routed.decision.source,
      usedMemoryIds: routed.decision.usedMemoryIds,
    },
  };
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
  const { runtime, memory, failureCatalog, paths } = await createRuntimeAssembly({
    dataDirectory,
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  const workspacePath = paths.workspacePath;
  const run = runtime.getRun(runId);
  if (run.status !== "waiting_approval" || run.activeStepId === undefined) {
    throw new Error(`Run ${runId} is not waiting for an approval.`);
  }

  await runtime.grantApproval(run.id, run.activeStepId, "Approved from the local desktop companion.");
  const registry = options.agents ?? await createConfiguredAgentRegistry((settings?.agents ?? defaultWorkerProfiles()), {
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
