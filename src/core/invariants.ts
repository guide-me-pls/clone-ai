import type {
  ApprovalGrant,
  Evidence,
  JournalEvent,
  RiskClass,
  SubagentRun,
  VerificationResult,
  WorkPlan,
} from "./contracts.ts";

export interface InvariantViolation {
  /** Stable identifier of the violated constraint. 被违反约束的稳定标识。 */
  invariant:
    | "evidence-before-completion"
    | "approval-before-external-execution"
    | "verification-before-run-completion"
    | "evidence-kind-authorized";
  sequence: number;
  runId?: string;
  message: string;
}

/**
 * Replays a whole journal and checks the cross-event constraints that no
 * single state machine enforces. Projectors reject illegal local transitions;
 * these invariants reject illegal histories, so a corrupted store, a buggy
 * adapter, or a future migration cannot silently produce a world that the
 * README's unbreakable constraints forbid.
 *
 * 重放整本 Journal，检查任何单个状态机都不负责的跨事件约束。Projector 拒绝非法的局部转移；
 * 这些不变量拒绝非法的历史，使损坏的存储、有缺陷的 Adapter 或未来的迁移都无法悄悄产出
 * README 不可破坏约束所禁止的世界。
 *
 * Checked invariants:
 * 1. evidence-before-completion — no work order completes without recorded
 *    evidence for that work order (constraint 5: no agent marks its own work done).
 * 2. approval-before-external-execution — no external or irreversible step
 *    starts executing before an approval grant (constraint 3: prediction is
 *    never authority).
 * 3. verification-before-run-completion — no run reaches "completed" without
 *    a passed verification (constraint 6: every action has an evidence path).
 * 4. evidence-kind-authorized — every recorded evidence kind must be inside
 *    the authorization snapshot journaled at dispatch time (constraint 5 again:
 *    a worker cannot mint receipts its adapter was never granted). Histories
 *    that predate authorization snapshots are skipped, not failed.
 */
export function checkJournalInvariants(events: readonly JournalEvent[]): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);

  const stepRisks = new Map<string, Map<string, RiskClass>>();
  const approvedSteps = new Map<string, Set<string>>();
  const evidencedWorkOrders = new Map<string, Set<string>>();
  const verifiedRuns = new Set<string>();
  const authorizedKinds = new Map<string, Set<string>>();

  const key = (runId: string | undefined): string => runId ?? "";
  const stepAuthorizationKey = (runId: string | undefined, stepId: string): string => `${key(runId)}:step:${stepId}`;
  const workOrderAuthorizationKey = (runId: string | undefined, workOrderId: string): string => `${key(runId)}:wo:${workOrderId}`;

  for (const event of sorted) {
    switch (event.type) {
      case "plan.created": {
        const plan = event.payload as WorkPlan;
        const risks = stepRisks.get(key(event.runId)) ?? new Map<string, RiskClass>();
        for (const step of plan.steps ?? []) risks.set(step.id, step.risk);
        stepRisks.set(key(event.runId), risks);
        break;
      }
      case "approval.granted": {
        const approval = event.payload as ApprovalGrant;
        const granted = approvedSteps.get(key(event.runId)) ?? new Set<string>();
        granted.add(approval.stepId);
        approvedSteps.set(key(event.runId), granted);
        break;
      }
      case "evidence.recorded": {
        const evidence = event.payload as Evidence;
        if (evidence.workOrderId !== undefined) {
          const seen = evidencedWorkOrders.get(key(event.runId)) ?? new Set<string>();
          seen.add(evidence.workOrderId);
          evidencedWorkOrders.set(key(event.runId), seen);
        }
        const authorization = evidence.workOrderId !== undefined
          ? authorizedKinds.get(workOrderAuthorizationKey(event.runId, evidence.workOrderId))
          : authorizedKinds.get(stepAuthorizationKey(event.runId, evidence.stepId));
        if (authorization !== undefined && !authorization.has(evidence.kind)) {
          violations.push({
            invariant: "evidence-kind-authorized",
            sequence: event.sequence,
            runId: event.runId,
            message: `Evidence kind "${evidence.kind}" was recorded, but the dispatch-time authorization only allowed: ${[...authorization].join(", ")}.`,
          });
        }
        break;
      }
      case "execution.started":
      case "subagent.dispatched":
      case "subagent.resumed": {
        const payload = event.payload as Partial<SubagentRun> & {
          stepId?: string;
          workOrderId?: string;
          authorizedEvidenceKinds?: string[];
        };
        const stepId = payload.stepId;
        if (stepId === undefined) break;
        if (payload.authorizedEvidenceKinds !== undefined) {
          const authorization = new Set(payload.authorizedEvidenceKinds);
          if (payload.workOrderId !== undefined) {
            authorizedKinds.set(workOrderAuthorizationKey(event.runId, payload.workOrderId), authorization);
          } else {
            authorizedKinds.set(stepAuthorizationKey(event.runId, stepId), authorization);
          }
        }
        const risk = stepRisks.get(key(event.runId))?.get(stepId);
        const needsApproval = risk === "external_side_effect" || risk === "irreversible";
        if (needsApproval && !(approvedSteps.get(key(event.runId))?.has(stepId) ?? false)) {
          violations.push({
            invariant: "approval-before-external-execution",
            sequence: event.sequence,
            runId: event.runId,
            message: `Step ${stepId} carries ${String(risk)} risk but started executing before any approval was granted.`,
          });
        }
        break;
      }
      case "subagent.completed": {
        const payload = event.payload as { workOrderId?: string };
        if (payload.workOrderId === undefined) break;
        if (!(evidencedWorkOrders.get(key(event.runId))?.has(payload.workOrderId) ?? false)) {
          violations.push({
            invariant: "evidence-before-completion",
            sequence: event.sequence,
            runId: event.runId,
            message: `Work order ${payload.workOrderId} completed without any recorded evidence.`,
          });
        }
        break;
      }
      case "verification.completed": {
        const verification = event.payload as VerificationResult;
        if (verification.passed) verifiedRuns.add(key(event.runId));
        else verifiedRuns.delete(key(event.runId));
        break;
      }
      case "run.status_changed": {
        const payload = event.payload as { status?: string };
        if (payload.status === "completed" && !verifiedRuns.has(key(event.runId))) {
          violations.push({
            invariant: "verification-before-run-completion",
            sequence: event.sequence,
            runId: event.runId,
            message: "The run was marked completed without a passed verification.",
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return violations;
}

/**
 * Loud variant for tests, migrations, and startup self-checks: an invalid
 * history must stop the world, not power it.
 * 面向测试、迁移与启动自检的大声版本：非法历史必须让世界停下，而不是继续驱动它。
 */
export function assertJournalInvariants(events: readonly JournalEvent[]): void {
  const violations = checkJournalInvariants(events);
  if (violations.length === 0) return;
  const lines = violations.map((violation) => (
    `- [${violation.invariant}] seq ${violation.sequence}${violation.runId === undefined ? "" : ` run ${violation.runId}`}: ${violation.message}`
  ));
  throw new Error(`The journal violates ${violations.length} invariant(s):\n${lines.join("\n")}`);
}
