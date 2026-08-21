/**
 * Assigning each step of a plan to a worker that can actually do that step.
 *
 * Routing settles authorization for a task as a whole, but a plan is not one
 * piece of work: "research the API, then write the client, then review it" is
 * three kinds of work, and the worker best suited to research is rarely the one
 * the owner configured for review. Collapsing every step onto a single worker
 * turns a multi-agent plan into a single-agent one and silently discards the
 * roles the owner set up.
 *
 * The authorization invariants still hold, and they are the reason this is not
 * simply "let the planner choose":
 *   - An explicit request from the owner pins every step to that worker. Asking
 *     for a specific worker means the whole task, not a suggestion the planner
 *     may partially honour.
 *   - A planner may only name workers that are enabled, installed and capable.
 *     A model naming an arbitrary id must not become a dispatch.
 *
 * 把计划中的每个步骤指派给真正能做该步骤的 Worker。
 *
 * 路由为整个任务确定授权，但一个计划并不是一份单一的工作："研究 API，然后写客户端，
 * 再评审它"是三种不同的工作，而最适合做研究的 Worker，通常不是所有者为评审配置的那个。
 * 把每个步骤都压到同一个 Worker 上，会把多 Agent 计划变成单 Agent 计划，并悄悄丢弃
 * 所有者设置好的角色分工。
 *
 * 授权不变量依然成立，这也正是本模块不能简化为"让 Planner 自己选"的原因：
 *   - 所有者的显式指定会把每个步骤都钉在那个 Worker 上。指定某个 Worker 意味着整个任务，
 *     而不是一个 Planner 可以部分采纳的建议。
 *   - Planner 只能指派已启用、已安装且具备能力的 Worker。模型随口写出的 ID 不得变成派发。
 */
import type { PlanStep, SubagentWorkOrder } from "../core/contracts.ts";
import type { DispatchDecision, WorkerDescriptor } from "./dispatch-contracts.ts";

export interface StepAssignment {
  stepId: string;
  /** Present for a subagent order inside a step. 步骤内子 Agent 工单时存在。 */
  orderId?: string;
  agentId: string;
  /** Why this worker runs this step, for the dispatch trace. 该 Worker 执行此步骤的原因，用于派发轨迹。 */
  reason: string;
}

export interface PlanRoutingResult {
  plan: { summary: string; steps: PlanStep[] };
  assignments: StepAssignment[];
}

/**
 * Rewrites a plan so every step names an authorized worker suited to it.
 *
 * `decision` is the task-level routing outcome: its worker is the default and,
 * when the owner named it explicitly, the only permitted choice.
 * 重写计划，使每个步骤都指派一个获得授权且适合它的 Worker。
 *
 * `decision` 是任务级路由结果：它选中的 Worker 是默认值；当所有者显式指定时，它也是
 * 唯一被允许的选择。
 */
