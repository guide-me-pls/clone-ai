import type { PlanStep, WorkPlan } from "../core/contracts.ts";

export type FallbackPlan = Pick<WorkPlan, "summary" | "steps">;

const RESEARCH_TERMS = [
  "调研", "研究", "比较", "分析", "推荐", "市场", "资料",
  "审查", "检查", "评估", "审阅", "审计", "优化", "改进", "看一下", "看看", "读取", "阅读", "查阅",
  "research", "compare", "analyze", "analyse", "review", "inspect", "audit", "evaluate", "optimize", "improve", "look at", "check",
];
// A delivery verb or a concrete artifact noun. "给我一个 3D 模型" is delivery
// even though it contains no verb from the original list; routing it to the
// direct responder produces an answer with no files, which is exactly what a
// one-line modelling request must not do.
// 交付动词或具体产物名词。"给我一个 3D 模型"没有原列表里的动词，却是交付请求；把它交给
// direct responder 只会得到一段文字、没有任何文件，这正是一句建模请求最不能接受的结果。
//
// Generic containers are deliberately absent: 项目, 代码, 文件 and 页面 name the
// subject of a review, not a requested output. They used to make "只读审查这个
// 项目的代码" a delivery request with a required artifact.
// 刻意不收录泛化容器词：项目、代码、文件、页面是复核的对象，不是被请求的产出。它们曾让
// "只读审查这个项目的代码"变成带必需产物的交付请求。
// A positive write verb asks for work; a bare artifact noun only names the
// subject. Keeping them apart is what stops "如无法读取则如实报告" (report as
// a verb inside a read-only request) from becoming "write a report".
// 正向写入动词是在请求工作；裸的产物名词只是点名对象。把两者分开，才能避免
// "如无法读取则如实报告"（只读请求里的"报告"动词）变成"写一份报告"。
const POSITIVE_WRITE_VERBS = [
  "写", "整理", "实现", "开发", "重构", "修复", "设计", "准备", "生成", "制作", "做",
  "交付", "输出", "保存", "形成", "产出", "创建",
  "write", "implement", "build", "create", "generate", "produce", "deliver", "save",
];
const ARTIFACT_NOUNS = [
  "计划", "草稿", "报告", "邮件", "建模", "模型", "场景", "动画", "结构图", "渲染", "贴图", "方案",
  "plan", "draft", "model", "modelling", "modeling", "scene", "render", "prototype",
];
// An explicit no-write instruction is a whole-task constraint, not one
// delivery term among many. Without it, "只读取 README，不要修改任何文件"
// contains "项目" and became a draft work order whose required artifact a
// read-only worker cannot produce; the run failed with "Missing required
// artifact".
// 明确的禁止写入指令是整条任务的约束，不是众多交付词之一。没有它，"只读取 README，
// 不要修改任何文件"因为含"项目"被规划成 draft 工作单，而只读 Worker 产不出它要求的
// 工件，Run 以 "Missing required artifact" 失败。
const READ_ONLY_TERMS = [
  "只读", "只读模式", "仅读", "只读取", "只做审查", "只审查", "仅审查", "review only", "read-only", "read only",
  "不要修改", "不修改", "不要改动", "不改动", "不要写入", "不要写", "不写",
  "不要创建", "不创建", "不要运行", "不运行", "不做修改", "不产生副作用",
  "do not modify", "don't modify", "without modifying", "no changes", "do not write", "don't write",
];
const ONLY_READ_TERMS = ["只读取", "仅读取", "只查看", "仅查看", "只翻阅", "只浏览"];
const NO_WRITE_TERMS = ["不要修改", "不修改", "不要改动", "不改动", "不要写", "不写", "no changes", "without modifying", "don't modify", "do not modify"];
// "不要修改现有文件，但把报告写到 out/report.md" still asks for a file. A named
// output target wins over the read-only marker, because the marker is about
// existing files, not about creating the requested output.
// "不要修改现有文件，但把报告写到 out/report.md"仍然要求一个文件。点名输出目标优先于只读
// 标记，因为该标记针对已有文件，而不是禁止创建被请求的产出。
const WRITE_TARGET_TERMS = [
  "写到", "写入", "保存到", "保存在", "保存成", "输出到", "生成文件", "创建文件", "新建文件",
  "write to", "save to", "save as", "output to", "create a file", "create the file",
];
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
  // One enabled executor does the local work; its id is a routing fact, not a
  // role. The external operator, when one exists, is not a local executor.
  // 一个已启用的本地执行者承担工作；它的 ID 是路由事实，不是角色。外部执行者（若存在）
  // 不是本地执行者。
  const executorId = [...enabledAgentIds].find((id) => id !== "external-operator");
  if (executorId === undefined) {
    throw new Error("No enabled executor can run this plan.");
  }
  const hasExternalOperator = enabledAgentIds.has("external-operator");
  const normalized = query.toLocaleLowerCase();
  // A read-only marker is a whole-task constraint, not one delivery term among
  // many. Without this, "只读取 README，不要修改任何文件" contains "项目" and
  // became a draft work order whose required artifact a read-only worker cannot
  // produce; the run failed with "Missing required artifact". A named output
  // target still wins, but a bare delivery verb does not override the marker.
  // 只读标记是整条任务的约束，而不是众多交付词之一。没有它，"只读取 README，不要修改
  // 任何文件"因为含"项目"被规划成 draft 工作单，而只读 Worker 产不出要求的工件，Run 以
  // "Missing required artifact" 失败。点名输出目标仍然优先，但单独的交付动词不能覆盖标记。
  // The no-write clause is removed before looking for delivery verbs: "不要写文件"
  // contains "写", which is a delivery verb everywhere else. Only the clause up to
  // the next comma/period disappears, so a later "但把报告写到…" still counts.
  // 查找交付动词前先去掉禁止写入的分句："不要写文件"含"写"，而"写"在其他地方是交付
  // 动词。只去掉到下一个逗号/句号为止的分句，因此后面的"但把报告写到……"仍然算数。
  const withoutNoWriteClauses = normalized.replace(
    /(?:不(?:要|能)?|禁止|请勿|无需)(?:去)?(?:写|创建|修改|改动|运行|生成|输出)[^，,。；;.!?]*/g,
    "",
  );
  const needsResearch = includesOne(normalized, RESEARCH_TERMS);
  const explicitReadOnly = includesOne(normalized, READ_ONLY_TERMS)
    || (includesOne(normalized, ONLY_READ_TERMS) && includesOne(normalized, NO_WRITE_TERMS));
  const writeTarget = includesOne(withoutNoWriteClauses, WRITE_TARGET_TERMS);
  const namedWriteTarget = WRITE_TARGET_TERMS.some((term) => {
    let index = withoutNoWriteClauses.indexOf(term);
    while (index !== -1) {
      const following = withoutNoWriteClauses.slice(index + term.length);
      if (/^\s*(?:文件\s*)?[：:]?\s*[`"'“‘]?(?:\.{0,2}\/|[a-z]:[\\/]|[^\s，,。；;!?"'`“”‘’]+[\\/]|[^\s，,。；;!?"'`“”‘’]+\.[a-z0-9]+(?:\b|$))/i.test(following)) return true;
      index = withoutNoWriteClauses.indexOf(term, index + term.length);
    }
    return false;
  });
  const positiveWrite = includesOne(withoutNoWriteClauses, POSITIVE_WRITE_VERBS);
  const artifactNoun = includesOne(withoutNoWriteClauses, ARTIFACT_NOUNS);
  // Read-only requests yield only to a named output path; verbs and artifact
  // nouns can describe existing code or files rather than requested delivery.
  // 只读请求仅让位于点名的输出路径；动词和产物名词可能描述已有代码或文件，而非交付请求。
  const deliveryRequested = explicitReadOnly
    ? namedWriteTarget
    : writeTarget || positiveWrite || artifactNoun;
  // A research request with no deliverable is read-only even without an explicit
  // marker: "看一下这个项目的代码，有什么优化空间" asks for an answer, not a file.
  // 没有交付物的研究请求即使没有显式标记也是只读的："看一下这个项目的代码，有什么优化空间"
  // 要的是回答，不是文件。
  const analysisOnly = needsResearch && !deliveryRequested;
  const readOnlyRequest = !deliveryRequested && (explicitReadOnly || analysisOnly);
  const needsDelivery = !readOnlyRequest && (deliveryRequested || needsResearch);
  // "提交" is both an action and a state word ("未提交/已提交的文件"), and a
  // quoted error can contain it without asking for anything. An explicit
  // read-only marker therefore suppresses the ambiguous word unless it names a
  // concrete target ("提交 PR"), while the clear verbs (发送/发布/上传) still
  // count even in a read-only request.
  // "提交"既是动作也是状态词（"未提交/已提交的文件"），引用的报错也可能包含它而并不
  // 请求任何动作。因此显式只读标记会压制这个歧义词，除非它点名了具体目标（"提交 PR"）；
  // 明确的动词（发送/发布/上传）即使在只读请求里仍然算数。
  const needsExternalAction = hasExternalActionCue(normalized, explicitReadOnly);
  const isIrreversible = includesOne(normalized, IRREVERSIBLE_ACTION_TERMS);
  const needsReview = (needsResearch && needsDelivery && query.length >= 38) || (needsExternalAction && needsResearch);
  const request = requestSummary(query);

  const preparationOrders = [];
  if (!readOnlyRequest && needsResearch) {
    preparationOrders.push({
      id: "context",
      agentId: executorId,
      role: "researcher" as const,
      title: "梳理相关上下文",
      objective: `只读查找完成该请求所需的约束、已有信息与待确认事项：${request}`,
      inputs: [{ name: "request", description: "The owner's current request and recalled local context.", required: true }],
      requiredCapabilities: ["research", "filesystem_read"],
      // A read phase reads; it does not write. Its contract must be the
      // evidence a read produces, or verification demands a file the phase
      // cannot legitimately create.
      // 读取阶段只读，不写。它的合同必须是读取能产出的证据，否则验证会索要该阶段无法
      // 合法创建的文件。
      expectedArtifacts: [observationContract("context-note", "A recorded context note: constraints, existing information and open questions observed in the files the worker read.")],
      acceptanceCriteria: ["形成一份可核对的上下文说明"],
      risk: "read_only" as const,
      budget: defaultWorkOrderBudget(),
    });
  }
  if (!readOnlyRequest && needsDelivery) {
    // The worker sees this objective and nothing else of the owner's request
    // (`buildInstructions` prefers `workOrder.objective`), so a generic one
    // turns a concrete task into "prepare something". Carry the request itself.
    // Worker 只看到这个 objective，看不到所有者请求的其余部分（`buildInstructions` 优先使用
    // `workOrder.objective`），因此通用文案会把具体任务变成"准备点什么"。把请求本身带进去。
    preparationOrders.push({
      id: "draft",
      agentId: executorId,
      role: "maker" as const,
      title: needsResearch ? "形成可执行草案" : "准备本地交付物",
      objective: `在本地完成所有者的请求，不产生外部影响：${request}`,
      inputs: [{ name: "request", description: "The owner's request and bounded plan-step instructions.", required: true }],
      requiredCapabilities: ["drafting", "filesystem_read", "filesystem_write"],
      expectedArtifacts: [artifactContract("local-draft", "A reviewable local draft or implementation artifact.", true)],
      acceptanceCriteria: [`完成请求要求的本地交付物：${request}`],
      risk: "reversible_write" as const,
      budget: defaultWorkOrderBudget(),
    });
  }
  if (needsReview && preparationOrders.length > 0) {
    preparationOrders.push({
      id: "review",
      agentId: executorId,
      role: "reviewer" as const,
      title: "复核计划与证据",
      objective: `复核以下请求的准备是否足以支持下一步，并明确保留的不确定性：${request}`,
      inputs: preparationOrders.map((order) => ({
        name: `${order.id}-evidence`,
        description: `Verified evidence from ${order.title}.`,
        sourceWorkOrderId: order.id,
        required: true,
      })),
      requiredCapabilities: ["review"],
      expectedArtifacts: [observationContract("review-note", "A review note on the dependency evidence the worker read. The same worker may run this pass, so it is a second look, not an independent reviewer.")],
      acceptanceCriteria: ["形成一份复核说明"],
      risk: "read_only" as const,
      budget: defaultWorkOrderBudget(),
      dependsOn: preparationOrders.map((order) => order.id),
    });
  }

  const steps: PlanStep[] = [];
  if (readOnlyRequest) {
    // A read-only request gets one read-only executor, never a draft work order:
    // the draft's required artifact is impossible for a read-only worker to
    // produce, and "look at this project" must not fail after a successful read.
    // 只读请求得到一个只读执行者，绝不生成 draft 工作单：只读 Worker 产不出 draft 要求的
    // 工件，"看一下这个项目"不能在成功读取之后以失败告终。
    steps.push({
      id: "read-only-lookup",
      agentId: executorId,
      requiredCapabilities: ["research", "filesystem_read"],
      title: "只读查看并回答",
      instructions: `${query}\n\nThis is a read-only step: read only what the request needs, answer from that evidence, and do not write or modify any file.`,
      risk: "read_only",
      acceptanceCriteria: ["只读取所需内容并给出有依据的回答，不修改任何文件。"],
    });
  } else if (preparationOrders.length > 0) {
    // A preparation group that only reads is a read-only step: it must not
    // hand the researcher write tools, and its observation contracts are the
    // only evidence the Kernel may demand.
    // 只读的准备组就是只读步骤：它不得把写工具交给研究员，观察合同是 Kernel 唯一可以
    // 索要的证据。
    const preparationRisk = preparationOrders.some((order) => order.risk !== "read_only")
      ? "reversible_write"
      : "read_only";
    steps.push({
      id: "prepare",
      title: "在本地准备结果",
      instructions: "根据请求所需的角色准备上下文、草案与复核证据。",
      risk: preparationRisk,
      acceptanceCriteria: ["所有被分配的准备工作都有证据"],
      subagents: preparationOrders,
    });
  } else {
    steps.push({
      id: "direct-response",
      agentId: executorId,
      requiredCapabilities: ["direct_response"],
      title: "直接处理请求",
      instructions: "这个请求不需要拆分或授权外部操作，直接在本地完成。",
      risk: "read_only",
      acceptanceCriteria: ["已生成可核对的直接结果"],
    });
  }

  if (needsExternalAction) {
    if (!hasExternalOperator) {
      throw new Error("外部动作连接器尚未实现，本地 Worker 不能执行这个外部动作。请改成由你确认并手动完成，或把请求改成本地准备（草稿、步骤或检查清单）。");
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
    summary: readOnlyRequest
      ? `One read-only step answers this request without writing files.${needsExternalAction ? " An external step remains separately approval-gated." : ""}`
      : describePlan(preparationOrders.length, needsExternalAction),
    steps,
  }, recalledMemories);
}

/** What the Main Agent assigns a dispatch to do. 主 Agent 为一次派发指定的职责。 */
export type DispatchResponsibility = "read" | "write";

/**
 * A dispatched task whose responsibility the Main Agent declared explicitly.
 *
 * The Main Agent knows whether the owner asked for investigation or for work
 * that changes files; inferring that again from keywords is how "优化一下"
 * became a read-only run whose acceptance criteria were the planner's canned
 * prose. The Kernel still validates the resulting step: risk floor, write
 * scopes, authority, protected paths and completion.
 *
 * 主 Agent 显式声明职责的派发任务。
 *
 * 主 Agent 知道所有者要的是调查，还是会改动文件的工作；再用关键词猜一次，正是
 * "优化一下"变成只读 Run、验收标准变成 Planner 固定文案的原因。Kernel 仍校验生成的
 * 步骤：风险下限、写 Scope、权限、受保护路径与完成判定。
 */
export function buildResponsibilityPlan(input: {
  query: string;
  responsibility: DispatchResponsibility;
  /** The routed executor. It is the only worker today. 路由选定的执行者；今天是唯一的 Worker。 */
  executorId: string;
  /** The Main Agent's own criteria, which become the step's criteria. 主 Agent 自己写的标准，成为步骤标准。 */
  acceptanceCriteria?: readonly string[];
}): FallbackPlan {
  const request = requestSummary(input.query);
  const criteria = (input.acceptanceCriteria ?? [])
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0)
    .slice(0, 12);

  if (input.responsibility === "read") {
    return {
      summary: "One read-only step answers this request without writing files.",
      steps: [{
        id: "read-only-lookup",
        agentId: input.executorId,
        requiredCapabilities: ["research", "filesystem_read"],
        title: "只读查看并回答",
        instructions: `${input.query}\n\nThis is a read-only step: read only what the request needs, answer from that evidence, and do not write or modify any file.`,
        risk: "read_only",
        acceptanceCriteria: criteria.length > 0 ? criteria : ["只读取所需内容并给出有依据的回答，不修改任何文件。"],
      }],
    };
  }

  const stepCriteria = criteria.length > 0 ? criteria : [`完成请求要求的本地交付物：${request}`];
  return {
    summary: "One local write step carries out this request; writes stay inside the step's scopes.",
    steps: [{
      id: "local-delivery",
      title: "在本地完成请求",
      instructions: `${input.query}\n\nThis is a local write step: create or change only the files the brief names, and do not touch any external system.`,
      risk: "reversible_write",
      acceptanceCriteria: stepCriteria,
      // A write task must produce a write. Without this contract a task that
      // only read and answered could complete with an observation and tell the
      // owner the work was done; the artifact is the proof the Kernel can check.
      // 写任务必须真的写出东西。没有这份合同，只读并回答的任务可以凭一条观察完成，
      // 让所有者以为工作已完成；产物才是 Kernel 能检查的证明。
      subagents: [{
        id: "deliver",
        agentId: input.executorId,
        role: "maker" as const,
        title: "完成本地交付",
        objective: request,
        inputs: [{ name: "request", description: "The owner's request and the step's brief.", required: true }],
        requiredCapabilities: ["drafting", "filesystem_read", "filesystem_write"],
        expectedArtifacts: [artifactContract("local-delivery", "A durable file the worker created or changed.", true)],
        acceptanceCriteria: stepCriteria,
        risk: "reversible_write" as const,
        budget: defaultWorkOrderBudget(),
      }],
    }],
  };
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

const defaultAgentIds = ["worker"];

/**
 * The owner's own words, trimmed to a size that fits an objective.
 *
 * The objective is what the worker reads, so it must be the request, not a
 * description of the role. Very long briefs are cut at a sentence boundary and
 * marked as truncated rather than silently shortened.
 *
 * 所有者自己的话，裁到能放进 objective 的长度。
 *
 * Worker 读到的就是 objective，因此它必须是请求本身，而不是对角色功能的描述。过长的简报在
 * 句子边界处截断，并明确标注被截断，而不是静默缩短。
 */
function requestSummary(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, " ");
  const limit = 1_200;
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, limit);
  const boundary = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf(". "), cut.lastIndexOf("；"), cut.lastIndexOf("; "));
  return `${cut.slice(0, boundary > limit * 0.6 ? boundary + 1 : limit).trim()} …(request truncated; see the step instructions)`;
}

