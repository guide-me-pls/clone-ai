import type { PlanStep, WorkPlan } from "../core/contracts.ts";

export type FallbackPlan = Pick<WorkPlan, "summary" | "steps">;

const RESEARCH_TERMS = ["调研", "研究", "比较", "分析", "方案", "推荐", "市场", "资料", "资料", "research", "compare", "analyze"];
const DELIVERY_TERMS = ["计划", "草稿", "写", "整理", "实现", "开发", "代码", "设计", "准备", "报告", "邮件", "plan", "draft", "build", "implement", "write"];
const EXTERNAL_ACTION_TERMS = ["发送", "发给", "发布", "提交", "上传", "预订", "购买", "支付", "邀请", "创建日程", "send", "publish", "submit", "upload", "book", "buy", "pay"];
const IRREVERSIBLE_ACTION_TERMS = ["删除", "清空", "付款", "支付", "购买", "下单", "delete", "remove", "pay", "buy", "purchase"];

/**
 * This is a transparent local planning policy, not a pretend
 * LLM planner. It deliberately varies the work graph based on the request:
 * direct questions stay direct, preparation work gets only the roles it
 * needs, and external actions remain a separately approved step.
 *
 * 这是透明的本地规划策略，不是假装成 LLM Planner。它会依据请求
 * 调整任务图：直接问题保持直接处理；准备型任务只分配必要角色；外部动作始终
 * 保持为单独审批的步骤。
 */
export function buildFallbackPlan(
  query: string,
  enabledAgentIds: ReadonlySet<string> = new Set(defaultAgentIds),
  recalledMemories: readonly string[] = [],
): FallbackPlan {
  const normalized = query.toLocaleLowerCase();
  const needsResearch = includesOne(normalized, RESEARCH_TERMS);
  const needsDelivery = includesOne(normalized, DELIVERY_TERMS) || needsResearch;
  const needsExternalAction = includesOne(normalized, EXTERNAL_ACTION_TERMS);
  const isIrreversible = includesOne(normalized, IRREVERSIBLE_ACTION_TERMS);
  const needsReview = (needsResearch && needsDelivery && query.length >= 38) || (needsExternalAction && needsResearch);

  const preparationOrders = [];
  if (needsResearch && enabledAgentIds.has("context-researcher")) {
    preparationOrders.push({
      id: "context",
      agentId: "context-researcher",
      role: "researcher" as const,
      title: "梳理相关上下文",
      objective: "找出请求涉及的约束、已有信息和待确认事项。",
      inputs: [{ name: "request", description: "The owner's current request and recalled local context.", required: true }],
      requiredCapabilities: ["research", "filesystem_read"],
      expectedArtifacts: [artifactContract("context-note", "A durable context note with sources and uncertainty.")],
      acceptanceCriteria: ["形成一份可核对的上下文说明"],
      risk: "read_only" as const,
      budget: defaultWorkOrderBudget(),
    });
  }
  if (needsDelivery && enabledAgentIds.has("draft-maker")) {
    preparationOrders.push({
      id: "draft",
      agentId: "draft-maker",
      role: "maker" as const,
      title: needsResearch ? "形成可执行草案" : "准备本地交付物",
      objective: "只在本地准备可修改、可回退的结果，不产生外部影响。",
      inputs: [{ name: "request", description: "The owner's request and bounded plan-step instructions.", required: true }],
      requiredCapabilities: ["drafting", "filesystem_read", "filesystem_write"],
      expectedArtifacts: [artifactContract("local-draft", "A reviewable local draft or implementation artifact.", true)],
      acceptanceCriteria: ["形成一份可复核的本地交付物"],
      risk: "reversible_write" as const,
      budget: defaultWorkOrderBudget(),
    });
  }
  if (needsReview && preparationOrders.length > 0 && enabledAgentIds.has("evidence-reviewer")) {
    preparationOrders.push({
      id: "review",
      agentId: "evidence-reviewer",
      role: "reviewer" as const,
      title: "复核计划与证据",
      objective: "检查现有准备是否足以支持下一步，并明确保留的不确定性。",
      inputs: preparationOrders.map((order) => ({
        name: `${order.id}-evidence`,
        description: `Verified evidence from ${order.title}.`,
        sourceWorkOrderId: order.id,
        required: true,
      })),
      requiredCapabilities: ["review"],
      expectedArtifacts: [artifactContract("review-note", "An independent review of dependency evidence.")],
      acceptanceCriteria: ["形成一份复核说明"],
      risk: "read_only" as const,
      budget: defaultWorkOrderBudget(),
      dependsOn: preparationOrders.map((order) => order.id),
    });
  }

  const steps: PlanStep[] = [];
  if (preparationOrders.length > 0) {
    steps.push({
      id: "prepare",
      title: "在本地准备结果",
      instructions: "根据请求所需的角色准备上下文、草案与复核证据。",
      risk: "reversible_write",
      acceptanceCriteria: ["所有被分配的准备工作都有证据"],
      subagents: preparationOrders,
    });
  } else {
    steps.push({
      id: "direct-response",
      agentId: "direct-responder",
      requiredCapabilities: ["direct_response"],
      title: "直接处理请求",
      instructions: "这个请求不需要拆分或授权外部操作，直接在本地完成。",
      risk: "read_only",
      acceptanceCriteria: ["已生成可核对的直接结果"],
    });
  }

  if (needsExternalAction) {
    if (!enabledAgentIds.has("external-operator")) {
      throw new Error("外部执行 Agent 已关闭。请先在设置中启用它，再提交这个外部动作。");
    }
    steps.push({
      id: "external-commitment",
      agentId: "external-operator",
      requiredCapabilities: ["external_action"],
      title: isIrreversible ? "执行不可逆外部操作" : "执行外部操作",
      instructions: "仅在用户确认这一个具体步骤后才允许影响外部系统。",
      risk: isIrreversible ? "irreversible" : "external_side_effect",
      acceptanceCriteria: ["保留外部操作的回执"],
    });
  }

  return applyMemoryContext({
    summary: describePlan(preparationOrders.length, needsExternalAction),
    steps,
  }, recalledMemories);
}

function applyMemoryContext(plan: FallbackPlan, recalledMemories: readonly string[]): FallbackPlan {
  if (recalledMemories.length === 0) return plan;
  const context = ` Owner-approved local memory for this work: ${recalledMemories.join(" | ")}`;
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      instructions: `${step.instructions}${context}`,
      subagents: step.subagents?.map((order) => ({ ...order, objective: `${order.objective}${context}` })),
    })),
  };
}

const defaultAgentIds = ["direct-responder", "context-researcher", "draft-maker", "evidence-reviewer", "external-operator"];

function includesOne(query: string, terms: string[]): boolean {
  return terms.some((term) => query.includes(term));
}

function describePlan(workerCount: number, needsExternalAction: boolean): string {
  if (workerCount === 0) {
    return "The request can be handled directly with no child-agent delegation.";
  }
  const approval = needsExternalAction ? " An external step remains separately approval-gated." : "";
  return `Use ${workerCount} bounded preparation role${workerCount === 1 ? "" : "s"} chosen for this request.${approval}`;
}

function artifactContract(id: string, description: string, locatorRequired = false) {
  return {
    id,
    kind: "artifact" as const,
    description,
    required: true,
    locatorRequired,
  };
}

function defaultWorkOrderBudget() {
  return {
    maxDurationMs: 10 * 60_000,
    maxModelCalls: 20,
    maxToolCalls: 100,
    maxAttempts: 2,
  };
}
