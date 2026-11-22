/**
 * The `agent-tools` MCP server: the read-only capabilities the native worker
 * lacks, behind the same authority gate as every other MCP tool.
 *
 * The worker ships four file tools. It can read and write a file it already
 * knows about, but it cannot find a symbol across files, inspect a diff or a
 * commit history, learn the wall-clock date, or read a documentation URL. This
 * server supplies exactly those capabilities and nothing that writes:
 *
 *   search_text, find_files  — discovery inside a tree
 *   git_status, git_diff, git_log — read-only repository inspection
 *   current_time             — the clock the worker prompt does not carry
 *   fetch_url                — one HTTP(S) GET, with the private network closed
 *
 * It is deliberately self-contained (Node built-ins only) because the installer
 * copies this one file into the clone home. The declaration in `mcp.json` is
 * still the authority for each tool's risk; this module only executes.
 *
 * 本文件是 `agent-tools` MCP 服务器：把原生 Worker 缺失的只读能力放到与其他 MCP 工具相同的
 * 权威闸门之后。Worker 只有四个文件工具，能读写已经知道路径的文件，却不能跨文件找符号、
 * 看 diff 或提交历史、知道当前日期，也读不了文档 URL。本服务器只补这些，不提供任何写操作。
 *
 * 它刻意自包含（只用 Node 内建模块），因为安装脚本会把这一份文件复制到 clone home。
 * 每个工具的风险仍由 `mcp.json` 中的声明决定；本模块只负责执行。
 */
import { execFile } from "node:child_process";
import { promises as fs, realpathSync, type Dirent } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { lookup as dnsLookup } from "node:dns/promises";

export const SERVER_NAME = "agent-tools";
export const SERVER_VERSION = "1.0.0";
export const PROTOCOL_VERSION = "2025-06-18";

/**
 * The protected roots, relative to the owner's home. This mirrors
 * `forbiddenRoots()` in `src/authority/scope.ts`; the test compares the two
 * lists so a new kernel-protected location cannot silently become searchable
 * through this server. `decideTool` checks only the path a tool names, not
 * every descendant, so a search rooted above a protected directory needs this
 * second guard.
 *
 * 受保护根，相对于所有者家目录。它与 `src/authority/scope.ts` 的 `forbiddenRoots()`
 * 对应；测试会比较两份列表，使内核新增的受保护位置不会经由本服务器被静默检索到。
 * `decideTool` 只检查工具点名的那个路径，不检查它的所有后代，因此以受保护目录之上的路径
 * 为根做检索时，需要这第二道保护。
 */
export const PROTECTED_RELATIVE_ROOTS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".config/gcloud",
  ".netrc",
  "Library/Keychains",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Application Support/Microsoft Edge",
  "Library/Safari",
  ".clone/journal.sqlite3",
  ".clone/journal.sqlite3-wal",
  ".clone/journal.sqlite3-shm",
  ".clone/journal.jsonl",
  ".clone/policies.json",
  ".clone/companion.token",
] as const;

/** Directories a code search never descends into. 代码检索不会进入的目录。 */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".playwright-mcp",
]);

const MAX_SEARCH_FILE_BYTES = 1_000_000;
/** A walk that never finds a match still has to end; this bounds one tool call. 一次找不到匹配的遍历也必须结束；这给单次调用设了上限。 */
const MAX_WALK_ENTRIES = 100_000;
const MAX_GIT_BYTES = 200_000;
const GIT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const DEFAULT_FETCH_BYTES = 40_000;
const MAX_FETCH_BYTES = 200_000;

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolRunResult {
  text: string;
  isError?: boolean;
}

export interface RunToolOptions {
  /** Working directory, normally the workspace the server was started in. 工作目录，通常是服务器启动时的工作区。 */
  cwd?: string;
  /** Home directory used for the protected-root guard; injectable for tests. 用于受保护根检查的家目录；测试可注入。 */
  home?: string;
  /** Clock seam so `current_time` is reproducible in tests. 时钟切口，使测试中的 `current_time` 可复现。 */
  now?: () => Date;
  /** Fetch implementation, injectable so the network path is testable offline. 可注入的 fetch，使网络路径可以离线测试。 */
  fetchImpl?: typeof fetch;
  /** Host resolver, injectable so tests never depend on DNS. 可注入的主机解析器，使测试不依赖 DNS。 */
  lookupHost?: (host: string) => Promise<Array<{ address: string; family: number }>>;
}

