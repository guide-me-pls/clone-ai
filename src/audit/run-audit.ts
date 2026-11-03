/**
 * Run audit: one self-contained, replayable record per Run, projected from the
 * journal and nothing else.
 *
 * It exists because the journal is the only truth, but it is a flat event
 * stream: answering "why did this run fail, which provider, after how long,
 * with what evidence, under which policy decision" meant reading raw events,
 * and until now a failed step did not even record its reason. An eval needs the
 * same answers as a joined row, so this projection produces exactly that, plus
 * a digest so an exported record can be checked against the journal later.
 *
 * Run 审计：从 Journal 且仅从 Journal 投影出的、每个 Run 一条自包含可重放的记录。
 *
 * 之所以需要它：Journal 是唯一真相，但它是扁平事件流；回答"这个 Run 为何失败、哪个 Provider、
 * 多久之后、带着什么证据、经过哪次策略决定"需要读原始事件，而此前失败步骤连原因都不记录。
 * 评估需要的正是这些答案的一行联表记录，所以这个投影直接产出它，并附一个摘要，使导出的记录
 * 之后可以与 Journal 对账。
 */
import { createHash } from "node:crypto";

import type { JournalEvent, PolicyDecision } from "../core/contracts.ts";
import { usageForWindow, type GatewayRequestRow, type GatewayUsage } from "../integrations/magpie-usage.ts";

export type FailureStage = "none" | "planning" | "policy" | "execution" | "verification" | "cancelled" | "unknown";

export interface AuditExecution {
  stepId: string;
  /** Subagent work order id when the step delegated; absent for a single-agent step. 步骤委派子 Agent 时的 WorkOrder id；单 Agent 步骤没有。 */
  workOrderId?: string;
  agentId?: string;
  providerId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  progressEvents: number;
  outcome: "completed" | "failed" | "unfinished";
  failure?: { message: string; category?: string; signature?: string; exitCode?: number | null };
  /** Model-gateway view of this execution (tokens, cost, HTTP errors). Inferred by time window, never exact. 模型网关视角下的此次执行（token、费用、HTTP 错误）；按时间窗口推断，不是精确归因。 */
  gatewayUsage?: GatewayUsage;
}

export interface AuditEvidence {
  stepId: string;
  kind: string;
  producedBy?: string;
  locator?: string;
  summary: string;
}

export interface RunAuditRecord {
  runId: string;
  taskTitle?: string;
  objective?: string;
  triggerKind?: string;
  status: string;
  createdAt?: string;
  endedAt?: string;
  durationMs?: number;
  plan: Array<{ id: string; title: string; risk: string; agentId?: string; scopes?: unknown; subagents: number }>;
  policy: Array<{ stepId: string; outcome: PolicyDecision["outcome"]; reason: string; policyIds?: string[]; scopeVerdicts?: PolicyDecision["scopeVerdicts"] }>;
  executions: AuditExecution[];
  evidence: AuditEvidence[];
  verification?: { passed: boolean; needsReview: boolean; unverifiedCriteria: string[]; summary: string };
  outcome: {
    status: string;
    /** Where the run stopped, so failures can be grouped without parsing prose. Run 在哪个阶段停下，使失败无需解析文字即可分组。 */
    failureStage: FailureStage;
    failureCategory?: string;
    reason?: string;
  };
  /** Number of journal events behind this record and the sequence span they cover. 支撑此记录的 Journal 事件数及其序号范围。 */
  basis: { events: number; firstSequence: number; lastSequence: number };
  /** sha256 over the run's events, canonicalised; recompute from the journal to verify an export. 对 Run 事件规范化后的 sha256；从 Journal 重算即可校验导出。 */
  digest: string;
}

type Payload = Record<string, any>;

export function projectRunAudits(events: readonly JournalEvent[]): RunAuditRecord[] {
  const byRun = new Map<string, JournalEvent[]>();
  const tasks = new Map<string, Payload>();
  const triggers = new Map<string, Payload>();
  for (const event of events) {
    if (event.type === "task.created") tasks.set((event.payload as Payload).id, event.payload as Payload);
    if (event.type === "trigger.received") triggers.set((event.payload as Payload).id, event.payload as Payload);
    if (event.runId === undefined) continue;
    const list = byRun.get(event.runId) ?? [];
    list.push(event);
    byRun.set(event.runId, list);
  }
  return [...byRun.entries()].map(([runId, runEvents]) => projectOne(runId, runEvents, tasks, triggers));
}

