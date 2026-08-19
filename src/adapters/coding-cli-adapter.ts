import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExecutionAssignment } from "../core/contracts.ts";
import {
  SupervisedWorkerAdapter,
  isRecord,
  wait,
  type NormalizedWorkerEvent,
  type ProviderTranslator,
  type WorkerTransport,
} from "./supervised-worker.ts";

export type CodingCliProvider = "codex-cli" | "claude-code";

export interface CodingCliAdapterOptions {
  id: string;
  providerId: CodingCliProvider;
  command?: string;
  /**
   * Arguments placed before the provider arguments, e.g. a script path when
   * command is a runtime such as node.
   * 放在 Provider 参数之前的参数，例如 command 是 node 之类运行时的脚本路径。
   */
  commandArgs?: string[];
  model?: string;
  workCapabilities: string[];
  /**
   * Extra environment variable names explicitly allowed into the CLI process.
   * 被显式允许传入 CLI 进程的额外环境变量名称。
   */
  environmentVariables?: string[];
}

/**
 * Codex CLI and Claude Code behind the shared supervised boundary. This class
 * is now only the CLI protocol translator plus its process transport; budgets,
 * hard deadlines, completion authority, and evidence policy live once in
 * SupervisedWorkerAdapter.
 *
 * 共享受监督边界之后的 Codex CLI 与 Claude Code。本类现在只是 CLI 协议翻译器加
 * 进程传输层；预算、硬截止、完成判定权与证据策略都只在 SupervisedWorkerAdapter 存在一份。
 */
export class CodingCliAdapter extends SupervisedWorkerAdapter {
  constructor(options: CodingCliAdapterOptions) {
    super({
      id: options.id,
      providerId: options.providerId,
      translator: new CodingCliTranslator(options),
      workCapabilities: options.workCapabilities,
      // Worker output can only ever claim workspace artifacts. Receipts must
      // come from a trusted runtime, never from CLI stdout.
      // Worker 输出最多只能申报 Workspace 内的 Artifact；Receipt 必须来自可信运行时，
      // 绝不能来自 CLI stdout。
      evidenceKinds: ["artifact", "observation"],
      defaultBudget: { maxDurationMs: 20 * 60_000 },
    });
  }
}

class CodingCliTranslator implements ProviderTranslator {
  readonly evidencePolicy = "worker-claim" as const;
  readonly #options: CodingCliAdapterOptions;
  readonly #launch: { command: string; args: string[] };

  constructor(options: CodingCliAdapterOptions) {
    this.#options = options;
    this.#launch = resolveCliLaunch(options.providerId, options.command, options.commandArgs);
  }

