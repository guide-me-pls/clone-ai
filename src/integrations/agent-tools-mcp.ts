/**
 * The `agent-tools` MCP integration: a bundled, read-only tool server the owner
 * can install into the clone home.
 *
 * The server itself lives in `src/mcp/agent-tools-server.ts`. This module owns
 * the part the MCP client trusts: the server entry (id, command, workspace) and
 * the per-tool risk declarations. A tool that the server offers but this module
 * does not classify is refused by `mcpToolSpecs` as `external`, which is the
 * safe default; `agentToolsToolDeclarations` makes the classification explicit
 * and fails loudly if a new tool was added without one.
 *
 * `agent-tools` MCP 集成：一个随 clone-ai 发布、可由所有者安装到 clone home 的只读工具服务器。
 *
 * 服务器本体在 `src/mcp/agent-tools-server.ts`。本模块负责 MCP 客户端信任的部分：服务器条目
 * （id、命令、工作区）与逐工具风险声明。服务器提供但本模块未分类的工具会被 `mcpToolSpecs`
 * 按 `external` 拒绝，这是安全默认值；`agentToolsToolDeclarations` 把分类写明确，并在新增
 * 工具却没有分类时直接失败。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { toolDefinitions } from "../mcp/agent-tools-server.ts";
import type { McpServerConfig, McpToolDeclaration } from "../workers/mcp-client.ts";
import type { NativeToolRisk } from "../workers/native-agent-worker.ts";

export const AGENT_TOOLS_SERVER_ID = "agent-tools";
export const AGENT_TOOLS_SERVER_FILE = "agent-tools-server.ts";
export const AGENT_TOOLS_SERVER_SUBDIRECTORY = "mcp-servers";

/** Where the installer copies the server inside a clone home. 安装器把服务器复制到 clone home 的位置。 */
export function agentToolsServerPath(cloneHome: string): string {
  return join(cloneHome, AGENT_TOOLS_SERVER_SUBDIRECTORY, AGENT_TOOLS_SERVER_FILE);
}

/** The source file in this checkout, so the installer can copy it. 本检出中的源文件，供安装器复制。 */
export function agentToolsServerSource(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", AGENT_TOOLS_SERVER_FILE);
}

/**
 * The risk for each tool the server offers. A read tool may be offered to a
 * read-only step; `fetch_url` is `network`, so it is offered only when the step
 * declared a network scope. No write or `external` tool is declared.
 * 服务器每个工具的风险。读取工具可提供给只读步骤；`fetch_url` 是 `network`，只有步骤声明了
 * 网络 Scope 时才提供。没有声明写工具或 `external` 工具。
 */
const TOOL_RISK: Record<string, NativeToolRisk> = {
  search_text: "read",
  find_files: "read",
  git_status: "read",
  git_diff: "read",
  git_log: "read",
  current_time: "read",
  fetch_url: "network",
};

/** The input field that names a path, for the per-call read check. 点名的路径字段，供逐次读取检查。 */
const TOOL_PATH_FIELD: Record<string, string> = {
  search_text: "path",
  find_files: "path",
  git_status: "path",
  git_diff: "path",
  git_log: "path",
};

export function agentToolsToolDeclarations(): McpToolDeclaration[] {
  return toolDefinitions().map((tool) => {
    const risk = TOOL_RISK[tool.name];
    if (risk === undefined) throw new Error(`No risk is declared for agent tool ${tool.name}.`);
    const pathField = TOOL_PATH_FIELD[tool.name];
    return {
      name: tool.name,
      risk,
      ...(pathField === undefined ? {} : { pathField }),
      description: tool.description,
    };
  });
}

/**
 * The mcp.json entry. `serverPath` is the copy in the clone home (or the source
 * when running from a checkout); `nodePath` is pinned because the daemon can be
 * started by launchd with an empty PATH.
 * mcp.json 条目。`serverPath` 是 clone home 中的副本（在检出中运行时也可以是源文件）；
 * `nodePath` 固定为绝对路径，因为 daemon 可能由 launchd 以空 PATH 启动。
 */
export function agentToolsServer(options: { workspace: string; serverPath: string; nodePath?: string }): McpServerConfig {
  return {
    id: AGENT_TOOLS_SERVER_ID,
    enabled: true,
    transport: "stdio",
    command: options.nodePath ?? process.execPath,
    args: ["--experimental-strip-types", options.serverPath],
    cwd: options.workspace,
    timeoutMs: 120_000,
    tools: agentToolsToolDeclarations(),
  };
}
