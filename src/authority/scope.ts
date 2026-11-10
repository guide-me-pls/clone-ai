/**
 * The vocabulary of machine-wide authority.
 *
 * A Scope names one thing a step wants to touch: a domain, a resource inside
 * it, and how. Authority is always expressed as scopes, so a plan, a standing
 * policy, and a sandbox profile can all be compared with the same intersection
 * rule instead of each inventing its own notion of "allowed".
 *
 * 整机权限的词汇表。
 *
 * Scope 描述一个步骤想触碰的一件事：哪个域、域内哪个资源、以何种方式。权限始终以 Scope
 * 表达，于是计划、常设策略与沙箱 profile 可以用同一条求交规则比较，而不是各自发明
 * "允许"的含义。
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Only files / shell / network are enforced today; the rest are reserved names. 目前只强制 files / shell / network，其余是保留名。 */
export const DOMAINS = ["files", "shell", "network", "calendar", "mail", "apps", "system"] as const;
export type Domain = (typeof DOMAINS)[number];

export const ENFORCED_DOMAINS: readonly Domain[] = ["files", "shell", "network"];

export type Access = "read" | "write" | "exec";

export interface Scope {
  domain: Domain;
  /**
   * files: an absolute (or `~/`) directory or file; covers its whole subtree.
   * shell: a command-name prefix such as `git`. network: a host name, or `*`.
   * files：绝对（或 `~/`）目录或文件，覆盖其整个子树。shell：命令名前缀，如 `git`。
   * network：主机名，或 `*`。
   */
  resource: string;
  access: Access;
}

