/**
 * The Kernel-side gateway: turns the scopes a step declared into the concrete
 * capability set a worker process may be given, and drops anything that is not
 * safe to hand over. This is the only place scopes become paths and flags, so
 * the sandbox profile never sees a raw, unvetted string from a plan.
 *
 * Kernel 侧网关：把步骤声明的 Scope 变成可交给 Worker 进程的具体能力集合，并丢弃任何不适合
 * 交出去的东西。Scope 只在这里变成路径与开关，因此沙箱 profile 永远看不到计划里未经审查的
 * 原始字符串。
 */
import { homedir } from "node:os";

import { canonicalPath, isForbiddenPath, type Scope } from "./scope.ts";

export interface EffectiveGrants {
  /** Canonical directories/files the process may read in addition to its workspace. 除工作空间外可读的规范路径。 */
  readRoots: string[];
  /** Canonical directories/files the process may write, always including the workspace. 可写的规范路径，始终包含工作空间。 */
  writeRoots: string[];
  /**
   * Seatbelt filters by address, not by host name, so network is all-or-nothing
   * here. A step that names hosts therefore gets open network and the audit
   * record says so, rather than pretending to a precision the OS cannot give.
   * Seatbelt 按地址而非主机名过滤，所以网络在这里只有开或关。点名了主机的步骤因此得到开放
   * 网络，审计记录如实说明，而不是假装有 OS 给不出的精度。
   */
  network: boolean;
  /** Scopes that were refused, with the reason, for the audit trail. 被拒绝的 Scope 及原因，供审计。 */
  dropped: Array<{ scope: Scope; reason: string }>;
}

export function resolveGrants(
  scopes: readonly Scope[] | undefined,
  options: { workspace: string; home?: string },
): EffectiveGrants {
  const home = options.home ?? homedir();
  const workspace = canonicalPath(options.workspace, home);
  const readRoots = new Set<string>();
  const writeRoots = new Set<string>([workspace]);
  let network = false;
  const dropped: EffectiveGrants["dropped"] = [];

  for (const scope of scopes ?? []) {
    if (scope.domain === "files") {
      if (isForbiddenPath(scope.resource, home)) {
        dropped.push({ scope, reason: "protected location" });
        continue;
      }
      const path = canonicalPath(scope.resource, home);
      if (path === "/" || path === home) {
        dropped.push({ scope, reason: "too broad: grant a specific folder, not the root or home directory" });
        continue;
      }
      if (scope.access === "read") readRoots.add(path);
      else writeRoots.add(path);
    } else if (scope.domain === "network") {
      network = true;
    } else if (scope.domain === "shell") {
      // A shell scope is a plan-level statement; the sandbox constrains what any
      // command can touch, so there is nothing further to hand the process.
      // shell Scope 是计划层面的声明；沙箱约束的是任何命令能触碰什么，无需再交给进程什么。
    } else {
      dropped.push({ scope, reason: `the ${scope.domain} domain has no enforcement yet` });
    }
  }
  return { readRoots: [...readRoots], writeRoots: [...writeRoots], network, dropped };
}