export function assignWorkersPerStep(
  plan: { summary: string; steps: PlanStep[] },
  decision: DispatchDecision,
  workers: readonly WorkerDescriptor[],
): PlanRoutingResult {
  const assignments: StepAssignment[] = [];
  const eligible = workers.filter((worker) => worker.enabled && worker.installed);
  const byId = new Map(eligible.map((worker) => [worker.id, worker]));
  const fallback = byId.get(decision.selectedAgentId);

  // An explicit request covers the whole task; nothing per-step may override it.
  // 显式指定覆盖整个任务；任何按步骤的选择都不得推翻它。
  const pinned = decision.source === "explicit";

  const resolve = (
    stepId: string,
    orderId: string | undefined,
    requested: string | undefined,
    capabilities: readonly string[],
  ): { agentId: string; capabilities: readonly string[] } => {
    const record = (agentId: string, reason: string): void => {
      assignments.push({ stepId, ...(orderId === undefined ? {} : { orderId }), agentId, reason });
    };

    if (pinned) {
      record(decision.selectedAgentId, `The owner explicitly requested ${decision.selectedAgentId} for this task.`);
      // The pinned worker's own capabilities replace whatever the plan declared.
      // A template plan declares what the *work* needs ("direct_response"), and
      // the owner's named worker may legitimately not list it; failing dispatch
      // on that would override the owner with a guess made by a template.
      // 被钉住的 Worker 自身能力会取代计划声明的任何能力。模板计划声明的是"工作"所需
      // （如 "direct_response"），而所有者点名的 Worker 完全可能没有列出它；因此而让派发
      // 失败，等于用模板的猜测推翻所有者的决定。
      return { agentId: decision.selectedAgentId, capabilities: pinnedCapabilities(byId.get(decision.selectedAgentId), capabilities) };
    }

    // A planner's choice is honoured only if that worker can be dispatched and
    // covers what the step declares it needs.
    // Planner 的选择只有在该 Worker 可被派发、且覆盖步骤声明的所需能力时才被采纳。
    const candidate = requested === undefined ? undefined : byId.get(requested);
    if (candidate !== undefined && covers(candidate, capabilities)) {
      record(candidate.id, `${candidate.id} was planned for this step and satisfies ${describe(capabilities)}.`);
      return { agentId: candidate.id, capabilities: capabilitiesFor(candidate, capabilities) };
    }

    // Otherwise pick the best authorized worker for this step's capabilities.
    // 否则，按该步骤所需能力挑选最合适的已授权 Worker。
    const best = bestFor(eligible, capabilities);
    if (best !== undefined) {
      const why = requested === undefined
        ? `${best.id} is the best available worker for ${describe(capabilities)}.`
        : `${requested} cannot run this step, so ${best.id} was chosen for ${describe(capabilities)}.`;
      record(best.id, why);
      return { agentId: best.id, capabilities: capabilitiesFor(best, capabilities) };
    }

    // Nothing covers the step. Fall back to the routed worker and let the
    // Kernel refuse at dispatch, where the failure names the missing capability
    // instead of being silently hidden here.
    // 没有 Worker 覆盖该步骤。回退到路由选定的 Worker，由 Kernel 在派发时拒绝——那里的
    // 失败会指明缺失的能力，而不是在这里被悄悄掩盖。
    record(decision.selectedAgentId, `No available worker covers ${describe(capabilities)}; the Kernel will validate ${decision.selectedAgentId}.`);
    return { agentId: decision.selectedAgentId, capabilities: capabilitiesFor(fallback, capabilities) };
  };

  const steps = plan.steps.map((step) => {
    if (step.subagents !== undefined) {
      const subagents: SubagentWorkOrder[] = step.subagents.map((order) => {
        const declared = order.requiredCapabilities ?? [];
        const resolved = resolve(step.id, order.id, order.agentId, declared);
        return { ...order, agentId: resolved.agentId, requiredCapabilities: [...resolved.capabilities] };
      });
      return { ...step, subagents };
    }
    const declared = step.requiredCapabilities ?? [];
    const resolved = resolve(step.id, undefined, step.agentId, declared);
    return { ...step, agentId: resolved.agentId, requiredCapabilities: [...resolved.capabilities] };
  });

  return { plan: { summary: plan.summary, steps }, assignments };
}

/**
 * A step that declares no capabilities inherits the worker's own, so it is
 * dispatchable rather than making a claim the adapter cannot satisfy.
 * 未声明能力的步骤沿用 Worker 自身的能力，使其可被派发，而不是提出 Adapter 无法满足的主张。
 */
/**
 * For an explicitly requested worker, its own capabilities win outright.
 * 对于被显式指定的 Worker，它自身的能力直接胜出。
 */
function pinnedCapabilities(worker: WorkerDescriptor | undefined, declared: readonly string[]): readonly string[] {
  return worker === undefined ? declared : worker.capabilities;
}

function capabilitiesFor(worker: WorkerDescriptor | undefined, declared: readonly string[]): readonly string[] {
  if (declared.length > 0) return declared;
  return worker === undefined ? declared : worker.capabilities;
}

function covers(worker: WorkerDescriptor, capabilities: readonly string[]): boolean {
  return capabilities.every((capability) => worker.capabilities.includes(capability));
}

/**
 * Prefers a worker that covers every declared capability, breaking ties by how
 * specialised it is: a worker whose capabilities are exactly what the step needs
 * is a better match than a broad one that happens to include them.
 * 优先选择覆盖全部声明能力的 Worker，并以专精程度打破平局：能力恰好等于步骤所需的
 * Worker，比恰好包含这些能力的宽泛 Worker 更匹配。
 */
function bestFor(workers: readonly WorkerDescriptor[], capabilities: readonly string[]): WorkerDescriptor | undefined {
  if (capabilities.length === 0) return undefined;
  const covering = workers.filter((worker) => covers(worker, capabilities));
  if (covering.length === 0) return undefined;
  return [...covering].sort((left, right) => (
    left.capabilities.length - right.capabilities.length
    || right.priority - left.priority
    || left.id.localeCompare(right.id)
  ))[0];
}

function describe(capabilities: readonly string[]): string {
  return capabilities.length === 0 ? "this step" : capabilities.join(", ");
}
