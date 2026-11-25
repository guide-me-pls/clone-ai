/**
 * The curated MCP marketplace behind the settings page.
 *
 * Why a shipped list instead of a live npm search: a search result is not a
 * reviewed server. It can be a package that is not an MCP server, a typosquat,
 * or a version that changed its tool surface after review. Every entry here is
 * a package the owner reviewed once, pinned to one version, with the inputs it
 * needs declared as typed fields instead of a raw argv string. The server
 * resolves the package, argv and environment from this file, so a marketplace
 * install cannot be pointed at an arbitrary package; the free-text form remains
 * for everything else.
 *
 * An entry may declare fixed environment values. `{dataDir}` is replaced with
 * the clone home before the install writes `mcp.json`; this is how a server that
 * persists data gets a file outside the npx cache. Entries that need an API key
 * are deliberately absent: the install form has no write-only secret input yet,
 * and a key typed into a visible field is worse than a manual install.
 *
 * 设置页背后的精选 MCP 市场。
 *
 * 为什么用随包清单而不是 npm 实时搜索：搜索结果不是被审查过的服务器。它可能不是 MCP
 * 服务器、可能是误拼包、也可能在审查之后换了工具面。这里的每一条都是所有者审查过一次的
 * 包、固定到一个版本，并把需要的输入声明成有类型的字段，而不是一段原始 argv 字符串。
 * 包、argv 与环境由服务器从本文件解析，因此市场安装无法被指向任意包；其余情况仍走自由
 * 文本表单。
 *
 * 条目可以声明固定的环境变量值。安装写入 `mcp.json` 前会把 `{dataDir}` 替换为 clone
 * home；需要持久化数据的服务器因此能把文件放在 npx 缓存之外。需要 API 密钥的条目刻意
 * 没有收录：安装表单还没有只写密文输入，把密钥输入可见字段比手动安装更糟。
 */
import { isAbsolute } from "node:path";

import { assertPackageSpec } from "./mcp-installer.ts";

export type RegistryVendor = "official" | "microsoft" | "google" | "community";

/** One string per UI language; the page picks by `config.locale`. 每种界面语言一条；由页面按 locale 选择。 */
export interface McpRegistryText {
  "zh-CN": string;
  en: string;
}

export type McpRegistryInputKind = "text" | "paths" | "toggle";

/** One typed install input. `paths` splits on commas/newlines into positional values. 一个有类型的安装输入；paths 按逗号/换行拆成位置参数。 */
export interface McpRegistryInput {
  key: string;
  label: McpRegistryText;
  placeholder?: string;
  hint?: McpRegistryText;
  required?: boolean;
  kind?: McpRegistryInputKind;
  /** Prefix the value with this flag instead of passing it positionally. 值前加这个开关，而不是作为位置参数。 */
  flag?: string;
  /** For a toggle: the argument emitted when it is on. 开关打开时追加的参数。 */
  arg?: string;
  defaultChecked?: boolean;
}

export interface McpRegistryEntry {
  /** The default server id; it also prefixes the tool names. 默认服务器 id；同时是工具名前缀。 */
  id: string;
  name: McpRegistryText;
  summary: McpRegistryText;
  /** A pinned npm spec: name@version, never a range. 固定的 npm 规格：name@version，绝不是范围。 */
  package: string;
  vendor: RegistryVendor;
  /** Search terms in both languages. 双语的搜索词。 */
  tags: string[];
  inputs: McpRegistryInput[];
  fixedArgs?: string[];
  /** Values with `{dataDir}` replaced by the clone home. 以 `{dataDir}` 引用 clone home 的值。 */
  env?: Record<string, string>;
  docs?: string;
}

/**
 * Five reviewed servers, all of which run without an API key. Versions were
 * checked against the npm registry on 2026-11-25.
 * 五个经过核对的服务器，全部无需 API 密钥。版本在 2026-11-25 对照 npm registry 核对。
 */
