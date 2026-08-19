import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { BlackBoxWorkerAdapter, type BlackBoxProviderConfig } from "./black-box-worker.ts";
import { ProviderRegistry, type ProviderDefinition } from "./provider-registry.ts";
import type { AgentRole } from "../settings/agent-settings.ts";

/**
 * Built-in launch recipes are data, not dispatch branches. The JSON file keeps
 * commands and environment names user-visible without storing credentials.
 * 内建启动配方是数据而不是分发分支。JSON 让命令和环境变量名可查看，但不保存凭据。
 */
const BUILT_IN_PROVIDER_FILE = fileURLToPath(new URL("./providers.json", import.meta.url));
export const BUILT_IN_PROVIDER_CONFIGS: readonly BlackBoxProviderConfig[] = parseProviderDocument(
  JSON.parse(readFileSync(BUILT_IN_PROVIDER_FILE, "utf8")) as unknown,
  BUILT_IN_PROVIDER_FILE,
);

export function toProviderDefinition(config: BlackBoxProviderConfig): ProviderDefinition {
  const launchConfig: BlackBoxProviderConfig = {
    ...config,
    command: commandForPlatform(config.command),
  };
  return {
    id: config.id,
    label: config.label ?? config.id,
    ...(config.supportedRoles === undefined ? {} : { supportedRoles: config.supportedRoles }),
    ...(config.roleRestrictionReason === undefined ? {} : { roleRestrictionReason: config.roleRestrictionReason }),
    createAdapter: ({ agentId, workCapabilities, failureCatalog }) => new BlackBoxWorkerAdapter({
      agentId,
      config: launchConfig,
      workCapabilities,
      failureCatalog,
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
 * to the built-ins. A colliding id replaces the built-in recipe, so the owner
 * can retune a shipped agent without changing source code.
 *
 * 从 <dataDirectory>/providers.json 载入用户声明的 Agent 并叠加到内建配置。同名 ID 会覆盖
 * 内建配方，因此所有者无需改源码就能调整自带 Agent。
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
    if (isMissingFile(error)) return [];
    throw error;
  }
  return parseProviderDocument(JSON.parse(source) as unknown, path);
}

function parseProviderDocument(value: unknown, where: string): BlackBoxProviderConfig[] {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Provider configuration at ${where} must be an object.`);
  }
  const entries = (value as Record<string, unknown>).providers;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    throw new Error(`Provider configuration at ${where} needs a "providers" array.`);
  }
  return entries.map((entry, index) => validateProviderConfig(entry, `${where}#${index}`));
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
  if (env !== undefined && (!Array.isArray(env) || env.some((name) => typeof name !== "string" || name.trim().length === 0))) {
    throw new Error(`Provider "${id}" must declare "env" as an array of variable names.`);
  }
  const promptVia = record.promptVia;
  if (promptVia !== undefined && promptVia !== "arg" && promptVia !== "stdin") {
    throw new Error(`Provider "${id}" must declare "promptVia" as "arg" or "stdin".`);
  }
  const work = record.work;
  if (work !== undefined && (!Array.isArray(work) || work.some((item) => typeof item !== "string" || item.trim().length === 0))) {
    throw new Error(`Provider "${id}" must declare "work" as an array of non-empty strings.`);
  }
  const supportedRoles = record.supportedRoles;
  if (
    supportedRoles !== undefined
    && (!Array.isArray(supportedRoles) || supportedRoles.some((role) => !isAgentRole(role)))
  ) {
    throw new Error(`Provider "${id}" must declare "supportedRoles" with valid agent roles.`);
  }
  const timeoutMs = record.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw new Error(`Provider "${id}" must declare a positive integer "timeoutMs".`);
  }
  return {
    id,
    command,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(args === undefined ? {} : { args: args as string[] }),
    ...(env === undefined ? {} : { env: env as string[] }),
    ...(promptVia === undefined ? {} : { promptVia }),
    ...(Array.isArray(work) ? { work: work as string[] } : {}),
    ...(Array.isArray(supportedRoles) ? { supportedRoles: supportedRoles as AgentRole[] } : {}),
    ...(typeof record.roleRestrictionReason === "string" ? { roleRestrictionReason: record.roleRestrictionReason } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

function commandForPlatform(command: string): string {
  if (process.platform !== "win32") return command;
  if (["claude", "codex", "pi", "opencode"].includes(command)) return `${command}.cmd`;
  return command;
}

function isAgentRole(value: unknown): value is AgentRole {
  return value === "direct" || value === "research" || value === "draft" || value === "review" || value === "external";
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Process-wide built-ins for callers that do not need user overrides. 不需要用户覆盖时使用的进程级内建 Registry。 */
export const builtInProviders = createBuiltInProviderRegistry();
