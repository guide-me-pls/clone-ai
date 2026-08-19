import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BlackBoxWorkerAdapter, type BlackBoxProviderConfig } from "./black-box-worker.ts";
import { ProviderRegistry, type ProviderDefinition } from "./provider-registry.ts";

/**
 * The agents Clone AI knows about out of the box. Each is only a launch recipe
 * — command, arguments, and the credentials it may see. Nothing here describes
 * how the agent works internally, because the Runtime never needs to know.
 *
 * Clone AI 开箱认识的 Agent。每一个都只是一份启动配方——命令、参数，以及它可以看到的
 * 凭据。这里没有任何关于 Agent 内部如何工作的描述，因为 Runtime 从不需要知道。
 */
export const BUILT_IN_PROVIDER_CONFIGS: readonly BlackBoxProviderConfig[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    command: process.platform === "win32" ? "claude.cmd" : "claude",
    args: ["-p", "{{prompt}}"],
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    command: process.platform === "win32" ? "codex.cmd" : "codex",
    args: ["exec", "--skip-git-repo-check", "{{prompt}}"],
    env: ["OPENAI_API_KEY", "CODEX_HOME"],
  },
  {
    id: "pi",
    label: "Pi",
    command: process.platform === "win32" ? "pi.cmd" : "pi",
    args: ["-p", "{{prompt}}"],
    env: [
      "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
      "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR",
    ],
  },
  {
    id: "opencode",
    label: "opencode",
    command: process.platform === "win32" ? "opencode.cmd" : "opencode",
    args: ["run", "{{prompt}}"],
    env: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_CONFIG"],
  },
];

export function toProviderDefinition(config: BlackBoxProviderConfig): ProviderDefinition {
  return {
    id: config.id,
    label: config.label ?? config.id,
    ...(config.supportedRoles === undefined ? {} : { supportedRoles: config.supportedRoles }),
    ...(config.roleRestrictionReason === undefined ? {} : { roleRestrictionReason: config.roleRestrictionReason }),
    createAdapter: ({ agentId, workCapabilities }) => new BlackBoxWorkerAdapter({
      agentId,
      config,
      workCapabilities,
    }),
  };
}

export function createBuiltInProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const config of BUILT_IN_PROVIDER_CONFIGS) registry.register(toProviderDefinition(config));
  return registry;
}

/**
 * Loads user-declared agents from <dataDirectory>/providers.json and adds them
 * to the registry. Integrating a new coding agent is a configuration edit, not
 * a source change; a declaration that collides with a built-in id replaces it,
 * so the owner can retune how a shipped agent is launched.
 *
 * 从 <dataDirectory>/providers.json 载入用户声明的 Agent 并加入 Registry。接入新的
 * Coding Agent 是改配置而不是改源码；与内建 ID 冲突的声明会覆盖内建项，因此所有者可以
 * 重新调整自带 Agent 的启动方式。
 */
export async function loadProviderRegistry(dataDirectory: string): Promise<ProviderRegistry> {
  const declared = await readProviderConfigs(join(dataDirectory, "providers.json"));
  const byId = new Map(BUILT_IN_PROVIDER_CONFIGS.map((config) => [config.id, config]));
  for (const config of declared) byId.set(config.id, config);

  const registry = new ProviderRegistry();
  for (const config of byId.values()) registry.register(toProviderDefinition(config));
  return registry;
}

async function readProviderConfigs(path: string): Promise<BlackBoxProviderConfig[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(source) as { providers?: unknown };
  const entries = Array.isArray(parsed.providers) ? parsed.providers : [];
  return entries.map((entry, index) => validateProviderConfig(entry, `${path}#${index}`));
}

function validateProviderConfig(value: unknown, where: string): BlackBoxProviderConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Provider declaration at ${where} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const command = record.command;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`Provider declaration at ${where} needs a non-empty "id".`);
  }
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(`Provider "${id}" needs a non-empty "command".`);
  }
  const args = record.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((argument) => typeof argument !== "string"))) {
    throw new Error(`Provider "${id}" must declare "args" as an array of strings.`);
  }
  const env = record.env;
  if (env !== undefined && (!Array.isArray(env) || env.some((name) => typeof name !== "string"))) {
    throw new Error(`Provider "${id}" must declare "env" as an array of variable names.`);
  }
  const promptVia = record.promptVia;
  if (promptVia !== undefined && promptVia !== "arg" && promptVia !== "stdin") {
    throw new Error(`Provider "${id}" must declare "promptVia" as "arg" or "stdin".`);
  }
  return {
    id,
    command,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(args === undefined ? {} : { args: args as string[] }),
    ...(env === undefined ? {} : { env: env as string[] }),
    ...(promptVia === undefined ? {} : { promptVia }),
    ...(Array.isArray(record.work) ? { work: record.work as string[] } : {}),
    ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
  };
}

/**
 * The process-wide registry of built-ins. Hosts that support user
 * declarations should call loadProviderRegistry() instead.
 * 内建 Provider 的进程级 Registry。支持用户声明的宿主应改用 loadProviderRegistry()。
 */
export const builtInProviders = createBuiltInProviderRegistry();
