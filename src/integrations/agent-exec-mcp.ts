/**
 * The `agent-exec` MCP integration: an owner-allowlisted, sandboxed command
 * runner for the worker's test loop.
 *
 * The server lives in `src/mcp/agent-exec-server.ts`. This module owns the
 * parts the MCP client and the installer trust: the server entry, the per-tool
 * risk declarations, the command detection heuristics and the Seatbelt profile
 * that the server wraps around every command.
 *
 * `agent-exec` MCP 集成：面向 Worker 测试回路的、所有者白名单式的沙箱命令执行器。
 *
 * 服务器本体在 `src/mcp/agent-exec-server.ts`。本模块负责 MCP 客户端与安装器信任的部分：
 * 服务器条目、逐工具风险声明、命令检测启发式，以及服务器包裹每条命令所用的 Seatbelt profile。
 */
import { access, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSeatbeltProfile, sbString } from "../authority/seatbelt.ts";
import { toolDefinitions, type AgentExecCommand } from "../mcp/agent-exec-server.ts";
import type { McpServerConfig, McpToolDeclaration } from "../workers/mcp-client.ts";
import type { NativeToolRisk } from "../workers/native-agent-worker.ts";

export const AGENT_EXEC_SERVER_ID = "agent-exec";
export const AGENT_EXEC_SERVER_FILE = "agent-exec-server.ts";
export const AGENT_EXEC_CONFIG_FILE = "agent-exec.json";
export const AGENT_EXEC_SANDBOX_FILE = "agent-exec.sandbox";
export const AGENT_EXEC_SERVER_SUBDIRECTORY = "mcp-servers";

/** Project scripts the installer will offer without asking. 安装器会直接提供的项目脚本。 */
export const SAFE_PACKAGE_SCRIPTS = ["test", "typecheck", "lint", "check", "gate", "build"] as const;

export function agentExecServerPath(cloneHome: string): string {
  return join(cloneHome, AGENT_EXEC_SERVER_SUBDIRECTORY, AGENT_EXEC_SERVER_FILE);
}

export function agentExecConfigPath(cloneHome: string): string {
  return join(cloneHome, AGENT_EXEC_CONFIG_FILE);
}

export function agentExecSandboxPath(cloneHome: string): string {
  return join(cloneHome, AGENT_EXEC_SANDBOX_FILE);
}

/** The source file in this checkout, so the installer can copy it. 本检出中的源文件，供安装器复制。 */
export function agentExecServerSource(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", AGENT_EXEC_SERVER_FILE);
}

/**
 * The risk for each tool. `run_command` is `write`: it is offered only to a
 * reversible-write step, and the server's allowlist plus the sandbox are its
 * boundary. No read-only step gets it.
 * 每个工具的风险。`run_command` 是 `write`：只提供给可逆写入步骤，边界是服务器白名单与沙箱。
 * 只读步骤拿不到它。
 */
const TOOL_RISK: Record<string, NativeToolRisk> = {
  list_commands: "read",
  run_command: "write",
};

export function agentExecToolDeclarations(): McpToolDeclaration[] {
  return toolDefinitions().map((tool) => {
    const risk = TOOL_RISK[tool.name];
    if (risk === undefined) throw new Error(`No risk is declared for agent-exec tool ${tool.name}.`);
    return { name: tool.name, risk, description: tool.description };
  });
}

export function agentExecServer(options: {
  workspace: string;
  serverPath: string;
  configPath: string;
  nodePath?: string;
}): McpServerConfig {
  return {
    id: AGENT_EXEC_SERVER_ID,
    enabled: true,
    transport: "stdio",
    command: options.nodePath ?? process.execPath,
    args: ["--experimental-strip-types", options.serverPath, "--config", options.configPath],
    cwd: options.workspace,
    // The client's request timeout must outlast the server's 240 s default and
    // its 600 s per-command maximum, or a long test would be cut at the client
    // while the server keeps running. 客户端请求超时必须长于服务器 240 秒默认值与 600 秒
    // 单命令上限，否则长测试会在客户端被切断，而服务器仍在运行。
    timeoutMs: 660_000,
    tools: agentExecToolDeclarations(),
  };
}

