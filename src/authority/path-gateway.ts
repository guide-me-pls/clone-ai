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

import { canonicalPath, cloneSandboxRoot, forbiddenRoots, isForbiddenPath, pathWithin, type Domain, type Scope } from "./scope.ts";

export interface EffectiveGrants {
  /**
   * Canonical directories/files a `files` read scope named. The native tool gate
   * no longer needs them for reads (the machine is the readable surface); they
   * remain for the macOS profile's `strictReads` mode and for the audit.
   * 由 `files` 读取 Scope 点名的规范路径。原生工具闸门已不需要它们来放行读取（整机都是可读
   * 范围）；它们仍供 macOS profile 的 `strictReads` 模式与审计使用。
   */
  readRoots: string[];
  /**
   * Canonical directories/files the step may write. The workspace is not added
   * implicitly: every write comes from a `files` write scope, except the
   * isolated sandbox copy the Kernel creates for external work.
   * 步骤可写的规范路径。工作区不会被隐式加入：每次写入都来自 `files` 写 Scope，唯一例外是
   * Kernel 为外部工作创建的隔离沙箱副本。
   */
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
  options: {
    workspace: string;
    home?: string;
    /**
     * Add the workspace itself as a write root. Only the isolated sandbox copy
     * uses this: it is the tree the Kernel created for the step, not the
     * owner's live folder. A normal step must declare a write scope.
     * 把工作区本身加入写入根。只有隔离沙箱副本使用：它是 Kernel 为步骤创建的树，不是
     * 所有者的活文件夹。普通步骤必须声明写 Scope。
     */
    includeWorkspace?: boolean;
    /**
     * Domains the owner set to 全部放行 with no narrowing policy. `files` adds
     * `/` as a write root; `network` opens the network. The tool gate still
     * refuses protected locations, `.git` and `.rsi` writes.
     * 所有者设为「全部放行」且无收紧策略的域。`files` 把 `/` 加入写入根；`network`
     * 打开网络。工具闸门仍拒绝受保护位置、`.git` 与 `.rsi` 写入。
     */
    unrestrictedDomains?: readonly Domain[];
    /**
     * A model judge (or the owner) overrode a Kernel denial for this step. The
     * scope is granted even when it names a protected location, `/` or the
     * home directory; the approval is in the journal.
     * 模型裁判（或所有者）为这一步覆盖了 Kernel 的拒绝。即使 Scope 点名受保护位置、
     * `/` 或家目录，也会被授权；批准记录在 Journal 里。
     */
    overrideProtection?: boolean;
  },
): EffectiveGrants {
  const home = options.home ?? homedir();
  const workspace = canonicalPath(options.workspace, home);
  const readRoots = new Set<string>();
  const writeRoots = new Set<string>(options.includeWorkspace === true ? [workspace] : []);
  let network = options.unrestrictedDomains?.includes("network") === true;
  if (options.unrestrictedDomains?.includes("files") === true) writeRoots.add("/");
  const dropped: EffectiveGrants["dropped"] = [];

  for (const scope of scopes ?? []) {
    if (scope.domain === "files") {
      const path = canonicalPath(scope.resource, home);
      // The Kernel's isolated sandbox lives under the protected clone home; it
      // is the one subtree a worker may use, so it bypasses both the
      // forbidden-root check and the "too broad" check that `.clone` would
      // otherwise trigger.
      // Kernel 的隔离沙箱位于受保护的 clone home 下；它是 Worker 唯一可用的子树，
      // 因此跳过禁区检查与因 `.clone` 触发的"过宽"检查。
      if (options.overrideProtection !== true && !pathWithin(cloneSandboxRoot(home), path)) {
        if (isForbiddenPath(scope.resource, home)) {
          dropped.push({ scope, reason: "protected location" });
          continue;
        }
        if (path === "/" || path === home) {
          dropped.push({ scope, reason: "too broad: grant a specific folder, not the root or home directory" });
          continue;
        }
        // A grant on a directory that CONTAINS a protected root opens that root,
        // even though the granted path itself is not inside one. `~/Library` was
        // accepted and handed over the Keychains with it.
        // 覆盖受保护根的授权会把它一起打开，即使被授权的路径本身不在受保护根之内。
        // `~/Library` 曾被接受，并连带交出了 Keychains。
        const covering = forbiddenRoots(home).find((root) => pathWithin(path, root));
        if (covering !== undefined) {
          dropped.push({ scope, reason: `too broad: this grant contains the protected location ${covering}; grant the specific folder instead` });
          continue;
        }
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
