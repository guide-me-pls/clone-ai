import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  ExecutionAssignment,
  ExecutionEvent,
  RuntimeAdapter,
  RuntimeCapabilities,
  WorkOrderBudget,
} from "../core/contracts.ts";

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
 * Pi runs as an isolated JSONL RPC subprocess. Clone Runtime owns authority,
 * budgets and completion; Pi owns only the bounded work order it receives.
 *
 * Pi 运行在隔离的 JSONL RPC 子进程中。Clone Runtime 拥有权限、预算和完成判定；Pi 只拥有
 * 它收到的有边界 WorkOrder。
 */
export class PiAgentAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly providerId = "pi";
  readonly #options: Required<Pick<
    PiAgentAdapterOptions,
    "tools" | "workCapabilities" | "offline" | "environmentVariables" | "abortGraceMs"
  >>
    & Omit<
      PiAgentAdapterOptions,
      "id" | "tools" | "workCapabilities" | "offline" | "environmentVariables" | "abortGraceMs" | "processHost"
    >;
  readonly #host: PiProcessHost;
  readonly #active = new Map<string, PiRpcSession>();

  constructor(options: PiAgentAdapterOptions = {}) {
    this.id = options.id ?? "pi";
    this.#options = {
      command: options.command,
      commandArgs: options.commandArgs,
      cwd: options.cwd,
      sessionDirectory: options.sessionDirectory,
      provider: options.provider,
      model: options.model,
      tools: options.tools ?? [],
      workCapabilities: options.workCapabilities ?? ["review", "direct_response"],
      offline: options.offline ?? false,
      environmentVariables: options.environmentVariables ?? [],
      abortGraceMs: options.abortGraceMs ?? 5_000,
    };
    this.#host = options.processHost ?? new ChildProcessPiHost();
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: true,
      cancellation: true,
      approvalCallback: false,
      parallelAssignments: true,
      work: [...this.#options.workCapabilities],
    };
  }

  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    return this.run(input, stableSessionId(this.id, input), false);
  }

  resume(sessionId: string, input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    return this.run(input, sessionId, true);
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.#active.get(sessionId);
    if (session === undefined) return;
    session.send({ id: `abort-${sessionId}`, type: "abort" });
    await session.terminate();
    this.#active.delete(sessionId);
  }

  private async *run(
    input: ExecutionAssignment,
    sessionId: string,
    resuming: boolean,
  ): AsyncIterable<ExecutionEvent> {
    const cwd = resolve(input.workspacePath ?? this.#options.cwd ?? process.cwd());
    const sessionDirectory = resolve(
      this.#options.sessionDirectory ?? join(process.cwd(), ".clone-ai", "pi-sessions"),
    );
    await mkdir(sessionDirectory, { recursive: true });

    const launch = resolvePiLaunch(this.#options.command, this.#options.commandArgs);
    const args = [
      ...launch.args,
      "--mode", "rpc",
      "--session-id", sessionId,
      "--session-dir", sessionDirectory,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
    ];
    if (this.#options.tools.length === 0) {
      args.push("--no-tools");
    } else {
      args.push("--tools", this.#options.tools.join(","));
    }
    if (this.#options.provider !== undefined) args.push("--provider", this.#options.provider);
    if (this.#options.model !== undefined) args.push("--model", this.#options.model);
    if (this.#options.offline) args.push("--offline");

    const session = await this.#host.start({
      command: launch.command,
      args,
      cwd,
      env: buildPiEnvironment(this.#options.provider, this.#options.environmentVariables),
    });
    this.#active.set(sessionId, session);

    const budget = input.workOrder?.budget ?? defaultBudget;
    let finalText = "";
    let toolCalls = 0;
    let modelCalls = 0;
    let settled = false;
    let failure: string | undefined;
    let timedOut = false;
    let hardStop: NodeJS.Timeout | undefined;
    // A cooperative abort is a request, not a guarantee. If Pi neither settles
    // nor exits within the grace period, the session is terminated so a wedged
    // worker can never hang the supervisor forever.
    // 协作式 abort 只是请求而非保证。若 Pi 在宽限期内既不 settle 也不退出，就强制终止会话，
    // 确保卡死的 Worker 永远无法把 Supervisor 挂住。
    const requestAbort = (id: string): void => {
      session.send({ id, type: "abort" });
      if (hardStop === undefined) {
        hardStop = setTimeout(() => void session.terminate(), this.#options.abortGraceMs);
        hardStop.unref();
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      requestAbort(`timeout-${sessionId}`);
    }, budget.maxDurationMs);
    timeout.unref();

    try {
      yield { type: "session_started", sessionId };
      session.send({
        id: `prompt-${sessionId}`,
        type: "prompt",
        message: buildPiPrompt(input, resuming),
      });

      for await (const transport of session.events) {
        if (transport.type === "stderr") {
          const message = transport.text.trim();
          if (message.length > 0) yield { type: "progress", message: `Pi: ${truncate(message, 500)}` };
          continue;
        }
        if (transport.type === "protocol_error" || transport.type === "process_error") {
          failure = transport.message;
          yield { type: "failed", message: transport.message };
          break;
        }
        if (transport.type === "exit") {
          if (!settled && failure === undefined) {
            failure = timedOut
              ? `Pi exceeded the duration budget (${budget.maxDurationMs} ms).`
              : `Pi exited before agent_settled (code ${String(transport.code)}, signal ${String(transport.signal)}).`;
            yield { type: "failed", message: failure };
          }
          break;
        }

        const event = transport.value;
        if (isFailedResponse(event)) {
          failure = `Pi rejected ${String(event.command)}: ${String(event.error)}`;
          yield { type: "failed", message: failure };
          break;
        }
        if (event.type === "agent_start") {
          yield { type: "progress", message: resuming ? "Pi resumed the work order." : "Pi started the work order." };
          continue;
        }
        if (event.type === "turn_start") {
          modelCalls += 1;
          if (modelCalls > budget.maxModelCalls) {
            failure = `Pi exceeded the model-call budget (${budget.maxModelCalls}).`;
            requestAbort(`budget-model-${sessionId}`);
          }
          continue;
        }
        if (event.type === "message_update") {
          const delta = readTextDelta(event);
          if (delta !== undefined) {
            const safeDelta = redactFreeText(delta);
            finalText += safeDelta;
            yield { type: "message_delta", text: safeDelta };
          }
          const streamError = readStreamError(event);
          if (streamError !== undefined) failure = streamError;
          continue;
        }
        if (event.type === "tool_execution_start") {
          toolCalls += 1;
          const toolCallId = stringField(event, "toolCallId") ?? `pi-tool-${toolCalls}`;
          const tool = stringField(event, "toolName") ?? "unknown";
          yield {
            type: "tool_started",
            toolCallId,
            tool,
            inputSummary: tool === "bash" ? "[shell command omitted from journal]" : safeInputSummary(event.args),
          };
          if (toolCalls > budget.maxToolCalls) {
            failure = `Pi exceeded the tool-call budget (${budget.maxToolCalls}).`;
            requestAbort(`budget-tool-${sessionId}`);
          }
          continue;
        }
        if (event.type === "tool_execution_end") {
          yield {
            type: "tool_completed",
            toolCallId: stringField(event, "toolCallId") ?? "unknown",
            tool: stringField(event, "toolName") ?? "unknown",
            isError: event.isError === true,
          };
          continue;
        }
        if (event.type === "auto_retry_start") {
          yield { type: "progress", message: `Pi is retrying a transient model failure (attempt ${String(event.attempt)}).` };
          continue;
        }
        if (event.type === "agent_settled") {
          settled = true;
          if (timedOut) failure = `Pi exceeded the duration budget (${budget.maxDurationMs} ms).`;
          if (failure !== undefined) {
            yield { type: "failed", message: failure };
            break;
          }
          const summary = finalText.trim() || "Pi completed the bounded work order.";
          yield {
            type: "evidence",
            evidence: {
              kind: "artifact",
              summary: truncate(redactFreeText(summary), 2_000),
              locator: `pi-session://${sessionId}`,
            },
          };
          yield { type: "completed", summary: truncate(redactFreeText(summary), 1_000) };
          break;
        }
      }
    } finally {
      clearTimeout(timeout);
      if (hardStop !== undefined) clearTimeout(hardStop);
      await session.terminate();
      this.#active.delete(sessionId);
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

function buildPiPrompt(input: ExecutionAssignment, resuming: boolean): string {
  const order = input.workOrder;
  const objective = order?.objective ?? input.step.instructions;
  const inputs = order?.inputs.map((item) => (
    `- ${item.name}${item.required ? " (required)" : ""}: ${item.description}`
  )).join("\n") || "- The parent task and step instructions below.";
  const dependencyEvidence = input.dependencyEvidence?.map((item) => (
    `- [${item.kind}] ${item.summary}${item.locator ? ` (${item.locator})` : ""}`
  )).join("\n") || "- None.";
  const artifacts = order?.expectedArtifacts.map((item) => (
    `- ${item.id}: ${item.description}; kind=${item.kind}; required=${String(item.required)}`
  )).join("\n") || "- Return one durable, reviewable result.";
  const acceptance = order?.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
    || input.step.acceptanceCriteria.map((item) => `- ${item}`).join("\n");

  return [
    "You are a bounded worker inside Clone AI. The supervisor, not you, owns planning, permissions, and final completion.",
    resuming
      ? "Resume this exact work order from the persisted Pi session. Reuse valid prior progress and do not repeat completed side effects."
      : "Execute only this work order. Do not expand its authority or redefine the parent goal.",
    "",
    `Parent task: ${input.task.objective}`,
    `Plan step: ${input.step.title}`,
    `Work order: ${order?.title ?? input.step.title}`,
    `Objective: ${objective}`,
    `Risk boundary: ${order?.risk ?? input.step.risk}`,
    "",
    "Inputs:",
    inputs,
    "",
    "Verified dependency evidence:",
    dependencyEvidence,
    "",
    "Expected artifacts:",
    artifacts,
    "",
    "Acceptance criteria:",
    acceptance,
    "",
    "When finished, give a concise factual summary of the artifact, checks performed, and any remaining uncertainty.",
  ].join("\n");
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

function isFailedResponse(value: Record<string, unknown>): value is Record<string, unknown> & { success: false } {
  return value.type === "response" && value.success === false;
}

function readTextDelta(value: Record<string, unknown>): string | undefined {
  const assistantEvent = value.assistantMessageEvent;
  if (!isRecord(assistantEvent) || assistantEvent.type !== "text_delta") return undefined;
  return typeof assistantEvent.delta === "string" ? assistantEvent.delta : undefined;
}

function readStreamError(value: Record<string, unknown>): string | undefined {
  const assistantEvent = value.assistantMessageEvent;
  if (!isRecord(assistantEvent) || assistantEvent.type !== "error") return undefined;
  return typeof assistantEvent.error === "string" ? assistantEvent.error : "Pi model stream failed.";
}

function safeInputSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return truncate(JSON.stringify(redact(value)), 800);
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

function redactFreeText(value: string): string {
  return value
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => (
    /key|token|secret|password|authorization/i.test(key) ? [key, "[REDACTED]"] : [key, redact(item)]
  )));
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}...`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, milliseconds);
    timer.unref();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultBudget: WorkOrderBudget = {
  maxDurationMs: 10 * 60_000,
  maxModelCalls: 20,
  maxToolCalls: 100,
  maxAttempts: 2,
};
