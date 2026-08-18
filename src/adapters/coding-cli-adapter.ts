import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../core/contracts.ts";

export type CodingCliProvider = "codex-cli" | "claude-code";

export interface CodingCliAdapterOptions {
  id: string;
  providerId: CodingCliProvider;
  command?: string;
  model?: string;
  workCapabilities: string[];
}

/**
 * A supervised boundary around Codex CLI and Claude Code. Their internal
 * agent loops remain provider-owned; Clone AI owns the WorkOrder, permission,
 * timeout, journal, and completion decision.
 *
 * Codex CLI 与 Claude Code 的受监督边界。它们内部 Agent Loop 仍属于 Provider；Clone AI
 * 拥有 WorkOrder、权限、超时、Journal 与完成判定。
 */
export class CodingCliAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly providerId: CodingCliProvider;
  readonly #command: string;
  readonly #model?: string;
  readonly #workCapabilities: string[];
  readonly #active = new Map<string, ChildProcess>();

  constructor(options: CodingCliAdapterOptions) {
    this.id = options.id;
    this.providerId = options.providerId;
    this.#command = options.command ?? defaultCommand(options.providerId);
    this.#model = options.model;
    this.#workCapabilities = [...options.workCapabilities];
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: true,
      cancellation: true,
      approvalCallback: false,
      parallelAssignments: true,
      work: [...this.#workCapabilities],
      // Worker output can only ever claim workspace artifacts. Receipts must
      // come from a trusted runtime, never from CLI stdout.
      // Worker 输出最多只能申报 Workspace 内的 Artifact；Receipt 必须来自可信运行时，
      // 绝不能来自 CLI stdout。
      evidenceKinds: ["artifact", "observation"],
    };
  }

  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    return this.run(input, stableSessionId(this.id, input), false);
  }

  resume(sessionId: string, input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    return this.run(input, sessionId, true);
  }

  async cancel(sessionId: string): Promise<void> {
    const child = this.#active.get(sessionId);
    if (child !== undefined) child.kill();
    this.#active.delete(sessionId);
  }

  private async *run(input: ExecutionAssignment, sessionId: string, resuming: boolean): AsyncIterable<ExecutionEvent> {
    const args = this.providerId === "codex-cli"
      ? codexArgs(input, sessionId, resuming, this.#model)
      : claudeArgs(input, sessionId, resuming, this.#model);
    const child = spawn(this.#command, args, {
      cwd: input.workspacePath ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#active.set(sessionId, child);
    yield { type: "session_started", sessionId };

    const budget = input.workOrder?.budget;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, budget?.maxDurationMs ?? 20 * 60_000);
    timeout.unref();
    let finalText = "";

    try {
      // stderr drains concurrently with stdout: once the pipe buffer fills, a
      // child blocked on stderr can never finish stdout, and the two processes
      // deadlock until the budget timeout kills the child.
      // stderr 与 stdout 并发消费：一旦管道缓冲区写满，卡在 stderr 上的子进程永远无法
      // 结束 stdout，两个进程会互锁到预算超时把子进程杀掉为止。
      const stderrText = collectStderr(child.stderr);
      for await (const line of jsonLines(child.stdout)) {
        const event = parseJson(line);
        if (event === undefined) continue;
        const session = sessionFrom(event);
        if (session !== undefined && session !== sessionId) yield { type: "session_started", sessionId: session };
        const delta = textDelta(event);
        if (delta !== undefined) {
          finalText += delta;
          yield { type: "message_delta", text: delta };
        }
        const tool = toolEvent(event);
        if (tool !== undefined) yield tool;
      }
      const stderr = await stderrText;
      const exit = await exited(child);
      if (timedOut) {
        yield { type: "failed", message: `${this.providerId} exceeded its WorkOrder duration budget.` };
        return;
      }
      if (exit !== 0) {
        yield { type: "failed", message: `${this.providerId} exited with code ${exit}: ${stderr.trim().slice(0, 500)}` };
        return;
      }
      const evidence = await readWorkerEvidence(finalText, input);
      if (evidence !== undefined) yield { type: "evidence", evidence };
      else yield { type: "evidence", evidence: { kind: "observation", summary: `${this.providerId} completed a supervised session.`, locator: `${this.providerId}://${sessionId}` } };
      yield { type: "completed", summary: finalText.trim() || `${this.providerId} completed its WorkOrder.` };
    } catch (error: unknown) {
      yield { type: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
      this.#active.delete(sessionId);
    }
  }
}

function codexArgs(input: ExecutionAssignment, sessionId: string, resuming: boolean, model?: string): string[] {
  const common = ["--json", "--sandbox", input.step.risk === "reversible_write" ? "workspace-write" : "read-only", "--skip-git-repo-check"];
  if (model !== undefined) common.push("--model", model);
  return resuming ? ["exec", "resume", sessionId, ...common, promptFor(input)] : ["exec", ...common, promptFor(input)];
}

function claudeArgs(input: ExecutionAssignment, sessionId: string, resuming: boolean, model?: string): string[] {
  const write = input.step.risk === "reversible_write";
  const common = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id", sessionId, "--permission-mode", write ? "acceptEdits" : "plan"];
  if (model !== undefined) common.push("--model", model);
  return resuming ? ["--resume", sessionId, ...common, promptFor(input)] : [...common, promptFor(input)];
}

function promptFor(input: ExecutionAssignment): string {
  const order = input.workOrder;
  const evidence = order?.expectedArtifacts.map((artifact) => ({ kind: artifact.kind, required: artifact.required, locatorRequired: artifact.locatorRequired })).filter((artifact) => artifact.required) ?? [];
  return [
    "You are a bounded worker inside Clone AI. Complete only this assignment in the current workspace.",
    "Do not perform network, payment, account, or destructive external actions. Do not modify Clone AI policy or task state.",
    `Objective: ${order?.objective ?? input.step.instructions}`,
    `Acceptance criteria: ${(order?.acceptanceCriteria ?? input.step.acceptanceCriteria).join("; ")}`,
    `Required evidence: ${JSON.stringify(evidence)}`,
    "If you produce a required artifact, end your final message with exactly one line: CLONE_AI_EVIDENCE: {\"kind\":\"artifact\",\"summary\":\"...\",\"locator\":\"relative/path\"}. Only \"artifact\" claims whose locator is an existing workspace-relative path are accepted.",
  ].join("\n");
}

async function* jsonLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    yield* lines.filter(Boolean);
  }
  if (pending.trim()) yield pending;
}