function includesOne(query: string, terms: string[]): boolean {
  return terms.some((term) => query.includes(term));
}

/**
 * Whether the request asks for an external side effect. `提交` is special: it
 * is also the state word in "未提交/已提交的文件", and a quoted error can
 * contain it without asking for anything. Only a clear action (not preceded by
 * a state marker and not followed by a state noun), or a named target under an
 * explicit read-only marker, counts.
 * 请求是否要求外部副作用。`提交`要特别处理：它也是"未提交/已提交的文件"里的状态词，引用
 * 的报错也可能包含它而并不请求任何动作。只有明确的动作（前面不是状态标记、后面不是状态
 * 名词），或在显式只读标记下点名了具体目标，才算数。
 */
function hasExternalActionCue(query: string, readOnly: boolean): boolean {
  for (const term of EXTERNAL_ACTION_TERMS) {
    if (term !== "提交") {
      if (query.includes(term)) return true;
      continue;
    }
    if (readOnly) {
      // Under an explicit read-only marker, only a named submission target is
      // an action; a quoted error that merely contains the word is not.
      // 在显式只读标记下，只有点名了提交目标才算动作；仅仅包含这个词的引用报错不算。
      if (/(?<![未已不没勿别])提交\s*(?:pr|pull request|表单|申请|工单|报告|代码|改动|变更)/.test(query)) return true;
      continue;
    }
    // Outside a read-only request, a state phrase ("未提交的文件") is still not
    // an action; an imperative "提交" (optionally with a target) is.
    // 非只读请求里，状态短语（"未提交的文件"）仍然不是动作；祈使的"提交"（可带目标）才是。
    if (/(?<![未已不没勿别])提交(?!的?(?:文件|改动|代码|变更|内容|版本|记录|状态))/.test(query)) return true;
  }
  return false;
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

/**
 * The contract a read-only worker can actually satisfy. A read produces an
 * observation with the file path as its locator; demanding an artifact here
 * would make every researcher or reviewer fail after a successful read.
 * 只读 Worker 真正能满足的合同。读取产生以文件路径为 locator 的观察；在这里索要产物，
 * 会让每个研究员或复核员在成功读取之后失败。
 */
function observationContract(id: string, description: string) {
  return {
    id,
    kind: "observation" as const,
    description,
    required: true,
    locatorRequired: true,
  };
}

function defaultWorkOrderBudget() {
  return {
    // Rounds are not capped: the model decides when to stop. Duration and tool
    // calls still bound the cost of one work order.
    // 轮次不设上限：由模型决定何时停下。时长与工具调用次数仍然约束单个工作单的成本。
    maxDurationMs: 10 * 60_000,
    maxToolCalls: 200,
    maxAttempts: 2,
  };
}

/**
 * True when the deterministic planner classifies the request as a read-only
 * lookup. The LLM planner's own contract requires a required artifact for every
 * subagent, so it cannot express a request that forbids writing; this is the
 * deterministic plan's own verdict, not a second heuristic.
 * 当确定性规划器把请求归类为只读查看时为真。LLM Planner 自己的合同要求每个子代理都有
 * 必需产物，因此无法表达禁止写入的请求；这里直接采用确定性计划自己的判定，而不是第二套
 * 启发式。
 */
export function isReadOnlyRequest(query: string): boolean {
  const plan = buildFallbackPlan(query, new Set(["worker"]));
  return plan.steps.length === 1 && plan.steps[0]?.id === "read-only-lookup";
}
