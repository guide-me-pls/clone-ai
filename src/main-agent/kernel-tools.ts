/**
 * clone-main 提案型工具：Main Agent 只能"提案"，Kernel 校验后才生效。
 *
 * The Main Agent is the brain, never the authority. Every tool below lands on
 * an existing Kernel validation path (CloneRuntime.attachPlan / policy /
 * memory / state projection). The agent can propose, recall, and inspect; it
 * cannot self-certify completion, grant approval, or mutate durable state
 * outside the Kernel's rules.
 */
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { PlanStep } from "../core/contracts.ts";
import type { CloneRuntime } from "../core/runtime.ts";
import { createRuntimeAssembly } from "../core/runtime-factory.ts";
import { resolveClonePaths } from "../config/clone-home.ts";
import { LocalMemoryStore } from "../memory/memory-store.ts";

export interface KernelToolsOptions {
  dataDirectory: string;
}

export interface PlanProposalResult {
  accepted: boolean;
  runId?: string;
  planId?: string;
  runStatus?: string;
  error?: string;
}

/**
 * Build the Kernel runtime exactly like the query workflow does. The journal
 * backend (JSONL default, CLONE_AI_JOURNAL=sqlite for WAL) sits behind the
 * same seam. 与 Query 工作流相同方式构建 Kernel Runtime；Journal 后端（默认 JSONL，
 * CLONE_AI_JOURNAL=sqlite 启用 WAL）位于同一 seam 之后。
 */
export async function createKernelRuntime(dataDirectory: string): Promise<CloneRuntime> {
  // The Main Agent must see exactly the Kernel the daemon and the Query
  // workflow see; a second assembly here would let its view of runs, memory,
  // and recovery drift from the authority it is supposed to be proposing to.
  // Main Agent 必须看到与 Daemon、Query 工作流完全相同的 Kernel；在这里另建一套组装，
  // 会让它对 Run、记忆和恢复的视图偏离它本应提案的那个权威。
  const { runtime } = await createRuntimeAssembly({ dataDirectory });
  return runtime;
}

/**
 * The Kernel validation path shared by the tool and the tests: a proposal
 * creates a durable Run, then attachPlan() validates the steps. A rejected
 * proposal fails its own run so nothing lingers as if it were still planning,
 * and the feedback lets the agent fix and re-propose under a fresh run.
 * 工具与测试共用的 Kernel 校验路径：提案先建 Run，再由 attachPlan() 校验步骤。
 * 被拒绝的提案会关闭自己的 Run，不让它伪装成仍在规划中；反馈让 Agent 修正后
 * 以新 Run 重新提案。
 */
export async function proposePlanToKernel(
  runtime: CloneRuntime,
  input: { summary: string; steps: unknown },
): Promise<PlanProposalResult> {
  const { run } = await runtime.acceptTrigger({
    kind: "query",
    summary: input.summary,
    payload: { source: "main-agent" },
  });
  try {
    const plan = await runtime.attachPlan(run.id, {
      summary: input.summary,
      steps: input.steps as PlanStep[], // compile-time assertion; the Kernel is the runtime authority
    });
    const current = runtime.getRun(run.id);
    return { accepted: true, runId: run.id, planId: plan.id, runStatus: current.status };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await runtime.failRun(run.id, `Plan proposal rejected: ${reason}`);
    return {
      accepted: false,
      runId: run.id,
      runStatus: runtime.getRun(run.id).status,
      error: reason,
    };
  }
}

/** Read-only: report the approval state of a run. The Main Agent can never grant. 只读：报告 Run 的审批状态；Main Agent 永远不能批准。 */
export async function requestApprovalInfo(runtime: CloneRuntime, runId: string): Promise<string> {
  let run;
  try {
    run = runtime.getRun(runId);
  } catch {
    return `Run ${runId} not found.`;
  }
  if (run.status === "waiting_approval") {
    return [
      `Run ${run.id} is waiting for approval on step ${run.activeStepId ?? "?"}.`,
      "The owner must approve it through the companion or CLI; the Main Agent cannot approve its own work.",
    ].join("\n");
  }
  return `Run ${run.id} status: ${run.status}${run.activeStepId === undefined ? "" : `, active step: ${run.activeStepId}`}.`;
}

