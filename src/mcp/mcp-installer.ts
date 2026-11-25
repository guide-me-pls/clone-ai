/**
 * Owner-confirmed installation of a stdio MCP server.
 *
 * Three steps, in order: probe the package (spawn it and ask for
 * `tools/list`), require the owner's explicit acknowledgement, then merge one
 * entry into `mcp.json`. The probe is the only place a package runs before it
 * is installed, and it runs with the narrow MCP environment — never the owner's
 * credentials. The agent cannot reach this module: its tools refuse `~/.clone`
 * and the exec sandbox re-denies it, so installation stays an owner action.
 *
 * The risk of each tool is the owner's declaration, not the package's: an
 * undeclared tool is refused by the same gate as before, and the settings page
 * starts every probed tool at `external` until the owner assigns one.
 *
 * 由所有者确认的 stdio MCP 服务器安装。
 *
 * 三步，按顺序：探测包（启动它并请求 `tools/list`）、要求所有者显式确认、把一条条目合并进
 * `mcp.json`。探测是包在安装前唯一会运行的地方，且运行在 MCP 的窄环境中——绝不带所有者的
 * 凭据。Agent 到不了这个模块：它的工具拒绝 `~/.clone`，exec 沙箱也会重新拒绝它，因此安装
 * 始终是所有者动作。
 *
 * 每个工具的风险由所有者声明，而不是包自己：未声明的工具仍被同一道闸门拒绝，设置页在所有者
 * 指定风险之前，让每个探测到的工具从 `external` 开始。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readJsonFile, writeJsonAtomic } from "../config/json-file.ts";
import type { NativeToolRisk } from "../workers/native-agent-worker.ts";
import { MCP_CONFIG_FILE, type McpServerConfig } from "../workers/mcp-client.ts";
import { readToolCatalog, type McpToolCatalog } from "./mcp-catalog.ts";
import { McpServerConnection } from "./mcp-host.ts";

/** A tool a server exposed during a probe. 探测时服务器暴露的一个工具。 */
export interface ProbedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One tool the owner is granting, with the risk they assigned. 所有者授予的一个工具及其风险。 */
export interface InstallToolDeclaration {
  name: string;
  risk: NativeToolRisk;
  pathField?: string;
}

/** A name or `@scope/name`, optionally `@version`. 名称或 `@scope/name`，可选 `@version`。 */
const PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._+-]*)?$/i;
/** Server ids become tool-name prefixes, so the character set stays narrow. 服务器 id 会成为工具名前缀，字符集保持窄。 */
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RISKS: readonly NativeToolRisk[] = ["read", "write", "network", "external"];
/** A first run downloads the package; this outlasts the client's 60s default. 首次运行要下载包，因此超过客户端 60s 默认值。 */
const PROBE_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = 120_000;
/**
 * The npx this runtime can actually run.
 *
 * A launchd daemon, a Finder launch and a dev shell disagree about PATH; the
 * daemon's minimal PATH has no npx at all, which surfaced as "spawn npx
 * ENOENT" on every marketplace install. Prefer the npx that sits next to the
 * Node running this daemon, then the usual package-manager locations, and
 * only then the bare name. The resolved absolute path is written into
 * `mcp.json`, so later worker runs do not depend on PATH either.
 *
 * 本运行时真正能跑的 npx。
 *
 * launchd 守护进程、Finder 启动与开发 Shell 对 PATH 的认识并不一致；守护进程的最小
 * PATH 里根本没有 npx，市场安装因此报 "spawn npx ENOENT"。优先用运行本守护进程的
 * Node 旁边的 npx，其次是常见包管理器位置，最后才是裸名字。解析出的绝对路径会写入
 * `mcp.json`，之后的 Worker 运行也不再依赖 PATH。
 */
export function resolveNpxCommand(): string {
  const configured = process.env.CLONE_AI_MCP_NPX?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  const home = homedir();
  const candidates = [
    join(dirname(process.execPath), "npx"),
    "/opt/homebrew/bin/npx",
    "/usr/local/bin/npx",
    join(home, "Library", "pnpm", "npx"),
    join(home, ".volta", "bin", "npx"),
    join(home, ".bun", "bin", "npx"),
    join(home, ".npm-global", "bin", "npx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "npx";
}

/** Validate an npm package spec. 校验 npm 包规格。 */
export function assertPackageSpec(value: string): string {
  const spec = value.trim();
  if (spec.length === 0) throw new Error("A package spec is required, for example @scope/server@1.2.3.");
  if (!PACKAGE_SPEC.test(spec)) {
    throw new Error(`"${value}" is not an npm package spec (name or @scope/name, optionally @version).`);
  }
  return spec;
}

/** Validate the argv passed after the package spec. 校验包规格之后的 argv。 */
export function parseInstallArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("args must be an array of strings.");
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`args[${index}] must be a string.`);
    if (/[\0\r\n]/.test(item)) throw new Error(`args[${index}] must not contain control characters.`);
    return item;
  });
}

