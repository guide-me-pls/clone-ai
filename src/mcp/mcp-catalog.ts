/**
 * The settings-facing catalog of MCP servers, their declared tools and the
 * skills under the owner's skill roots.
 *
 * What this module deliberately does not do: spawn a server or call
 * `tools/list`. The `mcp.json` declaration is the risk authority the worker
 * already trusts, so the catalog shows what the worker can actually be offered.
 * A malformed declaration is reported, never guessed at. The safe projection
 * drops `env`, `command`, `args` and `url`, because those can hold credentials.
 *
 * 面向设置页的目录：MCP 服务器、它们声明的工具，以及所有者技能根目录下的技能。
 *
 * 本模块刻意不做的事：启动服务器或调用 `tools/list`。`mcp.json` 声明本来就是 Worker 信任的
 * 风险权威，因此目录展示 Worker 实际能拿到的工具。损坏的声明会被报告，绝不猜测。安全投影会
 * 丢弃 `env`、`command`、`args` 与 `url`，因为它们可能包含凭据。
 */
import { join } from "node:path";

import { readJsonFile, writeJsonAtomic } from "../config/json-file.ts";
import { loadSkills, skillRootsFor, type SkillDefinition } from "../skills/skill-loader.ts";
import { loadMcpConfig, MCP_CONFIG_FILE, type McpServerConfig } from "../workers/mcp-client.ts";
import type { NativeToolRisk } from "../workers/native-agent-worker.ts";

export interface McpCatalogTool {
  name: string;
  risk: NativeToolRisk;
  description?: string;
  pathField?: string;
}

export interface McpCatalogServer {
  id: string;
  enabled: boolean;
  transport: "stdio" | "http";
  tools: McpCatalogTool[];
}

export interface McpCatalogSkill {
  name: string;
  description: string;
  allowedTools: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  path: string;
}

export interface McpToolCatalog {
  servers: McpCatalogServer[];
  /** Problems in mcp.json; a broken entry is reported rather than hidden. mcp.json 中的问题；坏条目会被报告而不是藏起来。 */
  mcpErrors: string[];
  skills: McpCatalogSkill[];
  skillRoots: string[];
  rejectedSkills: Array<{ path: string; reason: string }>;
}

// The roots live with the skill loader, because the Main Agent needs the same
// list without importing the MCP catalog. Re-exported here for existing callers.
// 根目录归属技能加载器，因为 Main Agent 需要同一份清单而不应导入 MCP 目录；此处为既有
// 调用方保留再导出。
export { skillRootsFor };

export async function readToolCatalog(dataDirectory: string, workspacePath: string): Promise<McpToolCatalog> {
  const loaded = await loadMcpConfig(join(dataDirectory, MCP_CONFIG_FILE));
  const skillRoots = skillRootsFor(dataDirectory, workspacePath);
  const skills = await loadSkills(skillRoots);
  return {
    servers: loaded.servers.map(safeServer),
    mcpErrors: loaded.errors,
    skills: skills.skills.map(safeSkill),
    skillRoots,
    rejectedSkills: skills.rejected,
  };
}

/**
 * Toggle one server's `enabled` field. The rest of the document is written back
 * as it was, so a custom command, args, env names and unknown fields survive.
 * 切换一个服务器的 `enabled` 字段。文档其余部分原样写回，因此自定义 command、args、
 * 环境变量名与未知字段都会保留。
 */
export async function setMcpServerEnabled(dataDirectory: string, workspacePath: string, id: string, enabled: boolean): Promise<McpToolCatalog> {
  const serverId = id.trim();
  if (serverId.length === 0) throw new Error("The server id must not be empty.");
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean.");
  const path = join(dataDirectory, MCP_CONFIG_FILE);
  const raw = await readJsonFile<unknown>(path);
  if (raw === undefined) throw new Error(`No ${MCP_CONFIG_FILE} exists in ${dataDirectory}.`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path} must be an object with a "servers" array.`);
  const servers = (raw as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) throw new Error(`${path}: "servers" must be an array.`);
  const matches = servers.filter((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry) && (entry as { id?: unknown }).id === serverId);
  if (matches.length === 0) throw new Error(`No MCP server named "${serverId}".`);
  if (matches.length > 1) throw new Error(`More than one MCP server is named "${serverId}".`);
  matches[0]!.enabled = enabled;
  await writeJsonAtomic(path, raw);
  return readToolCatalog(dataDirectory, workspacePath);
}

function safeServer(server: McpServerConfig): McpCatalogServer {
  return {
    id: server.id,
    enabled: server.enabled,
    transport: server.transport === "http" ? "http" : "stdio",
    tools: (server.tools ?? []).map((tool) => ({
      name: tool.name,
      risk: tool.risk ?? "external",
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.pathField === undefined ? {} : { pathField: tool.pathField }),
    })),
  };
}

function safeSkill(skill: SkillDefinition): McpCatalogSkill {
  return {
    name: skill.name,
    description: skill.description,
    allowedTools: skill.allowedTools,
    disableModelInvocation: skill.disableModelInvocation,
    userInvocable: skill.userInvocable,
    path: skill.path,
  };
}