export const MCP_REGISTRY: readonly McpRegistryEntry[] = Object.freeze([
  {
    id: "filesystem",
    name: { "zh-CN": "文件系统", en: "Filesystem" },
    summary: {
      "zh-CN": "读写你指定的目录；默认只读。未列出的目录对分身不可见。",
      en: "Read and write the directories you choose; read-only by default. Unlisted directories stay invisible.",
    },
    package: "@modelcontextprotocol/server-filesystem@2.4.0",
    vendor: "official",
    tags: ["文件", "目录", "读写", "只读", "file", "files", "directory", "folder", "read", "write", "filesystem"],
    inputs: [
      {
        key: "directory",
        label: { "zh-CN": "允许访问的目录", en: "Allowed directories" },
        placeholder: "/Users/you/Documents",
        hint: {
          "zh-CN": "填绝对路径；多个目录用逗号或换行分隔。",
          en: "Absolute paths; separate several with commas or new lines.",
        },
        required: true,
        kind: "paths",
      },
      {
        key: "readOnly",
        label: { "zh-CN": "只读模式（不暴露写入工具）", en: "Read-only (no write tools)" },
        kind: "toggle",
        arg: "--read-only",
        defaultChecked: true,
      },
    ],
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "memory",
    name: { "zh-CN": "记忆图谱", en: "Memory graph" },
    summary: {
      "zh-CN": "用本地知识图谱记住实体、关系与观察，跨会话保留。数据存在分身的数据目录里。",
      en: "A local knowledge graph of entities, relations and observations that survives across sessions. Its data lives in the clone home.",
    },
    package: "@modelcontextprotocol/server-memory@2.2.1",
    vendor: "official",
    tags: ["记忆", "知识图谱", "实体", "关系", "memory", "graph", "knowledge", "remember", "entity"],
    inputs: [],
    // The server's default file sits inside the npx cache, which an update may
    // delete. Anchor it to the clone home instead.
    // 服务器默认文件位于 npx 缓存，更新可能删掉它。改为固定在 clone home。
    env: { MEMORY_FILE_PATH: "{dataDir}/mcp-memory.jsonl" },
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "sequential-thinking",
    name: { "zh-CN": "分步思考", en: "Sequential thinking" },
    summary: {
      "zh-CN": "把复杂问题拆成可修订的思考步骤，适合规划与排查。",
      en: "Break a complex problem into revisable thinking steps, for planning and debugging.",
    },
    package: "@modelcontextprotocol/server-sequential-thinking@2.2.0",
    vendor: "official",
    tags: ["思考", "推理", "规划", "步骤", "thinking", "reasoning", "plan", "steps", "sequential"],
    inputs: [],
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "playwright",
    name: { "zh-CN": "浏览器自动化", en: "Browser automation" },
    summary: {
      "zh-CN": "用 Playwright 打开页面、点击、截图并读取控制台，适合验证本地 Web 应用。",
      en: "Open pages, click, screenshot and read the console through Playwright — useful for checking a local web app.",
    },
    package: "@playwright/mcp@0.0.86",
    vendor: "microsoft",
    tags: ["浏览器", "自动化", "截图", "页面", "browser", "playwright", "automation", "screenshot", "web"],
    inputs: [],
    docs: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "chrome-devtools",
    name: { "zh-CN": "Chrome 调试", en: "Chrome DevTools" },
    summary: {
      "zh-CN": "检查页面结构、性能与网络请求；使用统计已默认关闭。",
      en: "Inspect page structure, performance and network requests; usage statistics are switched off.",
    },
    package: "chrome-devtools-mcp@1.14.0",
    vendor: "google",
    tags: ["chrome", "调试", "性能", "网络", "浏览器", "devtools", "debug", "performance", "trace", "page", "browser"],
    inputs: [],
    // Google's server reports usage statistics unless told not to; this app
    // opts every reviewable server out by default.
    // Google 的服务器默认上报使用统计；本应用对所有可审查服务器默认关闭。
    fixedArgs: ["--no-usage-statistics"],
    docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
  },
]);

/** The entry behind a marketplace install, or a clear error. 市场安装对应的条目，或明确的错误。 */
export function registryEntry(id: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((entry) => entry.id === id);
}

