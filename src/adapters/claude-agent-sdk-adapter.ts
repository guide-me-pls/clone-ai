import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  ExecutionAssignment,
  ExecutionEvent,
  RuntimeAdapter,
  RuntimeCapabilities,
} from "../core/contracts.ts";

export interface ClaudeAgentSdkAdapterOptions {
  id: string;
  model?: string;
  workCapabilities: string[];
  /** Injected for tests; defaults to the real SDK query. 供测试注入；默认使用真实 SDK query。 */
  queryFn?: typeof query;
}

type WorkerEvidence = Extract<ExecutionEvent, { type: "evidence" }>["evidence"];

/**
 * Claude Code behind its official SDK instead of parsed stdout. The provider
 * emits typed messages, so the whole heuristic layer of the CLI adapter
 * (guessed delta fields, tool-name joins, the CLONE_AI_EVIDENCE magic line as
 * the only structured channel) disappears. Authority is unchanged: Clone AI
 * still owns the WorkOrder, permissions, budget, evidence, and completion.
 *
 * Claude Code 走官方 SDK，而不是解析 stdout。Provider 发出有类型的消息，因此 CLI Adapter
 * 里那整层启发式（猜测的 delta 字段、工具名拼接、把 CLONE_AI_EVIDENCE 魔法行当作唯一
 * 结构化通道）全部消失。权限不变：WorkOrder、许可、预算、证据与完成判定仍属于 Clone AI。
 */
export class ClaudeAgentSdkAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly providerId = "claude-agent-sdk";
  readonly #model?: string;
  readonly #workCapabilities: string[];
  readonly #query: typeof query;
  readonly #active = new Map<string, AbortController>();

  constructor(options: ClaudeAgentSdkAdapterOptions) {
    this.id = options.id;
    this.#model = options.model;
    this.#workCapabilities = [...options.workCapabilities];
    this.#query = options.queryFn ?? query;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: true,
      cancellation: true,
      approvalCallback: false,
      parallelAssignments: true,
      work: [...this.#workCapabilities],
      // Same rule as every worker-backed boundary: a receipt attests that an
      // external action really happened and can never be self-reported.
      // 与所有 Worker 型边界同一规则：Receipt 证明外部动作确实发生，永不允许自报。
      evidenceKinds: ["artifact", "observation"],
    };
  }

  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    return this.run(input, undefined);
  }

  resume(sessionId: string, input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    return this.run(input, sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    this.#active.get(sessionId)?.abort();
    this.#active.delete(sessionId);
  }

  private async *run(input: ExecutionAssignment, resumeSessionId?: string): AsyncIterable<ExecutionEvent> {
    const workspace = resolve(input.workspacePath ?? process.cwd());
    const budget = input.workOrder?.budget;
    const abort = new AbortController();
    // The SDK session id only exists once the provider reports it; cancel()
    // before that must still stop the run, so the controller is registered
    // under the work order key too.
    // SDK 会话 ID 要等 Provider 上报后才存在；在那之前调用 cancel() 也必须能停止运行，
    // 因此控制器同时以 WorkOrder 键登记。
    const pendingKey = `pending:${input.run.id}:${input.step.id}:${input.workOrder?.id ?? "step"}`;
    this.#active.set(pendingKey, abort);

    let sessionId = resumeSessionId;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, budget?.maxDurationMs ?? 20 * 60_000);
    timeout.unref();

    const toolNames = new Map<string, string>();
    let modelTurns = 0;
    let toolCalls = 0;
    let finalText = "";
    let settled: { ok: boolean; text: string } | undefined;
    let budgetFailure: string | undefined;

    const options: Options = {
      cwd: workspace,
      abortController: abort,
      includePartialMessages: true,
      // Write access follows the step's declared risk, not the worker's wish.
      // 写权限跟随步骤声明的风险，而不是 Worker 的意愿。
      permissionMode: input.step.risk === "reversible_write" ? "acceptEdits" : "plan",
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(budget?.maxModelCalls === undefined ? {} : { maxTurns: budget.maxModelCalls }),
      ...(resumeSessionId === undefined ? {} : { resume: resumeSessionId }),
    };

    try {
      for await (const message of this.#query({ prompt: promptFor(input), options }) as AsyncIterable<SDKMessage>) {
        const reported = sessionIdOf(message);
        if (reported !== undefined && reported !== sessionId) {
          sessionId = reported;
          this.#active.set(sessionId, abort);
          yield { type: "session_started", sessionId };
        }

        if (message.type === "stream_event") {
          const delta = partialTextDelta(message);
          if (delta !== undefined) {
            finalText += delta;
            yield { type: "message_delta", text: delta };
          }
          continue;
        }

        if (message.type === "assistant") {
          modelTurns += 1;
          for (const block of contentBlocks(message)) {
            if (block.type === "tool_use" && typeof block.name === "string") {
              toolCalls += 1;
              const toolCallId = typeof block.id === "string" ? block.id : `${block.name}-${toolCalls}`;
              toolNames.set(toolCallId, block.name);
              yield {
                type: "tool_started",
                toolCallId,
                tool: block.name,
                inputSummary: safeInputSummary(block.input),
              };
              if (budget?.maxToolCalls !== undefined && toolCalls > budget.maxToolCalls) {
                budgetFailure = `${this.providerId} exceeded the tool-call budget (${budget.maxToolCalls}).`;
                abort.abort();
              }
            }
          }
          continue;
        }

        if (message.type === "user") {
          for (const block of contentBlocks(message)) {
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
              yield {
                type: "tool_completed",
                toolCallId: block.tool_use_id,
                tool: toolNames.get(block.tool_use_id) ?? "unknown",
                isError: block.is_error === true,
              };
            }
          }
          continue;
        }

        if (message.type === "result") {
          // The typed result is the provider's explicit settled signal.
          // 有类型的 result 就是 Provider 显式的 settled 信号。
          const record = message as unknown as Record<string, unknown>;
          settled = {
            ok: record.is_error !== true && record.subtype === "success",
            text: typeof record.result === "string" ? record.result : "",
          };
        }
      }
    } catch (error: unknown) {
      if (!timedOut && budgetFailure === undefined) {
        yield { type: "failed", message: `${this.providerId} failed: ${errorText(error)}` };
        return;
      }
    } finally {
      clearTimeout(timeout);
      this.#active.delete(pendingKey);
      if (sessionId !== undefined) this.#active.delete(sessionId);
    }

    if (timedOut) {
      yield { type: "failed", message: `${this.providerId} exceeded its WorkOrder duration budget.` };
      return;
    }
    if (budgetFailure !== undefined) {
      yield { type: "failed", message: budgetFailure };
      return;
    }
    if (budget?.maxModelCalls !== undefined && modelTurns > budget.maxModelCalls) {
      yield { type: "failed", message: `${this.providerId} exceeded the model-call budget (${budget.maxModelCalls}).` };
      return;
    }
    // A stream that ends without a result message is not a completion, exactly
    // as an exiting process without agent_settled is not one.
    // 没有 result 消息就结束的流不算完成，正如进程退出但没有 agent_settled 也不算。
    if (settled === undefined) {
      yield { type: "failed", message: `${this.providerId} ended without a result message.` };
      return;
    }
    if (!settled.ok) {
      yield { type: "failed", message: `${this.providerId} reported an error result: ${(settled.text.trim() || "unknown error").slice(0, 500)}` };
      return;
    }

    const summary = (settled.text.trim() || finalText.trim()).slice(0, 2_000);
    const evidence = await readWorkerEvidence(`${finalText}\n${settled.text}`, workspace);
    yield {
      type: "evidence",
      evidence: evidence ?? {
        kind: "observation",
        summary: `${this.providerId} completed a supervised session.`,
        locator: `${this.providerId}://${sessionId ?? "unknown"}`,
      },
    };
    yield { type: "completed", summary: summary || `${this.providerId} completed its WorkOrder.` };
  }
}

