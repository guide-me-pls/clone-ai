import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ExecutionAssignment } from "../core/contracts.ts";
import {
  SupervisedWorkerAdapter,
  isRecord,
  safeInputSummary,
  wait,
  type NormalizedWorkerEvent,
  type ProviderTranslator,
  type WorkerTransport,
} from "./supervised-worker.ts";

export type PiToolName = "read" | "grep" | "find" | "ls" | "edit" | "write" | "bash";

export interface PiProcessStart {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type PiTransportEvent =
  | { type: "message"; value: Record<string, unknown> }
  | { type: "stderr"; text: string }
  | { type: "protocol_error"; message: string }
  | { type: "process_error"; message: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export interface PiRpcSession {
  readonly events: AsyncIterable<PiTransportEvent>;
  send(command: Record<string, unknown>): void;
  terminate(): Promise<void>;
}

export interface PiProcessHost {
  start(input: PiProcessStart): Promise<PiRpcSession>;
}

export interface PiAgentAdapterOptions {
  id?: string;
  command?: string;
  commandArgs?: string[];
  cwd?: string;
  sessionDirectory?: string;
  provider?: string;
  model?: string;
  tools?: PiToolName[];
  workCapabilities?: string[];
  offline?: boolean;
  /**
   * Extra environment variable names explicitly allowed into the Pi process.
   * 被显式允许传入 Pi 进程的额外环境变量名称。
   */
  environmentVariables?: string[];
  /**
   * Grace period after an abort before the session is forcibly terminated.
   * 发送 abort 后、强制终止会话前的宽限时间。
   */
  abortGraceMs?: number;
  processHost?: PiProcessHost;
}

/**
 * Pi runs as an isolated JSONL RPC subprocess. This class is now only the Pi
 * protocol translator plus its process transport; budgets, cancellation,
 * completion authority, and evidence policy live in SupervisedWorkerAdapter.
 *
 * Pi 运行在隔离的 JSONL RPC 子进程中。本类现在只是 Pi 协议翻译器加进程传输层；
 * 预算、取消、完成判定权与证据策略都在 SupervisedWorkerAdapter 中。
 */
export class PiAgentAdapter extends SupervisedWorkerAdapter {
  constructor(options: PiAgentAdapterOptions = {}) {
    super({
      id: options.id ?? "pi",
      providerId: "pi",
      label: "Pi",
      translator: new PiTranslator(options),
      workCapabilities: options.workCapabilities ?? ["review", "direct_response"],
      abortGraceMs: options.abortGraceMs ?? 5_000,
      // Pi's historical default budget for tool-free bounded work.
      // Pi 面向无 Tool 有界工作的历史默认预算。
      defaultBudget: { maxDurationMs: 10 * 60_000, maxModelCalls: 20, maxToolCalls: 100 },
    });
  }
}

class PiTranslator implements ProviderTranslator {
  readonly evidencePolicy = "session-artifact" as const;
  readonly #options: PiAgentAdapterOptions;
  readonly #host: PiProcessHost;

  constructor(options: PiAgentAdapterOptions) {
    this.#options = options;
    this.#host = options.processHost ?? new ChildProcessPiHost();
  }

  sessionIdFor(input: ExecutionAssignment): string {
    return stableSessionId(this.#options.id ?? "pi", input);
  }

  async start(input: {
    assignment: ExecutionAssignment;
    sessionId: string | undefined;
    resuming: boolean;
    prompt: string;
  }): Promise<WorkerTransport> {
    const options = this.#options;
    const cwd = resolve(input.assignment.workspacePath ?? options.cwd ?? process.cwd());
    const sessionDirectory = resolve(
      options.sessionDirectory ?? join(process.cwd(), ".clone-ai", "pi-sessions"),
    );
    await mkdir(sessionDirectory, { recursive: true });

    const launch = resolvePiLaunch(options.command, options.commandArgs);
    const args = [
      ...launch.args,
      "--mode", "rpc",
      "--session-id", input.sessionId ?? "clone-pi-session",
      "--session-dir", sessionDirectory,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
    ];
    const tools = options.tools ?? [];
    if (tools.length === 0) {
      args.push("--no-tools");
    } else {
      args.push("--tools", tools.join(","));
    }
    if (options.provider !== undefined) args.push("--provider", options.provider);
    if (options.model !== undefined) args.push("--model", options.model);
    if (options.offline ?? false) args.push("--offline");

    const session = await this.#host.start({
      command: launch.command,
      args,
      cwd,
      env: buildPiEnvironment(options.provider, options.environmentVariables ?? []),
    });
    return new PiWorkerTransport(session, input.prompt, input.sessionId ?? "clone-pi-session", input.resuming);
  }
}

class PiWorkerTransport implements WorkerTransport {
  readonly events: AsyncIterable<NormalizedWorkerEvent>;
  readonly #session: PiRpcSession;
  readonly #sessionId: string;

