import type { Verifier, VerificationResult } from "./contracts.ts";

/**
 * The initial verifier checks that every planned step produced observable
 * evidence. Production verifiers should additionally inspect real artifacts,
 * tool receipts, tests, and connector-specific effects.
 */
export class EvidenceVerifier implements Verifier {
  async verify(input: Parameters<Verifier["verify"]>[0]): Promise<VerificationResult> {
    const completedStepIds = new Set(input.evidence.map((item) => item.stepId));
    const missing = input.plan.steps.filter((step) => !completedStepIds.has(step.id));

    return {
      runId: input.run.id,
      passed: missing.length === 0,
      summary:
        missing.length === 0
          ? "Every planned step has at least one evidence record."
          : `Missing evidence for: ${missing.map((step) => step.title).join(", ")}`,
      checkedEvidenceIds: input.evidence.map((item) => item.id),
      createdAt: new Date().toISOString(),
    };
  }
}
