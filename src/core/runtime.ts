import { randomUUID } from "node:crypto";

import type {
  AgentRegistry,
  ApprovalGrant,
  Evidence,
  ExecutionAssignment,
  ExecutionEvent,
  MemoryContextPacket,
  PlanStep,
  PolicyEngine,
  Run,
  RunStatus,
  RuntimeCapabilities,
  SubagentRun,
  SubagentWorkOrder,
  Task,
  Trigger,
  VerificationResult,
  Verifier,
  WorkPlan,
  WorkerMemorySource,
} from "./contracts.ts";
import type { JournalStore } from "./journal.ts";
import { approvalKey, emptyProjection, reduceEvent, replay, subagentKey, type RuntimeProjection } from "./run-state.ts";
import { MemoryPipeline } from "../memory/memory-pipeline.ts";
import { CapabilityDispatcher } from "../agents/dispatcher.ts";

export interface CloneRuntimeOptions {
  journal: JournalStore;
  policy: PolicyEngine;
  verifier: Verifier;
  memory: MemoryPipeline;
  /**
   * Optional recall port. When present, the Kernel compiles a scoped memory
   * packet for each assignment so any worker — Pi, a coding CLI, or a future
   * provider — receives the same owner-governed context without the memory
   * ever living inside the tool.
   * 可选的召回端口。存在时，Kernel 会为每次派发编译有作用域的记忆包，使任何 Worker
   * （Pi、Coding CLI 或未来的 Provider）都收到同一份由所有者治理的上下文，而记忆
   * 从不驻留在工具内部。
   */
  memorySource?: WorkerMemorySource;
}

export interface DispatchResult {
  run: Run;
  status: "completed" | "waiting_approval" | "failed";
  verification?: VerificationResult;
}

/**
 * The Runtime is the supervisor. It owns state transitions, authority,
 * evidence, verification, and memory requests. An agent only receives a
 * bounded execution assignment or child work order; it cannot close a Run.
 *
 * Runtime 负责状态流转、授权、证据、验证与记忆请求。Agent 只能收到受边界
 * 约束的执行 Assignment 或子 WorkOrder，绝不能自行关闭 Run。
 */
export class CloneRuntime {
  readonly #journal: JournalStore;
  readonly #policy: PolicyEngine;
  readonly #verifier: Verifier;
  readonly #memory: MemoryPipeline;
  readonly #memorySource?: WorkerMemorySource;
  #state: RuntimeProjection = emptyProjection();
  #hydrated = false;

