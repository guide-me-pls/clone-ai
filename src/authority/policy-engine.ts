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
 *   2. a read                                                 → allowed
 *      (reads are machine-wide; only 1 closes them)
 *   3. a write/exec in a domain set to `observe`             → denied
 *      — except a scoped reversible `files` write, which is
 *        `approval_required` and may be approved once
 *   4. the risk-based default (external / irreversible)        → approval_required
 *      — waived when every declared scope's effective level is
 *        `allow_all`; the Runtime records a standing-policy
 *        approval before dispatch, so the invariant still holds
 *   5. a reversible write with no scope: allowed only when the
 *      files domain is `allow_all` and no policy narrows it     → allowed / denied
 *   6. a scope with no covering policy:
 *      domain `act_auto` or `allow_all`                        → allowed
 *   7. a scope covered by a standing policy: the effective
 *      autonomy is min(domain level, the lowest ceiling among
 *      covering policies)                              → allowed / approval / denied
 *      — a restriction is never defeated by a broader
 *        policy with a higher ceiling
 * `allow_all` is the default for files/shell/network: the whole domain is the
 * grant, and the worker receives `/` with the protected-path guard.
 * An owner approval lifts 4 and the scoped reversible files write at 3;
 * never a protected location, an unenforced domain, or a `.git`/`.rsi` write.
 *
 * 优先级由强到弱：禁区或未实现强制的域 → denied；读取 → allowed（读取覆盖整机，只有禁区
 * 关闭它）；档位为 `observe` 的域里写/执行 → denied（带 Scope 的可逆 files 写除外，它是
 * approval_required，可批准一次）；基于风险的默认（external / irreversible）→
 * approval_required——当每个声明 Scope 的有效档位都是 `allow_all` 时豁免，Runtime 在派发前
 * 记录一条策略审批，因此不变量仍成立；无 Scope 的可逆写入只有在 files 为 `allow_all` 且没有
 * 收紧策略时才 allowed；没有覆盖策略的 Scope 在 `act_auto` 或 `allow_all` 域下 allowed；
 * 有覆盖策略的 Scope 取 min(域档位, 覆盖策略中的最低上限) → allowed / 审批 / denied——
 * 更宽、上限更高的策略不会推翻一条显式限制。`allow_all` 是 files/shell/network 的默认值：
 * 整个域就是授权，Worker 拿到 `/`，但受保护路径守卫仍在。所有者审批能解除第 4 条与第 3 条
 * 中的带 Scope 可逆 files 写入，解除不了禁区、未实现强制的域、`.git`/`.rsi` 写入。
 */
import type { PolicyDecision, PolicyEngine } from "../core/contracts.ts";
import { DefaultPolicyEngine } from "../core/policy.ts";
import {
  autonomyRank,
  ENFORCED_DOMAINS,
  isForbiddenPath,
  minAutonomy,
  scopeCovers,
  type Autonomy,
  type Domain,
  type Scope,
} from "./scope.ts";
import { autonomyFor, policyIsActive, type AuthorityConfig } from "./standing-policy-store.ts";

type Verdict = NonNullable<PolicyDecision["scopeVerdicts"]>[number];

/** A scope verdict with the effective level behind it, for the risk-gate decision. 带有效档位的 Scope 判定，供风险闸门决策。 */
type JudgedVerdict = Verdict & { policyIds?: string[]; effectiveLevel?: Autonomy };

/**
 * A domain set to 全部放行 still allows a whole-domain grant only when no
 * active write/exec policy narrows it. A narrowing policy must not be
 * bypassable by a step that simply declares nothing.
 * 设为「全部放行」的域，只有在没有生效中的写/执行收紧策略时才获得全域授权；收紧策略不能
 * 被一个什么都不声明的步骤绕过。
 */
function hasNarrowingWritePolicy(config: AuthorityConfig, domain: Domain, now: Date): boolean {
  return config.policies.some((policy) => policyIsActive(policy, now)
    && autonomyRank(policy.maxAutonomy) < autonomyRank("allow_all")
    && policy.scopes.some((scope) => scope.domain === domain && scope.access !== "read"));
}

