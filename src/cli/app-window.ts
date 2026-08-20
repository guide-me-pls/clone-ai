/**
 * The desktop window for Clone AI.
 *
 * A browser in application mode gives a real window — no address bar, no tabs,
 * its own taskbar entry — using an engine that is already installed and
 * updated by the OS. It uses a dedicated profile directory so the owner's
 * everyday browser session, extensions, and cookies are never involved.
 *
 * Closing the window ends the session: the daemon is stopped by the caller
 * when this process exits, because a window the owner closed should not leave
 * a server running behind it.
 *
 * Clone AI 的桌面窗口。
 *
 * 以应用模式启动浏览器即可获得真正的窗口——没有地址栏、没有标签页、有独立的任务栏
 * 图标——而且用的是系统已安装并持续更新的引擎。它使用独立的 profile 目录，因此绝不
 * 触碰所有者日常浏览器的会话、扩展与 Cookie。
 *
 * 关闭窗口即结束会话：调用方会在本进程退出时停止 daemon，因为所有者关掉的窗口不应
 * 在背后留下一个还在运行的服务。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface AppWindowOptions {
  url: string;
  /** Profile directory, kept apart from the owner's daily browser. 独立 profile 目录，与日常浏览器隔离。 */
  profileDirectory: string;
  width?: number;
  height?: number;
}

const WINDOWS_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

/** The first Chromium-family engine installed on this machine. 本机安装的第一个 Chromium 系引擎。 */
export function findAppEngine(candidates: readonly string[] = defaultCandidates()): string | undefined {
  return candidates.find((path) => existsSync(path));
}

function defaultCandidates(): readonly string[] {
  if (process.platform === "win32") return WINDOWS_CANDIDATES;
  if (process.platform === "darwin") return MAC_CANDIDATES;
  return LINUX_CANDIDATES;
}

/** Command line that opens a chrome-less application window. 打开无浏览器外壳的应用窗口的命令行。 */
export function appWindowArgs(options: AppWindowOptions): string[] {
  return [
    `--app=${options.url}`,
    `--user-data-dir=${options.profileDirectory}`,
    `--window-size=${options.width ?? 1280},${options.height ?? 860}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Keep the window a plain app surface: no translate bar, no sync prompts.
    // 让窗口保持纯粹的应用界面：没有翻译栏，没有同步提示。
    "--disable-features=Translate,MediaRouter",
  ];
}

export interface RunningAppWindow {
  process: ChildProcess;
  /** Resolves when the owner closes the window. 所有者关闭窗口时 resolve。 */
  closed: Promise<void>;
}

export function openAppWindow(options: AppWindowOptions): RunningAppWindow | undefined {
  const engine = findAppEngine();
  if (engine === undefined) return undefined;
  const child = spawn(engine, appWindowArgs(options), { stdio: "ignore", windowsHide: false });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  return { process: child, closed };
}

/** Where the app window keeps its profile. 应用窗口 profile 的存放位置。 */
export function appProfileDirectory(dataDirectory: string): string {
  return join(dataDirectory, "app-window");
}
