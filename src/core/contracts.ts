/**
 * A Run may start from an owner query or from a governed non-query source.
 * A signal can request planning; it never grants execution authority itself.
 *
 * Run 既可以由用户 Query 发起，也可以由受治理的非 Query 来源发起。Signal 只能请求规划，
 * 绝不会自行授予执行权限。
 */
import type { Scope } from "../authority/scope.ts";
import type { FailureReport, OutcomeCatalog } from "./failure-analysis.ts";

export type TriggerKind = "query" | "schedule" | "signal" | "manual";

export type RunStatus =
  | "created"
  | "planning"
  | "queued"
  | "running"
  | "waiting_approval"
  | "verifying"
  | "waiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type RiskClass =
  | "read_only"
  | "reversible_write"
  | "external_side_effect"
  | "irreversible";

export interface Trigger {
  id: string;
  kind: TriggerKind;
  occurredAt: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface Task {
  id: string;
  triggerId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  createdAt: string;
}

export interface PlanStep {
  id: string;
  title: string;
  instructions: string;
  risk: RiskClass;
  acceptanceCriteria: string[];
  /**
   * A single bounded executor for this step. Mutually exclusive with subagents.
   * 该步骤的单个有边界执行者；不能与 subagents 同时存在。
   */
  agentId?: string;
  /**
   * Required when agentId is present; the Runtime checks it before execution.
   * 指定 agentId 时必须提供；Runtime 会在执行前检查。
   */
  requiredCapabilities?: string[];
  /**
   * Work orders supervised by this step. They may run in dependency-aware waves.
   * 由该步骤监督的工作单；可按依赖关系分批执行。
   */
  subagents?: SubagentWorkOrder[];
  /**
   * What the step wants to touch beyond its workspace: machine-wide scopes the
   * Authority policy intersects with the owner's standing grants. Absent means
   * the step stays inside the workspace and only the risk class applies.
   * 步骤在工作空间之外想触碰的东西：整机范围的 Scope，由 Authority 策略与所有者的常设授权
   * 求交。缺省表示步骤只在工作空间内，仅适用风险等级。
   */
  scopes?: Scope[];
}

export interface WorkOrderInput {
  /**
   * Stable name used when building the bounded agent prompt.
   * 构建有边界 Agent Prompt 时使用的稳定名称。
   */
  name: string;
  description: string;
  /**
   * When present, the Runtime injects evidence produced by this dependency.
   * 存在时，Runtime 会注入该依赖产生的 Evidence。
   */
  sourceWorkOrderId?: string;
  required: boolean;
}

export interface ArtifactContract {
  id: string;
  kind: Evidence["kind"];
  description: string;
  required: boolean;
  /**
   * Receipts and files generally need a durable location, not only prose.
   * Receipt 和文件通常需要一个持久定位地址，不能只有文字说明。
   */
  locatorRequired?: boolean;
}

export interface WorkOrderBudget {
  maxDurationMs: number;
  maxAttempts: number;
  /**
   * Enforced where the adapter reports model and tool activity: the Kernel
   * counts `tool_started`/`tool_completed` and, when the adapter declares it,
   * `model_call` events, and fails the step past the ceiling. A black-box CLI
   * cannot count what it does not report, so for those workers the ceiling is
   * still only a declaration — the duration budget is what stops them.
   * 在 Adapter 报告模型与工具活动处执行：Kernel 统计 `tool_started`/`tool_completed`，并在
   * Adapter 声明时统计 `model_call` 事件，超过上限即判该步骤失败。黑盒 CLI 无法报告自己
   * 没暴露的东西，因此对它们这两个上限仍只是声明——真正能停住它们的是时长预算。
   */
  maxModelCalls?: number;
  maxToolCalls?: number;
}

/**
 * A work order is deliberately smaller than a task. It has no authority over
 * personal state, policy, or the final outcome. It is an executable contract:
 * an agent receives bounded inputs and authority, then returns named artifacts
 * and evidence that the supervisor verifies.
 *
 * WorkOrder 被刻意设计得比 Task 更小。它无权修改个人状态、Policy 或最终结果；它是一份
 * 可执行合同：Agent 只获得有边界的输入与权限，返回具名的 Artifact 和 Evidence，再由
 * Supervisor 验收。
 */
export interface SubagentWorkOrder {
  id: string;
  /**
   * Optional routing preference. The dispatcher still checks capabilities.
   * 可选的路由偏好；Dispatcher 仍然必须检查能力。
   */
  agentId?: string;
  role: "researcher" | "maker" | "reviewer" | "custom";
  title: string;
  objective: string;
  inputs: WorkOrderInput[];
  requiredCapabilities: string[];
  expectedArtifacts: ArtifactContract[];
  acceptanceCriteria: string[];
  risk: RiskClass;
  budget: WorkOrderBudget;
  dependsOn?: string[];
}

export interface WorkPlan {
  id: string;
  runId: string;
  summary: string;
  steps: PlanStep[];
  createdAt: string;
  /**
   * The commitment this plan exists to satisfy, when the work was raised from
   * the owner's stated obligations rather than a fresh request. This is the
   * linkage the reconcile loop reads: when the run completes and verifies, the
   * commitment is settled (marked met, or advanced to its next occurrence) —
   * without it, "every Friday" happens exactly once and never again.
   * 本计划所要满足的承诺（当工作源自所有者声明过的义务而非新请求时）。这是收敛环读取
   * 的联动关系：Run 完成并验证后，承诺被结算（标记 met，或推进到下一次）——没有它，
   * “每周五”只发生一次，再也不会有第二次。
   */
  servesCommitmentId?: string;
}

export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  planId?: string;
  activeStepId?: string;
  /** Last recorded failure reason, when the run stopped before completion. 未完成时记录的最后失败原因。 */
  failureReason?: string;
}

