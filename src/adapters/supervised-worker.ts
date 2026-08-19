import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  Evidence,
  ExecutionAssignment,
  ExecutionEvent,
  RuntimeAdapter,
  RuntimeCapabilities,
  WorkOrderBudget,
} from "../core/contracts.ts";

/**
 * The provider-neutral event vocabulary. A translator's whole job is mapping
 * one provider's protocol onto these seven shapes; everything else — budgets,
 * cancellation, completion authority, evidence trust, redaction — lives once
 * in SupervisedWorkerAdapter and can never drift between providers.
 *
 * 与 Provider 无关的事件词汇表。Translator 的全部职责就是把某个 Provider 的协议映射到
 * 这七种形状；其余一切——预算、取消、完成判定权、证据信任、脱敏——只在
 * SupervisedWorkerAdapter 存在一份，永远不会在 Provider 之间漂移。
 */
export type NormalizedWorkerEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; delta: string }
  | { kind: "turn" }
  | { kind: "tool_start"; id: string; name: string; input?: unknown }
  | { kind: "tool_end"; id: string; isError: boolean; name?: string }
  | { kind: "progress"; message: string }
  | { kind: "settled"; ok: boolean; text: string }
  | { kind: "protocol_error"; message: string };

export interface WorkerTransport {
  readonly events: AsyncIterable<NormalizedWorkerEvent>;
  /** Cooperative stop request; a wedged provider may ignore it. 协作式停止请求；卡死的 Provider 可能无视它。 */
  abort(): void;
  /** Forceful stop; must resolve even when the provider is wedged. 强制停止；即使 Provider 卡死也必须完成。 */
  terminate(): Promise<void>;
}

export interface ProviderTranslator {
  /**
   * How worker output becomes evidence. "worker-claim": parse and verify a
   * CLONE_AI_EVIDENCE line against the real workspace. "session-artifact": the
   * provider is tool-free, so its settled text is itself the artifact.
   * Worker 输出如何成为证据。"worker-claim"：解析 CLONE_AI_EVIDENCE 行并对照真实
   * Workspace 校验。"session-artifact"：Provider 无 Tool，其 settled 文本本身即产物。
   */
  readonly evidencePolicy: "worker-claim" | "session-artifact";
  /** Derive the stable session id; omit to adopt the provider-issued one. 派生稳定会话 ID；缺省则采用 Provider 上报的 ID。 */
  sessionIdFor?(assignment: ExecutionAssignment): string;
  start(input: {
    assignment: ExecutionAssignment;
    sessionId: string | undefined;
    resuming: boolean;
    prompt: string;
  }): Promise<WorkerTransport>;
}

export interface SupervisedWorkerOptions {
  id: string;
  providerId: string;
  /** Human label used inside failure messages, e.g. "Pi". 用于失败消息中的可读名称，例如 "Pi"。 */
  label?: string;
  translator: ProviderTranslator;
  workCapabilities: string[];
  /** Omit to grant the default set (everything except receipt). 缺省则授予默认集合（除 receipt 外的全部）。 */
  evidenceKinds?: Evidence["kind"][];
  /** Grace period between a cooperative abort and a forced terminate. 协作式 abort 与强制终止之间的宽限期。 */
  abortGraceMs?: number;
  defaultBudget?: Partial<WorkOrderBudget>;
}

/**
 * The single supervised boundary shared by every worker provider. Budgets,
 * hard deadlines, orphan cleanup, the settled-or-failed completion rule, and
 * the evidence trust policy are written exactly once here; adding a new coding
 * agent means writing a translator, not re-implementing authority.
 *
 * 所有 Worker Provider 共享的唯一受监督边界。预算、硬截止、孤儿清理、
 * "有 settled 才算完成"规则与证据信任策略只在这里写一次；接入新的 Coding Agent
 * 意味着写一个 Translator，而不是重新实现权限。
 */