/** Validate the environment a server may receive. 校验服务器可以接收的环境变量。 */
export function parseInstallEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("env must be an object of string values.");
  }
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`env.${key} is not a valid environment variable name.`);
    if (typeof raw !== "string") throw new Error(`env.${key} must be a string.`);
    if (raw.includes("\0")) throw new Error(`env.${key} must not contain NUL.`);
    env[key] = raw;
  }
  return env;
}

/** Validate the tool declarations the owner approved. 校验所有者批准的工具声明。 */
export function parseInstallTools(value: unknown): InstallToolDeclaration[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Probe the package first; installing needs at least one declared tool.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`tools[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name.length === 0) throw new Error(`tools[${index}] needs a non-empty name.`);
    if (seen.has(name)) throw new Error(`tools[${index}] repeats the tool name "${name}".`);
    seen.add(name);
    const risk = record.risk;
    if (typeof risk !== "string" || !RISKS.includes(risk as NativeToolRisk)) {
      throw new Error(`tools[${index}] ("${name}") needs a risk: ${RISKS.join(", ")}.`);
    }
    const pathField = record.pathField;
    if (pathField !== undefined && (typeof pathField !== "string" || pathField.trim().length === 0)) {
      throw new Error(`tools[${index}] ("${name}") has an invalid pathField.`);
    }
    return {
      name,
      risk: risk as NativeToolRisk,
      ...(typeof pathField === "string" ? { pathField } : {}),
    };
  });
}

/**
 * Spawn one stdio MCP server, perform the handshake, and return its tools.
 * The process is always closed, including when the handshake fails.
 * 启动一个 stdio MCP 服务器，完成握手并返回工具；即使握手失败也一定关闭进程。
 */
export async function probeMcpPackage(input: {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
}): Promise<ProbedTool[]> {
  const connection = new McpServerConnection({
    name: input.id,
    command: input.command,
    args: input.args,
    ...(input.env === undefined ? {} : { env: input.env }),
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
  try {
    await connection.connect();
    return connection.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  } finally {
    await connection.close();
  }
}

/** Probe an npm package spec with the same argv the install will use. 用与安装相同的 argv 探测 npm 包。 */
export async function probeNpmPackage(input: {
  package: string;
  args?: unknown;
  env?: unknown;
  workspacePath: string;
}): Promise<ProbedTool[]> {
  const spec = assertPackageSpec(input.package);
  const extra = parseInstallArgs(input.args);
  const env = parseInstallEnv(input.env);
  return probeMcpPackage({
    id: "probe",
    command: resolveNpxCommand(),
    args: ["--yes", spec, ...extra],
    ...(env === undefined ? {} : { env }),
    cwd: input.workspacePath,
  });
}

export interface InstallMcpServerOptions {
  dataDirectory: string;
  workspacePath: string;
  id: string;
  package: string;
  args?: unknown;
  /** Environment values the server may receive; names never come from process.env. 服务器可以接收的环境值；变量名绝不来自 process.env。 */
  env?: unknown;
  tools: unknown;
  acknowledgeInstall: boolean;
  /** Test seam; production uses {@link probeMcpPackage}. 测试接缝；生产使用 probeMcpPackage。 */
  probe?: (input: { id: string; command: string; args: string[]; env?: Record<string, string>; cwd: string; timeoutMs: number }) => Promise<ProbedTool[]>;
}

/**
 * Probe, verify, and merge one server into `mcp.json`.
 *
 * Every failure happens before the write, so a refused install leaves the
 * owner's file untouched. A package that exposes a tool the request does not
 * declare is refused rather than silently filtered: the owner should see the
 * drift, not discover it later as a tool that does not work.
 * 探测、校验，并把一个服务器合并进 `mcp.json`。
 *
 * 所有失败都在写入之前发生，因此被拒绝的安装不会改动所有者的文件。暴露了请求未声明工具的包会被
 * 拒绝，而不是静默过滤：所有者应当看见这种漂移，而不是之后才发现某个工具不能用。
 */
export async function installMcpServer(options: InstallMcpServerOptions): Promise<McpToolCatalog> {
  // Installation downloads and runs a package. The settings UI is the only
  // caller that can set this flag; a route that forgets it fails closed.
  // 安装会下载并运行一个包。只有设置页能设置该标志；忘记它的路由会 fail closed。
  if (options.acknowledgeInstall !== true) {
    throw new Error("Installing downloads and runs a package from npm; the owner must confirm the install.");
  }
  const id = options.id.trim();
  if (!SERVER_ID.test(id)) {
    throw new Error("The server id must start with a letter or digit and contain only letters, digits, dots, dashes and underscores.");
  }
  const spec = assertPackageSpec(options.package);
  const extra = parseInstallArgs(options.args);
  const env = parseInstallEnv(options.env);
  const tools = parseInstallTools(options.tools);

  const path = join(options.dataDirectory, MCP_CONFIG_FILE);
  const document = await readMcpDocument(path);
  if (document.entries.some((entry) => serverIdOf(entry) === id)) {
    throw new Error(`An MCP server named "${id}" is already installed.`);
  }

  const argv = ["--yes", spec, ...extra];
  const npx = resolveNpxCommand();
  const probe = options.probe ?? ((input) => probeMcpPackage(input));
  const probed = await probe({
    id,
    command: npx,
    args: argv,
    ...(env === undefined ? {} : { env }),
    cwd: options.workspacePath,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (probed.length === 0) throw new Error(`The package "${spec}" exposed no tools, so there is nothing to install.`);
  const declared = new Set(tools.map((tool) => tool.name));
  const undeclared = probed.map((tool) => tool.name).filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new Error(`The package exposes tools the request does not declare (${undeclared.join(", ")}); refusing to install.`);
  }

  const server: McpServerConfig = {
    id,
    enabled: true,
    transport: "stdio",
    command: npx,
    args: argv,
    ...(env === undefined ? {} : { env }),
    cwd: options.workspacePath,
    timeoutMs: SERVER_TIMEOUT_MS,
    tools: tools.map((tool) => ({
      name: tool.name,
      risk: tool.risk,
      ...(tool.pathField === undefined ? {} : { pathField: tool.pathField }),
    })),
  };
  // Keep every top-level field and every untouched entry as written: mcp.json is
  // the owner's document, and an install edits one entry, not the file.
  // 原样保留每个顶层字段与未触碰的条目：mcp.json 是所有者的文档，安装只改一条条目，不改整个文件。
  await writeJsonAtomic(path, { ...document.raw, servers: [...document.entries, server] });
  return readToolCatalog(options.dataDirectory, options.workspacePath);
}

/**
 * Remove one server entry. The rest of the document is written back as it was.
 * 删除一条服务器条目；文档其余部分原样写回。
 */
export async function removeMcpServer(dataDirectory: string, workspacePath: string, id: string): Promise<McpToolCatalog> {
  const serverId = id.trim();
  if (serverId.length === 0) throw new Error("The server id must not be empty.");
  const path = join(dataDirectory, MCP_CONFIG_FILE);
  const document = await readMcpDocument(path);
  if (!document.entries.some((entry) => serverIdOf(entry) === serverId)) {
    throw new Error(`No MCP server named "${serverId}".`);
  }
  const next = document.entries.filter((entry) => serverIdOf(entry) !== serverId);
  await writeJsonAtomic(path, { ...document.raw, servers: next });
  return readToolCatalog(dataDirectory, workspacePath);
}

interface McpDocument {
  /** The parsed top-level object, before any edit. 编辑前的解析后顶层对象。 */
  raw: Record<string, unknown>;
  /** The original `servers` array, entries untouched. 原始 `servers` 数组，条目未改动。 */
  entries: unknown[];
}

async function readMcpDocument(path: string): Promise<McpDocument> {
  const raw = await readJsonFile<unknown>(path);
  if (raw === undefined) return { raw: {}, entries: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} must be an object with a "servers" array.`);
  }
  const record = raw as Record<string, unknown>;
  const servers = record.servers;
  if (servers === undefined) return { raw: record, entries: [] };
  if (!Array.isArray(servers)) throw new Error(`${path}: "servers" must be an array.`);
  return { raw: record, entries: servers };
}

function serverIdOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}
