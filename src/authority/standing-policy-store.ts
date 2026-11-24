/**
 * Owner-authored authority: per-domain autonomy levels and standing policies.
 *
 * Only the owner (through the desktop app) writes here. There is deliberately no tool that
 * lets the Main Agent or a worker change it, so authority can never be widened
 * by the party that benefits from it. Every change is also journaled, so "who
 * allowed that, and when?" always has an answer.
 *
 * 所有者撰写的权限：按域的自主档位与常设策略。
 *
 * 只有所有者（通过桌面 App）会写这里。刻意没有任何工具允许 Main Agent 或 Worker 修改它，
 * 因此权限永远不会被受益方自己放宽。每次变更也写入 Journal，"谁在何时允许了这件事"
 * 永远有答案。
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { readJsonFile, writeJsonAtomic } from "../config/json-file.ts";
import type { JournalStore } from "../core/journal.ts";
import {
  DOMAINS,
  ENFORCED_DOMAINS,
  isAutonomy,
  isDomain,
  parseScope,
  type Autonomy,
  type Domain,
  type Scope,
} from "./scope.ts";

export interface StandingPolicy {
  id: string;
  /** Owner's own words for why this exists. 所有者自己写的用途说明。 */
  label: string;
  scopes: Scope[];
  /** Highest autonomy this policy may confer on the scopes it covers. 该策略对其覆盖范围可授予的最高自主档位。 */
  maxAutonomy: Autonomy;
  createdAt: string;
  validFrom?: string;
  validUntil?: string;
  revokedAt?: string;
}

export interface AuthorityConfig {
  version: 1;
  /**
   * Owner-set autonomy levels. An absent enforced domain is `allow_all` (see
   * DEFAULT_DOMAIN_AUTONOMY); an absent reserved domain is never grantable.
   * 所有者设定的档位。已强制域缺省为 `allow_all`（见 DEFAULT_DOMAIN_AUTONOMY）；
   * 保留域缺省也不可授予。
   */
  domains: Partial<Record<Domain, Autonomy>>;
  policies: StandingPolicy[];
}

/**
 * The level a domain has when `policies.json` does not name it.
 *
 * The owner chose 全部放行 as the standard for files, shell and network: the
 * model needs no per-target scope, and external/irreversible work does not stop
 * for a confirmation. Protected locations, unenforced domains and the
 * `.git`/`.rsi` write guards still hold. `observe` and `prepare` remain valid
 * for legacy configs and for the corrupt-file fail-closed value, but the UI
 * does not offer them.
 *
 * 当 `policies.json` 没有点名某个域时的自主档位。
 *
 * 所有者选择「全部放行」作为 files/shell/network 的标准：模型无需逐目标 Scope，外部与
 * 不可逆工作也不再停下确认。受保护位置、未实现强制的域、`.git`/`.rsi` 写入守卫仍然有效。
 * `observe` 与 `prepare` 仍对旧配置和损坏文件的 fail-closed 值有效，但 UI 不再提供。
 */
export const DEFAULT_DOMAIN_AUTONOMY: Autonomy = "allow_all";

/** The effective level for a domain: the owner's entry, else the default. 域的有效档位：所有者的显式值，否则默认值。 */
export function autonomyFor(config: AuthorityConfig, domain: Domain): Autonomy {
  return config.domains[domain] ?? DEFAULT_DOMAIN_AUTONOMY;
}

/** No owner-authored policies. A fresh install still has the allow_all domain default. 没有所有者策略；新安装仍使用 allow_all 域默认值。 */
export const EMPTY_AUTHORITY: AuthorityConfig = { version: 1, domains: {}, policies: [] };

/**
 * A present but unreadable `policies.json` must fail closed. The default
 * `allow_all` is for an absent file; corruption is not the owner's silence.
 * 存在但无法读取的 `policies.json` 必须 fail closed。`allow_all` 默认值只用于文件不存在；
 * 文件损坏不等于所有者没有表态。
 */
const FAIL_CLOSED_AUTHORITY: AuthorityConfig = {
  version: 1,
  domains: { files: "observe", shell: "observe", network: "observe" },
  policies: [],
};

export function policyIsActive(policy: StandingPolicy, now: Date): boolean {
  if (policy.revokedAt !== undefined) return false;
  if (policy.validFrom !== undefined && now < new Date(policy.validFrom)) return false;
  if (policy.validUntil !== undefined && now >= new Date(policy.validUntil)) return false;
  return true;
}