/**
 * The Seatbelt profile for one workspace. Writes go to the workspace, temp and
 * the package caches; network is off; protected locations are denied by the
 * kernel builder. The final rule denies writes to the workspace's `.git`, so a
 * test cannot commit, reset or rewrite the checkout it is being run against.
 * 一个工作区的 Seatbelt profile。写入落在工作区、临时目录与包缓存；网络关闭；受保护位置由
 * 内核构造器拒绝。最后一条规则拒绝写入工作区的 `.git`，因此测试不能提交、重置或改写正在被
 * 检查的检出。
 */
export function agentExecSandboxProfile(workspace: string, home = homedir()): string {
  // Seatbelt matches the path the kernel sees. On macOS the temp workspace is
  // under /var/folders, whose real path is /private/var/folders; a rule written
  // with the unresolved spelling can be bypassed by the builder's temp allow.
  // Seatbelt 匹配内核看到的路径。macOS 的临时工作区在 /var/folders 下，真实路径是
  // /private/var/folders；用未解析写法写下的规则会被构造器的临时目录允许绕过。
  const root = realpathSync(resolve(workspace));
  if (root === resolve(home) || root === "/") {
    throw new Error("Refusing a workspace that is the home directory or the filesystem root.");
  }
  const profile = buildSeatbeltProfile({
    grants: { readRoots: [root], writeRoots: [root], network: false, dropped: [] },
    home,
    extraWriteRoots: [join(home, ".npm"), join(home, ".cache")],
  });
  return `${profile}(deny file-write* (subpath ${sbString(join(root, ".git"))}))\n`;
}

/**
 * The commands the installer offers for a project. `package.json` scripts are
 * restricted to the safe names above; other ecosystems get one `test` command.
 * A project with none gets an empty list and the owner edits `agent-exec.json`.
 * 安装器为项目提供的命令。`package.json` 脚本只取上面的安全名称；其他生态各给一条
 * `test` 命令。都没有时返回空表，所有者自行编辑 `agent-exec.json`。
 */
export async function detectAgentExecCommands(workspace: string): Promise<AgentExecCommand[]> {
  const commands: AgentExecCommand[] = [];
  const manifest = await readJson(join(workspace, "package.json"));
  const scripts = manifest !== undefined && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as { scripts?: unknown }).scripts
    : undefined;
  if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
    for (const name of SAFE_PACKAGE_SCRIPTS) {
      if (typeof (scripts as Record<string, unknown>)[name] === "string") {
        commands.push({ name, argv: ["npm", "run", name], description: `Run the package.json script "${name}".` });
      }
    }
  }
  if (commands.length > 0) return commands;
  if (await exists(join(workspace, "pyproject.toml")) || await exists(join(workspace, "pytest.ini")) || await exists(join(workspace, "setup.cfg"))) {
    commands.push({ name: "test", argv: ["python3", "-m", "pytest"], description: "Run the Python test suite." });
  } else if (await exists(join(workspace, "go.mod"))) {
    commands.push({ name: "test", argv: ["go", "test", "./..."], description: "Run the Go test suite." });
  } else if (await exists(join(workspace, "Cargo.toml"))) {
    commands.push({ name: "test", argv: ["cargo", "test"], description: "Run the Rust test suite." });
  } else if (await exists(join(workspace, "pom.xml"))) {
    commands.push({ name: "test", argv: ["mvn", "test"], description: "Run the Maven test suite." });
  } else if (await exists(join(workspace, "gradlew"))) {
    commands.push({ name: "test", argv: ["./gradlew", "test"], description: "Run the Gradle wrapper test suite." });
  } else if (await exists(join(workspace, "build.gradle")) || await exists(join(workspace, "build.gradle.kts"))) {
    commands.push({ name: "test", argv: ["gradle", "test"], description: "Run the Gradle test suite." });
  }
  return commands;
}

/** Keep the owner's commands; append detected ones whose names are new. 保留所有者命令；追加名字尚不存在的检测命令。 */
export function mergeAgentExecCommands(existing: readonly AgentExecCommand[], detected: readonly AgentExecCommand[]): AgentExecCommand[] {
  const byName = new Map(existing.map((command) => [command.name, command]));
  for (const command of detected) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  return [...byName.values()];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return undefined;
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
