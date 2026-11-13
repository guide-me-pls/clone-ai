/**
 * The resident daemon: a per-user LaunchAgent that owns the companion process.
 *
 * The desktop app is a window, not the runtime. Closing the window must not stop
 * the twin, logins must restart it, and a crash must come back on its own. macOS
 * gives exactly one mechanism with those properties — `launchd` — so this module
 * renders and installs the plist instead of supervising the child from Swift.
 *
 * Supervising in-process was rejected: the app would have to keep a hidden
 * process it can kill by quitting, which is the behaviour this change removes.
 * A shell wrapper was rejected too: it adds a process between launchd and the
 * runtime, and that process is exactly what gets killed on app quit.
 *
 * 常驻 Daemon：一个由当前用户拥有的 LaunchAgent，托管 companion 进程。
 *
 * 桌面 App 是窗口，不是运行时。关闭窗口不能停掉分身，登录必须重新拉起，崩溃必须自己
 * 回来。macOS 里具备这些性质的机制只有 `launchd`，因此本模块负责渲染并安装 plist，
 * 而不是在 Swift 里托管子进程。
 *
 * 进程内托管已被否决：App 将不得不保留一个隐藏进程，退出 App 就会杀掉它，而这正是本次
 * 要移除的行为。shell 包装也被否决：它在 launchd 与运行时之间多一个进程，而退出 App
 * 杀掉的恰好是那个进程。
 */
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The label launchd knows this job by. launchd 认识本任务的标签。 */
export const DAEMON_LABEL = "ai.clone.companion";

export interface LaunchAgentOptions {
  label: string;
  /** Absolute path to the node binary the app would have spawned. App 本会启动的 node 绝对路径。 */
  node: string;
  /** Absolute path to the sidecar entry point. sidecar 入口的绝对路径。 */
  entry: string;
  /** Working directory for the daemon; the runtime resolves relative paths from here. Daemon 工作目录；运行时据此解析相对路径。 */
  workingDirectory: string;
  /** Where launchd appends stdout and stderr. launchd 追加 stdout 与 stderr 的位置。 */
  log: string;
  /** Extra environment for the daemon only. 仅给 Daemon 的额外环境变量。 */
  environment: Record<string, string>;
  /** Defaults to ~/Library/LaunchAgents. 默认 ~/Library/LaunchAgents。 */
  launchAgentsDirectory?: string;
}

export function launchAgentPaths(
  homeDirectory: string,
  label: string,
): { directory: string; plist: string } {
  const directory = join(homeDirectory, "Library", "LaunchAgents");
  return { directory, plist: join(directory, `${label}.plist`) };
}

/**
 * The argv launchd will run. Kept separate so a test can assert the daemon is
 * launched exactly as the shell would have launched it — same entry, same flag.
 * launchd 将执行的 argv。单独成函数，使测试能断言 Daemon 的启动方式与外壳完全一致
 * ——同一个入口、同一个参数。
 */
export function resolveDaemonCommand(input: {
  node: string;
  entry: string;
  workingDirectory: string;
}): string[] {
  void input.workingDirectory;
  return [input.node, "--experimental-strip-types", input.entry];
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Pure renderer: no filesystem access, so the plist's guarantees are testable
 * without installing anything.
 * 纯渲染器：不触碰文件系统，因此 plist 的保证无需安装即可测试。
 */
export function renderLaunchAgentPlist(options: Omit<LaunchAgentOptions, "launchAgentsDirectory">): string {
  const argv = resolveDaemonCommand(options);
  const environment = Object.entries(options.environment)
    .map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(options.workingDirectory)}</string>
${environment.length === 0 ? "" : `  <key>EnvironmentVariables</key>\n  <dict>\n${environment}\n  </dict>\n`}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(options.log)}</string>
  <key>StandardErrorPath</key><string>${xml(options.log)}</string>
</dict>
</plist>
`;
}

/** Writes the plist with owner-only permissions; returns its path. 以仅所有者可读的权限写入 plist，返回路径。 */
export async function writeLaunchAgent(options: LaunchAgentOptions): Promise<string> {
  const { directory, plist } = options.launchAgentsDirectory === undefined
    ? launchAgentPaths(homedir(), options.label)
    : { directory: options.launchAgentsDirectory, plist: join(options.launchAgentsDirectory, `${options.label}.plist`) };
  await mkdir(directory, { recursive: true });
  await writeFile(plist, renderLaunchAgentPlist(options), { encoding: "utf8", mode: 0o600 });
  // A plist names executables and log paths; it is not world-readable.
  // plist 点名可执行文件与日志路径，不应全局可读。
  await chmod(plist, 0o600).catch(() => undefined);
  return plist;
}

/** Removes the plist; a missing one is success, so uninstall is idempotent. 删除 plist；不存在也算成功，使卸载可重复。 */
export async function removeLaunchAgent(options: LaunchAgentOptions): Promise<void> {
  const plist = options.launchAgentsDirectory === undefined
    ? launchAgentPaths(homedir(), options.label).plist
    : join(options.launchAgentsDirectory, `${options.label}.plist`);
  await rm(plist, { force: true });
}

export type LaunchAgentState = "installed" | "absent";

/** Whether launchd has a job file to load. launchd 是否有可加载的任务文件。 */
export async function readLaunchAgentState(directory: string, label: string): Promise<LaunchAgentState> {
  const plist = join(directory, `${label}.plist`);
  try {
    await stat(plist);
    return "installed";
  } catch {
    return "absent";
  }
}

/** The plist body, for a test that wants to compare two installs. 供测试比较两次安装的 plist 内容。 */
export async function readLaunchAgentPlist(directory: string, label: string): Promise<string | undefined> {
  try {
    return await readFile(join(directory, `${label}.plist`), "utf8");
  } catch {
    return undefined;
  }
}