export class StandingPolicyStore {
  readonly #file: string;
  readonly #journal: JournalStore | undefined;
  #config: AuthorityConfig = EMPTY_AUTHORITY;
  #mtime = -1;
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string, journal?: JournalStore) {
    this.#file = join(dataDirectory, "policies.json");
    this.#journal = journal;
  }

  /** Synchronous view for the policy engine, whose contract is synchronous. Policy 引擎的契约是同步的，因此提供同步视图。 */
  snapshot(): AuthorityConfig {
    // The CLI edits the same file from another process; a changed mtime makes the
    // daemon pick that up on the very next evaluation, so a revoke is never stale.
    // CLI 会在另一个进程里编辑同一个文件；mtime 变化让守护进程在下一次评估时就读到，撤销因此不会过期。
    try {
      const mtime = statSync(this.#file).mtimeMs;
      if (mtime !== this.#mtime) {
        this.#config = normalize(JSON.parse(readFileSync(this.#file, "utf8")) as Partial<AuthorityConfig>);
        this.#mtime = mtime;
      }
    } catch (error: unknown) {
      // A missing file means the default authority. A corrupt one must not
      // silently serve the permissive default, so it fails closed to observe.
      // 文件不存在表示使用默认权限。文件损坏时不能悄悄使用宽松默认，因此 fail closed 到
      // observe。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#config = EMPTY_AUTHORITY;
        this.#mtime = -1;
      } else {
        this.#config = FAIL_CLOSED_AUTHORITY;
        this.#mtime = -2;
      }
    }
    return this.#config;
  }

  async load(): Promise<AuthorityConfig> {
    const value = await readJsonFile<Partial<AuthorityConfig>>(this.#file);
    this.#config = normalize(value);
    try { this.#mtime = statSync(this.#file).mtimeMs; } catch { this.#mtime = -1; }
    return this.#config;
  }

  async setDomainLevel(domain: Domain, level: Autonomy): Promise<AuthorityConfig> {
    if (!isDomain(domain)) throw new Error(`Unknown domain: ${String(domain)}.`);
    if (!isAutonomy(level)) throw new Error(`Unknown autonomy level: ${String(level)}.`);
    return this.#mutate((current) => ({
      next: { ...current, domains: { ...current.domains, [domain]: level } },
      change: "domain_level_set",
      detail: { domain, from: autonomyFor(current, domain), to: level },
    }));
  }

  async addPolicy(input: {
    label: string;
    scopes: unknown;
    maxAutonomy: Autonomy;
    validFrom?: string;
    validUntil?: string;
  }, now = new Date()): Promise<StandingPolicy> {
    if (typeof input.label !== "string" || input.label.trim().length === 0) throw new Error("A policy needs a label.");
    if (!isAutonomy(input.maxAutonomy)) throw new Error("A policy needs a valid maxAutonomy.");
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) throw new Error("A policy needs at least one scope.");
    const scopes = input.scopes.map((scope, index) => parseScope(scope, `scopes[${index}]`));
    for (const [name, value] of [["validFrom", input.validFrom], ["validUntil", input.validUntil]] as const) {
      if (value !== undefined && Number.isNaN(new Date(value).getTime())) throw new Error(`${name} must be an ISO date.`);
    }
    const policy: StandingPolicy = {
      id: randomUUID(),
      label: input.label.trim(),
      scopes,
      maxAutonomy: input.maxAutonomy,
      createdAt: now.toISOString(),
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
    };
    await this.#mutate((current) => ({
      next: { ...current, policies: [...current.policies, policy] },
      change: "policy_added",
      detail: { policyId: policy.id, label: policy.label, maxAutonomy: policy.maxAutonomy, scopes: policy.scopes },
    }));
    return policy;
  }

  /** Revocation keeps the record: an audit trail must outlive the permission. 撤销保留记录：审计轨迹必须比权限活得久。 */
  async revokePolicy(id: string, now = new Date()): Promise<StandingPolicy> {
    let revoked: StandingPolicy | undefined;
    await this.#mutate((current) => {
      const existing = current.policies.find((policy) => policy.id === id);
      if (existing === undefined) throw new Error(`Unknown policy: ${id}.`);
      if (existing.revokedAt !== undefined) {
        revoked = existing;
        return undefined;
      }
      revoked = { ...existing, revokedAt: now.toISOString() };
      return {
        next: { ...current, policies: current.policies.map((policy) => (policy.id === id ? revoked! : policy)) },
        change: "policy_revoked",
        detail: { policyId: id, label: existing.label },
      };
    });
    return revoked!;
  }

  /**
   * Apply a change to the freshest on-disk config, inside the write queue.
   *
   * The mutators used to compute `next` from the in-memory copy before
   * enqueuing, so an interleaved write from another process (a hand edit, or a
   * second daemon sharing this file) was silently reverted: a revoke could
   * reappear as active. Reading inside the queue makes the last write win on
   * the real content, which is what "only the owner writes here" assumes.
   * 在写队列内把变更应用到磁盘上最新的配置。
   *
   * 变更方法过去在入队前就基于内存副本算出 `next`，因此来自另一个进程（手工编辑，或共享
   * 此文件的第二个守护进程）的交错写入会被静默回滚：被撤销的策略可能重新变为生效。在队列内
   * 读取，使最后一次写入作用于真实内容，这正是"只有所有者写这里"所假设的前提。
   */
  async #mutate(
    build: (current: AuthorityConfig) => { next: AuthorityConfig; change: string; detail: Record<string, unknown> } | undefined,
  ): Promise<AuthorityConfig> {
    let result: AuthorityConfig = this.#config;
    const write = this.#writes.then(async () => {
      // A missing file is "no authority granted yet", the same meaning
      // `snapshot()` gives it.
      // 文件不存在表示"尚未授权"，与 `snapshot()` 的含义一致。
      let current: AuthorityConfig = EMPTY_AUTHORITY;
      try {
        current = normalize(JSON.parse(readFileSync(this.#file, "utf8")) as Partial<AuthorityConfig>);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const change = build(current);
      if (change === undefined) { result = current; return; }
      await writeJsonAtomic(this.#file, change.next);
      this.#config = change.next;
      this.#mtime = statSync(this.#file).mtimeMs;
      await this.#journal?.append({ type: "authority.changed", payload: { change: change.change, ...change.detail } });
      result = change.next;
    });
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
    return result;
  }

  async #persist(next: AuthorityConfig, change: string, detail: Record<string, unknown>): Promise<void> {
    const write = this.#writes.then(async () => {
      await writeJsonAtomic(this.#file, next);
      this.#config = next;
      this.#mtime = statSync(this.#file).mtimeMs;
      await this.#journal?.append({
        type: "authority.changed",
        payload: { change, ...detail },
      });
    });
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
  }
}

