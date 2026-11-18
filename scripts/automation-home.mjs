#!/usr/bin/env node
/**
 * The clone home maintenance automation runs in — never the owner's live one.
 *
 * Automation shares the owner's machine, not the owner's runtime. A repair run
 * or an eval companion that writes into `~/.clone` competes with the daemon the
 * window is attached to: it can hold the Main Agent prompt lock, append to the
 * journal, or rewrite the endpoint file. The owner's home is read-only input
 * (failed traces, config seeds); everything automation produces lives under
 * `<repo>/.automation/<purpose>` unless `CLONE_AI_AUTOMATION_HOME` names a
 * different directory.
 *
 * 维护自动化使用的 clone home——绝不是所有者正在使用的那个。
 *
 * 自动化与所有者共享机器，而不是共享运行时。写入 `~/.clone` 的修复运行或评测 companion 会与
 * 窗口附着的守护竞争：它可能持有 Main Agent 提示锁、向 Journal 追加、或重写端点文件。
 * 所有者的 home 只是只读输入（失败轨迹、配置种子）；自动化的产物放在
 * `<repo>/.automation/<用途>`，除非 `CLONE_AI_AUTOMATION_HOME` 指定了别的目录。
 *
 * Usage:
 *   node scripts/automation-home.mjs [purpose]   # prints the isolated home
 *
 * Env:
 *   CLONE_AI_AUTOMATION_HOME    explicit isolated directory
 *   CLONE_AI_AUTOMATION_REFRESH=1  re-copy the seeded config files
 *   CLONE_AI_ALLOW_OWNER_HOME=1  deliberately share the owner's home (escape hatch)
 */
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const AUTOMATION_HOME_ENV = "CLONE_AI_AUTOMATION_HOME";
export const ALLOW_OWNER_HOME_ENV = "CLONE_AI_ALLOW_OWNER_HOME";
export const REFRESH_ENV = "CLONE_AI_AUTOMATION_REFRESH";

/**
 * The only files automation needs from the owner's home: model/worker settings
 * and connector policy. The journal, memory, sessions, turn ledger, companion
 * token, endpoint file and locks are deliberately absent.
 * 自动化只需要所有者 home 里的这些文件：模型/Worker 设置与连接器策略。Journal、记忆、会话、
 * 回合账本、companion 令牌、端点文件与锁都被刻意排除。
 */
export const SEEDED_FILES = ["config.json", "settings.json", "providers.json", "mcp.json", "policies.json"];

const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The owner's live clone home, resolved exactly as the runtime resolves it. 按运行时相同顺序解析所有者正在使用的 home。 */
export function ownerCloneHome(env = process.env) {
  return resolve(
    env.CLONE_HOME
    ?? env.CLONE_AI_HOME
    ?? env.CLONE_AI_DATA_DIR
    ?? join(homedir(), ".clone"),
  );
}

/**
 * Resolve the isolated home without touching the filesystem. Throws when the
 * result is the owner's home, so a misconfigured run fails before it writes.
 * 只解析目录、不碰文件系统。结果等于所有者 home 时抛错，使配置错误的运行在写入之前就失败。
 */
export function resolveAutomationHome(options) {
  const env = options.env ?? process.env;
  const purpose = options.purpose ?? "manual";
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new Error(`Automation purpose must match ${PURPOSE_PATTERN}: ${purpose}`);
  }
  const ownerDirectory = resolve(options.ownerDirectory ?? ownerCloneHome(env));
  const configured = env[AUTOMATION_HOME_ENV]?.trim();
  const dataDirectory = resolve(
    configured === undefined || configured.length === 0
      ? join(options.repoRoot, ".automation", purpose)
      : configured,
  );
  if (dataDirectory === ownerDirectory && env[ALLOW_OWNER_HOME_ENV] !== "1") {
    throw new Error(
      `Refusing to run automation in the owner's clone home (${ownerDirectory}). `
      + `Set ${AUTOMATION_HOME_ENV} to an isolated directory, or ${ALLOW_OWNER_HOME_ENV}=1 to override.`,
    );
  }
  return { dataDirectory, ownerDirectory, purpose };
}

/**
 * Create the isolated home and seed the small config files once. Existing files
 * are left alone unless `CLONE_AI_AUTOMATION_REFRESH=1`, so an automation run
 * cannot silently overwrite credentials it did not own.
 * 创建隔离 home，并只播种一次小配置文件。除非 `CLONE_AI_AUTOMATION_REFRESH=1`，已有文件不会被
 * 覆盖，因此自动化运行不会静默改写不属于它的凭据。
 */
export async function prepareAutomationHome(options) {
  const env = options.env ?? process.env;
  const resolved = resolveAutomationHome({ ...options, env });
  await mkdir(resolved.dataDirectory, { recursive: true, mode: 0o700 });
  const refresh = env[REFRESH_ENV] === "1";
  const seeded = [];
  for (const name of SEEDED_FILES) {
    const target = join(resolved.dataDirectory, name);
    if (!refresh && await exists(target)) continue;
    const source = join(resolved.ownerDirectory, name);
    if (!(await exists(source))) continue;
    await copyFile(source, target);
    await chmod(target, 0o600).catch(() => undefined);
    seeded.push(name);
  }
  return { ...resolved, seeded };
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const purpose = process.argv[2] ?? "manual";
  const home = await prepareAutomationHome({
    repoRoot: resolve(import.meta.dirname, ".."),
    purpose,
  });
  console.log(home.dataDirectory);
  if (home.seeded.length > 0) console.error(`seeded: ${home.seeded.join(", ")}`);
}
