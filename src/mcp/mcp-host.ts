/**
 * An MCP (Model Context Protocol) host for in-process tools.
 *
 * Workers and the Main Agent should be able to use the same tools a Claude
 * Code-style harness exposes, without each integration writing its own client.
 * This module is deliberately small: JSON-RPC 2.0 over a child process's stdio,
 * the MCP lifecycle (`initialize`, `tools/list`, `tools/call`), a per-server
 * timeout, and an output cap. It does not implement prompts, resources, OAuth,
 * or HTTP transports yet; those are additive and have their own approval.
 *
 * 进程内工具的 MCP（Model Context Protocol）宿主。
 *
 * Worker 与 Main Agent 应当能使用与 Claude Code 风格 harness 相同的工具，而不必让每个集成
 * 自己写客户端。本模块刻意保持很小：基于子进程 stdio 的 JSON-RPC 2.0、MCP 生命周期
 * （`initialize`、`tools/list`、`tools/call`）、每服务器超时与输出上限。它还没有实现
 * prompts、resources、OAuth 或 HTTP 传输；这些是增量能力，各有自己的审批。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { environmentFor } from "../workers/mcp-client.ts";

export interface McpServerConfig {
  /** A stable name; tools are exposed as `mcp__<server>__<tool>`. 稳定名称；工具暴露为 `mcp__<server>__<tool>`。 */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the server process. 服务器进程的工作目录。 */
  cwd?: string;
  /** Per-request timeout; defaults to 60,000 ms. 每请求超时；默认 60,000 ms。 */
  timeoutMs?: number;
  /** Output cap per tool call; defaults to 25,000 tokens' worth of characters. 每次工具调用的输出上限。 */
  maxOutputChars?: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
}

export class McpError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One MCP server connection over stdio.
 *
 * The process is started lazily by `connect`; every request has its own timeout,
 * a failed server is marked failed and never hangs the caller, and `close`
 * terminates the process tree on platforms that allow it.
 * 一个基于 stdio 的 MCP 服务器连接。
 *
 * 进程由 `connect` 惰性启动；每个请求有自己的超时；失败的服务器被标记为失败，绝不挂住调用方；
 * `close` 在平台允许时终止整个进程树。
 */
export class McpServerConnection {
  readonly #config: McpServerConfig;
  readonly #pending = new Map<number, Pending>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #nextId = 1;
  #failed: string | undefined;
  #tools: McpTool[] | undefined;

  constructor(config: McpServerConfig) {
    this.#config = config;
  }

  get name(): string {
    return this.#config.name;
  }

  get tools(): readonly McpTool[] {
    return this.#tools ?? [];
  }

  async connect(): Promise<void> {
    if (this.#child !== undefined) return;
    if (this.#failed !== undefined) throw new McpError(`MCP server ${this.#config.name} failed: ${this.#failed}`);
    const child = spawn(this.#config.command, this.#config.args ?? [], {
      cwd: this.#config.cwd ?? process.cwd(),
      // The owner's whole environment includes API keys. A server receives the
      // same narrow set the worker's MCP client forwards (PATH, HOME and the
      // names it declared), so a third-party server cannot read credentials it
      // was never granted.
      // 所有者的完整环境包含 API 密钥。服务器只收到 Worker 的 MCP 客户端转发的同一个窄集合
      // （PATH、HOME 及它自己声明的变量名），因此第三方服务器读不到未被授予的凭据。
      env: environmentFor({ env: this.#config.env ?? {} }, process.env),
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so the whole tree can be terminated.
      // 独立进程组，以便终止整棵进程树。
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    this.#child = child;
    // An EPIPE on stdin must fail this server, not the process.
    // stdin 上的 EPIPE 应让这个服务器失败，而不是进程。
    child.stdin.on("error", (error: Error) => this.#fail(`stdin failed: ${error.message}`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      // stderr is diagnostic; a chatty server must not crash the host.
      // stderr 是诊断信息；话多的服务器不能弄崩宿主。
    });
    child.on("error", (error) => this.#fail(error.message));
    child.on("exit", (code, signal) => {
      this.#fail(`exited ${signal === null ? `with code ${code}` : `on ${signal}`}`);
    });
    // Initialize handshake. The server may already be old; a missing
    // protocolVersion is tolerated and the version we sent is used.
    // 初始化握手。服务器可能较旧；缺少 protocolVersion 时容错，并使用我们发送的版本。
    await this.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "clone-ai", version: "0.1.0" },
    });
    await this.#notify("notifications/initialized", {});
    const listed = await this.#request("tools/list", {}) as { tools?: unknown };
    this.#tools = parseTools(listed);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.connect();
    const result = await this.#request("tools/call", { name, arguments: args }) as {
      content?: unknown;
      isError?: unknown;
    };
    const content = Array.isArray(result.content)
      ? result.content.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const record = item as { type?: unknown; text?: unknown };
        return typeof record.type === "string"
          ? [{ type: record.type, ...(typeof record.text === "string" ? { text: capText(record.text, this.#config.maxOutputChars ?? 100_000) } : {}) }]
          : [];
      })
      : [];
    return { content, isError: result.isError === true };
  }

  /** Terminates the server. Best effort: a server that ignores SIGTERM is killed. 终止服务器。尽力而为：忽略 SIGTERM 的服务器会被强杀。 */
  async close(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#tools = undefined;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new McpError(`MCP server ${this.#config.name} closed.`));
      this.#pending.delete(id);
    }
    if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (process.platform === "win32") child.kill(name);
        else process.kill(-child.pid!, name);
      } catch {
        child.kill(name);
      }
    };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      signal("SIGTERM");
    });
  }

  #fail(reason: string): void {
    this.#failed = reason;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new McpError(`MCP server ${this.#config.name} ${reason}.`));
      this.#pending.delete(id);
    }
    this.#child = undefined;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as { id?: unknown; result?: unknown; error?: unknown; method?: unknown };
    if (typeof record.method === "string") {
      // Server-initiated requests: answer ping, ignore the rest.
      // 服务器发起的请求：应答 ping，忽略其余。
      if (record.method === "ping" && typeof record.id === "number") {
        this.#write({ jsonrpc: "2.0", id: record.id, result: {} });
      }
      return;
    }
    if (typeof record.id !== "number") return;
    const pending = this.#pending.get(record.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(record.id);
    if (record.error !== undefined) {
      const error = record.error as { message?: unknown; code?: unknown };
      pending.reject(new McpError(
        typeof error.message === "string" ? error.message : "MCP request failed.",
        typeof error.code === "number" ? error.code : undefined,
      ));
      return;
    }
    pending.resolve(record.result);
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.#child;
    if (child === undefined) return Promise.reject(new McpError(`MCP server ${this.#config.name} is not running.`));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpError(`MCP server ${this.#config.name} did not answer ${method} in time.`));
      }, this.#config.timeoutMs ?? 60_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.#write({ jsonrpc: "2.0", method, params });
    return Promise.resolve();
  }

  #write(message: Record<string, unknown>): void {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/** Parse a `tools/list` result, dropping entries without a name. 解析 `tools/list` 结果，丢弃没有名称的条目。 */