export function projectRunAudit(events: readonly JournalEvent[], runId: string): RunAuditRecord | undefined {
  return projectRunAudits(events).find((record) => record.runId === runId);
}

function projectOne(
  runId: string,
  events: JournalEvent[],
  tasks: Map<string, Payload>,
  triggers: Map<string, Payload>,
): RunAuditRecord {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const record: RunAuditRecord = {
    runId,
    status: "created",
    plan: [],
    policy: [],
    executions: [],
    evidence: [],
    outcome: { status: "created", failureStage: "none" },
    basis: { events: sorted.length, firstSequence: sorted[0]!.sequence, lastSequence: sorted.at(-1)!.sequence },
    digest: "",
  };
  const open = new Map<string, AuditExecution>();
  let lastFailure: { stage: FailureStage; category?: string; reason?: string } | undefined;
  let sawExecution = false;

  for (const event of sorted) {
    const p = (event.payload ?? {}) as Payload;
    switch (event.type) {
      case "run.created": {
        record.createdAt = event.occurredAt;
        const task = event.taskId === undefined ? undefined : tasks.get(event.taskId);
        if (task !== undefined) {
          record.taskTitle = task.title;
          record.objective = task.objective;
          record.triggerKind = triggers.get(task.triggerId)?.kind;
        }
        break;
      }
      case "plan.created":
        record.plan = (Array.isArray(p.steps) ? p.steps : []).map((step: Payload) => ({
          id: step.id,
          title: step.title,
          risk: step.risk,
          ...(step.agentId === undefined ? {} : { agentId: step.agentId }),
          ...(step.scopes === undefined ? {} : { scopes: step.scopes }),
          subagents: Array.isArray(step.subagents) ? step.subagents.length : 0,
        }));
        break;
      case "policy.decided":
        record.policy.push({
          stepId: p.stepId,
          outcome: p.decision?.outcome,
          reason: p.decision?.reason,
          ...(p.decision?.policyIds === undefined ? {} : { policyIds: p.decision.policyIds }),
          ...(p.decision?.scopeVerdicts === undefined ? {} : { scopeVerdicts: p.decision.scopeVerdicts }),
        });
        if (p.decision?.outcome === "denied") lastFailure = { stage: "policy", reason: p.decision.reason };
        break;
      case "execution.started": {
        sawExecution = true;
        const execution: AuditExecution = {
          stepId: p.stepId,
          agentId: p.adapterId,
          providerId: p.providerId,
          startedAt: event.occurredAt,
          progressEvents: 0,
          outcome: "unfinished",
        };
        record.executions.push(execution);
        open.set(p.stepId, execution);
        break;
      }
      case "execution.progress":
        if (open.has(p.stepId)) open.get(p.stepId)!.progressEvents += 1;
        break;
      case "execution.failed": {
        const execution = open.get(p.stepId) ?? ensureExecution(record, p.stepId, p.agentId);
        closeExecution(execution, event.occurredAt, "failed");
        execution.failure = {
          message: p.message,
          ...(p.report?.category === undefined ? {} : { category: p.report.category }),
          ...(p.report?.signature === undefined ? {} : { signature: p.report.signature }),
          ...(p.report?.exitCode === undefined ? {} : { exitCode: p.report.exitCode }),
        };
        lastFailure = { stage: "execution", category: p.report?.category ?? (p.errorKind === "kernel" ? "kernel_error" : undefined), reason: p.message };
        break;
      }
      case "subagent.dispatched": {
        sawExecution = true;
        const execution: AuditExecution = {
          stepId: p.stepId,
          workOrderId: p.workOrderId,
          agentId: p.adapterId,
          providerId: p.providerId,
          startedAt: event.occurredAt,
          progressEvents: 0,
          outcome: "unfinished",
        };
        record.executions.push(execution);
        open.set(`${p.stepId}/${p.workOrderId}`, execution);
        break;
      }
      case "subagent.progress": {
        const execution = open.get(`${p.stepId}/${p.workOrderId}`);
        if (execution !== undefined) execution.progressEvents += 1;
        break;
      }
      case "subagent.completed": {
        const execution = findOrder(record, p.workOrderId);
        if (execution !== undefined) closeExecution(execution, event.occurredAt, "completed");
        break;
      }
      case "subagent.failed": {
        const execution = findOrder(record, p.workOrderId);
        if (execution !== undefined) {
          closeExecution(execution, event.occurredAt, "failed");
          execution.failure = {
            message: p.message,
            ...(p.report?.category === undefined ? {} : { category: p.report.category }),
            ...(p.report?.signature === undefined ? {} : { signature: p.report.signature }),
            ...(p.report?.exitCode === undefined ? {} : { exitCode: p.report.exitCode }),
          };
        }
        lastFailure = { stage: "execution", category: p.report?.category, reason: p.message };
        break;
      }
      case "evidence.recorded":
        record.evidence.push({ stepId: p.stepId, kind: p.kind, producedBy: p.producedBy, locator: p.locator, summary: p.summary });
        // A step that recorded evidence and reached the next state completed. 记录了证据且继续推进的步骤视为完成。
        break;
      case "verification.completed":
        record.verification = {
          passed: p.passed === true,
          needsReview: p.needsReview === true,
          unverifiedCriteria: Array.isArray(p.unverifiedCriteria) ? p.unverifiedCriteria : [],
          summary: p.summary,
        };
        if (p.passed !== true && p.needsReview !== true) lastFailure = { stage: "verification", reason: p.summary };
        break;
      case "run.status_changed":
        record.status = p.status;
        // The run moving past execution is the only end marker a successful single-agent
        // step leaves, so it closes the step's time window.
        // 对成功的单 Agent 步骤来说，Run 离开执行阶段是它唯一留下的结束标记，用它闭合时间窗口。
        if (["verifying", "waiting_review", "completed", "failed", "cancelled"].includes(p.status)) {
          for (const execution of record.executions) {
            if (execution.endedAt === undefined && execution.startedAt !== undefined) {
              execution.endedAt = event.occurredAt;
              execution.durationMs = Date.parse(event.occurredAt) - Date.parse(execution.startedAt);
            }
          }
        }
        if (["completed", "failed", "cancelled"].includes(p.status)) record.endedAt = event.occurredAt;
        if (p.status === "cancelled") lastFailure = { stage: "cancelled", reason: p.reason };
        if (p.status === "failed" && typeof p.reason === "string") lastFailure = { stage: lastFailure?.stage ?? "unknown", ...lastFailure, reason: p.reason };
        break;
      default:
        break;
    }
  }

  // A step that finished without a failure event and has evidence completed.
  // 没有失败事件且有证据的步骤视为完成。
  for (const execution of record.executions) {
    if (execution.outcome === "unfinished" && record.evidence.some((item) => item.stepId === execution.stepId)
      && record.status !== "running" && record.status !== "queued") {
      execution.outcome = "completed";
    }
  }
  if (record.createdAt !== undefined && record.endedAt !== undefined) {
    record.durationMs = Date.parse(record.endedAt) - Date.parse(record.createdAt);
  }
  record.outcome = { status: record.status, failureStage: "none" };
  if (record.status === "failed" || record.status === "cancelled") {
    const stage: FailureStage = lastFailure?.stage ?? (sawExecution ? "unknown" : "planning");
    record.outcome = {
      status: record.status,
      failureStage: stage,
      ...(lastFailure?.category === undefined ? {} : { failureCategory: lastFailure.category }),
      // A failed run with no recorded reason is itself a finding, not a blank. 没有记录原因的失败 Run 本身就是一项发现，而不是空白。
      reason: lastFailure?.reason ?? "No failure reason was journaled for this run.",
    };
  }
  record.digest = digestEvents(sorted);
  return record;
}