export interface ApprovalGrant {
  id: string;
  runId: string;
  stepId: string;
  grantedAt: string;
  grantedBy: "user" | "standing_policy";
  note?: string;
}

export interface Evidence {
  id: string;
  runId: string;
  stepId: string;
  /**
   * Present when the evidence came from a child-agent work order.
   * Evidence 来自子 Agent WorkOrder 时才存在。
   */
  workOrderId?: string;
  producedBy?: string;
  kind: "artifact" | "tool_result" | "receipt" | "test" | "observation";
  summary: string;
  locator?: string;
  createdAt: string;
}

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentRun {
  id: string;
  runId: string;
  stepId: string;
  workOrderId: string;
  agentId: string;
  /**
   * Concrete provider pinned when the work order first starts.
   * WorkOrder 第一次启动时固定下来的具体 Provider。
   */
  providerId?: string;
  sessionId?: string;
  /** Trusted adapter attestation; absence means interrupted work cannot be replayed safely. 可信 Adapter 对重放安全的声明；缺省时中断后不得安全重跑。 */
  retrySafeAfterInterruption?: boolean;
  /** Durable pre-dispatch Workspace checkpoint used for black-box recovery. 黑盒恢复所用的派发前持久 Workspace 检查点。 */
  workspaceCheckpoint?: string;
  workspacePath?: string;
  attempt: number;
  role: SubagentWorkOrder["role"];
  title: string;
  status: SubagentStatus;
  startedAt: string;
  updatedAt: string;
  summary?: string;
}

export interface SubagentVerificationResult {
  id: string;
  runId: string;
  stepId: string;
  workOrderId: string;
  passed: boolean;
  summary: string;
  checkedEvidenceIds: string[];
  createdAt: string;
}

export interface VerificationResult {
  runId: string;
  passed: boolean;
  needsReview?: boolean;
  unverifiedCriteria?: string[];
  reviewedBy?: "owner";
  summary: string;
  checkedEvidenceIds: string[];
  createdAt: string;
}

export type MemoryType = "fact" | "preference" | "procedure" | "decision" | "commitment";
export type MemorySensitivity = "public" | "private" | "secret";

export interface MemoryCandidate {
  id: string;
  runId: string;
  sourceEvidenceIds: string[];
  summary: string;
  confidence: "low" | "medium" | "high";
  status: "proposed" | "committed" | "rejected";
  createdAt: string;
  /** Suggested classification from the mining worker, kept for the commit step. 提炼 Worker 建议的分类，供提交时沿用。 */
  type?: MemoryType;
  sensitivity?: MemorySensitivity;
  expiresAt?: string;
}