/** observe < prepare < act_with_approval < act_auto. 自主阶梯，由低到高。 */
export const AUTONOMY_LEVELS = ["observe", "prepare", "act_with_approval", "act_auto"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export function autonomyRank(level: Autonomy): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

export function minAutonomy(a: Autonomy, b: Autonomy): Autonomy {
  return autonomyRank(a) <= autonomyRank(b) ? a : b;
}

export function maxAutonomy(a: Autonomy, b: Autonomy): Autonomy {
  return autonomyRank(a) >= autonomyRank(b) ? a : b;
}

export function isDomain(value: unknown): value is Domain {
  return typeof value === "string" && (DOMAINS as readonly string[]).includes(value);
}

export function isAutonomy(value: unknown): value is Autonomy {
  return typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

export function isAccess(value: unknown): value is Access {
  return value === "read" || value === "write" || value === "exec";
}

/** Throws on a malformed scope so bad input never reaches the policy engine. 格式错误的 Scope 直接抛出，坏输入到不了 Policy 引擎。 */
export function parseScope(value: unknown, location = "scope"): Scope {
  if (typeof value !== "object" || value === null) throw new Error(`${location} must be an object.`);
  const raw = value as Record<string, unknown>;
  if (!isDomain(raw.domain)) throw new Error(`${location}.domain must be one of ${DOMAINS.join(", ")}.`);
  if (!isAccess(raw.access)) throw new Error(`${location}.access must be read, write or exec.`);
  if (typeof raw.resource !== "string" || raw.resource.trim().length === 0) {
    throw new Error(`${location}.resource must be a non-empty string.`);
  }
  const resource = raw.resource.trim();
  if (raw.domain === "files" && !isAbsolute(expandHome(resource))) {
    throw new Error(`${location}.resource must be an absolute path or start with ~/ for the files domain.`);
  }
  return { domain: raw.domain, resource, access: raw.access };
}

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * Canonical form of a path for comparison: `~` expanded, `..` resolved, and the
 * deepest existing ancestor passed through realpath so a symlink cannot make a
 * forbidden location look like an allowed one. The not-yet-created tail is
 * appended unchanged, which is what lets a policy cover a file a worker is
 * about to create.
 * 路径的规范形式：展开 `~`、消除 `..`，并让最深的已存在祖先经过 realpath，使符号链接无法把
 * 禁区伪装成允许区。尚未创建的尾部原样附上，这样策略才能覆盖 Worker 即将创建的文件。
 */
export function canonicalPath(path: string, home = homedir()): string {
  const absolute = resolve(expandHome(path, home));
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return pending.length === 0 ? real : join(real, ...pending.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      pending.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

/**
 * Whether the volume holding `path` compares names case-sensitively.
 *
 * macOS and Windows default to case-insensitive volumes, so `~/.SSH` and
 * `~/.ssh` open the same directory there. A protected-root check that compares
 * strings would let the other spelling through.
 * `path` 所在卷是否区分大小写。
 *
 * macOS 与 Windows 默认不区分大小写，因此在那里 `~/.SSH` 与 `~/.ssh` 打开同一目录。
 * 用字符串比较的受保护根检查会让另一种拼写通过。
 */
export function isCaseSensitive(path: string): boolean {
  if (process.platform === "win32") return false;
  if (process.platform !== "darwin") return true;
  try {
    // Compare the directory listing against its own case-folded spelling: a
    // case-insensitive volume answers the folded name, a case-sensitive one
    // does not. macOS APFS volumes are mixed, so this asks the volume instead
    // of assuming from the platform.
    // 把目录清单与它自己的大小写折叠拼写比较：不区分大小写的卷会应答折叠名，
    // 区分大小写的卷不会。macOS 的 APFS 卷是混合的，因此要问卷本身而不是按平台假设。
    const real = realpathSync(path);
    const base = real.split("/").pop() ?? real;
    const directory = real.slice(0, real.length - base.length) || "/";
    const folded = base.toUpperCase();
    if (folded === base) return true;
    return !existsSync(join(directory, folded));
  } catch {
    return false;
  }
}

/** True when `candidate` is `root` itself or lies inside it. candidate 是 root 本身或位于其内。 */
export function pathWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function accessCovers(granted: Access, wanted: Access): boolean {
  if (granted === wanted) return true;
  // write implies read; exec does not imply write. write 蕴含 read；exec 不蕴含 write。
  return granted === "write" && wanted === "read";
}

/** Does `grant` cover everything `wanted` asks for? grant 是否覆盖 wanted 所请求的全部内容？ */
export function scopeCovers(grant: Scope, wanted: Scope, home = homedir()): boolean {
  if (grant.domain !== wanted.domain || !accessCovers(grant.access, wanted.access)) return false;
  if (grant.domain === "files") {
    return pathWithin(canonicalPath(grant.resource, home), canonicalPath(wanted.resource, home));
  }
  if (grant.domain === "network") {
    return grant.resource === "*" || grant.resource.toLowerCase() === wanted.resource.toLowerCase();
  }
  if (grant.domain === "shell") {
    return grant.resource === "*" || wanted.resource === grant.resource
      || wanted.resource.startsWith(`${grant.resource} `);
  }
  return grant.resource === "*" || grant.resource === wanted.resource;
}

/**
 * Locations no policy can ever open. They are checked before any grant, so a
 * standing policy, an approval, or a sloppy "allow my whole home directory"
 * cannot reach the owner's credentials or Clone AI's own audit trail.
 * 任何策略都无法开放的位置。它们先于任何授权被检查，因此常设策略、审批或一句草率的
 * "允许整个家目录"，都碰不到所有者的凭据或 Clone AI 自己的审计轨迹。
 */
export function forbiddenRoots(home = homedir()): string[] {
  const roots = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".config/gcloud",
    ".netrc",
    "Library/Keychains",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/Microsoft Edge",
    "Library/Safari",
    ".clone/journal.sqlite3",
    ".clone/journal.sqlite3-wal",
    ".clone/journal.sqlite3-shm",
    ".clone/journal.jsonl",
    ".clone/policies.json",
    ".clone/companion.token",
  ];
  return roots.map((entry) => canonicalPath(join(home, entry), home));
}

export function isForbiddenPath(path: string, home = homedir()): boolean {
  const target = canonicalPath(path, home);
  const fold = isCaseSensitive(target) ? (value: string) => value : (value: string) => value.toLowerCase();
  return forbiddenRoots(home).some((root) => pathWithin(fold(root), fold(target)));
}