export function parseTools(value: unknown): McpTool[] {
  if (typeof value !== "object" || value === null) return [];
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (typeof tool !== "object" || tool === null) return [];
    const record = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof record.name !== "string" || record.name.length === 0) return [];
    return [{
      name: record.name,
      description: typeof record.description === "string" ? record.description : "",
      inputSchema: typeof record.inputSchema === "object" && record.inputSchema !== null
        ? record.inputSchema as Record<string, unknown>
        : { type: "object", properties: {} },
    }];
  });
}

/** The namespaced model-facing name of an MCP tool. MCP 工具面向模型的命名空间名称。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Split a namespaced name back into server and tool. 把命名空间名称拆回服务器与工具。 */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_][^_]*?)__(.+)$/.exec(name);
  return match === null ? undefined : { server: match[1]!, tool: match[2]! };
}

/**
 * A host that owns several MCP servers and exposes one namespaced tool table.
 *
 * A server that fails to start is reported in `failures` and contributes no
 * tools; it never blocks the other servers.
 * 拥有多个 MCP 服务器、对外暴露一张命名空间工具表的宿主。
 *
 * 启动失败的服务器记入 `failures` 且不贡献工具；它绝不阻塞其他服务器。
 */
export class McpHost {
  readonly #servers: McpServerConnection[];
  readonly #failures: Array<{ server: string; reason: string }> = [];

  constructor(configs: readonly McpServerConfig[]) {
    // Two servers with one name would both register tools under the same
    // prefix, and the loop resolves a duplicate by name (first wins), so one
    // server's tools silently shadowed the other's. Refusing at construction
    // makes the configuration error visible where it is written.
    // 两个同名服务器会把工具注册在同一前缀下，而循环按名解析（先到先得），于是一个服务器的工具
    // 会静默遮住另一个。在构造时拒绝，让配置错误在书写处就暴露。
    const names = new Set<string>();
    for (const config of configs) {
      const name = config.name.trim();
      if (name.length === 0) throw new McpError("An MCP server needs a non-empty name.");
      if (names.has(name)) throw new McpError(`Duplicate MCP server name: ${name}.`);
      names.add(name);
    }
    this.#servers = configs.map((config) => new McpServerConnection(config));
  }

  get failures(): readonly { server: string; reason: string }[] {
    return this.#failures;
  }

  /** Connects every server in parallel; a failure is recorded, not thrown. 并行连接所有服务器；失败被记录而不是抛出。 */
  async connectAll(): Promise<void> {
    this.#failures.length = 0;
    await Promise.all(this.#servers.map(async (server) => {
      try {
        await server.connect();
      } catch (error: unknown) {
        this.#failures.push({ server: server.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }));
  }

  /** Every tool from every connected server, namespaced. 每个已连接服务器的全部工具，带命名空间。 */
  tools(): Array<{ name: string; description: string; parameters: Record<string, unknown>; server: string; tool: string }> {
    const seen = new Set<string>();
    return this.#servers.flatMap((server) => server.tools.flatMap((tool) => {
      const name = mcpToolName(server.name, tool.name);
      if (seen.has(name)) {
        // A provider rejects two functions with one name, and dropping the
        // duplicate silently would hide which server lost its tool.
        // Provider 会拒绝两个同名函数，而静默丢弃重复项会掩盖是哪个服务器失去了工具。
        this.#failures.push({ server: server.name, reason: `duplicate tool name ${tool.name}` });
        return [];
      }
      seen.add(name);
      return [{ name, description: tool.description, parameters: tool.inputSchema, server: server.name, tool: tool.name }];
    }));
  }

  /** Calls a namespaced tool. 调用一个命名空间工具。 */
  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const parsed = parseMcpToolName(name);
    if (parsed === undefined) throw new McpError(`Not an MCP tool name: ${name}`);
    const server = this.#servers.find((candidate) => candidate.name === parsed.server);
    if (server === undefined) throw new McpError(`Unknown MCP server: ${parsed.server}`);
    return server.callTool(parsed.tool, args);
  }

  async close(): Promise<void> {
    await Promise.all(this.#servers.map((server) => server.close().catch(() => undefined)));
  }
}

function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = Math.max(0, limit - 40);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}\n... [${text.length - keep} characters truncated] ...\n${text.slice(text.length - tail)}`;
}