/** Enforced domains that are at 全部放行 with no narrowing write/exec policy. 处于全部放行且无收紧写/执行策略的已强制域。 */
function unrestrictedDomainsFor(config: AuthorityConfig, now: Date): Domain[] {
  return ENFORCED_DOMAINS.filter((domain) => autonomyFor(config, domain) === "allow_all"
    && !hasNarrowingWritePolicy(config, domain, now));
}

export interface AuthorityPolicyOptions {
  /** Read on every evaluation so a revoke takes effect on the very next step. 每次评估都读取，撤销在下一个步骤即生效。 */
  config: () => AuthorityConfig;
  now?: () => Date;
  home?: string;
  /**
   * The repair lane's isolated worktree. It is a sandbox the Kernel created and
   * owns, not the owner's machine, so an unscoped write there is not the
   * implicit folder permission the owner removed. Owner-facing runtime
   * assemblies never set this.
   * 修复通道的隔离 worktree。它是由 Kernel 创建并拥有的沙箱，不是所有者的机器，因此那里
   * 的无 Scope 写入不是所有者移除的那种隐式文件夹权限。面向所有者的运行时组装从不设置它。
   */
  writableSandbox?: boolean;
}

export class AuthorityPolicyEngine implements PolicyEngine {
  readonly #config: () => AuthorityConfig;
  readonly #now: () => Date;
  readonly #home: string | undefined;
  readonly #writableSandbox: boolean;
  readonly #base = new DefaultPolicyEngine();

  constructor(options: AuthorityPolicyOptions) {
    this.#config = options.config;
    this.#now = options.now ?? (() => new Date());
    this.#home = options.home;
    this.#writableSandbox = options.writableSandbox === true;
  }