function parseJson(line: string): Record<string, unknown> | undefined { try { const value = JSON.parse(line); return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; } catch { return undefined; } }
function sessionFrom(event: Record<string, unknown>): string | undefined { for (const key of ["thread_id", "session_id", "threadId", "sessionId"]) if (typeof event[key] === "string") return event[key] as string; return undefined; }
function textDelta(event: Record<string, unknown>): string | undefined { const nested = event.event; if (typeof nested === "object" && nested !== null) { const delta = (nested as Record<string, unknown>).delta; if (typeof delta === "object" && delta !== null && typeof (delta as Record<string, unknown>).text === "string") return (delta as Record<string, unknown>).text as string; } for (const key of ["text", "result", "message"]) if (typeof event[key] === "string") return event[key] as string; const item = event.item; return typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).text === "string" ? (item as Record<string, unknown>).text as string : undefined; }
function toolEvent(event: Record<string, unknown>): Extract<ExecutionEvent, { type: "tool_started" | "tool_completed" }> | undefined { const type = String(event.type ?? ""); const name = typeof event.tool_name === "string" ? event.tool_name : undefined; if (name === undefined) return undefined; const id = typeof event.tool_use_id === "string" ? event.tool_use_id : `${name}-${type}`; return /start|begin|call/.test(type) ? { type: "tool_started", toolCallId: id, tool: name } : { type: "tool_completed", toolCallId: id, tool: name, isError: /error|fail/.test(type) }; }

type WorkerEvidence = Extract<ExecutionEvent, { type: "evidence" }>["evidence"];

/**
 * Worker output is untrusted. A worker may only claim an artifact that really
 * exists inside its workspace; its declared kind is never passed through, so a
 * worker cannot mint receipts for external actions it merely described.
 * Worker 输出不可信。Worker 只能申报确实存在于其 Workspace 内的 Artifact；其声明的 kind
 * 绝不透传，因此 Worker 无法为仅仅“描述过”的外部动作伪造 Receipt。
 */
async function readWorkerEvidence(text: string, input: ExecutionAssignment): Promise<WorkerEvidence | undefined> {
  const match = /CLONE_AI_EVIDENCE:\s*(\{[^\n]+\})/.exec(text);
  if (match === null) return undefined;
  let claim: Record<string, unknown>;
  try {
    const value = JSON.parse(match[1]) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    claim = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const summary = typeof claim.summary === "string" && claim.summary.trim().length > 0
    ? claim.summary
    : "The worker declared evidence without a summary.";
  const rejected = (reason: string): WorkerEvidence => ({
    kind: "observation",
    summary: `Worker evidence claim rejected (${reason}): ${summary}`,
  });
  if (claim.kind !== "artifact") return rejected(`kind "${String(claim.kind)}" cannot be self-reported`);
  if (typeof claim.locator !== "string" || claim.locator.trim().length === 0) return rejected("an artifact claim needs a locator");
  if (isAbsolute(claim.locator)) return rejected("the locator must be workspace-relative");
  const workspace = resolve(input.workspacePath ?? process.cwd());
  const target = resolve(workspace, claim.locator);
  const workspaceRelative = relative(workspace, target);
  if (workspaceRelative.length === 0 || workspaceRelative.startsWith("..") || isAbsolute(workspaceRelative)) {
    return rejected("the locator escapes the workspace");
  }
  try {
    await stat(target);
  } catch {
    return rejected("the locator does not exist in the workspace");
  }
  return { kind: "artifact", summary, locator: claim.locator };
}

async function collectStderr(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  try {
    for await (const chunk of stream) {
      // Keep draining past the cap so the child never blocks on a full pipe.
      // 超出上限后继续消费，避免子进程因管道写满而阻塞。
      if (text.length < 16_384) text += chunk.toString("utf8");
    }
  } catch {
    // Failures surface through the exit code; a broken stderr pipe must not mask them.
    // 失败由退出码体现；stderr 管道异常不应掩盖它。
  }
  return text;
}

function exited(child: ChildProcess): Promise<number | null> { return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); }); }
function defaultCommand(provider: CodingCliProvider): string { return process.platform === "win32" ? `${provider === "codex-cli" ? "codex" : "claude"}.cmd` : provider === "codex-cli" ? "codex" : "claude"; }
function stableSessionId(adapterId: string, input: ExecutionAssignment): string { const value = createHash("sha256").update(`${adapterId}:${input.run.id}:${input.step.id}:${input.workOrder?.id ?? "step"}`).digest("hex"); return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`; }
