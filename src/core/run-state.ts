import type {
  ApprovalGrant,
  Evidence,
  JournalEvent,
  Run,
  RunStatus,
  SubagentRun,
  SubagentVerificationResult,
  Task,
  VerificationResult,
  WorkPlan,
} from "./contracts.ts";

export interface RuntimeProjection {
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  plans: Record<string, WorkPlan>;
  approvals: Record<string, ApprovalGrant>;
  evidenceByRun: Record<string, Evidence[]>;
  subagents: Record<string, SubagentRun>;
  subagentVerificationByKey: Record<string, SubagentVerificationResult>;
  verificationByRun: Record<string, VerificationResult>;
}

const allowedTransitions: Record<RunStatus, readonly RunStatus[]> = {
  created: ["planning", "cancelled"],
  planning: ["queued", "failed", "cancelled"],
  queued: ["running", "waiting_approval", "failed", "cancelled"],
  // A run may go back to the queue for exactly one reason: its executor died
  // and the orphan recovery found no live claim. The event carries that
  // reason, so a replayed journal never mistakes a recovery for a scheduler
  // decision.
  // Run 只因一个原因回到队列：执行者死亡，且孤儿恢复没有找到存活的领取。事件携带该
  // 原因，因此重放 Journal 时绝不会把恢复误认为调度决策。
  running: ["waiting_approval", "verifying", "failed", "cancelled", "queued"],
  waiting_approval: ["running", "failed", "cancelled"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function emptyProjection(): RuntimeProjection {
  return {
    tasks: {},
    runs: {},
    plans: {},
    approvals: {},
    evidenceByRun: {},
    subagents: {},
    subagentVerificationByKey: {},
    verificationByRun: {},
  };
}

export function replay(events: JournalEvent[]): RuntimeProjection {
  return events.reduce(reduceEvent, emptyProjection());
}

export function reduceEvent(state: RuntimeProjection, event: JournalEvent): RuntimeProjection {
  switch (event.type) {
    case "task.created": {
      const task = event.payload as Task;
      return { ...state, tasks: { ...state.tasks, [task.id]: task } };
    }
    case "run.created": {
      const run = event.payload as Run;
      return { ...state, runs: { ...state.runs, [run.id]: run } };
    }
    case "run.status_changed": {
      const payload = event.payload as { status: RunStatus; activeStepId?: string };
      const run = requireRun(state, event.runId);
      assertTransition(run.status, payload.status);
      return {
        ...state,
        runs: {
          ...state.runs,
          [run.id]: {
            ...run,
            status: payload.status,
            activeStepId: payload.activeStepId,
            updatedAt: event.occurredAt,
          },
        },
      };
    }
    case "plan.created": {
      const plan = event.payload as WorkPlan;
      const run = requireRun(state, plan.runId);
      return {
        ...state,
        plans: { ...state.plans, [plan.id]: plan },
        runs: { ...state.runs, [run.id]: { ...run, planId: plan.id, updatedAt: event.occurredAt } },
      };
    }
    case "approval.granted": {
      const approval = event.payload as ApprovalGrant;
      return {
        ...state,
        approvals: { ...state.approvals, [approvalKey(approval.runId, approval.stepId)]: approval },
      };
    }
    case "evidence.recorded": {
      const evidence = event.payload as Evidence;
      return {
        ...state,
        evidenceByRun: {
          ...state.evidenceByRun,
          [evidence.runId]: [...(state.evidenceByRun[evidence.runId] ?? []), evidence],
        },
      };
    }
    case "subagent.dispatched": {
      const subagent = event.payload as SubagentRun;
      return { ...state, subagents: { ...state.subagents, [subagentKey(subagent.runId, subagent.workOrderId)]: subagent } };
    }
    case "subagent.resumed": {
      const payload = event.payload as { workOrderId: string; attempt: number };
      return updateSubagent(state, event.runId, payload.workOrderId, (subagent) => ({
        ...subagent,
        status: "running",
        attempt: payload.attempt,
        updatedAt: event.occurredAt,
      }));
    }
    case "subagent.session_started": {
      const payload = event.payload as { workOrderId: string; sessionId: string };
      return updateSubagent(state, event.runId, payload.workOrderId, (subagent) => ({
        ...subagent,
        sessionId: payload.sessionId,
        updatedAt: event.occurredAt,
      }));
    }
    case "subagent.progress": {
      const payload = event.payload as { workOrderId: string };
      return updateSubagent(state, event.runId, payload.workOrderId, (subagent) => ({
        ...subagent,
        updatedAt: event.occurredAt,
      }));
    }
    case "subagent.completed": {
      const payload = event.payload as { workOrderId: string; summary: string };
      return updateSubagent(state, event.runId, payload.workOrderId, (subagent) => ({
        ...subagent,
        status: "completed",
        summary: payload.summary,
        updatedAt: event.occurredAt,
      }));
    }
    case "subagent.failed": {
      const payload = event.payload as { workOrderId: string; message: string };
      return updateSubagent(state, event.runId, payload.workOrderId, (subagent) => ({
        ...subagent,
        status: "failed",
        summary: payload.message,
        updatedAt: event.occurredAt,
      }));
    }
    case "subagent.cancelled": {
      const payload = event.payload as { workOrderId: string; message: string };
      return updateSubagent(state, event.runId, payload.workOrderId, (subagent) => ({
        ...subagent,
        status: "cancelled",
        summary: payload.message,
        updatedAt: event.occurredAt,
      }));
    }
    case "subagent.verified": {
      const verification = event.payload as SubagentVerificationResult;
      return {
        ...state,
        subagentVerificationByKey: {
          ...state.subagentVerificationByKey,
          [subagentKey(verification.runId, verification.workOrderId)]: verification,
        },
      };
    }
    case "verification.completed": {
      const verification = event.payload as VerificationResult;
      return {
        ...state,
        verificationByRun: { ...state.verificationByRun, [verification.runId]: verification },
      };
    }
    default:
      return state;
  }
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid run status transition: ${from} -> ${to}`);
  }
}

export function approvalKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

export function subagentKey(runId: string, workOrderId: string): string {
  return `${runId}:${workOrderId}`;
}

function updateSubagent(
  state: RuntimeProjection,
  runId: string | undefined,
  workOrderId: string,
  update: (subagent: SubagentRun) => SubagentRun,
): RuntimeProjection {
  if (runId === undefined) {
    throw new Error("A subagent event is missing its parent run.");
  }
  const key = subagentKey(runId, workOrderId);
  const subagent = state.subagents[key];
  if (subagent === undefined) {
    throw new Error(`Journal references an unknown subagent work order: ${workOrderId}`);
  }
  return { ...state, subagents: { ...state.subagents, [key]: update(subagent) } };
}

function requireRun(state: RuntimeProjection, runId: string | undefined): Run {
  if (runId === undefined || state.runs[runId] === undefined) {
    throw new Error(`Journal references an unknown run: ${runId ?? "missing"}`);
  }
  return state.runs[runId];
}