  sessionIdFor(input: ExecutionAssignment): string {
    return stableSessionId(this.#options.id, input);
  }

  async start(input: {
    assignment: ExecutionAssignment;
    sessionId: string | undefined;
    resuming: boolean;
    prompt: string;
  }): Promise<WorkerTransport> {
    const provider = this.#options.providerId;
    const sessionId = input.sessionId ?? "clone-cli-session";
    const args = provider === "codex-cli"
      ? codexArgs(input.assignment, sessionId, input.resuming, input.prompt, this.#options.model)
      : claudeArgs(input.assignment, sessionId, input.resuming, input.prompt, this.#options.model);
    const child = spawn(this.#launch.command, [...this.#launch.args, ...args], {
      cwd: input.assignment.workspacePath ?? process.cwd(),
      env: buildCliEnvironment(provider, this.#options.environmentVariables ?? []),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return new CliWorkerTransport(child, provider);
  }
}

class CliWorkerTransport implements WorkerTransport {
  readonly events: AsyncIterable<NormalizedWorkerEvent>;
  readonly #child: ChildProcess;
  readonly #exited: Promise<ProcessExit>;

  constructor(child: ChildProcess, provider: CodingCliProvider) {
    this.#child = child;
    // Exit and error are observed before the first await: a failed spawn emits
    // "error" on the next tick, and an unobserved ChildProcess "error" event
    // crashes the whole supervisor process.
    // 在第一个 await 之前就观察 exit 与 error：spawn 失败会在下一个 tick 触发 "error"，
    // 而无人监听的 ChildProcess "error" 事件会让整个 Supervisor 进程崩溃。
    this.#exited = observeExit(child);
    this.events = translateCliEvents(child, provider, this.#exited);
  }

  abort(): void {
    // The CLI protocols have no cooperative stop channel; kill is the abort.
    // CLI 协议没有协作式停止通道；kill 就是 abort。
    this.#child.kill();
  }

  async terminate(): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill();
    await Promise.race([this.#exited, wait(2_000)]);
  }
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

async function* translateCliEvents(
  child: ChildProcess,
  provider: CodingCliProvider,
  exited: Promise<ProcessExit>,
): AsyncGenerator<NormalizedWorkerEvent> {
  // stderr drains concurrently with stdout: once the pipe buffer fills, a
  // child blocked on stderr can never finish stdout, and the two processes
  // deadlock until the supervisor's deadline kills the child.
  // stderr 与 stdout 并发消费：一旦管道缓冲区写满，卡在 stderr 上的子进程永远无法
  // 结束 stdout，两个进程会互锁到 Supervisor 的硬截止杀掉子进程为止。
  const stderrText = collectStderr(child.stderr);
  const toolNames = new Map<string, string>();
  let protocolEvents = 0;
  let settled = false;

  for await (const line of jsonLines(child.stdout)) {
    const event = parseJson(line);
    if (event === undefined) continue;
    protocolEvents += 1;
    const session = sessionFrom(event);
    if (session !== undefined) yield { kind: "session", id: session };

    if (provider === "claude-code") {
      // These shapes come from a recorded stream-json session, not guesses:
      // deltas ride stream_event, tools ride content blocks, and the result
      // event is the provider's explicit settled signal.
      // 这些结构来自录制的 stream-json 会话而非猜测：增量在 stream_event 里，工具在
      // content 块里，result 事件是 Provider 显式的 settled 信号。
      const result = claudeResult(event);
      if (result !== undefined) {
        settled = true;
        yield { kind: "settled", ok: result.ok, text: result.text };
        return;
      }
      const delta = claudeTextDelta(event);
      if (delta !== undefined) yield { kind: "text", delta };
      yield* claudeToolEvents(event, toolNames);
      continue;
    }

    const delta = textDelta(event);
    if (delta !== undefined) yield { kind: "text", delta };
    const tool = toolEvent(event);
    if (tool !== undefined) yield tool;
  }

  const stderr = await stderrText;
  const exit = await exited;
  if (settled) return;
  if (exit.error !== undefined) {
    yield { kind: "protocol_error", message: `${provider} failed to start: ${exit.error}` };
    return;
  }
  if (exit.code !== 0) {
    yield { kind: "protocol_error", message: `${provider} exited with ${describeExit(exit)}: ${stderr.trim().slice(0, 500)}` };
    return;
  }
  // A clean exit alone is not completion: pointing this adapter at the wrong
  // binary also exits 0. Completion additionally requires that the child
  // actually spoke the JSONL protocol.
  // 干净退出本身不等于完成：把 Adapter 指向错误的二进制同样会以 0 退出。完成还要求
  // 子进程确实说过 JSONL 协议。
  if (protocolEvents === 0) {
    yield { kind: "protocol_error", message: `${provider} exited cleanly but produced no parseable protocol output.` };
    return;
  }
  if (provider === "claude-code") {
    yield { kind: "protocol_error", message: `${provider} exited cleanly but never reported a result event.` };
    return;
  }
  // Codex has no dedicated settled event; a clean protocol-speaking exit is
  // its completion signal.
  // Codex 没有专门的 settled 事件；说过协议且干净退出就是它的完成信号。
  yield { kind: "settled", ok: true, text: "" };
}

function codexArgs(input: ExecutionAssignment, sessionId: string, resuming: boolean, prompt: string, model?: string): string[] {
  const sandbox = input.step.risk === "reversible_write" ? "workspace-write" : "read-only";
  const common = ["--json", "--sandbox", sandbox, "--skip-git-repo-check"];
  if (model !== undefined) common.push("--model", model);
  return resuming
    ? ["exec", "resume", sessionId, ...common, prompt]
    : ["exec", ...common, prompt];
}

function claudeArgs(input: ExecutionAssignment, sessionId: string, resuming: boolean, prompt: string, model?: string): string[] {
  const write = input.step.risk === "reversible_write";
  const common = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--session-id", sessionId,
    "--permission-mode", write ? "acceptEdits" : "plan",
  ];
  if (model !== undefined) common.push("--model", model);
  return resuming ? ["--resume", sessionId, ...common, prompt] : [...common, prompt];
}

/**
 * The CLI process starts from an empty environment and receives only what is
 * named here: baseline OS variables, the one provider's own credentials, and
 * explicitly configured extras. Every other secret in the supervisor's
 * environment stays invisible to the worker.
 * CLI 进程从空环境开始，只拿到点名的变量：操作系统基础变量、所属 Provider 自己的凭据，
 * 以及显式配置的额外名单。Supervisor 环境里的其他机密对 Worker 一律不可见。
 */
function buildCliEnvironment(provider: CodingCliProvider, additionalNames: string[]): NodeJS.ProcessEnv {
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
    ...(provider === "codex-cli"
      ? ["OPENAI_API_KEY", "CODEX_HOME"]
      : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]),
    ...additionalNames,
  ]);
  return Object.fromEntries(
    [...names]
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
}

function observeExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

function describeExit(exit: ProcessExit): string {
  return exit.code !== null ? `code ${exit.code}` : `signal ${String(exit.signal)}`;
}

/**
 * Pipe chunks do not align with protocol lines; only complete lines are ever
 * parsed, and the remainder waits in the buffer for the next chunk.
 * 管道 chunk 与协议行不对齐；只有完整的行才会被解析，剩余部分留在缓冲区等下一个 chunk。
 */
async function* jsonLines(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) return;
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    yield* lines.filter(Boolean);
  }
  if (pending.trim()) yield pending;
}

function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sessionFrom(event: Record<string, unknown>): string | undefined {
  for (const key of ["thread_id", "session_id", "threadId", "sessionId"]) {
    const value = event[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * The result event is claude-code's explicit settled signal; is_error marks a
 * failed session even when the process still exits with code 0.
 * result 事件是 claude-code 显式的 settled 信号；即便进程仍以 0 退出，is_error 也标记
 * 这是一次失败会话。
 */
function claudeResult(event: Record<string, unknown>): { ok: boolean; text: string } | undefined {
  if (event.type !== "result") return undefined;
  const text = typeof event.result === "string" ? event.result : "";
  const ok = event.is_error !== true && (event.subtype === undefined || event.subtype === "success");
  return { ok, text };
}

function claudeTextDelta(event: Record<string, unknown>): string | undefined {
  if (event.type !== "stream_event") return undefined;
  const nested = event.event;
  if (!isRecord(nested) || nested.type !== "content_block_delta") return undefined;
  const delta = nested.delta;
  return isRecord(delta) && typeof delta.text === "string" ? delta.text : undefined;
}

/**
 * Tool activity rides message content blocks: tool_use inside assistant
 * events, tool_result inside user events. The name map joins the two halves.
 * 工具活动位于消息 content 块中：tool_use 在 assistant 事件里，tool_result 在 user
 * 事件里。名称映射把两半连起来。
 */
function* claudeToolEvents(
  event: Record<string, unknown>,
  toolNames: Map<string, string>,
): Generator<NormalizedWorkerEvent> {
  if (event.type !== "assistant" && event.type !== "user") return;
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (event.type === "assistant" && block.type === "tool_use" && typeof block.name === "string") {
      const id = typeof block.id === "string" ? block.id : block.name;
      toolNames.set(id, block.name);
      yield { kind: "tool_start", id, name: block.name, input: block.input };
    }
    if (event.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      yield {
        kind: "tool_end",
        id: block.tool_use_id,
        name: toolNames.get(block.tool_use_id),
        isError: block.is_error === true,
      };
    }
  }
}

function textDelta(event: Record<string, unknown>): string | undefined {
  const nested = event.event;
  if (isRecord(nested)) {
    const delta = nested.delta;
    if (isRecord(delta) && typeof delta.text === "string") return delta.text;
  }
  for (const key of ["text", "result", "message"]) {
    const value = event[key];
    if (typeof value === "string") return value;
  }
  const item = event.item;
  return isRecord(item) && typeof item.text === "string" ? item.text : undefined;
}

function toolEvent(event: Record<string, unknown>): NormalizedWorkerEvent | undefined {
  const type = String(event.type ?? "");
  const name = typeof event.tool_name === "string" ? event.tool_name : undefined;
  if (name === undefined) return undefined;
  const id = typeof event.tool_use_id === "string" ? event.tool_use_id : `${name}-${type}`;
  return /start|begin|call/.test(type)
    ? { kind: "tool_start", id, name }
    : { kind: "tool_end", id, name, isError: /error|fail/.test(type) };
}

/**
 * Node refuses to spawn .cmd shims without a shell (CVE-2024-27980), so on
 * Windows the launcher resolves the real executable behind the npm shim.
 * Node 出于安全原因拒绝在无 shell 时启动 .cmd 垫片（CVE-2024-27980），因此 Windows 上
 * 由启动器直接解析 npm 垫片背后的真实可执行文件。
 */
function resolveCliLaunch(
  provider: CodingCliProvider,
  command?: string,
  commandArgs: string[] = [],
): { command: string; args: string[] } {
  if (command !== undefined) return { command, args: [...commandArgs] };
  if (process.platform === "win32") {
    const npmRoot = join(process.env.APPDATA ?? "", "npm", "node_modules");
    const candidates = provider === "claude-code"
      ? [
          { command: join(npmRoot, "@anthropic-ai", "claude-code", "bin", "claude.exe"), args: [] as string[] },
          { command: process.execPath, args: [join(npmRoot, "@anthropic-ai", "claude-code", "cli.js")] },
        ]
      : [
          { command: process.execPath, args: [join(npmRoot, "@openai", "codex", "bin", "codex.js")] },
        ];
    for (const candidate of candidates) {
      if (existsSync(candidate.args[0] ?? candidate.command)) return candidate;
    }
  }
  const binary = provider === "codex-cli" ? "codex" : "claude";
  return { command: process.platform === "win32" ? `${binary}.cmd` : binary, args: [] };
}

function stableSessionId(adapterId: string, input: ExecutionAssignment): string {
  const value = createHash("sha256")
    .update(`${adapterId}:${input.run.id}:${input.step.id}:${input.workOrder?.id ?? "step"}`)
    .digest("hex");
  // Claude Code requires --session-id to be a UUID. Deriving a stable
  // v4-shaped one means the same WorkOrder always reopens the same provider
  // session, which is what makes resume-after-crash possible at all.
  // Claude Code 要求 --session-id 是 UUID。派生稳定的 v4 形态 ID 让同一 WorkOrder 总是
  // 重新打开同一个 Provider 会话——崩溃后能恢复的前提就在这里。
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

async function collectStderr(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return "";
  let text = "";
  try {
    for await (const chunk of stream) {
      // Keep draining past the cap so the child never blocks on a full pipe.
      // 超出上限后继续消费，避免子进程因管道写满而阻塞。
      if (text.length < 16_384) text += chunk.toString("utf8");
    }
  } catch {
    // Failures surface through the exit result; a broken stderr pipe must not mask them.
    // 失败由退出结果体现；stderr 管道异常不应掩盖它。
  }
  return text;
}