export type JournalEventType =
  | "trigger.received"
  | "task.created"
  | "run.created"
  | "run.status_changed"
  | "plan.created"
  | "policy.decided"
  | "approval.granted"
  // An approval code was sent to the owner's phone; the request itself is auditable.
  // 审批码已发送到所有者手机；请求本身可审计。
  | "approval.requested"
  // One round of the agent's own adversarial suite and gate; recorded so the loop itself is auditable.
  // Agent 自己的一轮对抗套件与门禁；记录下来，使回路本身可审计。
  | "selfcheck.completed"
  | "execution.started"
  | "execution.failed"
  | "execution.progress"
  // Why a single-agent step ended the run. Without it a failed run only said "failed".
  // 单 Agent 步骤为何让 Run 失败。没有它，失败的 Run 只会说一句 "failed"。
  | "execution.failed"
  // An owner verdict on a finished run, the ground truth an eval compares the system's own verdict with.
  // 所有者对已结束 Run 的判定，是评估用来对照系统自身判定的真值。
  | "audit.labeled"
  // An owner applied (or reverted) a configuration change proposed by AI self-review.
  // 所有者应用（或撤销）了 AI 自我评审提出的配置改动。
  | "recommendation.applied"
  // A routing decision is not a dispatch: it records which worker was chosen
  // and why, before any process exists to dispatch to.
  // 路由决策不是一次派发：它在任何可派发的进程存在之前，记录选了哪个 Worker、为什么。
  // What a connector saw. Journaled so a later proposal can be traced back to
  // the observation that prompted it.
  // Connector 看到了什么。写入 Journal，使日后的提案能回溯到引发它的那次观察。
  | "observation.recorded"
  | "dispatch.decided"
  | "dispatch.steps_assigned"
  | "dispatch.blocked"
  | "subagent.dispatched"
  | "subagent.resumed"
  | "subagent.session_started"
  | "subagent.progress"
  | "subagent.completed"
  | "subagent.failed"
  | "subagent.cancelled"
  | "subagent.recovery_decided"
  | "subagent.verified"
  | "agent.message_delta"
  | "agent.tool_started"
  | "agent.tool_completed"
  | "evidence.recorded"
  // Isolated work finished: which named files landed in the live tree, which
  // stayed in the sandbox, and whether that sandbox was kept for inspection.
  // 隔离工作结束：哪些点名文件落到了活树、哪些留在沙箱、沙箱是否保留供查看。
  | "workspace.isolation.applied"
  | "verification.completed"
  | "memory.candidate.requested"
  | "memory.candidate.proposed"
  | "memory.candidate.extracted"
  | "memory.candidate.promoted"
  | "memory.candidate.rejected"
  // The owner writing a memory by hand. Distinct from a promoted candidate:
  // it cites no evidence because the owner is the evidence.
  // 所有者手写的一条记忆。与被提升的候选不同：它不引用任何证据，因为所有者本人就是证据。
  | "memory.authored"
  | "memory.updated"
  | "memory.archived"
  | "memory.restored"
  | "memory.mutation.discarded"
  | "memory.recalled"
  // The improvement loop: a suggestion derived from outcomes, and the owner's
  // decision on it. 改进环路：由结局得出的建议，以及所有者对它的决定。
  // A conversation turn asked for memory mining, and that request was drained.
  // Separate from the task request/extracted pair so a conversation request
  // never marks its run as mined for a task.
  // 一个对话回合请求了记忆提炼，以及该请求已被处理。与任务请求/提炼完成分开，使对话请求
  // 不会把同一 Run 标记为任务已提炼。
  | "memory.conversation.requested"
  | "memory.conversation.extracted"
  | "improvement.suggested"
  | "improvement.applied"
  | "improvement.dismissed"
  // Personal state is journal-projected like every other durable fact, so the
  // owner's model of themselves survives a deleted projection.
  // 个人状态与其他持久事实一样由 Journal 投影得出，因此即使投影被删除，所有者对自身的
  // 建模依然能够重建。
  | "state.self_model.recorded"
  | "state.self_model.updated"
  | "state.self_model.archived"
  | "state.goal.recorded"
  | "state.goal.updated"
  | "state.goal.archived"
  | "state.commitment.recorded"
  | "state.commitment.updated"
  | "state.commitment.archived"
  | "opportunity.proposed"
  | "opportunity.resolved"
  // Owner edits to autonomy levels / standing policies; only the owner writes these.
  // 所有者对自主档位 / 常设策略的编辑；只有所有者会写这类事件。
  | "authority.changed"
  | "agent.installed"
  | "agent.install_failed"
  // Model turn cost/duration. Copied from session metadata when the SDK has
  // tokens; otherwise duration and model id still land so the ledger is not empty.
  // 模型回合的费用/时长。SDK 有 token 时从会话元数据抄来；否则仍记下时长与模型 id，
  // 账本不会是空的。
  | "usage.recorded"
  // What the Main Agent was told before it answered: hashes of the charter,
  // briefing, and tool table plus the model that read them. Without this a
  // failure cannot be attributed to a prompt revision, and an "improvement"
  // cannot be compared with the baseline it replaced.
  // 主 Agent 回答前收到的输入：charter、简报与工具表的哈希，以及读取它们的模型。
  // 没有它，失败无法归因到某一版提示词，"改进"也无法与它所替换的基线比较。
  | "main_agent.prompt_snapshot"
  // One Main Agent turn from any entry point: the input before the model sees
  // it, and the reply/tool calls/usage after. Without these a CLI or WhatsApp
  // task left no auditable trace of what was asked or done.
  // 来自任意入口的一次主 Agent 回合：模型看到之前的输入，以及之后的回复/工具调用/用量。
  // 没有它们，CLI 或 WhatsApp 的任务不会留下"问过什么、做过什么"的可审计轨迹。
  | "main_agent.turn_started"
  | "main_agent.turn_completed";