/** Read-only: lexical recall over the local memory store. 只读：本地记忆库的词法召回。 */
export async function recallMemories(dataDirectory: string, query: string, runId = "main-agent"): Promise<string> {
  const store = new LocalMemoryStore(resolveClonePaths({ dataDirectory }).memoryFile);
  const matches = await store.recall(query, runId);
  if (matches.length === 0) return "No matching memories.";
  return matches.map((match) => `[${match.score.toFixed(2)}] ${match.memory.summary}`).join("\n");
}

/** Read-only: summarize a run from the Kernel projection. 只读：从 Kernel 投影汇总 Run 状态。 */
export async function runStatusInfo(runtime: CloneRuntime, runId: string): Promise<string> {
  let run;
  try {
    run = runtime.getRun(runId);
  } catch {
    return `Run ${runId} not found.`;
  }
  const subagents = runtime.getSubagentsForRun(runId);
  const completed = subagents.filter((item) => item.status === "completed").length;
  return [
    `Run ${run.id}: ${run.status}`,
    `Task: ${run.taskId}`,
    ...(run.planId === undefined ? [] : [`Plan: ${run.planId}`]),
    ...(run.activeStepId === undefined ? [] : [`Active step: ${run.activeStepId}`]),
    `Subagents: ${completed}/${subagents.length} completed`,
  ].join("\n");
}

/**
 * Extension factory: registers the four proposal-only tools for clone-main.
 * The Pi agent loop drives the conversation; every tool call ends at the
 * Kernel paths above.
 * 扩展工厂：为 clone-main 注册四个提案型工具。Pi 的 agent loop 驱动对话，
 * 每个工具调用最终都落在上面的 Kernel 路径。
 */
export function createKernelToolsExtension(pi: ExtensionAPI, options: KernelToolsOptions): void {
  let runtimePromise: Promise<CloneRuntime> | undefined;
  const kernel = (): Promise<CloneRuntime> => (runtimePromise ??= createKernelRuntime(options.dataDirectory));

  pi.registerTool({
    name: "propose_work_plan",
    label: "Propose Work Plan",
    description:
      "Propose a durable work plan to the Kernel (summary + 1..8 steps). "
      + "The Kernel validates it; when accepted, a Run and WorkPlan are journaled and you receive runId/planId. "
      + "Invalid proposals return a rejection with feedback so you can fix and re-propose. "
      + "Each step needs id, title, instructions, risk (read_only | reversible_write | external_side_effect | irreversible), "
      + "acceptanceCriteria (string[]), and either agentId+requiredCapabilities or a subagents group.",
    parameters: Type.Object({
      summary: Type.String({ description: "One-sentence summary of the plan." }),
      steps: Type.Array(Type.Any(), {
        description: "Plan steps as described above; the Kernel is the authority on validity.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const runtime = await kernel();
      const result = await proposePlanToKernel(runtime, { summary: params.summary, steps: params.steps });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
    },
  });

  pi.registerTool({
    name: "request_approval",
    label: "Request Approval",
    description:
      "Check the approval state of a run. If it is waiting for approval, report what the owner must do. "
      + "This tool never grants approval.",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id returned by propose_work_plan." }),
    }),
    execute: async (_toolCallId, params) => {
      const runtime = await kernel();
      const text = await requestApprovalInfo(runtime, params.runId);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "recall_memory",
    label: "Recall Memory",
    description:
      "Recall relevant reviewed memories for a query. Read-only; the owner governs promotion of new memories.",
    parameters: Type.Object({
      query: Type.String({ description: "Text to match against reviewed memories." }),
      runId: Type.Optional(Type.String({ description: "Run id for audit; defaults to main-agent." })),
    }),
    execute: async (_toolCallId, params) => {
      const text = await recallMemories(options.dataDirectory, params.query, params.runId);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "get_run_status",
    label: "Get Run Status",
    description:
      "Summarize the Kernel projection of a run: status, plan, active step, subagent completion. Read-only.",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id returned by propose_work_plan." }),
    }),
    execute: async (_toolCallId, params) => {
      const runtime = await kernel();
      const text = await runStatusInfo(runtime, params.runId);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