/** Every term must appear in the name, summary, package, vendor or tags. 每个词都必须出现在名称、摘要、包、厂商或标签里。 */
export function searchMcpRegistry(query: string): McpRegistryEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return [...MCP_REGISTRY];
  return MCP_REGISTRY.filter((entry) => {
    const haystack = [
      entry.name["zh-CN"],
      entry.name.en,
      entry.summary["zh-CN"],
      entry.summary.en,
      entry.package,
      entry.vendor,
      ...entry.tags,
    ].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface ResolvedRegistryServer {
  entry: McpRegistryEntry;
  id: string;
  package: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Build the one install request from an entry and the owner's inputs. The
 * package and fixed environment come from the registry, never from the client.
 * 从条目与所有者的输入构造唯一的安装请求。包与固定环境来自清单，绝不来自客户端。
 */
export function resolveRegistryServer(options: {
  entryId: string;
  inputs?: unknown;
  dataDirectory: string;
}): ResolvedRegistryServer {
  const entry = registryEntry(options.entryId);
  if (entry === undefined) throw new Error(`No MCP marketplace entry is named "${options.entryId}".`);
  const values = readInputValues(entry, options.inputs);
  const args = buildArgs(entry, values);
  const env = buildEnv(entry, options.dataDirectory);
  return {
    entry,
    id: entry.id,
    package: assertPackageSpec(entry.package),
    args,
    ...(env === undefined ? {} : { env }),
  };
}

function readInputValues(entry: McpRegistryEntry, input: unknown): Record<string, string | boolean> {
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    throw new Error("inputs must be an object.");
  }
  const provided = (input ?? {}) as Record<string, unknown>;
  const declared = new Set(entry.inputs.map((item) => item.key));
  for (const key of Object.keys(provided)) {
    if (!declared.has(key)) throw new Error(`The ${entry.id} entry has no input named "${key}".`);
  }
  const values: Record<string, string | boolean> = {};
  for (const item of entry.inputs) {
    const value = provided[item.key];
    if ((item.kind ?? "text") === "toggle") {
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`"${item.key}" must be true or false.`);
      }
      values[item.key] = value === undefined ? item.defaultChecked === true : value;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length === 0) {
      if (item.required === true) throw new Error(`The ${entry.id} entry needs "${item.label.en}".`);
      values[item.key] = "";
      continue;
    }
    if (/[\0\r\n]/.test(text)) throw new Error(`"${item.key}" must not contain control characters.`);
    values[item.key] = text;
  }
  return values;
}

function buildArgs(entry: McpRegistryEntry, values: Record<string, string | boolean>): string[] {
  const args = [...(entry.fixedArgs ?? [])];
  for (const item of entry.inputs) {
    const value = values[item.key];
    if ((item.kind ?? "text") === "toggle") {
      if (value !== true) continue;
      if (item.arg === undefined) throw new Error(`The ${entry.id} entry's "${item.key}" toggle has no argument.`);
      args.push(item.arg);
      continue;
    }
    if (typeof value !== "string" || value.length === 0) continue;
    const items = item.kind === "paths"
      ? value.split(/[,\n]/).map((part) => part.trim()).filter((part) => part.length > 0)
      : [value];
    if (item.kind === "paths") {
      for (const path of items) {
        if (!isAbsolute(path)) throw new Error(`"${item.key}" must be an absolute path; got "${path}".`);
      }
    }
    for (const part of items) {
      if (item.flag === undefined) args.push(part);
      else args.push(item.flag, part);
    }
  }
  return args;
}

function buildEnv(entry: McpRegistryEntry, dataDirectory: string): Record<string, string> | undefined {
  if (entry.env === undefined) return undefined;
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(entry.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`The ${entry.id} entry declares an invalid environment name "${key}".`);
    const value = raw.replace(/\{dataDir\}/g, dataDirectory);
    if (value.includes("\0")) throw new Error(`The ${entry.id} entry's "${key}" environment value must not contain NUL.`);
    env[key] = value;
  }
  return env;
}