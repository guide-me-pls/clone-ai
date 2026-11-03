import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export type ExecutableResolutionSource = "absolute" | "path" | "known-directory";

export interface ExecutableResolution {
  /** The command exactly as declared by the provider. 配置中声明的原始命令。 */
  declared: string;
  /** Absolute executable path when found. 找到时的可执行文件绝对路径。 */
  resolvedPath?: string;
  source?: ExecutableResolutionSource;
  /** Directories searched, in order. 按顺序搜索过的目录。 */
  searchedDirectories: string[];
}

export interface ResolveExecutableOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  cwd?: string;
  /** Additional owner-specific directories before built-in fallbacks. 内置回退目录之前的额外所有者目录。 */
  additionalDirectories?: readonly string[];
}

/**
 * Finder-launched apps receive a much smaller PATH than a terminal. Resolve
 * the exact executable once and reuse that absolute path for both status and
 * launch, otherwise the settings screen can say "installed" while spawn fails.
 *
 * Finder 启动的应用拿到的 PATH 远小于终端。这里先解析出确切的可执行文件，并让状态
 * 检测与实际启动复用同一个绝对路径；否则设置页可能显示“已安装”，真正启动却失败。
 */
export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): ExecutableResolution {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homeDirectory(environment);
  const cwd = options.cwd ?? process.cwd();
  const declared = expandHome(command.trim(), home);
  if (declared.length === 0) return { declared: command, searchedDirectories: [] };

  if (isPathLike(declared)) {
    const candidate = isAbsolute(declared) ? declared : resolve(cwd, declared);
    return {
      declared: command,
      ...(isExecutable(candidate, platform) ? { resolvedPath: candidate, source: "absolute" as const } : {}),
      searchedDirectories: [dirname(candidate)],
    };
  }

  const pathDirectories = environmentPath(environment, platform)
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const knownDirectories = executableDirectories(command, { home, platform, environment });
  const additionalDirectories = (options.additionalDirectories ?? []).map((entry) => expandHome(entry, home));
  const searchedDirectories = unique([...pathDirectories, ...additionalDirectories, ...knownDirectories]);
  const extensions = executableExtensions(command, environment, platform);

  for (const directory of searchedDirectories) {
    const source: ExecutableResolutionSource = pathDirectories.includes(directory) ? "path" : "known-directory";
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isExecutable(candidate, platform)) {
        return { declared: command, resolvedPath: candidate, source, searchedDirectories };
      }
    }
  }
  return { declared: command, searchedDirectories };
}

/**
 * Extend PATH for child processes so a resolved launcher can find its own
 * helpers even when the app was started by Finder.
 *
 * 为子进程扩展 PATH，使已解析的启动器即使由 Finder 启动也能找到自己的辅助命令。
 */
export function augmentedExecutablePath(options: ResolveExecutableOptions = {}): string {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homeDirectory(environment);
  const current = environmentPath(environment, platform)
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return unique([
    ...current,
    ...(options.additionalDirectories ?? []),
    ...commonExecutableDirectories({ home, platform, environment }),
  ]).join(delimiter);
}

export function executableDirectories(
  command: string,
  options: {
    home: string;
    platform: NodeJS.Platform;
    environment: NodeJS.ProcessEnv;
  },
): string[] {
  const directories = commonExecutableDirectories(options);
  if (command === "codex" && options.platform === "darwin") {
    directories.push(
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin",
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS",
      join(options.home, "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"),
      join(options.home, "Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS"),
    );
  }
  return unique(directories);
}

function commonExecutableDirectories(input: {
  home: string;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
}): string[] {
  if (input.platform === "win32") {
    return unique([
      join(input.environment.APPDATA ?? join(input.home, "AppData", "Roaming"), "npm"),
      join(input.home, ".local", "bin"),
      join(input.home, ".bun", "bin"),
      join(input.home, ".npm-global", "bin"),
    ]);
  }
  return unique([
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    join(input.home, ".local", "bin"),
    join(input.home, ".npm-global", "bin"),
    join(input.home, ".bun", "bin"),
    join(input.home, "Library", "pnpm"),
    join(input.home, ".opencode", "bin"),
  ]);
}

function environmentPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") return environment.PATH ?? environment.Path ?? "";
  return environment.PATH ?? environment.Path ?? "/usr/bin:/bin:/usr/sbin:/sbin";
}

function executableExtensions(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32" || /\.[A-Za-z0-9]+$/.test(command)) return [""];
  return (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isPathLike(command: string): boolean {
  return isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

function homeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME ?? environment.USERPROFILE ?? homedir();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