  constructor(options: CloneRuntimeOptions) {
    this.#journal = options.journal;
    this.#policy = options.policy;
    this.#verifier = options.verifier;
    this.#memory = options.memory;
    this.#memorySource = options.memorySource;
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated) {
      return;
    }
    this.#state = replay(await this.#journal.list());
    await this.#memory.rebuild();
    this.#hydrated = true;
  }

  async acceptTrigger(input: Omit<Trigger, "id" | "occurredAt">): Promise<{ task: Task; run: Run }> {
    await this.hydrate();

    const trigger: Trigger = { ...input, id: randomUUID(), occurredAt: new Date().toISOString() };
    const task: Task = {
      id: randomUUID(),
      triggerId: trigger.id,
      title: trigger.summary,
      objective: trigger.summary,
      acceptanceCriteria: ["A plan exists", "Execution is verified or explicitly blocked"],
      createdAt: new Date().toISOString(),
    };
    const run: Run = {
      id: randomUUID(),
      taskId: task.id,
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.record({ type: "trigger.received", payload: trigger });
    await this.record({ type: "task.created", taskId: task.id, payload: task });
    await this.record({ type: "run.created", taskId: task.id, runId: run.id, payload: run });
    await this.changeStatus(run.id, "planning");
    return { task, run: this.requireRun(run.id) };
  }

  async attachPlan(runId: string, input: Omit<WorkPlan, "id" | "runId" | "createdAt">): Promise<WorkPlan> {
    await this.hydrate();
    const run = this.requireRun(runId);
    if (run.status !== "planning") {
      throw new Error(`A plan can only be attached while planning; run is ${run.status}.`);
    }
    assertPlanIsExecutable(input.steps);

    const plan: WorkPlan = { ...input, id: randomUUID(), runId, createdAt: new Date().toISOString() };
    await this.record({ type: "plan.created", taskId: run.taskId, runId, payload: plan });
    await this.changeStatus(runId, "queued");
    return plan;
  }

  /**
   * Close a run that can no longer proceed (for example a rejected plan
   * proposal). A journaled terminal status keeps the projection honest;
   * abandoned runs must not linger as if they were still planning.
   * 关闭无法继续的 Run（例如被拒绝的计划提案）。记入 Journal 的终态让投影保持诚实；
   * 被放弃的 Run 不能像仍在规划中一样滞留。
   */
  async failRun(runId: string, reason: string): Promise<void> {
    await this.hydrate();
    const run = this.requireRun(runId);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Run ${runId} already reached terminal status ${run.status}.`);
    }
    await this.record({
      type: "run.status_changed",
      taskId: run.taskId,
      runId,
      payload: { status: "failed", reason: redactAuditText(reason) },
    });
  }

  async grantApproval(runId: string, stepId: string, note?: string): Promise<ApprovalGrant> {    await this.hydrate();
    const run = this.requireRun(runId);
    const plan = this.requirePlan(run);
    if (!plan.steps.some((step) => step.id === stepId)) {
      throw new Error(`Step ${stepId} is not part of run ${runId}.`);
    }

    const approval: ApprovalGrant = {
      id: randomUUID(),
      runId,
      stepId,
      grantedAt: new Date().toISOString(),
      grantedBy: "user",
      note,
    };
    await this.record({ type: "approval.granted", taskId: run.taskId, runId, payload: approval });
    return approval;
  }

  async execute(runId: string, agents: AgentRegistry): Promise<DispatchResult> {
    await this.hydrate();
    let run = this.requireRun(runId);
    const task = this.requireTask(run.taskId);
    const plan = this.requirePlan(run);

    if (run.status !== "queued" && run.status !== "waiting_approval" && run.status !== "running") {
      throw new Error(`Run ${run.id} cannot execute while ${run.status}.`);
    }

    for (const step of plan.steps) {
      if (this.stepHasCompletedEvidence(run.id, step)) {
        continue;
      }

      const approved = this.#state.approvals[approvalKey(run.id, step.id)] !== undefined;
      const decision = this.#policy.evaluate({ run, task, step, approved });
      await this.record({ type: "policy.decided", taskId: task.id, runId: run.id, payload: { stepId: step.id, decision } });

      if (decision.outcome === "denied") {
        await this.changeStatus(run.id, "failed", step.id);
        return { run: this.requireRun(run.id), status: "failed" };
      }
      if (decision.outcome === "approval_required") {
        await this.changeStatus(run.id, "waiting_approval", step.id);
        return { run: this.requireRun(run.id), status: "waiting_approval" };
      }

      if (this.requireRun(run.id).status !== "running") {
        await this.changeStatus(run.id, "running", step.id);
      }
      run = this.requireRun(run.id);

      try {
        if (step.subagents !== undefined) {
          await this.executeSubagents({ run, task, step, agents });
        } else {
          await this.executeSingleAgent({ run, task, step, agents });
        }
      } catch (error: unknown) {
        await this.changeStatus(run.id, "failed", step.id);
        return { run: this.requireRun(run.id), status: "failed" };
      }
    }

    await this.changeStatus(run.id, "verifying");
    const verification = await this.#verifier.verify({
      run: this.requireRun(run.id),
      plan,
      evidence: this.#state.evidenceByRun[run.id] ?? [],
    });
    await this.record({ type: "verification.completed", taskId: task.id, runId: run.id, payload: verification });

    if (!verification.passed) {
      await this.changeStatus(run.id, "failed");
      return { run: this.requireRun(run.id), status: "failed", verification };
    }

    await this.changeStatus(run.id, "completed");
    await this.#memory.request(this.requireRun(run.id), task, this.#state.evidenceByRun[run.id] ?? []);
    return { run: this.requireRun(run.id), status: "completed", verification };
  }

  getRun(runId: string): Run {
    return this.requireRun(runId);
  }

  /** Read-only view of every run in the projection, oldest first. 投影中全部 Run 的只读视图，按创建时间升序。 */
  listRuns(): Run[] {
    return Object.values(this.#state.runs)
      .map((run) => ({ ...run }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getSubagentsForRun(runId: string): SubagentRun[] {
    return Object.values(this.#state.subagents)
      .filter((subagent) => subagent.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  getEventsForRun(runId: string): Promise<readonly string[]> {
    return this.#journal.list().then((events) => events.filter((event) => event.runId === runId).map((event) => event.type));
  }

  async cancel(runId: string, agents: AgentRegistry): Promise<Run> {
    await this.hydrate();
    const run = this.requireRun(runId);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Run ${run.id} cannot be cancelled while ${run.status}.`);
    }

    for (const subagent of this.getSubagentsForRun(runId).filter((item) => item.status === "running")) {
      if (subagent.sessionId !== undefined) {
        const adapter = agents.get(subagent.agentId);
        if (adapter === undefined) {
          throw new Error(`Cannot cancel ${subagent.workOrderId}; adapter ${subagent.agentId} is not registered.`);
        }
        if (subagent.providerId !== undefined && subagent.providerId !== adapter.providerId) {
          throw new Error(
            `Cannot cancel ${subagent.workOrderId}; provider changed from ${subagent.providerId} to ${adapter.providerId}.`,
          );
        }
        if (adapter.cancel === undefined) {
          throw new Error(`Cannot cancel ${subagent.workOrderId}; adapter ${adapter.id} does not support cancellation.`);
        }
        await adapter.cancel(subagent.sessionId);
      }
      await this.record({
        type: "subagent.cancelled",
        taskId: run.taskId,
        runId,
        payload: { workOrderId: subagent.workOrderId, message: "Cancelled by the supervisor." },
      });
    }
    await this.changeStatus(runId, "cancelled", run.activeStepId);
    return this.requireRun(runId);
  }

  /**
   * Records the curated local memories that were actually supplied to this run.
   * 记录实际被筛选并提供给当前 Run 的本地 Memory。
   */
  async recordMemoryRecall(runId: string, query: string, memories: Array<{ id: string; summary: string; score: number; matchedTerms: string[] }>): Promise<void> {
    await this.hydrate();
    const run = this.requireRun(runId);
    if (memories.length === 0) return;
    await this.record({
      type: "memory.recalled",
      taskId: run.taskId,
      runId,
      payload: { query, memories },
    });
  }

  private async executeSingleAgent(input: { run: Run; task: Task; step: PlanStep; agents: AgentRegistry }): Promise<void> {
    const agentId = input.step.agentId;
    if (agentId === undefined) {
      throw new Error(`Plan step ${input.step.id} has no executor.`);
    }
    const adapter = input.agents.get(agentId);
    if (adapter === undefined) {
      throw new Error(`No adapter is registered for agent ${agentId}.`);
    }
    const capabilities = await adapter.capabilities();
    const missingCapabilities = (input.step.requiredCapabilities ?? []).filter(
      (capability) => !capabilities.work.includes(capability),
    );
    if (missingCapabilities.length > 0) {
      throw new Error(
        `Agent ${agentId} cannot execute step ${input.step.id}; missing capabilities: ${missingCapabilities.join(", ")}.`,
      );
    }
    const memoryContext = await this.compileMemoryContext({ run: input.run, task: input.task, step: input.step });
    const assignment: ExecutionAssignment = {
      run: input.run,
      task: input.task,
      step: input.step,
      executor: { agentId: adapter.id, providerId: adapter.providerId },
      ...(memoryContext === undefined ? {} : { memoryContext }),
    };
    const executionAuthorization = evidenceAuthorization(capabilities);
    await this.record({
      type: "execution.started",
      taskId: input.task.id,
      runId: input.run.id,
      payload: {
        stepId: input.step.id,
        adapterId: adapter.id,
        providerId: adapter.providerId,
        // The authorization snapshot makes the journal self-auditing: a later
        // replay can verify every recorded evidence kind against what this
        // adapter was actually allowed to record at dispatch time.
        // 授权快照让 Journal 可以自审计：事后重放能对照派发时该 Adapter 实际被允许的
        // 证据类型，校验每一条已记录的 Evidence。
        authorizedEvidenceKinds: [...executionAuthorization],
        memoryItemIds: memoryContext?.items.map((item) => item.id) ?? [],
      },
    });
    const completion = await this.consumeExecutionEvents(adapter, assignment, executionAuthorization);
    if (completion === undefined) {
      throw new Error(`Agent ${agentId} ended without an explicit completion event.`);
    }
    if (!this.stepHasCompletedEvidence(input.run.id, input.step)) {
      throw new Error(`Agent ${agentId} completed step ${input.step.id} without evidence.`);
    }
  }

  private async executeSubagents(input: { run: Run; task: Task; step: PlanStep; agents: AgentRegistry }): Promise<void> {
    const orders = input.step.subagents ?? [];
    let outstanding = orders.filter((order) => !this.workOrderHasCompletedEvidence(input.run.id, order.id));

    while (outstanding.length > 0) {
      const ready = outstanding.filter((order) => this.dependenciesAreComplete(input.run.id, order));
      if (ready.length === 0) {
        throw new Error(`Subagent work orders for step ${input.step.id} cannot make progress; check dependencies.`);
      }
      await Promise.all(ready.map((order) => this.dispatchSubagent({ ...input, workOrder: order })));
      outstanding = orders.filter((order) => !this.workOrderHasCompletedEvidence(input.run.id, order.id));
    }
  }

  private dependenciesAreComplete(runId: string, order: SubagentWorkOrder): boolean {
    return (order.dependsOn ?? []).every((dependencyId) => this.workOrderHasCompletedEvidence(runId, dependencyId));
  }

  private async dispatchSubagent(input: { run: Run; task: Task; step: PlanStep; workOrder: SubagentWorkOrder; agents: AgentRegistry }): Promise<void> {
    const existing = this.#state.subagents[subagentKey(input.run.id, input.workOrder.id)];
    if (existing?.status === "completed") {
      if (await this.ensureWorkOrderVerified(input, existing.agentId)) {
        return;
      }
    }
    if (existing?.status === "cancelled") {
      throw new Error(`Subagent ${input.workOrder.id} was cancelled.`);
    }

    // A fresh work order may be routed by capability. Once started, the
    // concrete adapter identity is pinned so replay cannot silently move the
    // persisted provider session to another configured worker.
    // 新 WorkOrder 可以按能力路由；一旦启动，具体 Adapter 身份会被固定，避免重放时
    // 悄悄把已持久化的 Provider Session 换到另一个 Worker。
    const adapter = await new CapabilityDispatcher(input.agents).select(
      existing === undefined
        ? input.workOrder
        : { ...input.workOrder, agentId: existing.agentId },
    );
    if (existing?.providerId !== undefined && existing.providerId !== adapter.providerId) {
      throw new Error(
        `Work order ${input.workOrder.id} started with provider ${existing.providerId} and cannot resume with ${adapter.providerId}.`,
      );
    }
    const memoryContext = await this.compileMemoryContext({
      run: input.run,
      task: input.task,
      step: input.step,
      workOrder: input.workOrder,
    });
    const assignment: ExecutionAssignment = {
      run: input.run,
      task: input.task,
      step: input.step,
      executor: { agentId: adapter.id, providerId: adapter.providerId },
      workOrder: input.workOrder,
      dependencyEvidence: this.dependencyEvidence(input.run.id, input.workOrder),
      ...(memoryContext === undefined ? {} : { memoryContext }),
    };
    const allowedEvidenceKinds = evidenceAuthorization(await adapter.capabilities());

    const previousAttempt = existing?.attempt ?? 1;
    let attempt = existing === undefined
      ? 1
      : existing.status === "running"
        ? previousAttempt
        : previousAttempt + 1;
    let sessionId = existing?.sessionId;
    let lastError: unknown = existing?.status === "completed"
      ? new Error(`Subagent ${input.workOrder.id} did not satisfy its artifact contract.`)
      : undefined;
    while (attempt <= input.workOrder.budget.maxAttempts) {
      if (existing === undefined && attempt === 1) {
        const startedAt = new Date().toISOString();
        const subagent: SubagentRun = {
          id: randomUUID(),
          runId: input.run.id,
          stepId: input.step.id,
          workOrderId: input.workOrder.id,
          agentId: adapter.id,
          providerId: adapter.providerId,
          role: input.workOrder.role,
          title: input.workOrder.title,
          status: "running",
          attempt,
          startedAt,
          updatedAt: startedAt,
        };
        await this.record({
          type: "subagent.dispatched",
          taskId: input.task.id,
          runId: input.run.id,
          payload: { ...subagent, authorizedEvidenceKinds: [...allowedEvidenceKinds], memoryItemIds: memoryContext?.items.map((item) => item.id) ?? [] },
        });
      } else {
        await this.record({
          type: "subagent.resumed",
          taskId: input.task.id,
          runId: input.run.id,
          payload: { workOrderId: input.workOrder.id, sessionId, adapterId: adapter.id, attempt },
        });
      }

      try {
        const stream = sessionId !== undefined && adapter.resume !== undefined
          ? { execute: () => adapter.resume!(sessionId!, assignment) }
          : adapter;
        const completion = await this.consumeExecutionEvents(stream, assignment, allowedEvidenceKinds);
        if (completion === undefined) {
          throw new Error("Subagent ended without an explicit completion event.");
        }
        if (!this.workOrderHasEvidence(input.run.id, input.workOrder.id)) {
          throw new Error("Subagent completed without producing evidence.");
        }
        await this.record({
          type: "subagent.completed",
          taskId: input.task.id,
          runId: input.run.id,
          payload: { workOrderId: input.workOrder.id, summary: redactAuditText(completion) },
        });
        if (!(await this.ensureWorkOrderVerified(input, adapter.id))) {
          throw new Error(`Subagent ${input.workOrder.id} did not satisfy its artifact contract.`);
        }
        return;
      } catch (error: unknown) {
        lastError = error;
        const message = redactAuditText(
          error instanceof Error ? error.message : "Unknown subagent failure.",
        );
        await this.record({
          type: "subagent.failed",
          taskId: input.task.id,
          runId: input.run.id,
          payload: { workOrderId: input.workOrder.id, message },
        });
        if (attempt >= input.workOrder.budget.maxAttempts) throw error;
        sessionId = this.#state.subagents[subagentKey(input.run.id, input.workOrder.id)]?.sessionId;
        attempt += 1;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Subagent exhausted its attempt budget.");
  }

  /**
   * Compiles the scoped memory packet for one assignment and journals exactly
   * which memories reached which worker. Memory is never handed over wholesale:
   * the objective is the query, the store applies the owner's recall switch and
   * per-task cap, and nothing reaches a worker without a memory.recalled event
   * to audit it against.
   * 为一次派发编译有作用域的记忆包，并把"哪些记忆到了哪个 Worker"记入 Journal。
   * 记忆绝不整体移交：以目标为查询、由 Store 施加所有者的召回开关与每任务上限，
   * 且没有 memory.recalled 事件可供对照的记忆不会到达任何 Worker。
   */
  private async compileMemoryContext(input: {
    run: Run;
    task: Task;
    step: PlanStep;
    workOrder?: SubagentWorkOrder;
  }): Promise<MemoryContextPacket | undefined> {
    if (this.#memorySource === undefined) return undefined;
    const query = input.workOrder?.objective ?? input.step.instructions;
    const matches = await this.#memorySource.recall(query, input.run.id);
    if (matches.length === 0) return undefined;

    await this.record({
      type: "memory.recalled",
      taskId: input.task.id,
      runId: input.run.id,
      payload: {
        query,
        scope: { stepId: input.step.id, workOrderId: input.workOrder?.id },
        memories: matches.map((match) => ({
          id: match.memory.id,
          summary: match.memory.summary,
          score: match.score,
          matchedTerms: match.matchedTerms,
        })),
      },
    });
    return {
      items: matches.map((match) => ({ id: match.memory.id, summary: match.memory.summary })),
      selectedBy: { query },
    };
  }

  private dependencyEvidence(runId: string, order: SubagentWorkOrder): Evidence[] {
    const dependencyIds = new Set(order.dependsOn ?? []);
    return (this.#state.evidenceByRun[runId] ?? []).filter((item) => (
      item.workOrderId !== undefined && dependencyIds.has(item.workOrderId)
    ));
  }

  private async ensureWorkOrderVerified(
    input: { run: Run; task: Task; step: PlanStep; workOrder: SubagentWorkOrder },
    producedBy: string,
  ): Promise<boolean> {
    const key = subagentKey(input.run.id, input.workOrder.id);
    const existing = this.#state.subagentVerificationByKey[key];
    if (existing?.passed === true) return true;

    const evidence = (this.#state.evidenceByRun[input.run.id] ?? []).filter(
      (item) => item.workOrderId === input.workOrder.id,
    );
    const failures: string[] = [];
    const usedEvidenceIds = new Set<string>();
    for (const artifact of input.workOrder.expectedArtifacts.filter((item) => item.required)) {
      const match = evidence.find((item) => (
        !usedEvidenceIds.has(item.id)
        && item.kind === artifact.kind
        && (!artifact.locatorRequired || (item.locator !== undefined && item.locator.length > 0))
      ));
      if (match === undefined) {
        failures.push(artifact.id);
      } else {
        usedEvidenceIds.add(match.id);
      }
    }
    const verification = {
      id: randomUUID(),
      runId: input.run.id,
      stepId: input.step.id,
      workOrderId: input.workOrder.id,
      passed: failures.length === 0 && evidence.length > 0,
      summary: failures.length === 0
        ? `${producedBy} supplied the required evidence contract.`
        : `Missing required artifact evidence: ${failures.join(", ")}.`,
      checkedEvidenceIds: evidence.map((item) => item.id),
      createdAt: new Date().toISOString(),
    };
    await this.record({
      type: "subagent.verified",
      taskId: input.task.id,
      runId: input.run.id,
      payload: verification,
    });
    return verification.passed;
  }

  private async consumeExecutionEvents(
    adapter: { execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> },
    input: ExecutionAssignment,
    allowedEvidenceKinds: ReadonlySet<Evidence["kind"]>,
  ): Promise<string | undefined> {
    let completion: string | undefined;
    for await (const event of adapter.execute(input)) {
      if (event.type === "completed") {
        completion = event.summary;
        continue;
      }
      await this.recordExecutionEvent(input, event, allowedEvidenceKinds);
    }
    return completion;
  }

  private async recordExecutionEvent(
    input: ExecutionAssignment,
    event: Exclude<ExecutionEvent, { type: "completed" }>,
    allowedEvidenceKinds: ReadonlySet<Evidence["kind"]>,
  ): Promise<void> {
    if (event.type === "session_started") {
      await this.record({
        type: input.workOrder === undefined ? "execution.progress" : "subagent.session_started",
        taskId: input.task.id,
        runId: input.run.id,
        payload: input.workOrder === undefined
          ? { stepId: input.step.id, message: `Agent session started: ${event.sessionId}`, sessionId: event.sessionId }
          : { stepId: input.step.id, workOrderId: input.workOrder.id, sessionId: event.sessionId },
      });
      return;
    }
    if (event.type === "message_delta") {
      // Raw model streams may echo file contents or personal data. They remain
      // transient UI events; only the redacted completion/evidence is durable.
      // 原始模型流可能回显文件内容或个人数据，只能作为瞬时 UI 事件；只有脱敏后的
      // completion/evidence 才允许持久化。
      return;
    }
    if (event.type === "tool_started") {
      await this.record({
        type: "agent.tool_started",
        taskId: input.task.id,
        runId: input.run.id,
        payload: {
          stepId: input.step.id,
          workOrderId: input.workOrder?.id,
          ...event,
          inputSummary: event.inputSummary === undefined ? undefined : redactAuditText(event.inputSummary),
        },
      });
      return;
    }
    if (event.type === "tool_completed") {
      await this.record({
        type: "agent.tool_completed",
        taskId: input.task.id,
        runId: input.run.id,
        payload: { stepId: input.step.id, workOrderId: input.workOrder?.id, ...event },
      });
      return;
    }
    if (event.type === "progress") {
      await this.record({
        type: input.workOrder === undefined ? "execution.progress" : "subagent.progress",
        taskId: input.task.id,
        runId: input.run.id,
        payload: input.workOrder === undefined
          ? { stepId: input.step.id, message: redactAuditText(event.message) }
          : {
            stepId: input.step.id,
            workOrderId: input.workOrder.id,
            message: redactAuditText(event.message),
          },
      });
      return;
    }
    if (event.type === "failed") {
      throw new Error(`Agent execution failed: ${event.message}`);
    }

    // Evidence kinds are an authorization, not a claim: an adapter may only
    // record the kinds it declared, and "receipt" is never granted by default,
    // so no worker can self-certify that an external action really happened.
    // Evidence 类型是授权而非声明：Adapter 只能记录其声明过的类型，"receipt" 默认永不授予，
    // 因此任何 Worker 都无法自证外部动作确实发生。
    if (!allowedEvidenceKinds.has(event.evidence.kind)) {
      throw new Error(
        `Adapter ${input.executor.agentId} is not authorized to record "${event.evidence.kind}" evidence.`,
      );
    }
    const evidence: Evidence = {
      ...event.evidence,
      summary: redactAuditText(event.evidence.summary),
      id: randomUUID(),
      runId: input.run.id,
      stepId: input.step.id,
      workOrderId: input.workOrder?.id,
      producedBy: input.executor.agentId,
      createdAt: new Date().toISOString(),
    };
    await this.record({ type: "evidence.recorded", taskId: input.task.id, runId: input.run.id, payload: evidence });
  }

  private async changeStatus(runId: string, status: RunStatus, activeStepId?: string): Promise<void> {
    const run = this.requireRun(runId);
    await this.record({ type: "run.status_changed", taskId: run.taskId, runId, payload: { status, activeStepId } });
  }

  private async record(input: Parameters<JournalStore["append"]>[0]): Promise<void> {
    const event = await this.#journal.append(input);
    this.#state = reduceEvent(this.#state, event);
  }

  private requireRun(runId: string): Run {
    const run = this.#state.runs[runId];
    if (run === undefined) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return run;
  }

  private requireTask(taskId: string): Task {
    const task = this.#state.tasks[taskId];
    if (task === undefined) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  private requirePlan(run: Run): WorkPlan {
    if (run.planId === undefined || this.#state.plans[run.planId] === undefined) {
      throw new Error(`Run ${run.id} has no plan.`);
    }
    return this.#state.plans[run.planId];
  }

  private stepHasCompletedEvidence(runId: string, step: PlanStep): boolean {
    if (step.subagents === undefined) {
      return (this.#state.evidenceByRun[runId] ?? []).some((item) => item.stepId === step.id && item.workOrderId === undefined);
    }
    return step.subagents.every((order) => this.workOrderHasCompletedEvidence(runId, order.id));
  }

  private workOrderHasEvidence(runId: string, workOrderId: string): boolean {
    return (this.#state.evidenceByRun[runId] ?? []).some((item) => item.workOrderId === workOrderId);
  }

  private workOrderHasCompletedEvidence(runId: string, workOrderId: string): boolean {
    const subagent = this.#state.subagents[subagentKey(runId, workOrderId)];
    const verification = this.#state.subagentVerificationByKey[subagentKey(runId, workOrderId)];
    return subagent?.status === "completed"
      && this.workOrderHasEvidence(runId, workOrderId)
      && verification?.passed === true;
  }
}

function assertPlanIsExecutable(steps: PlanStep[]): void {
  if (steps.length === 0) {
    throw new Error("A plan must contain at least one step.");
  }
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) {
    throw new Error("Plan step identifiers must be unique.");
  }
  const workOrderIds = new Set<string>();
  for (const step of steps) {
    assertNonEmpty(step.id, "Plan step id");
    assertNonEmpty(step.title, `Plan step ${step.id} title`);
    assertNonEmpty(step.instructions, `Plan step ${step.id} instructions`);
    if (!riskClasses.has(step.risk)) {
      throw new Error(`Plan step ${step.id} has an invalid risk class.`);
    }
    if (!Array.isArray(step.acceptanceCriteria) || step.acceptanceCriteria.length === 0) {
      throw new Error(`Plan step ${step.id} needs one or more acceptance criteria.`);
    }
    if ((step.agentId === undefined) === (step.subagents === undefined)) {
      throw new Error(`Plan step ${step.id} must have exactly one executor or one subagent group.`);
    }
    if (
      step.agentId !== undefined
      && (
        !Array.isArray(step.requiredCapabilities)
        || step.requiredCapabilities.length === 0
        || step.requiredCapabilities.some((item) => typeof item !== "string" || item.trim().length === 0)
      )
    ) {
      throw new Error(`Plan step ${step.id} needs one or more required capabilities.`);
    }
    if (step.subagents !== undefined) {
      for (const order of step.subagents) {
        if (workOrderIds.has(order.id)) {
          throw new Error(`Work order identifier ${order.id} must be unique across the whole plan.`);
        }
        workOrderIds.add(order.id);
      }
      assertSubagentOrders(step.id, step.subagents);
    }
  }
}

function assertSubagentOrders(stepId: string, orders: SubagentWorkOrder[]): void {
  if (orders.length === 0) {
    throw new Error(`Plan step ${stepId} has an empty subagent group.`);
  }
  const ids = new Set(orders.map((order) => order.id));
  if (ids.size !== orders.length) {
    throw new Error(`Subagent work order identifiers for step ${stepId} must be unique.`);
  }
  for (const order of orders) {
    assertNonEmpty(order.id, `Work order id in step ${stepId}`);
    assertNonEmpty(order.title, `Work order ${order.id} title`);
    assertNonEmpty(order.objective, `Work order ${order.id} objective`);
    if (
      !Array.isArray(order.acceptanceCriteria)
      || order.acceptanceCriteria.length === 0
      || order.acceptanceCriteria.some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new Error(`Subagent work order ${order.id} needs one or more acceptance criteria.`);
    }
    if (
      !Array.isArray(order.requiredCapabilities)
      || order.requiredCapabilities.length === 0
      || order.requiredCapabilities.some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new Error(`Subagent work order ${order.id} needs one or more required capabilities.`);
    }
    if (!riskClasses.has(order.risk)) {
      throw new Error(`Subagent work order ${order.id} has an invalid risk class.`);
    }
    if (!Array.isArray(order.inputs)) {
      throw new Error(`Subagent work order ${order.id} needs an input contract.`);
    }
    if (!Array.isArray(order.expectedArtifacts) || order.expectedArtifacts.length === 0) {
      throw new Error(`Subagent work order ${order.id} needs an artifact contract.`);
    }
    for (const artifact of order.expectedArtifacts) {
      assertNonEmpty(artifact.id, `Artifact id in work order ${order.id}`);
      assertNonEmpty(artifact.description, `Artifact ${artifact.id} description in work order ${order.id}`);
      if (!evidenceKinds.has(artifact.kind)) {
        throw new Error(`Artifact ${artifact.id} in work order ${order.id} has an invalid evidence kind.`);
      }
    }
    const artifactIds = new Set(order.expectedArtifacts.map((artifact) => artifact.id));
    if (artifactIds.size !== order.expectedArtifacts.length) {
      throw new Error(`Subagent work order ${order.id} has duplicate artifact contract ids.`);
    }
    if (!order.expectedArtifacts.some((artifact) => artifact.required)) {
      throw new Error(`Subagent work order ${order.id} must require at least one artifact.`);
    }
    assertBudget(order);
    if (
      (order.risk === "external_side_effect" || order.risk === "irreversible")
      && order.budget.maxAttempts !== 1
    ) {
      throw new Error(
        `Subagent work order ${order.id} can cause external or irreversible effects and must use maxAttempts=1.`,
      );
    }
    if (order.dependsOn !== undefined && !Array.isArray(order.dependsOn)) {
      throw new Error(`Subagent work order ${order.id} dependencies must be an array.`);
    }
    for (const dependencyId of order.dependsOn ?? []) {
      if (!ids.has(dependencyId) || dependencyId === order.id) {
        throw new Error(`Subagent work order ${order.id} has an invalid dependency: ${dependencyId}.`);
      }
    }
    for (const workInput of order.inputs) {
      assertNonEmpty(workInput.name, `Input name in work order ${order.id}`);
      assertNonEmpty(workInput.description, `Input ${workInput.name} description in work order ${order.id}`);
      if (
        workInput.sourceWorkOrderId !== undefined
        && !(order.dependsOn ?? []).includes(workInput.sourceWorkOrderId)
      ) {
        throw new Error(
          `Input ${workInput.name} in work order ${order.id} references ${workInput.sourceWorkOrderId} without a dependency.`,
        );
      }
    }
  }
  assertAcyclicWorkOrders(stepId, orders);
}

function assertAcyclicWorkOrders(stepId: string, orders: SubagentWorkOrder[]): void {
  const byId = new Map(orders.map((order) => [order.id, order]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Subagent work orders for step ${stepId} contain a dependency cycle at ${id}.`);
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const order of orders) visit(order.id);
}

function assertBudget(order: SubagentWorkOrder): void {
  if (typeof order.budget !== "object" || order.budget === null) {
    throw new Error(`Subagent work order ${order.id} needs an execution budget.`);
  }
  for (const name of ["maxDurationMs", "maxModelCalls", "maxToolCalls", "maxAttempts"] as const) {
    if (!Number.isInteger(order.budget[name]) || order.budget[name] < 1) {
      throw new Error(`Subagent work order ${order.id} has an invalid budget value for ${name}.`);
    }
  }
  for (const [name, value] of Object.entries(order.budget)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Subagent work order ${order.id} has an invalid budget value for ${name}.`);
    }
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} cannot be empty.`);
}

const riskClasses = new Set(["read_only", "reversible_write", "external_side_effect", "irreversible"]);
const evidenceKinds = new Set(["artifact", "tool_result", "receipt", "test", "observation"]);

/**
 * Receipts attest that an external action really happened, so an adapter must
 * opt in explicitly; every other evidence kind is granted by default.
 * Receipt 用于证明外部动作确实发生，Adapter 必须显式声明才可记录；其余 Evidence 类型默认授予。
 */
function evidenceAuthorization(capabilities: RuntimeCapabilities): ReadonlySet<Evidence["kind"]> {
  return new Set(capabilities.evidenceKinds ?? ["artifact", "tool_result", "test", "observation"]);
}

function redactAuditText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}