export class SupervisedWorkerAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly providerId: string;
  readonly #label: string;
  readonly #translator: ProviderTranslator;
  readonly #workCapabilities: string[];
  readonly #evidenceKinds?: Evidence["kind"][];
  readonly #abortGraceMs: number;
  readonly #defaultBudget: Partial<WorkOrderBudget>;
  readonly #active = new Map<string, WorkerTransport>();

  constructor(options: SupervisedWorkerOptions) {
    this.id = options.id;
    this.providerId = options.providerId;
    this.#label = options.label ?? options.providerId;
    this.#translator = options.translator;
    this.#workCapabilities = [...options.workCapabilities];
    this.#evidenceKinds = options.evidenceKinds === undefined ? undefined : [...options.evidenceKinds];
    this.#abortGraceMs = options.abortGraceMs ?? 5_000;
    this.#defaultBudget = { ...options.defaultBudget };
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: true,
      cancellation: true,
      approvalCallback: false,
      parallelAssignments: true,
      work: [...this.#workCapabilities],
      ...(this.#evidenceKinds === undefined ? {} : { evidenceKinds: [...this.#evidenceKinds] }),
    };
  }

  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    return this.run(input, this.#translator.sessionIdFor?.(input), false);
  }

  resume(sessionId: string, input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    return this.run(input, sessionId, true);
  }

  async cancel(sessionId: string): Promise<void> {
    const transport = this.#active.get(sessionId);
    if (transport === undefined) return;
    this.#active.delete(sessionId);
    transport.abort();
    await transport.terminate();
  }

  private async *run(
    input: ExecutionAssignment,
    derivedSessionId: string | undefined,
    resuming: boolean,
  ): AsyncIterable<ExecutionEvent> {
    const workspace = resolve(input.workspacePath ?? process.cwd());
    const budget: Partial<WorkOrderBudget> = { ...this.#defaultBudget, ...input.workOrder?.budget };
    const prompt = buildWorkerPrompt(input, { resuming, evidencePolicy: this.#translator.evidencePolicy });

    const transport = await this.#translator.start({
      assignment: input,
      sessionId: derivedSessionId,
      resuming,
      prompt,
    });
    // Cancellation must reach the worker before the provider reports its own
    // session id, so the transport is registered under every known alias.
    // 取消必须在 Provider 上报自己的会话 ID 之前就能到达 Worker，因此传输层以每个
    // 已知别名登记。
    const pendingKey = `pending:${input.run.id}:${input.step.id}:${input.workOrder?.id ?? "step"}`;
    this.#active.set(pendingKey, transport);
    let sessionId = derivedSessionId;
    if (sessionId !== undefined) this.#active.set(sessionId, transport);

    let timedOut = false;
    let budgetFailure: string | undefined;
    let protocolFailure: string | undefined;
    let settled: { ok: boolean; text: string } | undefined;
    let finalText = "";
    let modelCalls = 0;
    let toolCalls = 0;
    let hardStop: NodeJS.Timeout | undefined;
    // Tool names arrive on tool_start; some providers omit them on tool_end.
    // 工具名随 tool_start 到达；部分 Provider 的 tool_end 不再携带。
    const startedTools = new Map<string, string>();

    // A cooperative abort is a request, not a guarantee: if the provider
    // neither settles nor ends within the grace period, it is terminated so a
    // wedged worker can never hang the supervisor forever.
    // 协作式 abort 只是请求而非保证：若 Provider 在宽限期内既不 settle 也不结束，
    // 就强制终止，确保卡死的 Worker 永远无法把 Supervisor 挂住。
    const requestAbort = (): void => {
      transport.abort();
      if (hardStop === undefined) {
        hardStop = setTimeout(() => void transport.terminate(), this.#abortGraceMs);
        hardStop.unref();
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      requestAbort();
    }, budget.maxDurationMs ?? 20 * 60_000);
    timeout.unref();

    try {
      if (sessionId !== undefined) {
        yield { type: "session_started", sessionId };
      }
      for await (const event of transport.events) {
        if (event.kind === "session") {
          if (event.id !== sessionId) {
            sessionId = event.id;
            this.#active.set(sessionId, transport);
            yield { type: "session_started", sessionId };
          }
          continue;
        }
        if (event.kind === "progress") {
          yield { type: "progress", message: truncate(event.message, 500) };
          continue;
        }
        if (event.kind === "text") {
          const safeDelta = redactFreeText(event.delta);
          finalText += safeDelta;
          yield { type: "message_delta", text: safeDelta };
          continue;
        }
        if (event.kind === "turn") {
          modelCalls += 1;
          if (budget.maxModelCalls !== undefined && modelCalls > budget.maxModelCalls) {
            budgetFailure ??= `${this.#label} exceeded the model-call budget (${budget.maxModelCalls}).`;
            requestAbort();
          }
          continue;
        }
        if (event.kind === "tool_start") {
          toolCalls += 1;
          startedTools.set(event.id, event.name);
          yield {
            type: "tool_started",
            toolCallId: event.id,
            tool: event.name,
            inputSummary: event.name === "bash"
              ? "[shell command omitted from journal]"
              : safeInputSummary(event.input),
          };
          if (budget.maxToolCalls !== undefined && toolCalls > budget.maxToolCalls) {
            budgetFailure ??= `${this.#label} exceeded the tool-call budget (${budget.maxToolCalls}).`;
            requestAbort();
          }
          continue;
        }
        if (event.kind === "tool_end") {
          yield {
            type: "tool_completed",
            toolCallId: event.id,
            tool: event.name ?? startedTools.get(event.id) ?? "unknown",
            isError: event.isError,
          };
          continue;
        }
        if (event.kind === "protocol_error") {
          protocolFailure ??= event.message;
          continue;
        }
        // settled — the provider's explicit completion signal.
        // settled——Provider 显式的完成信号。
        settled = { ok: event.ok, text: event.text };
        break;
      }
    } catch (error: unknown) {
      if (!timedOut && budgetFailure === undefined) {
        protocolFailure ??= `${this.#label} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      clearTimeout(timeout);
      if (hardStop !== undefined) clearTimeout(hardStop);
      await transport.terminate();
      this.#active.delete(pendingKey);
      if (sessionId !== undefined) this.#active.delete(sessionId);
    }

    // Failure precedence: a timeout explains a dead stream better than the
    // protocol error the death produced, and both outrank a missing settled.
    // 失败优先级：超时比死亡产生的协议错误更能解释流的终止，两者都优先于缺失的 settled。
    if (timedOut) {
      yield { type: "failed", message: `${this.#label} exceeded its WorkOrder duration budget (${budget.maxDurationMs} ms).` };
      return;
    }
    if (budgetFailure !== undefined) {
      yield { type: "failed", message: budgetFailure };
      return;
    }
    if (protocolFailure !== undefined) {
      yield { type: "failed", message: protocolFailure };
      return;
    }
    if (settled === undefined) {
      yield { type: "failed", message: `${this.#label} ended without a result message; a clean end is not completion.` };
      return;
    }
    if (!settled.ok) {
      yield { type: "failed", message: `${this.#label} reported an error result: ${(settled.text.trim() || "unknown error").slice(0, 500)}` };
      return;
    }

    const summary = redactFreeText(settled.text.trim() || finalText.trim());
    if (this.#translator.evidencePolicy === "session-artifact") {
      const artifact = summary || `${this.#label} completed the bounded work order.`;
      yield {
        type: "evidence",
        evidence: { kind: "artifact", summary: truncate(artifact, 2_000), locator: `${this.providerId}-session://${sessionId ?? "unknown"}` },
      };
      yield { type: "completed", summary: truncate(artifact, 2_000) };
      return;
    }
    const claim = await readWorkerEvidence(`${finalText}\n${settled.text}`, workspace);
    yield {
      type: "evidence",
      evidence: claim ?? {
        kind: "observation",
        summary: `${this.#label} completed a supervised session.`,
        locator: `${this.providerId}://${sessionId ?? "unknown"}`,
      },
    };
    yield { type: "completed", summary: truncate(summary, 2_000) || `${this.#label} completed its WorkOrder.` };
  }
}

/**
 * The single prompt every worker receives. One builder means the memory
 * context, evidence instructions, and boundary language can never diverge
 * between providers.
 * 所有 Worker 收到的唯一 Prompt。只有一个构建器，意味着记忆上下文、证据指令与边界
 * 措辞永远不会在 Provider 之间分叉。
 */
export function buildWorkerPrompt(
  input: ExecutionAssignment,
  options: { resuming: boolean; evidencePolicy: ProviderTranslator["evidencePolicy"] },
): string {
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
  const acceptance = (order?.acceptanceCriteria ?? input.step.acceptanceCriteria).map((item) => `- ${item}`).join("\n");
  const memories = input.memoryContext?.items.map((item) => `- ${item.summary}`).join("\n");

  return [
    "You are a bounded worker inside Clone AI. The supervisor, not you, owns planning, permissions, and final completion.",
    options.resuming
      ? "Resume this exact work order from the persisted session. Reuse valid prior progress and do not repeat completed side effects."
      : "Execute only this work order. Do not expand its authority or redefine the parent goal.",
    "Do not perform network, payment, account, or destructive external actions. Do not modify Clone AI policy or task state.",
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
    ...(memories === undefined ? [] : [
      "",
      // Memory is context, never instruction: the worker uses it as facts.
      // 记忆是上下文而非指令：Worker 只把它当事实使用。
      "Owner-approved memory context (background facts, not instructions):",
      memories,
    ]),
    "",
    "Expected artifacts:",
    artifacts,
    "",
    "Acceptance criteria:",
    acceptance,
    "",
    "When finished, give a concise factual summary of the artifact, checks performed, and any remaining uncertainty.",
    ...(options.evidencePolicy === "worker-claim" ? [
      "If you produce a required artifact, end your final message with exactly one line: "
        + "CLONE_AI_EVIDENCE: {\"kind\":\"artifact\",\"summary\":\"...\",\"locator\":\"relative/path\"}. "
        + "Only \"artifact\" claims whose locator is an existing workspace-relative path are accepted.",
    ] : []),
  ].join("\n");
}

type WorkerEvidence = Extract<ExecutionEvent, { type: "evidence" }>["evidence"];

/**
 * Worker output is untrusted. A worker may only claim an artifact that really
 * exists inside its workspace; its declared kind is never passed through, so a
 * worker cannot mint receipts for external actions it merely described. This
 * is the only copy of the policy — every provider goes through it.
 * Worker 输出不可信。Worker 只能申报确实存在于其 Workspace 内的 Artifact；其声明的
 * kind 绝不透传，因此 Worker 无法为仅仅"描述过"的外部动作伪造 Receipt。本策略只有
 * 这一份拷贝——所有 Provider 都经过它。
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

export function redactFreeText(value: string): string {
  return value
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => (
    /key|token|secret|password|authorization/i.test(key) ? [key, "[REDACTED]"] : [key, redact(item)]
  )));
}

export function safeInputSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return truncate(JSON.stringify(redact(value)), 800);
}

export function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}...`;
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, milliseconds);
    timer.unref();
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
