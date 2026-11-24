/**
 * Main-Agent-authored worker briefs: one place that bounds them and decides
 * which execution slot receives them.
 *
 * The brief is task content, not authority. The Kernel still gates every tool
 * call; this module only makes sure the Main Agent's text reaches exactly one
 * executor and cannot grow without a stated limit.
 *
 * 主 Agent 编写的 Worker 简报：在一个地方限定长度，并决定它落到哪个执行槽位。
 *
 * 简报是任务内容，不是权限。每次工具调用仍由 Kernel 放行；本模块只保证主 Agent 的文本
 * 恰好到达一个执行者，并且不会无上限地增长。
 */
import type { PlanStep } from "../core/contracts.ts";

/** Hard upper bound for one worker brief. 单份 Worker 简报的硬上限。 */
export const WORKER_BRIEF_MAX_CHARS = 16_000;

/**
 * Trim a brief and enforce the bound. An empty or non-string value means "no
 * brief", which keeps the previous template in place.
 *
 * 去掉首尾空白并施加上限。空值或非字符串表示"没有简报"，此时沿用原来的模板。
 */
export function normalizeWorkerBrief(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > WORKER_BRIEF_MAX_CHARS) {
    throw new Error(`A worker brief must be at most ${WORKER_BRIEF_MAX_CHARS.toLocaleString("en-US")} characters.`);
  }
  return trimmed;
}

/**
 * Put the Main Agent's brief on the plan's primary execution step or work
 * order.
 *
 * A `dispatch_task` brief describes the task, not each step of a multi-step
 * plan. The primary execution is the maker or write-capable order, because
 * that is the executor the brief's paths and evidence belong to; a read-only
 * researcher must not receive a brief that tells it to write. Without a
 * write-capable order, the first step that supervises orders; without orders,
 * the first step. Per-step briefs belong to `propose_work_plan`, where the
 * Main Agent writes the plan itself.
 *
 * 把主 Agent 的简报放到计划的主执行步骤或工作单上。
 *
 * `dispatch_task` 的简报描述的是任务，而不是多步计划里的每一步。主执行是 maker 或
 * 具备写能力的工作单，因为简报里的路径与证据属于它；只读研究员不该收到让它写入的简报。
 * 没有写能力工作单时，取第一个带工作单的步骤；再没有则取第一步。按步骤分别写简报属于
 * `propose_work_plan`——在那里计划本身就是主 Agent 写的。
 */
export function attachMainAgentBrief(steps: readonly PlanStep[], brief: string | undefined): PlanStep[] {
  const normalized = normalizeWorkerBrief(brief);
  if (normalized === undefined) return [...steps];
  const stepIndex = primaryStepIndex(steps);
  return steps.map((step, index) => {
    if (index !== stepIndex) return step;
    const orders = step.subagents;
    if (orders === undefined || orders.length === 0) return { ...step, workerBrief: normalized };
    const orderIndex = primaryOrderIndex(orders);
    return {
      ...step,
      subagents: orders.map((order, current) => (current === orderIndex ? { ...order, workerBrief: normalized } : order)),
    };
  });
}

function primaryStepIndex(steps: readonly PlanStep[]): number {
  // A maker/write-capable order is the executor the brief describes.
  // 具备 maker/写入能力的工作单就是简报所描述的执行者。
  const withMaker = steps.findIndex((step) => (step.subagents ?? []).some(isWriteOrder));
  if (withMaker >= 0) return withMaker;
  // A single write-capable executor is the same case without orders.
  // 单个具备写入能力的执行者是同一情形，只是没有工作单。
  const writeStep = steps.findIndex((step) => step.subagents === undefined && isWriteStep(step));
  if (writeStep >= 0) return writeStep;
  const withOrders = steps.findIndex((step) => step.subagents !== undefined && step.subagents.length > 0);
  return withOrders >= 0 ? withOrders : 0;
}

function primaryOrderIndex(orders: readonly { id: string; role?: string; risk?: string; requiredCapabilities?: readonly string[] }[]): number {
  const maker = orders.findIndex((order) => isWriteOrder(order));
  if (maker >= 0) return maker;
  const draft = orders.findIndex((order) => order.id === "draft");
  return draft >= 0 ? draft : 0;
}

function isWriteOrder(order: { role?: string; risk?: string; requiredCapabilities?: readonly string[] }): boolean {
  if (order.role === "maker") return true;
  if (order.risk === "reversible_write" || order.risk === "external_side_effect" || order.risk === "irreversible") return true;
  return (order.requiredCapabilities ?? []).some((capability) => /write|draft/i.test(capability));
}

function isWriteStep(step: PlanStep): boolean {
  if (step.risk === "reversible_write" || step.risk === "external_side_effect" || step.risk === "irreversible") return true;
  return (step.requiredCapabilities ?? []).some((capability) => /write|draft/i.test(capability));
}
