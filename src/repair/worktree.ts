/**
 * The isolated tree a repair runs in, and the command runner every gate uses.
 *
 * The repair lane must never edit the checkout that is serving the owner. It
 * creates a linked git worktree from a base ref and does all of its work there;
 * the serving checkout only sees `git worktree add` and, on success, nothing at
 * all. A branch is created so the owner can inspect or delete the result, but
 * the lane never checks it out anywhere and never merges it.
 *
 * 修复运行所在的隔离树，以及每道闸门共用的命令执行器。
 *
 * 修复通道绝不能改正在服务所有者的检出。它从基线引用创建一个链接的 git worktree，全部改动
 * 都发生在那里；服务中的检出只经历一次 `git worktree add`，成功时什么都不发生。分支会被
 * 创建，方便所有者查看或删除，但通道绝不在别处检出它，也绝不合并。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs one command with no shell, so arguments cannot be re-parsed. 不经过 shell 执行一条命令，参数不会被重新解析。 */
export type CommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, cwd) => new Promise((resolvePromise) => {
  const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("error", (error) => resolvePromise({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
  child.on("close", (status) => resolvePromise({ status: status ?? 1, stdout, stderr }));
});

export interface RepairWorktree {
  /** Where every repair write happens. 所有修复写入发生的地方。 */
  path: string;
  branch: string;
  /** The checkout being served; never written to. 正在服务的检出；绝不写入。 */
  repo: string;
  base: string;
}

export interface CreateWorktreeInput {
  repo: string;
  /** Branch the repair is based on. 修复所基于的分支。 */
  base?: string;
  /** Directory that holds created worktrees; created when missing. 存放新建 worktree 的目录；不存在时创建。 */
  worktreesRoot?: string;
  /** Stable stamp used in the path and branch name. 用于路径与分支名的稳定时间戳。 */
  stamp: string;
  run?: CommandRunner;
}

/**
 * Creates the repair worktree, or throws before touching anything.
 *
 * Every refusal happens before `git worktree add`, because a half-created
 * worktree is a state the caller then has to reason about. The path must be
 * new, must not be the repo itself, and the repo must be the git root the
 * caller named — otherwise `--repo` could silently point the repair at a
 * parent project.
 * 创建修复 worktree；任何问题都在触碰任何东西之前抛出。
 *
 * 所有拒绝都发生在 `git worktree add` 之前，因为创建了一半的 worktree 会成为调用方必须
 * 推断的状态。路径必须是新的、不能是仓库本身，且仓库必须是调用方点名的 git 根——否则
 * `--repo` 可能在无声中把修复指向父项目。
 */
export async function createRepairWorktree(input: CreateWorktreeInput): Promise<RepairWorktree> {
  const run = input.run ?? runCommand;
  const repo = await assertGitRoot(input.repo, run);
  const base = input.base ?? "main";
  const worktreesRoot = resolve(input.worktreesRoot ?? join(repo, ".claude", "worktrees"));
  const branch = `rsi/auto-fix-${input.stamp}`;
  const path = join(worktreesRoot, `rsi-${input.stamp}`);
  if (existsSync(path)) throw new Error(`The repair worktree path already exists: ${path}`);
  const inside = path === repo || path.startsWith(`${repo}/`);
  if (path === repo) throw new Error("The repair worktree cannot be the checkout being served.");

  await run("git", ["worktree", "prune"], repo).catch(() => undefined);
  const created = await run("git", ["worktree", "add", "-b", branch, path, base], repo);
  if (created.status !== 0) {
    throw new Error(`git worktree add failed: ${created.stderr.trim() || created.stdout.trim()}`);
  }
  // A worktree nested inside the served checkout is expected (it is gitignored),
  // but it must never be the checkout's own working tree.
  // 嵌套在服务中检出里的 worktree 是预期形态（已被 git 忽略），但它绝不能是该检出的工作树本身。
  if (inside) await access(join(path, ".git")).catch(() => {
    throw new Error(`git worktree add reported success but ${path} is not a worktree.`);
  });
  return { path, branch, repo, base };
}

/**
 * `node_modules` is ignored by git, so a fresh worktree has none and `npm test`
 * cannot run there. Linking the served checkout's modules makes the repair
 * suite runnable without installing anything or writing into the served tree.
 * `node_modules` 被 git 忽略，因此新 worktree 里没有它，`npm test` 跑不起来。链接服务检出
 * 的模块即可让修复套件可运行，既不安装任何东西，也不写服务中的树。
 */
export async function linkDependencies(worktree: RepairWorktree): Promise<"linked" | "absent"> {
  const source = join(worktree.repo, "node_modules");
  if (!existsSync(source)) return "absent";
  const target = join(worktree.path, "node_modules");
  if (existsSync(target)) return "linked";
  const { symlink } = await import("node:fs/promises");
  try {
    await symlink(source, target, "junction");
    return "linked";
  } catch {
    return "absent";
  }
}

/** Removes the worktree but keeps the branch, exactly like the nightly lane. 移除 worktree、保留分支，与夜间通道一致。 */
export async function removeRepairWorktree(worktree: RepairWorktree, run: CommandRunner = runCommand): Promise<void> {
  await run("git", ["worktree", "remove", "--force", worktree.path], worktree.repo).catch(() => undefined);
  await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
}

async function assertGitRoot(repo: string, run: CommandRunner): Promise<string> {
  const requested = await realpath(resolve(repo));
  const result = await run("git", ["rev-parse", "--show-toplevel"], requested);
  if (result.status !== 0) throw new Error(`${requested} is not a git repository: ${result.stderr.trim()}`);
  const actual = await realpath(result.stdout.trim());
  if (actual !== requested) {
    throw new Error(`${requested} is not the git root of this checkout (it is ${actual}). Pass the repository root.`);
  }
  return actual;
}