/**
 * The model-facing catalogue. The descriptions carry each argument shape
 * because clone-ai's MCP client deliberately does not load a server's schema;
 * the owner declaration in `mcp.json` carries the risk instead.
 *
 * 面向模型的目录。描述里带每个参数形状，因为 clone-ai 的 MCP 客户端刻意不加载服务器
 * 自己的 Schema；风险则由 `mcp.json` 中的所有者声明承载。
 */
export function toolDefinitions(): AgentToolDefinition[] {
  return [
    {
      name: "search_text",
      description:
        "Search files under a directory and return matching lines as `path:line: text`. "
        + "Args: {\"query\": string, \"path\"?: string (default \".\"), \"glob\"?: string (e.g. \"*.ts\"), "
        + "\"regex\"?: boolean, \"caseSensitive\"?: boolean, \"maxResults\"?: number (default 50, max 500)}. "
        + "Skips .git, node_modules, build output, binary files and protected locations. Use it before claiming a symbol is absent.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal text, or a regular expression when regex is true." },
          path: { type: "string", description: "Directory or file to search. Defaults to the workspace." },
          glob: { type: "string", description: "Only search files whose base name or relative path matches this glob." },
          regex: { type: "boolean", description: "Treat query as a regular expression. Defaults to false." },
          caseSensitive: { type: "boolean", description: "Match case-sensitively. Defaults to false." },
          maxResults: { type: "number", description: "Maximum matching lines to return. Defaults to 50." },
        },
        required: ["query"],
      },
    },
    {
      name: "find_files",
      description:
        "Find files under a directory by glob and return their relative paths. "
        + "Args: {\"pattern\": string (e.g. \"**/*.ts\" or \"*.md\"), \"path\"?: string (default \".\"), "
        + "\"maxResults\"?: number (default 200, max 1000)}. Skips the same directories as search_text.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob to match; ** crosses directories." },
          path: { type: "string", description: "Directory to search. Defaults to the workspace." },
          maxResults: { type: "number", description: "Maximum paths to return. Defaults to 200." },
        },
        required: ["pattern"],
      },
    },
    {
      name: "git_status",
      description:
        "Show a repository's branch and working-tree status. Args: {\"path\"?: string} — the repository or a directory inside it; defaults to the workspace. Read-only.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Repository directory. Defaults to the workspace." } },
      },
    },
    {
      name: "git_diff",
      description:
        "Show a repository's unified diff. Args: {\"path\"?: string, \"staged\"?: boolean, \"commit\"?: string, "
        + "\"file\"?: string}. With no commit it shows the working tree (or the index when staged is true); "
        + "with a commit it shows that commit against the working tree. Read-only; never commits.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository directory. Defaults to the workspace." },
          staged: { type: "boolean", description: "Diff the index instead of the working tree." },
          commit: { type: "string", description: "A commit, tag or revision range, e.g. HEAD~1 or main." },
          file: { type: "string", description: "Limit the diff to one path." },
        },
      },
    },
    {
      name: "git_log",
      description:
        "Show recent commits as `hash date author subject`. Args: {\"path\"?: string, \"limit\"?: number "
        + "(default 20, max 200), \"file\"?: string}. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository directory. Defaults to the workspace." },
          limit: { type: "number", description: "Number of commits. Defaults to 20." },
          file: { type: "string", description: "Limit history to one path." },
        },
      },
    },
    {
      name: "current_time",
      description: "Return the current instant as ISO, local time, time zone, UTC offset and epoch milliseconds. No arguments.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "fetch_url",
      description:
        "Fetch one HTTP(S) URL with a GET and return its text (HTML is reduced to readable text). "
        + "Args: {\"url\": string, \"maxBytes\"?: number (default 40000, max 200000)}. "
        + "Refuses non-HTTP schemes, embedded credentials, and hosts that resolve to a private or loopback address. "
        + "Sends no cookies or credentials. This is a network tool and needs a network grant.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "An http: or https: URL." },
          maxBytes: { type: "number", description: "Maximum response bytes to read. Defaults to 40000." },
        },
        required: ["url"],
      },
    },
  ];
}