/**
 * Parse an owner-written config. It must fail loudly on a semantic problem:
 * silently dropping an invalid domain or a non-array `policies` used to mean
 * "observe", but with the `allow_all` default it would mean "unrestricted".
 * The live snapshot turns a thrown error into FAIL_CLOSED_AUTHORITY; startup
 * load and owner edits propagate it.
 * 解析所有者撰写的配置。语义错误必须显式失败：悄悄丢掉非法域或非数组的 `policies`
 * 过去等于"只观察"，但在 `allow_all` 默认值下会等于"无限制"。运行中的快照会把抛出的
 * 错误转成 FAIL_CLOSED_AUTHORITY；启动加载与所有者编辑则直接抛出。
 */
function normalize(value: Partial<AuthorityConfig> | undefined): AuthorityConfig {
  if (value !== undefined && (typeof value !== "object" || value === null)) {
    throw new Error("policies.json: the root must be an object.");
  }
  const rawDomains = value?.domains;
  const domains: Partial<Record<Domain, Autonomy>> = {};
  if (rawDomains !== undefined) {
    if (typeof rawDomains !== "object" || rawDomains === null || Array.isArray(rawDomains)) {
      throw new Error("policies.json: domains must be an object.");
    }
    for (const [domain, level] of Object.entries(rawDomains)) {
      if (!isDomain(domain)) throw new Error(`policies.json: unknown domain "${domain}".`);
      if (!isAutonomy(level)) throw new Error(`policies.json: ${domain} has an invalid autonomy level.`);
      domains[domain] = level;
    }
  }
  if (value?.policies !== undefined && !Array.isArray(value.policies)) {
    throw new Error("policies.json: policies must be an array.");
  }
  const policies = (value?.policies ?? []).map((policy, index) => normalizePolicy(policy, index));
  return { version: 1, domains, policies };
}

function normalizePolicy(value: StandingPolicy, index: number): StandingPolicy {
  // A corrupt policy must fail loudly rather than silently widen or drop authority.
  // 损坏的策略必须显式失败，而不是悄悄放宽或丢弃权限。
  if (typeof value?.id !== "string" || !isAutonomy(value.maxAutonomy) || !Array.isArray(value.scopes)) {
    throw new Error(`policies.json: policy ${index} is malformed.`);
  }
  return {
    ...value,
    scopes: value.scopes.map((scope, scopeIndex) => parseScope(scope, `policies[${index}].scopes[${scopeIndex}]`)),
  };
}

/** Plain-text summary shared by the Main Agent tool and the CLI. Main Agent 工具与 CLI 共用的纯文本摘要。 */
export function describeAuthority(config: AuthorityConfig, now = new Date()): string {
  const lines = ["Autonomy by domain (observe < prepare < act_with_approval < act_auto < allow_all; allow_all is the default: no scope requirement and no external confirmation, protected locations stay closed):"];
  for (const domain of DOMAINS) {
    const level = (ENFORCED_DOMAINS as readonly Domain[]).includes(domain)
      ? autonomyFor(config, domain)
      : config.domains[domain] ?? "observe";
    lines.push(`- ${domain}: ${level}`);
  }
  lines.push("", "Protected locations, unenforced domains and .git/.rsi writes still stop regardless of autonomy.");
  const active = config.policies.filter((policy) => policyIsActive(policy, now));
  lines.push("", active.length === 0 ? "No active standing policies (optional; not required at 全部放行)." : "Active standing policies (optional; a lower ceiling narrows a scope):");
  for (const policy of active) {
    const scopes = policy.scopes.map((scope) => `${scope.domain}:${scope.access}:${scope.resource}`).join(", ");
    const until = policy.validUntil === undefined ? "" : ` until ${policy.validUntil}`;
    lines.push(`- ${policy.id} "${policy.label}" max ${policy.maxAutonomy}${until}: ${scopes}`);
  }
  return lines.join("\n");
}
