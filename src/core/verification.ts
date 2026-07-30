import type { Verifier, VerificationResult } from "./contracts.ts";

/**
 * The initial verifier checks that every planned step produced observable
 * evidence. Production verifiers should additionally inspect real artifacts,
 * tool receipts, tests, and connector-specific effects.
 *
 * 初版 Verifier 只检查每个计划步骤是否产生可观察的 Evidence。生产级 Verifier 还必须
 * 深入检查真实 Artifact、Tool Receipt、测试结果和连接器造成的真实效果。
 */
export class EvidenceVerifier implements Verifier {
  async verify(input: Parameters<Verifier["verify"]>[0]): Promise<VerificationResult> {
    const missing = input.plan.steps.filter((step) => {
      const stepEvidence = input.evidence.filter((item) => item.stepId === step.id);
      if (stepEvidence.length === 0) return true;
      if (step.risk === "external_side_effect" || step.risk === "irreversible") {
        return !stepEvidence.some((item) => item.kind === "receipt" && item.locator !== undefined);
      }
      return false;
    });

    return {
      runId: input.run.id,
      passed: missing.length === 0,
      summary:
        missing.length === 0
          ? "Every planned step has the evidence required for its risk class."
          : `Missing required evidence for: ${missing.map((step) => step.title).join(", ")}`,
      checkedEvidenceIds: input.evidence.map((item) => item.id),
      createdAt: new Date().toISOString(),
    };
  }
}