function promptFor(input: ExecutionAssignment): string {
  const order = input.workOrder;
  const artifacts = order?.expectedArtifacts.filter((artifact) => artifact.required) ?? [];
  return [
    "You are a bounded worker inside Clone AI. Complete only this assignment in the current workspace.",
    "Do not perform network, payment, account, or destructive external actions. Do not modify Clone AI policy or task state.",
    `Objective: ${order?.objective ?? input.step.instructions}`,
    `Acceptance criteria: ${(order?.acceptanceCriteria ?? input.step.acceptanceCriteria).join("; ")}`,
    `Required artifacts: ${JSON.stringify(artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind })))}`,
    "If you produce a required artifact, end your final message with exactly one line: "
      + "CLONE_AI_EVIDENCE: {\"kind\":\"artifact\",\"summary\":\"...\",\"locator\":\"relative/path\"}. "
      + "Only \"artifact\" claims whose locator is an existing workspace-relative path are accepted.",
  ].join("\n");
}

function sessionIdOf(message: SDKMessage): string | undefined {
  const value = (message as unknown as Record<string, unknown>).session_id;
  return typeof value === "string" ? value : undefined;
}

function contentBlocks(message: SDKMessage): Array<Record<string, unknown>> {
  const inner = (message as unknown as { message?: unknown }).message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return [];
  return inner.content.filter(isRecord);
}

function partialTextDelta(message: SDKMessage): string | undefined {
  const event = (message as unknown as { event?: unknown }).event;
  if (!isRecord(event) || event.type !== "content_block_delta") return undefined;
  const delta = event.delta;
  return isRecord(delta) && typeof delta.text === "string" ? delta.text : undefined;
}

/**
 * Worker output is untrusted: only an artifact that really exists inside the
 * workspace is accepted, and the declared kind is never passed through.
 * Worker 输出不可信：只接受确实存在于 Workspace 内的 Artifact，声明的 kind 绝不透传。
 */
async function readWorkerEvidence(text: string, workspace: string): Promise<WorkerEvidence | undefined> {
  const match = /CLONE_AI_EVIDENCE:\s*(\{[^\n]+\})/.exec(text);
  if (match === null) return undefined;
  let claim: Record<string, unknown>;
  try {
    const value = JSON.parse(match[1]) as unknown;
    if (!isRecord(value)) return undefined;
    claim = value;
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

function safeInputSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return JSON.stringify(redact(value)).slice(0, 800);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => (
    /key|token|secret|password|authorization/i.test(key) ? [key, "[REDACTED]"] : [key, redact(item)]
  )));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