  constructor(session: PiRpcSession, prompt: string, sessionId: string, resuming: boolean) {
    this.#session = session;
    this.#sessionId = sessionId;
    // The prompt is sent lazily on the first pull, so a cancel that arrives
    // before consumption starts sends abort as the very first command.
    // Prompt 在第一次拉取时才发送，因此在消费开始前到达的 cancel 会让 abort 成为
    // 第一条命令。
    this.events = translatePiEvents(session, prompt, sessionId, resuming);
  }

  abort(): void {
    this.#session.send({ id: `abort-${this.#sessionId}`, type: "abort" });
  }

  terminate(): Promise<void> {
    return this.#session.terminate();
  }
}

async function* translatePiEvents(
  session: PiRpcSession,
  prompt: string,
  sessionId: string,
  resuming: boolean,
): AsyncGenerator<NormalizedWorkerEvent> {
  session.send({ id: `prompt-${sessionId}`, type: "prompt", message: prompt });
  let settled = false;

  for await (const transport of session.events) {
    if (transport.type === "stderr") {
      const message = transport.text.trim();
      if (message.length > 0) yield { kind: "progress", message: `Pi: ${message}` };
      continue;
    }
    if (transport.type === "protocol_error" || transport.type === "process_error") {
      yield { kind: "protocol_error", message: transport.message };
      return;
    }
    if (transport.type === "exit") {
      if (!settled) {
        yield {
          kind: "protocol_error",
          message: `Pi exited before agent_settled (code ${String(transport.code)}, signal ${String(transport.signal)}).`,
        };
      }
      return;
    }

    const event = transport.value;
    if (event.type === "response" && event.success === false) {
      yield { kind: "protocol_error", message: `Pi rejected ${String(event.command)}: ${String(event.error)}` };
      return;
    }
    if (event.type === "agent_start") {
      yield { kind: "progress", message: resuming ? "Pi resumed the work order." : "Pi started the work order." };
      continue;
    }
    if (event.type === "turn_start") {
      yield { kind: "turn" };
      continue;
    }
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (isRecord(assistantEvent) && assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
        yield { kind: "text", delta: assistantEvent.delta };
      }
      if (isRecord(assistantEvent) && assistantEvent.type === "error") {
        yield {
          kind: "protocol_error",
          message: typeof assistantEvent.error === "string" ? assistantEvent.error : "Pi model stream failed.",
        };
      }
      continue;
    }
    if (event.type === "tool_execution_start") {
      yield {
        kind: "tool_start",
        id: stringField(event, "toolCallId") ?? "pi-tool",
        name: stringField(event, "toolName") ?? "unknown",
        input: event.args,
      };
      continue;
    }
    if (event.type === "tool_execution_end") {
      yield {
        kind: "tool_end",
        id: stringField(event, "toolCallId") ?? "unknown",
        name: stringField(event, "toolName") ?? "unknown",
        isError: event.isError === true,
      };
      continue;
    }
    if (event.type === "auto_retry_start") {
      yield { kind: "progress", message: `Pi is retrying a transient model failure (attempt ${String(event.attempt)}).` };
      continue;
    }
    if (event.type === "agent_settled") {
      settled = true;
      yield { kind: "settled", ok: true, text: "" };
      return;
    }
  }
}

export class ChildProcessPiHost implements PiProcessHost {
  async start(input: PiProcessStart): Promise<PiRpcSession> {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      stdio: "pipe",
    });
    return new ChildProcessPiRpcSession(child);
  }
}