  evaluate(input: Parameters<PolicyEngine["evaluate"]>[0]): PolicyDecision {
    const scopes = input.step.scopes ?? [];
    const config = this.#config();
    const now = this.#now();
    const unrestrictedDomains = unrestrictedDomainsFor(config, now);
    const base = this.#base.evaluate({ ...input, approved: false });
    // A step that writes files in place must name where, unless the owner has
    // set 全部放行 on files with no narrowing policy: then the whole domain is
    // the grant, and the worker receives `/` with the protected-path guard.
    // 原地写文件的步骤必须点名写到哪里；除非所有者把 files 设为「全部放行」且没有收紧策略：
    // 此时整个域就是授权，Worker 拿到 `/`，但受保护路径守卫仍在。
    if (input.step.risk === "reversible_write"
      && !scopes.some((scope) => scope.access !== "read")
      && !this.#writableSandbox) {
      if (!unrestrictedDomains.includes("files")) {
        return {
          outcome: "denied",
          reason: "The step can write but names no write scope; name the exact target, or set the files domain to 全部放行 with no narrowing write policy.",
        };
      }
      return {
        outcome: "allowed",
        reason: "The files domain is 全部放行, so the step may write without naming a scope; protected locations still stop.",
        unrestrictedDomains,
        riskWaived: false,
        scopeVerdicts: [],
      };
    }
    if (scopes.length === 0) {
      // A scoped-less external/irreversible step names no domain that could
      // justify 全部放行; it keeps the base gate. 没有 Scope 的外部/不可逆步骤
      // 不指向任何可据以全部放行的域，保留基础闸门。
      return { ...this.#base.evaluate(input), ...(unrestrictedDomains.length === 0 ? {} : { unrestrictedDomains }) };
    }

    const approvableWrite = input.step.risk === "reversible_write";
    const verdicts: JudgedVerdict[] = scopes.map((scope) => this.#judge(scope, config, now, { approved: input.approved, approvableWrite }));
    const denied = verdicts.find((verdict) => verdict.outcome === "denied");
    if (denied !== undefined) {
      return { outcome: "denied", reason: denied.reason, scopeVerdicts: verdicts };
    }
    const scopeApproval = verdicts.some((verdict) => verdict.outcome === "approval_required");
    // 全部放行 waives the external/irreversible gate only when every declared
    // scope is itself at allow_all with no narrowing policy. A narrower scope
    // keeps the owner's confirmation.
    // 只有当每个声明 Scope 的有效档位都是 allow_all 且无收紧策略时，全部放行才豁免外部/
    // 不可逆闸门；更窄的 Scope 仍保留所有者确认。
    const riskWaived = base.outcome === "approval_required"
      && !input.approved
      && verdicts.every((verdict) => verdict.outcome === "allowed" && verdict.effectiveLevel === "allow_all");
    const needsApproval = (base.outcome === "approval_required" && !riskWaived) || scopeApproval;
    if (needsApproval && !input.approved) {
      const why = base.outcome === "approval_required" && !riskWaived
        ? base.reason
        : verdicts.find((verdict) => verdict.outcome === "approval_required")?.reason ?? "Owner approval is required.";
      return { outcome: "approval_required", reason: why, scopeVerdicts: verdicts };
    }
    const policyIds = [...new Set(verdicts.flatMap((verdict) => verdict.policyIds ?? []))];
    const allModelJudged = verdicts.every((verdict) => verdict.outcome === "allowed" && (verdict.policyIds?.length ?? 0) === 0);
    const someModelJudged = verdicts.some((verdict) => verdict.outcome === "allowed" && (verdict.policyIds?.length ?? 0) === 0);
    // The observe carve-out is an owner approval, not a model judgment; naming
    // act_auto there would put a false reason in the audit.
    // observe 豁免来自所有者审批，不是模型判断；在那里声称 act_auto 会往审计里写假理由。
    const approvalLifted = verdicts.some((verdict) => verdict.outcome === "allowed" && verdict.reason.startsWith("The owner approved"));
    const anyAllowAll = verdicts.some((verdict) => verdict.effectiveLevel === "allow_all");
    return {
      outcome: "allowed",
      reason: needsApproval || approvalLifted
        ? "The owner approved this exact step within its declared scopes."
        : riskWaived
          ? "The owner's 全部放行 autonomy allowed this external/irreversible step without a prompt; protected locations and .git/.rsi writes still stop."
          : allModelJudged && anyAllowAll
            ? "Every declared scope is allowed at 全部放行; protected locations still stop."
            : allModelJudged
              ? "Every declared scope is allowed at act_auto; the model's declared scope is the judgment where no standing policy applies."
              : someModelJudged
                ? "Every declared scope is allowed: the model's judgment covers the scopes at act_auto, and standing policies cover the rest."
                : "Every declared scope is covered by a standing policy within its effective autonomy.",
      ...(policyIds.length === 0 ? {} : { policyIds }),
      ...(unrestrictedDomains.length === 0 ? {} : { unrestrictedDomains }),
      ...(riskWaived ? { riskWaived: true } : {}),
      scopeVerdicts: verdicts,
    };
  }

  #judge(
    scope: Scope,
    config: AuthorityConfig,
    now: Date,
    options: { approved: boolean; approvableWrite: boolean },
  ): JudgedVerdict {
    const verdict = (
      outcome: Verdict["outcome"],
      reason: string,
      extra: { policyIds?: string[]; effectiveLevel?: Autonomy } = {},
    ): JudgedVerdict => ({
      scope,
      outcome,
      reason,
      ...(extra.policyIds === undefined || extra.policyIds.length === 0 ? {} : { policyIds: extra.policyIds }),
      ...(extra.effectiveLevel === undefined ? {} : { effectiveLevel: extra.effectiveLevel }),
    });

    if (!ENFORCED_DOMAINS.includes(scope.domain)) {
      return verdict("denied", `The ${scope.domain} domain has no enforcement yet, so it cannot be granted.`);
    }
    if (scope.domain === "files" && isForbiddenPath(scope.resource, this.#home)) {
      return verdict("denied", `${scope.resource} is a protected location that no policy can open.`);
    }

    const domainLevel: Autonomy = autonomyFor(config, scope.domain);
    // Reads are machine-wide: the task's read tools already admit any
    // non-protected path, so a policy prompt for reading only added friction.
    // 读取覆盖整机：读取工具本来就放行任何非受保护路径，读取策略提示只增加摩擦。
    if (scope.access === "read") {
      return verdict("allowed", "Reads are machine-wide except protected locations.", { effectiveLevel: domainLevel });
    }

    const covering = config.policies.filter((policy) => policyIsActive(policy, now)
      && policy.scopes.some((grant) => scopeCovers(grant, scope, this.#home)));

    if (domainLevel === "observe") {
      // A scoped, reversible files write may be approved once by the owner:
      // the model decided the write inside a target the owner already saw, and
      // the owner supplies the missing authority at the step. Protected paths
      // and every other domain keep the hard denial.
      // 带 Scope 的可逆 files 写入可以由所有者批准一次：模型在所有者已经看到的 target
      // 内决定写入，所有者在步骤上补上缺失的授权。受保护路径与其他域保持硬拒绝。
      if (options.approvableWrite && scope.domain === "files" && scope.access === "write") {
        return options.approved
          ? verdict("allowed", "The owner approved this exact scoped write once; the files domain stays observe-only for every other step.", { effectiveLevel: domainLevel })
          : verdict("approval_required", "The files domain is observe-only; approve this exact scoped step once, or set the files domain to 全部放行 for automatic writes.");
      }
      return verdict("denied", `The ${scope.domain} domain is observe-only; raise its autonomy to allow ${scope.access}.`);
    }
    if (covering.length === 0) {
      // 全部放行 is the owner's explicit whole-domain grant: no per-resource
      // policy is needed. Protected locations were checked above.
      // 「全部放行」是所有者对整个域的显式授权：无需逐资源策略。受保护位置已在上方检查。
      if (domainLevel === "allow_all") {
        return verdict("allowed", `The ${scope.domain} domain is 全部放行; every resource in it is allowed; protected locations still stop.`, { effectiveLevel: domainLevel });
      }
      // The default for act_auto: the plan model already decided what the step
      // does and named the exact scope, so the Kernel's job is the hard
      // boundary, not a second permission authored by the owner.
      // act_auto 下：计划模型已经决定步骤做什么并点名了精确 Scope，Kernel 的职责是硬边界，
      // 而不是再要一份所有者撰写的许可。
      if (domainLevel === "act_auto") {
        return verdict("allowed", `The ${scope.domain} domain is act_auto, so the step's declared ${scope.access} scope is the model's judgment; no standing policy is required.`, { effectiveLevel: domainLevel });
      }
      return verdict("approval_required", `No standing policy covers ${scope.access} on ${scope.resource}.`, { effectiveLevel: domainLevel });
    }
    // The lowest ceiling wins, not the highest: policies are an optional
    // narrowing, and an owner's explicit "observe this subtree" must not be
    // defeated by a broader policy with a higher ceiling. The previous max()
    // union made an explicit restriction unreachable whenever a broader grant
    // also covered the scope.
    // 生效的是最低上限，而不是最高：常设策略现在是一种可选的收紧，所有者明确
    // "只观察这个子树"不能因为另一条覆盖更广、上限更高的策略而失效。此前的 max()
    // 并集会让显式限制在更宽的授权同时覆盖该 Scope 时失效。
    const ceiling = covering.reduce<Autonomy>((lowest, policy) => minAutonomy(lowest, policy.maxAutonomy), "allow_all");
    const effective = minAutonomy(domainLevel, ceiling);
    const ids = covering.map((policy) => policy.id);

    if (effective === "allow_all") {
      return verdict("allowed", "A 全部放行 standing policy covers this scope.", { policyIds: ids, effectiveLevel: effective });
    }
    if (effective === "act_auto") {
      return verdict("allowed", "An act_auto standing policy covers this scope.", { policyIds: ids, effectiveLevel: effective });
    }
    if (autonomyRank(effective) <= autonomyRank("observe")) {
      return verdict("denied", `Standing policies only allow observing ${scope.resource}.`, { effectiveLevel: effective });
    }
    return verdict("approval_required", `Autonomy for ${scope.resource} is ${effective}; owner approval is required.`, { effectiveLevel: effective });
  }
}