export interface JournalEvent {
  id: string;
  sequence: number;
  type: JournalEventType;
  occurredAt: string;
  taskId?: string;
  runId?: string;
  payload: unknown;
}

export interface NewJournalEvent {
  type: JournalEventType;
  taskId?: string;
  runId?: string;
  payload: unknown;
}

export interface ExecutionAssignment {
  run: Run;
  task: Task;
  step: PlanStep;
  /**
   * The concrete adapter selected by the Runtime, not merely a planning hint.
   * Runtime 选择的具体 Adapter，而不只是 Planner 的建议。
   */
  executor: {
    agentId: string;
    providerId: string;
  };
  /**
   * Defined only for a child agent. The parent Runtime remains the supervisor.
   * 只为子 Agent 定义；父 Runtime 始终是 Supervisor。
   */
  workOrder?: SubagentWorkOrder;
  /**
   * Evidence from completed dependencies, curated by the supervisor.
   * 已完成依赖产生且由 Supervisor 筛选过的 Evidence。
   */
  dependencyEvidence?: Evidence[];
  /**
   * The scoped memory packet compiled by the Kernel for this assignment —
   * never the whole store. Workers receive it as background facts; every item
   * must already be journaled as memory.recalled for this run.
   * Kernel 为本次派发编译的有作用域记忆包——绝不是整个记忆库。Worker 只把它当背景事实；
   * 每一条都必须已作为本 Run 的 memory.recalled 记入 Journal。
   */
  memoryContext?: MemoryContextPacket;
  /** Owner-editable failure taxonomy used only for diagnostics. 所有者可编辑的失败分类，仅用于诊断。 */
  failureCatalog?: OutcomeCatalog;
  workspacePath?: string;
  /**
   * Present when this assignment is not allowed to touch the owner's live tree.
   * The worker's cwd is `workspacePath`; `ownerPath` is recorded for audit.
   * 本次派发不得碰所有者活树时出现。Worker 的 cwd 是 `workspacePath`；`ownerPath` 记入审计。
   */
  workspaceIsolation?: {
    kind: "git_worktree" | "directory_copy";
    ownerPath: string;
  };
}

export interface MemoryContextPacket {
  items: Array<{ id: string; summary: string }>;
  /** Why these items reached this worker. 这些条目为何到达该 Worker。 */
  selectedBy: { query: string };
}