function ensureExecution(record: RunAuditRecord, stepId: string, agentId?: string): AuditExecution {
  const existing = record.executions.find((execution) => execution.stepId === stepId && execution.workOrderId === undefined);
  if (existing !== undefined) return existing;
  const created: AuditExecution = { stepId, ...(agentId === undefined ? {} : { agentId }), progressEvents: 0, outcome: "unfinished" };
  record.executions.push(created);
  return created;
}

function findOrder(record: RunAuditRecord, workOrderId: string): AuditExecution | undefined {
  return [...record.executions].reverse().find((execution) => execution.workOrderId === workOrderId);
}

function closeExecution(execution: AuditExecution, at: string, outcome: "completed" | "failed"): void {
  execution.endedAt = at;
  execution.outcome = outcome;
  if (execution.startedAt !== undefined) execution.durationMs = Date.parse(at) - Date.parse(execution.startedAt);
}

/** Canonical digest: event identity and content only, so it is stable across re-reads. 规范化摘要：只含事件身份与内容，重读结果稳定。 */
export function digestEvents(events: readonly JournalEvent[]): string {
  const hash = createHash("sha256");
  for (const event of events) hash.update(`${event.sequence}|${event.id}|${event.type}|${event.occurredAt}|${stableJson(event.payload)}\n`);
  return hash.digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Aggregates for eval dashboards: pass rate and failure mix by stage / category / provider. 评估面板用的聚合：通过率，以及按阶段 / 类别 / Provider 的失败构成。 */
export function summarizeAudits(records: readonly RunAuditRecord[]): {
  runs: number;
  byStatus: Record<string, number>;
  byFailureStage: Record<string, number>;
  byFailureCategory: Record<string, number>;
  byProvider: Record<string, { runs: number; failed: number; completed: number; medianDurationMs: number | null }>;
} {
  const count = (target: Record<string, number>, key: string): void => { target[key] = (target[key] ?? 0) + 1; };
  const summary = { runs: records.length, byStatus: {} as Record<string, number>, byFailureStage: {} as Record<string, number>, byFailureCategory: {} as Record<string, number>, byProvider: {} as Record<string, { runs: number; failed: number; completed: number; medianDurationMs: number | null }> };
  const durations = new Map<string, number[]>();
  for (const record of records) {
    count(summary.byStatus, record.status);
    if (record.outcome.failureStage !== "none") count(summary.byFailureStage, record.outcome.failureStage);
    if (record.outcome.failureCategory !== undefined) count(summary.byFailureCategory, record.outcome.failureCategory);
    for (const provider of new Set(record.executions.map((execution) => execution.providerId).filter((id): id is string => id !== undefined))) {
      const entry = (summary.byProvider[provider] ??= { runs: 0, failed: 0, completed: 0, medianDurationMs: null });
      entry.runs += 1;
      if (record.status === "failed") entry.failed += 1;
      if (record.status === "completed") entry.completed += 1;
      if (record.durationMs !== undefined) durations.set(provider, [...(durations.get(provider) ?? []), record.durationMs]);
    }
  }
  for (const [provider, list] of durations) {
    const sorted = [...list].sort((a, b) => a - b);
    summary.byProvider[provider]!.medianDurationMs = sorted[Math.floor(sorted.length / 2)] ?? null;
  }
  return summary;
}

/**
 * Adds gateway usage to executions that have a closed time window. Pure over its
 * inputs (rows are passed in), so it is testable without a gateway.
 * 给有闭合时间窗口的执行附上网关用量。对输入是纯函数（行数据由外部传入），无需网关即可测试。
 */
export function attachGatewayUsage(records: RunAuditRecord[], rows: readonly GatewayRequestRow[]): RunAuditRecord[] {
  for (const record of records) {
    for (const execution of record.executions) {
      if (execution.providerId === undefined || execution.startedAt === undefined || execution.endedAt === undefined) continue;
      const usage = usageForWindow(rows, { providerId: execution.providerId, startedAt: execution.startedAt, endedAt: execution.endedAt });
      if (usage !== undefined) execution.gatewayUsage = usage;
    }
  }
  return records;
}
