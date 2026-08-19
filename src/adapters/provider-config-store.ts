import { readJsonFile, writeJsonAtomic } from "../config/json-file.ts";
import { BUILT_IN_PROVIDER_CONFIGS } from "./built-in-providers.ts";
import type { BlackBoxProviderConfig } from "./black-box-worker.ts";

/**
 * Read only the owner's overrides. Built-ins remain source-controlled defaults;
 * user edits are stored as a small, portable JSON document. 只读取所有者覆盖项；内建配方
 * 仍是源码默认值，用户修改保存为小而可迁移的 JSON 文档。
 */
export async function readUserProviderConfigs(dataDirectory: string): Promise<BlackBoxProviderConfig[]> {
  const value = await readJsonFile<unknown>(`${dataDirectory}/providers.json`);
  if (value === undefined) return [];
  return parseProviderDocument(value, `${dataDirectory}/providers.json`);
}

export async function writeUserProviderConfigs(
  dataDirectory: string,
  providers: readonly BlackBoxProviderConfig[],
): Promise<BlackBoxProviderConfig[]> {
  const validated = providers.map((provider, index) => validateProviderConfig(provider, `providers.json#${index}`));
  await writeJsonAtomic(`${dataDirectory}/providers.json`, { providers: validated });
  return validated;
}

export async function upsertUserProviderConfig(
  dataDirectory: string,
  provider: BlackBoxProviderConfig,
): Promise<BlackBoxProviderConfig[]> {
  const current = await readUserProviderConfigs(dataDirectory);
  const next = current.filter((candidate) => candidate.id !== provider.id);
  next.push(validateProviderConfig(provider, `providers.json#${provider.id}`));
  return writeUserProviderConfigs(dataDirectory, next);
}

export async function removeUserProviderConfig(dataDirectory: string, id: string): Promise<BlackBoxProviderConfig[]> {
  const current = await readUserProviderConfigs(dataDirectory);
  return writeUserProviderConfigs(dataDirectory, current.filter((provider) => provider.id !== id));
}

export async function listEffectiveProviderConfigs(dataDirectory: string): Promise<BlackBoxProviderConfig[]> {
  const byId = new Map(BUILT_IN_PROVIDER_CONFIGS.map((provider) => [provider.id, provider]));
  for (const provider of await readUserProviderConfigs(dataDirectory)) byId.set(provider.id, provider);
  return [...byId.values()];
}

function parseProviderDocument(value: unknown, where: string): BlackBoxProviderConfig[] {
  if (typeof value !== "object" || value === null) throw new Error(`Provider configuration at ${where} must be an object.`);
  const entries = (value as Record<string, unknown>).providers;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error(`Provider configuration at ${where} needs a "providers" array.`);
  const providers = entries.map((entry, index) => validateProviderConfig(entry, `${where}#${index}`));
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`Provider ${provider.id} is declared more than once at ${where}.`);
    ids.add(provider.id);
  }
  return providers;
}

function validateProviderConfig(value: unknown, where: string): BlackBoxProviderConfig {
  if (typeof value !== "object" || value === null) throw new Error(`Provider declaration at ${where} must be an object.`);
  const record = value as Record<string, unknown>;
  const id = record.id;
  const command = record.command;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) throw new Error(`Provider declaration at ${where} needs a valid id.`);
  if (typeof command !== "string" || command.trim().length === 0) throw new Error(`Provider ${id} needs a non-empty command.`);
  const args = record.args;
  const env = record.env;
  const work = record.work;
  const supportedRoles = record.supportedRoles;
  const timeoutMs = record.timeoutMs;
  if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== "string"))) throw new Error(`Provider ${id} args must be strings.`);
  if (env !== undefined && (!Array.isArray(env) || env.some((item) => typeof item !== "string" || !/^[A-Z_][A-Z0-9_]*$/i.test(item)))) throw new Error(`Provider ${id} env must contain variable names only.`);
  if (work !== undefined && (!Array.isArray(work) || work.some((item) => typeof item !== "string" || item.trim().length === 0))) throw new Error(`Provider ${id} work must contain non-empty strings.`);
  if (supportedRoles !== undefined && (!Array.isArray(supportedRoles) || supportedRoles.some((role) => !isRole(role)))) throw new Error(`Provider ${id} has an invalid supportedRoles list.`);
  if (record.promptVia !== undefined && record.promptVia !== "arg" && record.promptVia !== "stdin") throw new Error(`Provider ${id} promptVia must be arg or stdin.`);
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1)) throw new Error(`Provider ${id} timeoutMs must be a positive integer.`);
  return {
    id,
    command,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(Array.isArray(args) ? { args: args as string[] } : {}),
    ...(Array.isArray(env) ? { env: env as string[] } : {}),
    ...(record.promptVia === "arg" || record.promptVia === "stdin" ? { promptVia: record.promptVia } : {}),
    ...(Array.isArray(work) ? { work: work as string[] } : {}),
    ...(Array.isArray(supportedRoles) ? { supportedRoles: supportedRoles as BlackBoxProviderConfig["supportedRoles"] } : {}),
    ...(typeof record.roleRestrictionReason === "string" ? { roleRestrictionReason: record.roleRestrictionReason } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

function isRole(value: unknown): value is NonNullable<BlackBoxProviderConfig["supportedRoles"]>[number] {
  return value === "direct" || value === "research" || value === "draft" || value === "review" || value === "external";
}