/**
 * The narrow recall port the Kernel uses to compile worker memory packets.
 * The owner's switches (recall enabled, per-task cap) stay inside the store,
 * so the Kernel cannot widen its own access.
 * Kernel 编译 Worker 记忆包所用的窄召回端口。所有者的开关（是否启用召回、每任务上限）
 * 留在 Store 内部，因此 Kernel 无法自行放宽访问范围。
 */
export interface WorkerMemorySource {
  recall(query: string, runId: string): Promise<Array<{
    memory: { id: string; summary: string };
    score: number;
    matchedTerms: string[];
  }>>;
}

/**
 * What an adapter can say about the model calls behind one execution.
 * Optional fields stay absent rather than being invented when a provider
 * omits its usage block.
 * Adapter 对一次执行背后的模型调用能诚实说出的内容。Provider 不返回 usage 时，
 * 可选字段保持缺省，而不是编造为 0。
 */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  /** Model round trips, when the adapter can count them. 模型往返次数（Adapter 能计数时）。 */
  modelCalls?: number;
  durationMs?: number;
}

export type ExecutionEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "message_delta"; text: string }
  | { type: "tool_started"; toolCallId: string; tool: string; inputSummary?: string }
  /** One model round trip. Adapters that can count them emit this. 一次模型往返。能计数的 Adapter 发出此事件。 */
  | { type: "model_call" }
  | { type: "tool_completed"; toolCallId: string; tool: string; isError: boolean }
  | { type: "progress"; message: string }
  | { type: "evidence"; evidence: Omit<Evidence, "id" | "runId" | "stepId" | "createdAt"> }
  | { type: "completed"; summary: string; usage?: ModelUsage }
  | { type: "failed"; message: string; report?: FailureReport; usage?: ModelUsage };

export interface RuntimeCapabilities {
  resume: boolean;
  cancellation: boolean;
  approvalCallback: boolean;
  parallelAssignments: boolean;
  /** Only a trusted adapter with enforced replay safety may opt in. 只有可信且真正保证重放安全的 Adapter 可以启用。 */
  retrySafeAfterInterruption?: boolean;
  /**
   * Domain abilities used by the dispatcher; tool access remains adapter-owned.
   * Dispatcher 使用的领域能力；Tool 权限仍由 Adapter 自己持有。
   */
  work: string[];
  /**
   * Evidence kinds this adapter may record. Omitted means every kind except
   * "receipt": a receipt attests that an external action really happened, so
   * an adapter must declare it explicitly, and only when its receipts come
   * from a trusted runtime rather than from worker-controlled output.
   * 该 Adapter 允许记录的 Evidence 类型。省略时默认允许除 "receipt" 外的全部类型：
   * Receipt 用于证明外部动作确实发生，Adapter 必须显式声明，且只有当 Receipt 来自
   * 可信运行时（而非 Worker 可控输出）时才可以声明。
   */
  evidenceKinds?: Evidence["kind"][];
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly providerId: string;

  capabilities(): Promise<RuntimeCapabilities>;

  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent>;

  resume?(sessionId: string, input: ExecutionAssignment): AsyncIterable<ExecutionEvent>;

  cancel?(sessionId: string): Promise<void>;
}

/**
 * Maps a work order to a replaceable agent adapter.
 * 将 WorkOrder 映射到可替换的 Agent Adapter；Adapter 不拥有 Run 状态。
 */
export interface AgentRegistry {
  get(agentId: string): RuntimeAdapter | undefined;
  list(): RuntimeAdapter[];
}

export interface PolicyDecision {
  outcome: "allowed" | "approval_required" | "denied";
  reason: string;
  /** Standing policies that justified an automatic allow, for audit. 促成自动放行的常设策略，供审计。 */
  policyIds?: string[];
  /** Per-scope verdicts behind the outcome, for audit. 结论背后的逐 Scope 判定，供审计。 */
  scopeVerdicts?: Array<{ scope: Scope; outcome: "allowed" | "approval_required" | "denied"; reason: string }>;
}

export interface PolicyEngine {
  evaluate(input: { run: Run; task: Task; step: PlanStep; approved: boolean }): PolicyDecision;
}

export interface Verifier {
  verify(input: { run: Run; plan: WorkPlan; evidence: Evidence[] }): Promise<VerificationResult>;
}