class ChildProcessPiRpcSession implements PiRpcSession {
  readonly events: AsyncIterable<PiTransportEvent>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #queue = new AsyncPushQueue<PiTransportEvent>();
  readonly #closed: Promise<void>;
  #stdoutBuffer = "";
  #terminated = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.events = this.#queue;
    this.#closed = new Promise((resolveClosed) => child.once("close", () => resolveClosed()));
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => this.#queue.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", (error) => this.#queue.push({ type: "process_error", message: error.message }));
    child.on("close", (code, signal) => {
      if (this.#stdoutBuffer.trim().length > 0) {
        this.#queue.push({ type: "protocol_error", message: "Pi ended with an incomplete JSONL record." });
      }
      this.#queue.push({ type: "exit", code, signal });
      this.#queue.close();
    });
  }

  send(command: Record<string, unknown>): void {
    if (this.#terminated || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async terminate(): Promise<void> {
    if (this.#terminated) return;
    this.#terminated = true;
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill();
    await Promise.race([this.#closed, wait(2_000)]);
  }

  private consumeStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const raw = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (raw.length === 0) continue;
      try {
        const value = JSON.parse(raw) as unknown;
        if (isRecord(value)) {
          this.#queue.push({ type: "message", value });
        } else {
          this.#queue.push({ type: "protocol_error", message: "Pi emitted a JSONL value that is not an object." });
        }
      } catch (error: unknown) {
        this.#queue.push({
          type: "protocol_error",
          message: `Pi emitted invalid JSONL: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
}

class AsyncPushQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
    } else {
      this.#values.push(value);
    }
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolveNext) => this.#waiters.push(resolveNext));
  }
}

function resolvePiLaunch(command?: string, commandArgs: string[] = []): { command: string; args: string[] } {
  if (command !== undefined) return { command, args: [...commandArgs] };
  if (process.platform === "win32") {
    const npmRoot = join(process.env.APPDATA ?? "", "npm", "node_modules");
    for (const packageName of ["@earendil-works", "@mariozechner"]) {
      const cli = join(npmRoot, packageName, "pi-coding-agent", "dist", "cli.js");
      if (existsSync(cli)) return { command: process.execPath, args: [cli, ...commandArgs] };
    }
  }
  return { command: "pi", args: [...commandArgs] };
}

function stableSessionId(adapterId: string, input: ExecutionAssignment): string {
  const raw = `clone-${input.run.id}-${input.step.id}-${input.workOrder?.id ?? adapterId}`;
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 180);
}

function buildPiEnvironment(provider: string | undefined, additionalNames: string[]): NodeJS.ProcessEnv {
  const names = new Set([
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "NO_COLOR",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "PI_CODING_AGENT_DIR",
    "PI_PACKAGE_DIR",
    "PI_OFFLINE",
    ...providerEnvironmentVariables(provider ?? "google"),
    ...additionalNames,
  ]);
  return Object.fromEntries(
    [...names]
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
}

function providerEnvironmentVariables(provider: string): string[] {
  const normalized = provider.toLocaleLowerCase();
  if (normalized.includes("anthropic")) {
    return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"];
  }
  if (normalized.includes("azure")) {
    return [
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_BASE_URL",
      "AZURE_OPENAI_RESOURCE_NAME",
      "AZURE_OPENAI_API_VERSION",
      "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    ];
  }
  if (normalized.includes("openai")) return ["OPENAI_API_KEY"];
  if (normalized.includes("google") || normalized.includes("gemini")) return ["GEMINI_API_KEY"];
  if (normalized.includes("openrouter")) return ["OPENROUTER_API_KEY"];
  if (normalized.includes("deepseek")) return ["DEEPSEEK_API_KEY"];
  if (normalized.includes("groq")) return ["GROQ_API_KEY"];
  if (normalized.includes("mistral")) return ["MISTRAL_API_KEY"];
  if (normalized.includes("moonshot")) return ["MOONSHOT_API_KEY"];
  if (normalized.includes("minimax")) return ["MINIMAX_API_KEY"];
  return [];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
