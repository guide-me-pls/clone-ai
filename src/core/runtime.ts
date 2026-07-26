import { randomUUID } from "node:crypto";

import type {
  AgentRegistry,
  ApprovalGrant,
  Evidence,
  ExecutionAssignment,
  ExecutionEvent,
  PlanStep,
  PolicyEngine,
  Run,
  RunStatus,
  SubagentRun,
  SubagentWorkOrder,
  Task,
  Trigger,
  VerificationResult,
  Verifier,
  WorkPlan,
} from "./contracts.ts";
import type { JournalStore } from "./journal.ts";
import { approvalKey, emptyProjection, reduceEvent, replay, subagentKey, type RuntimeProjection } from "./run-state.ts";
import { MemoryPipeline } from "../memory/memory-pipeline.ts";

export interface CloneRuntimeOptions {
  journal: JournalStore;
  policy: PolicyEngine;
  verifier: Verifier;
  memory: MemoryPipeline;
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
 */
export class CloneRuntime {
  readonly #journal: JournalStore;
  readonly #policy: PolicyEngine;
  readonly #verifier: Verifier;
  readonly #memory: MemoryPipeline;
  #state: RuntimeProjection = emptyProjection();
  #hydrated = false;

  constructor(options: CloneRuntimeOptions) {
    this.#journal = options.journal;
    this.#policy = options.policy;
    this.#verifier = options.verifier;
    this.#memory = options.memory;
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

  async grantApproval(runId: string, stepId: string, note?: string): Promise<ApprovalGrant> {
    await this.hydrate();
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

    if (run.status !== "queued" && run.status !== "waiting_approval") {
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

  getSubagentsForRun(runId: string): SubagentRun[] {
    return Object.values(this.#state.subagents)
      .filter((subagent) => subagent.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  getEventsForRun(runId: string): Promise<readonly string[]> {
    return this.#journal.list().then((events) => events.filter((event) => event.runId === runId).map((event) => event.type));
  }

  /** Records the curated local memories that were actually supplied to this run. */
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
    await this.record({
      type: "execution.started",
      taskId: input.task.id,
      runId: input.run.id,
      payload: { stepId: input.step.id, adapterId: adapter.id },
    });
    await this.consumeExecutionEvents(adapter, input);
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
      if (this.workOrderHasCompletedEvidence(input.run.id, input.workOrder.id)) {
        return;
      }
      throw new Error(`Subagent ${input.workOrder.id} completed without usable evidence.`);
    }
    if (existing?.status === "failed") {
      throw new Error(`Subagent ${input.workOrder.id} previously failed: ${existing.summary ?? "unknown failure"}`);
    }

    const adapter = input.agents.get(input.workOrder.agentId);
    if (adapter === undefined) {
      throw new Error(`No adapter is registered for subagent ${input.workOrder.agentId}.`);
    }

    const startedAt = new Date().toISOString();
    const subagent: SubagentRun = {
      id: randomUUID(),
      runId: input.run.id,
      stepId: input.step.id,
      workOrderId: input.workOrder.id,
      agentId: input.workOrder.agentId,
      role: input.workOrder.role,
      title: input.workOrder.title,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    };
    await this.record({ type: "subagent.dispatched", taskId: input.task.id, runId: input.run.id, payload: subagent });

    try {
      const completion = await this.consumeExecutionEvents(adapter, input);
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
        payload: { workOrderId: input.workOrder.id, summary: completion },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown subagent failure.";
      await this.record({
        type: "subagent.failed",
        taskId: input.task.id,
        runId: input.run.id,
        payload: { workOrderId: input.workOrder.id, message },
      });
      throw error;
    }
  }

  private async consumeExecutionEvents(adapter: { execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> }, input: ExecutionAssignment): Promise<string | undefined> {
    let completion: string | undefined;
    for await (const event of adapter.execute(input)) {
      if (event.type === "completed") {
        completion = event.summary;
        continue;
      }
      await this.recordExecutionEvent(input, event);
    }
    return completion;
  }

  private async recordExecutionEvent(input: ExecutionAssignment, event: Exclude<ExecutionEvent, { type: "completed" }>): Promise<void> {
    if (event.type === "progress") {
      await this.record({
        type: input.workOrder === undefined ? "execution.progress" : "subagent.progress",
        taskId: input.task.id,
        runId: input.run.id,
        payload: input.workOrder === undefined
          ? { stepId: input.step.id, message: event.message }
          : { stepId: input.step.id, workOrderId: input.workOrder.id, message: event.message },
      });
      return;
    }
    if (event.type === "failed") {
      throw new Error(`Agent execution failed: ${event.message}`);
    }

    const evidence: Evidence = {
      ...event.evidence,
      id: randomUUID(),
      runId: input.run.id,
      stepId: input.step.id,
      workOrderId: input.workOrder?.id,
      producedBy: input.workOrder?.agentId ?? input.step.agentId,
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
    return subagent?.status === "completed" && this.workOrderHasEvidence(runId, workOrderId);
  }
}

function assertPlanIsExecutable(steps: PlanStep[]): void {
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) {
    throw new Error("Plan step identifiers must be unique.");
  }
  for (const step of steps) {
    if ((step.agentId === undefined) === (step.subagents === undefined)) {
      throw new Error(`Plan step ${step.id} must have exactly one executor or one subagent group.`);
    }
    if (step.subagents !== undefined) {
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
    for (const dependencyId of order.dependsOn ?? []) {
      if (!ids.has(dependencyId) || dependencyId === order.id) {
        throw new Error(`Subagent work order ${order.id} has an invalid dependency: ${dependencyId}.`);
      }
    }
  }
}
