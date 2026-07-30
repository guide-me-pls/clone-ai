import type { PolicyDecision, PolicyEngine } from "./contracts.ts";

/**
 * Default policy deliberately errs on the side of preparation. A caller may
 * replace this engine with personal policy, budgets, connector scopes, or a
 * human approval UI without changing the execution runtime.
 *
 * 默认 Policy 有意偏向“先准备、后执行”。调用者可以替换为个人 Policy、Budget、Connector
 * Scope 或人工审批 UI，而无需改动执行 Runtime。
 */
export class DefaultPolicyEngine implements PolicyEngine {
  evaluate(input: Parameters<PolicyEngine["evaluate"]>[0]): PolicyDecision {
    if (input.approved) {
      return { outcome: "allowed", reason: "The user approved this exact plan step." };
    }

    switch (input.step.risk) {
      case "read_only":
      case "reversible_write":
        return { outcome: "allowed", reason: "The step is local and reversible." };
      case "external_side_effect":
        return { outcome: "approval_required", reason: "The step can affect an external system." };
      case "irreversible":
        return { outcome: "approval_required", reason: "The step is irreversible or hard to undo." };
    }
  }
}
