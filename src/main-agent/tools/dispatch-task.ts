/**
 * The `dispatch_task` tool: a model-invocable task that always becomes a
 * governed Run.
 *
 * The Main Agent cannot execute work itself. What it *can* do is ask the
 * Kernel to plan and run a bounded task, then read the result back. That is the
 * same path `propose_work_plan` uses, but the model supplies an objective and
 * acceptance criteria instead of a full plan: the Kernel still builds or
 * validates the plan, applies authority and budgets, and decides completion.
 *
 * 模型可调用的 `dispatch_task` 工具：任务永远变成受治理的 Run。
 *
 * Main Agent 不能自己执行工作。它能做的是请 Kernel 规划并运行一个有边界的任务，然后读回
 * 结果。这与 `propose_work_plan` 是同一条路径，但模型给出的是目标与验收标准，而不是完整
 * 计划：计划仍由 Kernel 生成或校验，权威、预算与完成判定也仍归 Kernel。
 */
import { runQuery } from "../../application/run-query.ts";
import { defaultWorkerProfiles, type CloneSettings } from "../../config/worker-settings.ts";
import type { PlainKernelTool } from "./kernel-tools.ts";
import { Type } from "typebox";

export interface DispatchTaskOptions {
  dataDirectory: string;
  /**
   * The turn's abort signal. A stopped turn must stop the work it dispatched;
   * without this the run outlived the reply.
   * 本回合的 abort 信号。停止的回合必须停掉它派发的工作；没有它，Run 会比回复活得更久。
   */
  signal?: AbortSignal;
  /** The same settings the companion uses; defaults are used when absent. 与 companion 相同的设置；缺省使用默认值。 */
  settings?: CloneSettings;
  /** Resolves the planner's settings lazily, so a settings edit applies to the next call. 惰性解析设置，使设置修改对下一次调用生效。 */
  loadSettings?: () => Promise<CloneSettings>;
  /** Test seam: a scripted registry. 测试切口：脚本化 Registry。 */
  workspacePath?: string;
}

/** A bounded objective the model asks the Kernel to carry out. 模型请 Kernel 执行的有界目标。 */
export interface DispatchTaskInput {
  objective: string;
  acceptanceCriteria: string[];
}

/**
 * Validate what the model sent before it reaches the planning path. The check
 * is deliberately narrow: the Kernel is the authority on plan validity, but a
 * task with no objective or no criterion would waste a planning round.
 * 在进入规划路径前校验模型输入。检查刻意很窄：计划有效性归 Kernel 判定，但没有目标或
 * 验收标准的任务只会浪费一轮规划。
 */
export function validateDispatchTask(input: unknown): { ok: true; task: DispatchTaskInput } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "The task must be an object." };
  const record = input as Record<string, unknown>;
  const objective = typeof record.objective === "string" ? record.objective.trim() : "";
  if (objective.length === 0) return { ok: false, error: "The task needs a non-empty objective." };
  if (objective.length > 4_000) return { ok: false, error: "The objective is too long; keep it under 4,000 characters." };
  const raw = record.acceptanceCriteria;
  const criteria = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0)
    : typeof raw === "string" && raw.trim().length > 0 ? [raw.trim()] : [];
  if (criteria.length === 0) return { ok: false, error: "The task needs at least one acceptance criterion." };
  if (criteria.length > 12) return { ok: false, error: "Keep acceptance criteria to 12 or fewer." };
  return { ok: true, task: { objective, acceptanceCriteria: criteria } };
}

/** The tool the Main Agent calls to start bounded work. 主 Agent 启动有界工作的工具。 */
export function dispatchTaskTool(options: DispatchTaskOptions): PlainKernelTool {
  return {
    name: "dispatch_task",
    label: "Dispatch Task",
    description:
      "Ask the Kernel to plan and run one bounded task. Use this for work that must change files or run an executor; "
      + "answer conversation directly and use propose_work_plan when you already know the exact steps. "
      + "The objective is the outcome, not the method; acceptance criteria are what the Kernel verifies. "
      + "The Kernel owns planning, authority, budgets and completion. Returns runId, final status and a short summary.",
    parameters: Type.Object({
      objective: Type.String({ description: "The outcome the work must achieve, in one or two sentences." }),
      acceptanceCriteria: Type.Array(Type.String(), {
        description: "Checkable criteria the Kernel can verify; at least one.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const validated = validateDispatchTask(params);
      if (!validated.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ accepted: false, error: validated.error }) }], details: {} };
      }
      try {
        const settings = options.settings ?? options.loadSettings === undefined
          ? options.settings
          : await options.loadSettings();
        const result = await runQuery(
          options.dataDirectory,
          validated.task.objective,
          {
            kind: "query",
            payload: {
              source: "main-agent",
              acceptanceCriteria: validated.task.acceptanceCriteria,
            },
          },
          settings ?? { agents: defaultWorkerProfiles() },
          {
            ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              accepted: true,
              runId: result.runId,
              status: result.status,
              ...(result.blocked === undefined ? {} : { blocked: result.blocked }),
              ...(result.routing === undefined ? {} : { routing: result.routing }),
              subagentsCompleted: result.subagentsCompleted,
            }, null, 2),
          }],
          details: {},
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              accepted: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          details: {},
        };
      }
    },
  };
}