/** True when `path` is a protected location or inside one. 当 `path` 是受保护位置或位于其内时为真。 */
export function isProtectedAgentPath(path: string, home = homedir()): boolean {
  return isProtectedAgainst(path, protectedRootPaths(home));
}

/** The protected roots, resolved once per tool call. 每次工具调用解析一次的受保护根。 */
function protectedRootPaths(home: string): string[] {
  return PROTECTED_RELATIVE_ROOTS.map((entry) => canonicalAgentPath(resolve(home, entry)));
}

function isProtectedAgainst(path: string, roots: readonly string[]): boolean {
  // Resolve the path the OS would open: a symlink into a protected directory
  // must not pass just because its own name is outside one.
  // 按操作系统实际会打开的路径解析：指向受保护目录的符号链接不能因为自己的名字在外就通过。
  const target = canonicalAgentPath(path);
  const fold = process.platform === "win32" || process.platform === "darwin"
    ? (value: string) => value.toLowerCase()
    : (value: string) => value;
  return roots.some((root) => {
    const rel = relative(fold(root), fold(target));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function canonicalAgentPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The one entry point the protocol handler calls. Returning a tool error
 * instead of throwing keeps a bad argument or a missing file from killing the
 * server, which would look to the worker like the whole tool source died.
 *
 * 协议处理器调用的唯一入口。用工具错误而不是抛出来返回，坏参数或缺失文件不会杀死服务器，
 * 否则在 Worker 看来就是整个工具源都死了。
 */
export async function runTool(name: string, args: Record<string, unknown>, options: RunToolOptions = {}): Promise<ToolRunResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  try {
    switch (name) {
      case "search_text":
        return await searchText(args, cwd, home);
      case "find_files":
        return await findFiles(args, cwd, home);
      case "git_status":
        return await gitStatus(args, cwd, home);
      case "git_diff":
        return await gitDiff(args, cwd, home);
      case "git_log":
        return await gitLog(args, cwd, home);
      case "current_time":
        return currentTime(options.now);
      case "fetch_url":
        return await fetchUrl(args, options);
      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

async function searchText(args: Record<string, unknown>, cwd: string, home: string): Promise<ToolRunResult> {
  const query = stringArg(args.query);
  if (query === undefined) return { text: "Error: query must be a non-empty string.", isError: true };
  // A very long pattern is not a code search; it is a way to make the server
  // burn a step's whole budget. 超长模式不是代码检索，而是让服务器烧掉整个步骤预算的方式。
  if (query.length > 500) return { text: "Error: query is longer than 500 characters; narrow it.", isError: true };
  const caseSensitive = args.caseSensitive === true;
  let matcher: RegExp;
  try {
    matcher = new RegExp(args.regex === true ? query : escapeRegExp(query), caseSensitive ? "" : "i");
  } catch (error) {
    return { text: `Error: invalid regular expression: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
  const maxResults = clampCount(args.maxResults, 50, 1, 500);
  const glob = stringArg(args.glob);
  const protectedRoots = protectedRootPaths(home);
  const root = resolveInputPath(args.path, cwd, home);
  if (isProtectedAgainst(root, protectedRoots)) return { text: `Error: ${root} is a protected location.`, isError: true };
  const info = await fs.stat(root).catch(() => undefined);
  if (info === undefined) return { text: `Error: ${root} does not exist.`, isError: true };
  const rootIsFile = info.isFile();
  const matches: string[] = [];
  const files = rootIsFile ? singleFile(root) : walkFiles(root, protectedRoots);
  for await (const file of files) {
    if (glob !== undefined && !globMatches(glob, relative(root, file), file)) continue;
    const buffer = await readSmallFile(file);
    if (buffer === undefined) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      matcher.lastIndex = 0;
      // A pathological regex on a megabyte-long line can hold the server for
      // the whole step; matching the first 20 KB bounds that cost.
      // 病态正则遇上超长单行可能拖住服务器整个步骤；只匹配前 20KB 可以限制这个成本。
      if (!matcher.test(line.length > 20_000 ? line.slice(0, 20_000) : line)) continue;
      matches.push(`${rootIsFile ? file : slashPath(relative(root, file))}:${index + 1}: ${truncate(line.trim(), 300)}`);
      if (matches.length >= maxResults) break;
    }
    if (matches.length >= maxResults) break;
  }
  if (matches.length === 0) return { text: "No matches." };
  const suffix = matches.length >= maxResults ? `\n(stopped at ${maxResults} matches; narrow the query or raise maxResults)` : "";
  return { text: matches.join("\n") + suffix };
}

async function findFiles(args: Record<string, unknown>, cwd: string, home: string): Promise<ToolRunResult> {
  const pattern = stringArg(args.pattern);
  if (pattern === undefined) return { text: "Error: pattern must be a non-empty string.", isError: true };
  const maxResults = clampCount(args.maxResults, 200, 1, 1_000);
  const protectedRoots = protectedRootPaths(home);
  const root = resolveInputPath(args.path, cwd, home);
  if (isProtectedAgainst(root, protectedRoots)) return { text: `Error: ${root} is a protected location.`, isError: true };
  const info = await fs.stat(root).catch(() => undefined);
  if (info === undefined) return { text: `Error: ${root} does not exist.`, isError: true };
  const files: string[] = [];
  if (info.isFile()) {
    if (globMatches(pattern, relative(root, root), root)) files.push(root);
  } else {
    for await (const file of walkFiles(root, protectedRoots)) {
      if (!globMatches(pattern, relative(root, file), file)) continue;
      files.push(slashPath(relative(root, file)));
      if (files.length >= maxResults) break;
    }
  }
  if (files.length === 0) return { text: "No files matched." };
  files.sort((left, right) => left.localeCompare(right));
  const suffix = files.length >= maxResults ? `\n(stopped at ${maxResults} paths; narrow the pattern or raise maxResults)` : "";
  return { text: files.join("\n") + suffix };
}

async function gitStatus(args: Record<string, unknown>, cwd: string, home: string): Promise<ToolRunResult> {
  const directory = await gitDirectory(args, cwd, home);
  if (typeof directory !== "string") return directory;
  return runGit(["-C", directory, "--no-optional-locks", "--no-pager", "status", "--porcelain=v1", "--branch"]);
}

async function gitDiff(args: Record<string, unknown>, cwd: string, home: string): Promise<ToolRunResult> {
  const directory = await gitDirectory(args, cwd, home);
  if (typeof directory !== "string") return directory;
  // `--no-textconv` and `--no-ext-diff` keep a repository's own diff helpers
  // from running as code during a read-only inspection.
  // `--no-textconv` 与 `--no-ext-diff` 阻止仓库自带的 diff 助手在只读检查中执行代码。
  const command = [
    "-C", directory, "--no-optional-locks", "--no-pager",
    "-c", "core.fsmonitor=false",
    "diff", "--no-color", "--no-textconv", "--no-ext-diff", "--patch", "--stat",
  ];
  if (args.staged === true) command.push("--cached");
  const commit = stringArg(args.commit);
  if (commit !== undefined) {
    // A revision is not an option: `--output=…` would turn a read into a write.
    // 修订号不是选项：`--output=…` 会把读取变成写入。
    if (commit.startsWith("-") || !/^[A-Za-z0-9._~^@{}:/-]+$/.test(commit)) {
      return { text: `Error: not a valid revision: ${commit}`, isError: true };
    }
    command.push("--end-of-options", commit);
  }
  const file = stringArg(args.file);
  if (file !== undefined) command.push("--", file);
  return runGit(command);
}

async function gitLog(args: Record<string, unknown>, cwd: string, home: string): Promise<ToolRunResult> {
  const directory = await gitDirectory(args, cwd, home);
  if (typeof directory !== "string") return directory;
  const limit = clampCount(args.limit, 20, 1, 200);
  const command = [
    "-C", directory, "--no-optional-locks", "--no-pager",
    "-c", "core.fsmonitor=false",
    "log",
    `--max-count=${limit}`,
    "--date=iso-strict",
    "--pretty=format:%h %ad %an %s",
  ];
  const file = stringArg(args.file);
  if (file !== undefined) command.push("--", file);
  return runGit(command);
}

async function gitDirectory(args: Record<string, unknown>, cwd: string, home: string): Promise<string | ToolRunResult> {
  const directory = resolveInputPath(args.path, cwd, home);
  if (isProtectedAgentPath(directory, home)) return { text: `Error: ${directory} is a protected location.`, isError: true };
  const info = await fs.stat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return { text: `Error: ${directory} is not a directory.`, isError: true };
  return directory;
}

function runGit(args: string[]): Promise<ToolRunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      args,
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_BYTES,
        windowsHide: true,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
        },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = `${stderr || ""}${error.message}`.trim();
          resolvePromise({ text: `Error: git failed: ${truncate(detail, 2_000)}`, isError: true });
          return;
        }
        const text = stdout.trim();
        resolvePromise({ text: text.length === 0 ? "(no output)" : truncate(text, 20_000) });
      },
    );
  });
}

function currentTime(now: (() => Date) | undefined): ToolRunResult {
  const date = now?.() ?? new Date();
  return {
    text: JSON.stringify({
      iso: date.toISOString(),
      local: date.toString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMinutes: -date.getTimezoneOffset(),
      epochMs: date.getTime(),
    }, null, 2),
  };
}

async function fetchUrl(args: Record<string, unknown>, options: RunToolOptions): Promise<ToolRunResult> {
  const raw = stringArg(args.url);
  if (raw === undefined) return { text: "Error: url must be a non-empty string.", isError: true };
  let current: URL;
  try {
    current = new URL(raw);
  } catch {
    return { text: `Error: not a valid URL: ${raw}`, isError: true };
  }
  const maxBytes = clampCount(args.maxBytes, DEFAULT_FETCH_BYTES, 1, MAX_FETCH_BYTES);
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupHost = options.lookupHost ?? ((host: string) => dnsLookup(host, { all: true }));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refused = await publicUrlProblem(current, lookupHost);
    if (refused !== undefined) return { text: `Error: ${refused}`, isError: true };
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": `clone-ai-${SERVER_NAME}/${SERVER_VERSION}`,
          accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      return { text: `Error: fetch failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) return { text: `Error: HTTP ${response.status} without a Location header.`, isError: true };
      try {
        current = new URL(location, current);
      } catch {
        return { text: `Error: redirect to an invalid URL: ${location}`, isError: true };
      }
      continue;
    }
    if (!response.ok) {
      return { text: `Error: HTTP ${response.status} ${response.statusText} from ${current.href}`, isError: true };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = await readCapped(response, maxBytes);
    const text = contentType.toLowerCase().includes("html") ? htmlToText(body.text) : body.text;
    return {
      text: [
        `[${response.status}] ${current.href}`,
        `content-type: ${contentType.length === 0 ? "(unknown)" : contentType}`,
        ...(body.truncated ? [`(truncated at ${maxBytes} bytes)`] : []),
        "",
        text.length === 0 ? "(empty)" : text,
      ].join("\n"),
    };
  }
  return { text: `Error: more than ${MAX_REDIRECTS} redirects.`, isError: true };
}

async function publicUrlProblem(url: URL, lookupHost: (host: string) => Promise<Array<{ address: string; family: number }>>): Promise<string | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `only http: and https: are allowed, not ${url.protocol}`;
  if (url.username.length > 0 || url.password.length > 0) return "URLs with embedded credentials are refused";
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (host.length === 0) return "the URL has no host";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return `refused private host ${host}`;
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host) !== 0) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await lookupHost(host);
    } catch (error) {
      return `could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (addresses.length === 0) return `could not resolve ${host}`;
  const privateAddress = addresses.find((entry) => isPrivateAddress(entry.address));
  if (privateAddress !== undefined) return `refused private address ${privateAddress.address} for ${host}`;
  return undefined;
}

/** True for loopback, private, link-local, CGNAT, multicast and documentation ranges. 回环、私有、链路本地、CGNAT、组播与文档地址返回真。 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && parts[2] === 100) return true;
    if (a === 203 && b === 0 && parts[2] === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      if (mapped.includes(".")) return isPrivateAddress(mapped);
      // `::ffff:7f00:1` is the same address as `::ffff:127.0.0.1` in hex.
      // `::ffff:7f00:1` 与十六进制写法的 `::ffff:127.0.0.1` 是同一个地址。
      const groups = mapped.split(":");
      if (groups.length === 2) {
        const high = Number.parseInt(groups[0] ?? "", 16);
        const low = Number.parseInt(groups[1] ?? "", 16);
        if (Number.isInteger(high) && Number.isInteger(low)) {
          return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
        }
      }
      return true;
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith("ff")) return true;
    if (normalized.startsWith("2001:db8:")) return true;
    return false;
  }
  return true;
}

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    return text.length > maxBytes ? { text: text.slice(0, maxBytes), truncated: true } : { text, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), truncated };
}

/** Reduce an HTML document to readable text; scripts and styles never reach the model. 把 HTML 降为可读文本；脚本与样式不会到达模型。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Convert a small glob (`*`, `?`, `**`) to an anchored regular expression. 把小 glob（`*`、`?`、`**`）转成锚定正则。 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if ("\\^$+.|()[]{}".includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`^${source}$`);
}

function globMatches(pattern: string, relativePath: string, absolutePath: string): boolean {
  const normalized = relativePath.split(sep).join("/");
  const matcher = globToRegExp(pattern);
  if (pattern.includes("/")) return matcher.test(normalized);
  const base = absolutePath.split(sep).pop() ?? absolutePath;
  return matcher.test(normalized) || matcher.test(base);
}

async function* singleFile(path: string): AsyncGenerator<string> {
  yield path;
}

async function* walkFiles(root: string, protectedRoots: readonly string[]): AsyncGenerator<string> {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= MAX_WALK_ENTRIES) return;
    const directory = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    visited += entries.length;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        if (isProtectedAgainst(full, protectedRoots)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

async function readSmallFile(path: string): Promise<Buffer | undefined> {
  const info = await fs.stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > MAX_SEARCH_FILE_BYTES) return undefined;
  const buffer = await fs.readFile(path).catch(() => undefined);
  if (buffer === undefined) return undefined;
  // A NUL in the first block marks a binary file; searching it would only
  // return mojibake. 第一段里的 NUL 表示二进制文件；检索它只会得到乱码。
  if (buffer.subarray(0, 8_192).includes(0)) return undefined;
  return buffer;
}

function resolveInputPath(raw: unknown, cwd: string, home: string): string {
  const value = stringArg(raw) ?? ".";
  const expanded = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Tool output names paths with `/`, independent of the host separator. 工具输出统一用 `/` 命名路径，与宿主机分隔符无关。 */
function slashPath(path: string): string {
  return path.split(sep).join("/");
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clampCount(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[+${value.length - limit} chars]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

/** Handle one JSON-RPC message; notifications return undefined. 处理一条 JSON-RPC 消息；通知返回 undefined。 */
export async function handleMessage(message: JsonRpcRequest, options: RunToolOptions = {}): Promise<Record<string, unknown> | undefined> {
  if (message.id === undefined || message.id === null) return undefined;
  const id = message.id;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: toolDefinitions().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) },
    };
  }
  if (message.method === "tools/call") {
    const params = typeof message.params === "object" && message.params !== null ? message.params as { name?: unknown; arguments?: unknown } : {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {};
    const result = await runTool(name, args, options);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: result.text }],
        ...(result.isError === true ? { isError: true } : {}),
      },
    };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${message.method ?? "(none)"}` } };
}

/** Serve newline-delimited JSON-RPC on stdin/stdout until the parent closes stdin. 在 stdin/stdout 上提供换行分隔的 JSON-RPC，直到父进程关闭 stdin。 */
export function startServer(options: RunToolOptions = {}): void {
  let buffer = "";
  let queue: Promise<void> = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      queue = queue.then(() => handleLine(line, options));
    }
  });
  process.stdin.on("error", () => process.exit(0));
}

async function handleLine(line: string, options: RunToolOptions): Promise<void> {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(line) as JsonRpcRequest;
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }
  try {
    const reply = await handleMessage(message, options);
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    })}\n`);
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) startServer();
