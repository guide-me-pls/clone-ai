/**
 * Scope-aware policy: the autonomy ladder and standing policies applied to a
 * step. It wraps the risk-based default rather than replacing it, so a step can
 * only become *less* restricted by an explicit owner policy, never by omission.
 *
 * 带 Scope 感知的 Policy：把自主阶梯与常设策略应用到一个步骤上。它包裹而不是取代基于风险的
 * 默认规则，因此步骤只可能因所有者明确的策略而变得更宽松，绝不会因为遗漏而宽松。
 *
 * Order of precedence, strongest first:
 *   1. a forbidden location, or a domain with no enforcement → denied
 *   2. a write/exec in a domain still at `observe`            → denied
 *   3. the risk-based default (external / irreversible)        → approval_required
 *   4. a scope with no `act_auto` standing policy              → approval_required
 *   5. otherwise                                                → allowed
 * An owner approval lifts 3 and 4, never 1 or 2.
 * 优先级由强到弱：禁区或未实现强制的域 → denied；仍处于 observe 的域里写/执行 → denied；
 * 基于风险的默认（external / irreversible）→ approval_required；没有 act_auto 常设策略覆盖的
 * Scope → approval_required；其余放行。所有者审批能解除 3 和 4，解除不了 1 和 2。
 */
import type { PolicyDecision, PolicyEngine } from "../core/contracts.ts";
import { DefaultPolicyEngine } from "../core/policy.ts";
import {
  autonomyRank,
  ENFORCED_DOMAINS,
  isForbiddenPath,
  maxAutonomy,
  minAutonomy,
  scopeCovers,
  type Autonomy,
  type Scope,
} from "./scope.ts";
import { policyIsActive, type AuthorityConfig } from "./standing-policy-store.ts";

type Verdict = NonNullable<PolicyDecision["scopeVerdicts"]>[number];

export interface AuthorityPolicyOptions {
  /** Read on every evaluation so a revoke takes effect on the very next step. 每次评估都读取，撤销在下一个步骤即生效。 */
  config: () => AuthorityConfig;
  now?: () => Date;
  home?: string;
}

export class AuthorityPolicyEngine implements PolicyEngine {
  readonly #config: () => AuthorityConfig;
  readonly #now: () => Date;
  readonly #home: string | undefined;
  readonly #base = new DefaultPolicyEngine();

  constructor(options: AuthorityPolicyOptions) {
    this.#config = options.config;
    this.#now = options.now ?? (() => new Date());
    this.#home = options.home;
  }

  evaluate(input: Parameters<PolicyEngine["evaluate"]>[0]): PolicyDecision {
    const scopes = input.step.scopes ?? [];
    const base = this.#base.evaluate({ ...input, approved: false });
    if (scopes.length === 0) return this.#base.evaluate(input);

    const config = this.#config();
    const now = this.#now();
    const verdicts = scopes.map((scope) => this.#judge(scope, config, now));
    const denied = verdicts.find((verdict) => verdict.outcome === "denied");
    if (denied !== undefined) {
      return { outcome: "denied", reason: denied.reason, scopeVerdicts: verdicts };
    }
    const needsApproval = base.outcome === "approval_required"
      || verdicts.some((verdict) => verdict.outcome === "approval_required");
    if (needsApproval && !input.approved) {
      const why = base.outcome === "approval_required"
        ? base.reason
        : verdicts.find((verdict) => verdict.outcome === "approval_required")?.reason ?? "Owner approval is required.";
      return { outcome: "approval_required", reason: why, scopeVerdicts: verdicts };
    }
    const policyIds = [...new Set(verdicts.flatMap((verdict) => verdict.policyIds ?? []))];
    return {
      outcome: "allowed",
      reason: needsApproval
        ? "The owner approved this exact step within its declared scopes."
        : "Every declared scope is covered by an act_auto standing policy.",
      ...(policyIds.length === 0 ? {} : { policyIds }),
      scopeVerdicts: verdicts,
    };
  }

  #judge(scope: Scope, config: AuthorityConfig, now: Date): Verdict & { policyIds?: string[] } {
    const verdict = (outcome: Verdict["outcome"], reason: string, policyIds?: string[]) => ({
      scope,
      outcome,
      reason,
      ...(policyIds === undefined || policyIds.length === 0 ? {} : { policyIds }),
    });

    if (!ENFORCED_DOMAINS.includes(scope.domain)) {
      return verdict("denied", `The ${scope.domain} domain has no enforcement yet, so it cannot be granted.`);
    }
    if (scope.domain === "files" && isForbiddenPath(scope.resource, this.#home)) {
      return verdict("denied", `${scope.resource} is a protected location that no policy can open.`);
    }

    const domainLevel: Autonomy = config.domains[scope.domain] ?? "observe";
    const covering = config.policies.filter((policy) => policyIsActive(policy, now)
      && policy.scopes.some((grant) => scopeCovers(grant, scope, this.#home)));

    if (scope.access !== "read" && domainLevel === "observe") {
      return verdict("denied", `The ${scope.domain} domain is observe-only; raise its autonomy to allow ${scope.access}.`);
    }
    if (covering.length === 0) {
      return verdict("approval_required", `No standing policy covers ${scope.access} on ${scope.resource}.`);
    }
    const ceiling = covering.reduce<Autonomy>((best, policy) => maxAutonomy(best, policy.maxAutonomy), "observe");
    const effective = minAutonomy(domainLevel, ceiling);
    const ids = covering.map((policy) => policy.id);

    if (scope.access === "read" && autonomyRank(effective) >= autonomyRank("observe")) {
      return verdict("allowed", "A standing policy covers this read.", ids);
    }
    if (effective === "act_auto") {
      return verdict("allowed", "An act_auto standing policy covers this scope.", ids);
    }
    if (autonomyRank(effective) <= autonomyRank("observe")) {
      return verdict("denied", `Standing policies only allow observing ${scope.resource}.`);
    }
    return verdict("approval_required", `Autonomy for ${scope.resource} is ${effective}; owner approval is required.`);
  }
}
