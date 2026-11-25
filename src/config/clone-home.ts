import { lstat, mkdir, readdir, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CLONE_DIRECTORY_NAME = ".clone";
export const LEGACY_CLONE_DIRECTORY_NAME = ".clone-ai";

export interface ClonePaths {
  /** User-owned global data directory. 用户拥有的全局数据目录。 */
  dataDirectory: string;
  /**
   * The internal base for relative paths, project-instruction lookup and the
   * verifier's default root. It defaults to the machine root (`/`): the
   * computer is the workspace, and a folder is neither a default nor a
   * permission. An explicit option or CLONE_AI_WORKSPACE still overrides it.
   * It is not an owner setting and not a permission; writes name their own
   * targets. 相对路径、项目指令查找与验证器默认根的内部基准。默认是机器根目录（`/`）：
   * 整台电脑就是工作空间，文件夹既不是默认值也不是权限。显式选项或 CLONE_AI_WORKSPACE
   * 仍可覆盖它。它不是所有者设置，也不是权限；写入自己点名目标。
   */
  workspacePath: string;
  configFile: string;
  agentsFile: string;
  legacyAgentsFile: string;
  providersFile: string;
  schedulesFile: string;
  sessionsFile: string;
  journalJsonlFile: string;
  journalSqliteFile: string;
  outcomesDirectory: string;
  checkpointsDirectory: string;
  sessionsDirectory: string;
  /**
   * Runtime coordination for in-place work. It lives in the clone home, not in
   * a project folder: there is no fixed working directory whose `.clone`
   * directory could own it.
   * 原地工作的运行时协调数据。它在 clone home 里，而不是项目文件夹里：没有固定工作目录，
   * 也就没有它的 `.clone` 目录可以存放这些数据。
   */
  workspaceRuntimeDirectory: string;
  workspaceLockFile: string;
  /**
   * Sandboxes for external/irreversible steps. Lives in clone home, not the
   * owner's project, so a worker cannot walk `..` into live files.
   * 外部/不可逆步骤的沙箱。放在 clone home 而不是所有者项目里，Worker 就不能靠 `..` 走进活文件。
   */
  isolatedWorkspacesDirectory: string;
}

export interface ClonePathOptions {
  dataDirectory?: string;
  workspacePath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve every persistent path from one place. Explicit test paths win,
 * then CLONE_HOME/CLONE_AI_DATA_DIR, then the user's home directory. The
 * internal base is the machine root unless a caller or CLONE_AI_WORKSPACE
 * names another one.
 * 所有持久化路径都从一个地方解析：测试显式路径优先，其次是环境变量，最后才是用户主目录。
 * 除非调用方或 CLONE_AI_WORKSPACE 指定了别的路径，内部基准就是机器根目录。
 */
export function resolveClonePaths(options: ClonePathOptions = {}): ClonePaths {
  const env = options.env ?? process.env;
  const home = userHomeDirectory(env);
  const dataDirectory = resolve(
    options.dataDirectory
      ?? env.CLONE_HOME
      ?? env.CLONE_AI_HOME
      ?? env.CLONE_AI_DATA_DIR
      ?? join(home, CLONE_DIRECTORY_NAME),
  );
  const workspacePath = resolve(options.workspacePath ?? env.CLONE_AI_WORKSPACE ?? "/");
  // Runtime state belongs to the clone home. There is no fixed working
  // directory, so a project folder cannot be the owner of the execution lock.
  // 运行时状态属于 clone home。没有固定工作目录，因此项目文件夹不能成为执行锁的持有者。
  const workspaceRuntimeDirectory = join(dataDirectory, "workspace-runtime");

  return {
    dataDirectory,
    workspacePath,
    configFile: join(dataDirectory, "config.json"),
    agentsFile: join(dataDirectory, "agents.json"),
    legacyAgentsFile: join(dataDirectory, "settings.json"),
    providersFile: join(dataDirectory, "providers.json"),
    schedulesFile: join(dataDirectory, "schedules.json"),
    sessionsFile: join(dataDirectory, "sessions.json"),
    journalJsonlFile: join(dataDirectory, "journal.jsonl"),
    journalSqliteFile: join(dataDirectory, "journal.sqlite3"),
    outcomesDirectory: join(dataDirectory, "outcomes"),
    checkpointsDirectory: join(dataDirectory, "checkpoints"),
    sessionsDirectory: join(dataDirectory, "sessions"),
    workspaceRuntimeDirectory,
    workspaceLockFile: join(workspaceRuntimeDirectory, "workspace-execution.sqlite3"),
    isolatedWorkspacesDirectory: join(dataDirectory, "isolated-workspaces"),
  };
}

/**
 * Create only the directories the Runtime owns; JSON files remain absent until
 * a feature needs them. 只创建 Runtime 拥有的目录，JSON 文件在真正需要时再产生。
 */
export async function prepareCloneHome(paths: ClonePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.dataDirectory, { recursive: true }),
    mkdir(paths.outcomesDirectory, { recursive: true }),
    mkdir(paths.checkpointsDirectory, { recursive: true }),
    mkdir(paths.sessionsDirectory, { recursive: true }),
    mkdir(paths.workspaceRuntimeDirectory, { recursive: true }),
    mkdir(paths.isolatedWorkspacesDirectory, { recursive: true }),
  ]);
}

/**
 * Copy legacy files without overwriting anything the owner has already placed
 * in the new home. This is deliberately recoverable and can be run repeatedly.
 * 只复制旧目录中尚不存在的文件，不覆盖新目录内容；可重复运行且可恢复。
 */
export async function migrateLegacyCloneHome(input: {
  legacyDirectory: string;
  targetDirectory: string;
}): Promise<{ copied: number }> {
  const legacyDirectory = resolve(input.legacyDirectory);
  const targetDirectory = resolve(input.targetDirectory);
  if (legacyDirectory === targetDirectory || !(await isDirectory(legacyDirectory))) return { copied: 0 };

  await mkdir(targetDirectory, { recursive: true });
  return { copied: await copyMissingTree(legacyDirectory, targetDirectory) };
}

export function defaultLegacyDirectory(cwd = process.cwd()): string {
  return join(resolve(cwd), LEGACY_CLONE_DIRECTORY_NAME);
}

function userHomeDirectory(env: NodeJS.ProcessEnv): string {
  const configured = process.platform === "win32"
    ? env.USERPROFILE ?? env.HOME
    : env.HOME ?? env.USERPROFILE;
  return resolve(configured ?? homedir());
}

async function copyMissingTree(source: string, target: string): Promise<number> {
  let copied = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      copied += await copyMissingTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || await pathExists(targetPath)) continue;
    await copyFile(sourcePath, targetPath);
    copied += 1;
  }
  return copied;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error: unknown) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
