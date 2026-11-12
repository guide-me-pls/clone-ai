/**
 * A provider-agnostic agent loop kernel.
 *
 * The Main Agent and execution workers share the same mechanics: a bounded
 * round loop, a typed terminal reason, streamed model calls, tool scheduling
 * that runs safe tools together and unsafe tools as barriers, structured tool
 * results, abort propagation, budgets, and an optional compaction hook. A
 * provider is an adapter; it does not own the loop.
 *
 * 与 Provider 无关的 Agent 循环内核。
 *
 * Main Agent 与执行 Worker 共享同一套机制：有界回合循环、带类型的终止原因、流式模型调用、
 * 安全工具并行/非安全工具屏障的工具调度、结构化工具结果、abort 传播、预算，以及可选的压缩
 * 钩子。Provider 只是适配器，不拥有循环。
 */
import type { ModelUsage } from "../core/contracts.ts";
import { countCharacters, estimateTokens, type TokenCalibrator } from "./token-estimate.ts";

/** A text or image part in a user message. 用户消息中的文本或图片片段。 */
export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A message in the loop's provider-neutral transcript. 循环中与 Provider 无关的对话消息。 */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AgentContentPart[] | null;
  /** Set on a tool result message; matches the assistant's call id. 工具结果消息上的调用 id，与 assistant 的调用对应。 */
  toolCallId?: string;
  /** Set on an assistant message that requested tools. assistant 请求工具时设置。 */
  toolCalls?: AgentToolCall[];
}

/** One model-requested tool call. 模型请求的一次工具调用。 */
export interface AgentToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as the model produced them. 模型产出的原始 JSON 参数。 */
  arguments: string;
}

/** The normalized result of one tool call. 一次工具调用的规范化结果。 */
export interface AgentToolResult {
  content: string;
  isError?: boolean;
}

/** A tool the loop may offer to the model. 循环可以提供给模型的工具。 */
export interface AgentToolSpec {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /**
   * Safe tools may run concurrently with each other. An unsafe tool waits for
   * all in-flight tools and makes later tools wait for it.
   * 安全工具可以彼此并发。非安全工具等待所有在途工具，并让后续工具等它。
   */
  parallelSafe?: boolean;
  run(
    args: Record<string, unknown>,
    context: { toolCallId: string; signal: AbortSignal },
  ): Promise<AgentToolResult>;
}

/** A per-call permission decision. 一次调用的权限决定。 */
export type AgentToolDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; reason?: string }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; reason: string };

/** The tool request a permission check or hook sees. 权限检查或 Hook 看到的工具请求。 */
export interface AgentToolRequest {
  round: number;
  tool: AgentToolSpec;
  call: AgentToolCall;
  input: Record<string, unknown>;
}

/** Pre/post tool hooks. Pre hooks may tighten a decision or rewrite input. 工具前后 Hook；前置 Hook 可以收紧决定或改写输入。 */
export interface AgentHooks {
  preToolUse?: (request: AgentToolRequest) => AgentToolDecision | void | Promise<AgentToolDecision | void>;
  postToolUse?: (request: AgentToolRequest & {
    result: AgentToolResult;
    isError: boolean;
    durationMs: number;
  }) => void | Promise<void>;
}

/** The character set every OpenAI-compatible provider accepts for a function name. 所有 OpenAI 兼容 Provider 接受的函数名字符集。 */
const PROVIDER_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The name a provider will accept, derived from the tool's own name.
 *
 * Tools are named for humans (`Skill(release-notes)`, `docs.search`), but a
 * provider rejects anything outside `[a-zA-Z0-9_-]`. The mapping is stable and
 * deterministic, and `providerToolName` holds the reverse table so a call the
 * model makes maps back to the real tool.
 * Provider 会接受的名字，由工具名派生。
 *
 * 工具是给人命名的（`Skill(release-notes)`、`docs.search`），但 Provider 只接受
 * `[a-zA-Z0-9_-]`。映射稳定且确定，`providerToolName` 持有反向表，模型发起的调用能映射回真工具。
 */
export function toProviderToolName(name: string): string {
  if (PROVIDER_NAME.test(name)) return name;
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const hash = [...name].reduce((value, character) => (value * 31 + character.charCodeAt(0)) % 0xffffffff, 7);
  return `${cleaned.slice(0, 48) || "tool"}_${hash.toString(36).slice(0, 6)}`;
}

/** One model call request. 一次模型调用请求。 */
export interface AgentModelRequest {
  messages: AgentMessage[];
  tools: AgentToolSpec[];
  signal: AbortSignal;
  onDelta?: (delta: string) => void;
}

/** One model call response. 一次模型调用响应。 */
export interface AgentModelResponse {
  content: string | null;
  toolCalls: AgentToolCall[];
  usage?: ModelUsage;
  finishReason?: string;
}

/** A provider adapter. 一个 Provider 适配器。 */
export interface AgentModel {
  complete(request: AgentModelRequest): Promise<AgentModelResponse>;
}

/** Why the loop stopped. 循环终止的原因。 */
export type AgentTerminalReason =
  | "completed"
  | "empty_response"
  | "max_turns"
  | "budget_exhausted"
  | "aborted"
  | "model_error";

/** A loop event; callers map these onto their journal or UI. 循环事件；调用方映射到 Journal 或 UI。 */
export type AgentLoopEvent =
  | { type: "turn_started"; maxRounds: number }
  | { type: "model_call_started"; round: number }
  | { type: "model_call_completed"; round: number; usage?: ModelUsage; toolCalls: number }
  | { type: "compaction"; round: number; estimatedTokens: number; before: number; after: number; afterTokens?: number }
  | { type: "tool_started"; round: number; toolCallId: string; tool: string; arguments: string }
  | { type: "tool_decision"; round: number; toolCallId: string; tool: string; behavior: "allow" | "deny"; reason?: string }
  | {
    type: "tool_completed";
    round: number;
    toolCallId: string;
    tool: string;
    isError: boolean;
    durationMs: number;
    truncated: boolean;
    denied?: boolean;
  }
  | { type: "budget_exhausted"; kind: "rounds" | "tool_calls" | "tokens" | "duration"; limit: number }
  | { type: "turn_completed"; reason: AgentTerminalReason; replyLength: number }
  | { type: "turn_failed"; reason: AgentTerminalReason; error: string };

/** Retry policy for transient model-call failures. 模型调用瞬时失败的有限重试策略。 */
export interface AgentRetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
}

export interface AgentToolResultBudget {
  /** Characters kept from one tool result; the middle is truncated. 单个工具结果保留的字符数，中间被截断。 */
  perResultChars?: number;
  /** Characters kept across all tool results in one round. 单回合所有工具结果保留的总字符数。 */
  totalChars?: number;
}

export interface AgentLoopOptions {
  model: AgentModel;
  tools: AgentToolSpec[];
  /** Initial messages, including the system prompt. 初始消息，包含 System Prompt。 */
  messages: AgentMessage[];
  /** Maximum model rounds; defaults to 8. 最大模型回合数；默认 8。 */
  maxRounds?: number;
  /** Maximum tool calls across the turn. 整个回合的最大工具调用次数。 */
  maxToolCalls?: number;
  /** Maximum wall-clock duration across the turn. 整个回合的最大墙钟时长。 */
  maxDurationMs?: number;
  /** Maximum total tokens reported by the provider. Provider 报告的总 token 上限。 */
  maxTotalTokens?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
  /** Per-call authorization; deny/ask is returned to the model as a tool error. 逐次授权；deny/ask 作为工具错误返回给模型。 */
  authorize?: (request: AgentToolRequest) => AgentToolDecision | Promise<AgentToolDecision>;
  /** Resolves an `ask`; without it an ask becomes a denial. 解决 `ask`；缺省时 ask 变为拒绝。 */
  requestApproval?: (request: AgentToolRequest & { reason: string }) => boolean | Promise<boolean>;
  hooks?: AgentHooks;
  toolResultBudget?: AgentToolResultBudget;
  /** Called when the estimated transcript exceeds the threshold. 估计对话超过阈值时调用。 */
  compact?: (messages: AgentMessage[], context: { round: number; estimatedTokens: number }) => Promise<AgentMessage[]>;
  compactThresholdTokens?: number;
  estimateTokens?: (messages: AgentMessage[]) => number;
  /**
   * Learns the provider's real characters-per-token from its usage reports, so
   * the estimate is calibrated instead of guessed. Without one the loop uses
   * the conservative bootstrap ratio.
   * 从 Provider 的用量报告里学习真实的每 token 字符数，使估算经过标定而不是猜测。
   * 不提供时循环使用保守的引导比例。
   */
  calibrator?: TokenCalibrator;
  retry?: AgentRetryPolicy;
}

export interface AgentLoopResult {
  reply: string;
  terminalReason: AgentTerminalReason;
  error?: string;
  messages: AgentMessage[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; modelCalls: number };
  toolCalls: number;
  rounds: number;
  durationMs: number;
}

/**
 * Run one bounded agent turn.
 *
 * The loop continues only when the model requested tools; a terminal reason is
 * always returned, never thrown, so callers can journal why it stopped.
 * 运行一个有界的 Agent 回合。
 *
 * 只有模型请求了工具才继续；循环总是返回终止原因而不是抛出，调用方可以记录“为什么停止”。
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const startedAt = Date.now();
  const maxRounds = Math.max(1, options.maxRounds ?? 8);
  const messages = [...options.messages];
  const tools = options.tools;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 };
  let reply = "";
  let toolCalls = 0;
  let rounds = 0;
  let terminalReason: AgentTerminalReason | undefined;
  let terminalError: string | undefined;

  await emit(options, { type: "turn_started", maxRounds });

  const stop = (reason: AgentTerminalReason, error?: string): void => {
    terminalReason = reason;
    if (error !== undefined) terminalError = error;
  };

  for (let round = 0; round < maxRounds; round += 1) {
    if (isAborted(options.signal)) {
      stop("aborted", "The turn was cancelled.");
      break;
    }
    if (exceedsDuration(options.maxDurationMs, startedAt)) {
      await emit(options, { type: "budget_exhausted", kind: "duration", limit: options.maxDurationMs! });
      stop("budget_exhausted", `The turn exceeded its ${options.maxDurationMs}ms budget.`);
      break;
    }
    if (options.maxTotalTokens !== undefined && usage.totalTokens >= options.maxTotalTokens) {
      await emit(options, { type: "budget_exhausted", kind: "tokens", limit: options.maxTotalTokens });
      stop("budget_exhausted", `The turn reached its ${options.maxTotalTokens}-token budget.`);
      break;
    }

    // Two consecutive compactions that remove nothing mean the newest turn alone
    // exceeds the window; stop with a typed reason instead of journaling the
    // same useless record every round.
    // 连续两次压缩都没有减少，说明仅最新一轮就超过窗口；以带类型的原因停止，而不是每轮记下同一条
    // 无用的记录。
    const progressed = await compactIfNeeded(options, messages, round);
    if (!progressed) {
      await emit(options, { type: "budget_exhausted", kind: "tokens", limit: options.compactThresholdTokens ?? 0 });
      stop("budget_exhausted", `Compaction cannot bring the transcript below ${options.compactThresholdTokens} tokens; the newest turn alone exceeds the window.`);
      break;
    }

    rounds += 1;
    await emit(options, { type: "model_call_started", round });
    let response: AgentModelResponse;
    try {
      response = await completeWithRetry(options, messages, tools);
    } catch (error: unknown) {
      if (isAborted(options.signal)) {
        stop("aborted", "The turn was cancelled.");
      } else {
        stop("model_error", error instanceof Error ? error.message : String(error));
      }
      break;
    }
    usage.modelCalls += 1;
    if (response.usage !== undefined) {
      // The provider just told us what the request cost; learn from it so the
      // next estimate is measured rather than guessed.
      // Provider 刚告诉我们这次请求花了多少；据此学习，使下一次估算是测量而不是猜测。
      options.calibrator?.observe(
        countCharacters(messages, tools).characters,
        response.usage.inputTokens ?? response.usage.totalTokens,
      );
      usage.inputTokens += response.usage.inputTokens ?? 0;
      usage.outputTokens += response.usage.outputTokens ?? 0;
      usage.totalTokens += response.usage.totalTokens ?? 0;
    }
    if (response.content !== null && response.content.length > 0) reply += response.content;
    await emit(options, {
      type: "model_call_completed",
      round,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
      toolCalls: response.toolCalls.length,
    });

    if (response.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: response.content });
      // `finish_reason` is how a provider says the answer was cut off. Reading
      // it is the difference between "the model finished" and "the model ran
      // out of output tokens mid-sentence", and the callers report the second
      // as a failure so a truncated answer is never presented as complete.
      // `finish_reason` 是 Provider 说明回答被截断的方式。读取它，才能区分"模型说完了"与
      // "模型在句子中间用完输出 token"；调用方把后者报为失败，使被截断的回答永远不会被当作完成。
      const truncated = response.finishReason === "length" || response.finishReason === "max_tokens";
      stop(
        truncated ? "model_error" : reply.trim().length === 0 ? "empty_response" : "completed",
        truncated ? `The model's answer was cut off (finish_reason: ${response.finishReason}).` : undefined,
      );
      break;
    }

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });

    if (options.maxTotalTokens !== undefined && usage.totalTokens >= options.maxTotalTokens) {
      // Keep tool-call pairing even when the turn stops before execution.
      // 即使回合在执行前停止，也保持 tool call 与 result 的配对。
      appendSyntheticResults(messages, response.toolCalls, "Tool call skipped: the turn reached its token budget.");
      await emit(options, { type: "budget_exhausted", kind: "tokens", limit: options.maxTotalTokens });
      stop("budget_exhausted", `The turn reached its ${options.maxTotalTokens}-token budget.`);
      break;
    }

    const batch = await executeToolBatch({
      options,
      tools,
      calls: response.toolCalls,
      round,
      usedToolCalls: toolCalls,
    });
    toolCalls += batch.executed;
    messages.push(...batch.messages);
    if (batch.budgetHit) {
      await emit(options, { type: "budget_exhausted", kind: "tool_calls", limit: options.maxToolCalls ?? 0 });
      stop("budget_exhausted", batch.budgetHitMessage ?? "The turn reached its tool-call budget.");
      break;
    }
    if (isAborted(options.signal)) {
      stop("aborted", "The turn was cancelled.");
      break;
    }
    if (exceedsDuration(options.maxDurationMs, startedAt)) {
      await emit(options, { type: "budget_exhausted", kind: "duration", limit: options.maxDurationMs! });
      stop("budget_exhausted", `The turn exceeded its ${options.maxDurationMs}ms budget.`);
      break;
    }
    if (round === maxRounds - 1) {
      await emit(options, { type: "budget_exhausted", kind: "rounds", limit: maxRounds });
      stop("max_turns", `The agent reached its ${maxRounds}-round limit without a final answer.`);
    }
  }

  const reason: AgentTerminalReason = terminalReason ?? "max_turns";
  const reasonError = terminalError ?? `The agent reached its ${maxRounds}-round limit without a final answer.`;
  const result: AgentLoopResult = {
    reply: reply.trim(),
    terminalReason: reason,
    ...(terminalError === undefined ? {} : { error: terminalError }),
    messages,
    usage,
    toolCalls,
    rounds,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  if (reason === "completed" || reason === "empty_response") {
    await emit(options, { type: "turn_completed", reason, replyLength: result.reply.length });
  } else {
    await emit(options, { type: "turn_failed", reason, error: reasonError });
  }
  return result;
}

interface ToolBatchResult {
  messages: AgentMessage[];
  executed: number;
  budgetHit: boolean;
  budgetHitMessage?: string;
}

/**
 * Execute one assistant tool-call batch.
 *
 * Consecutive safe tools run together; an unsafe tool is a barrier and runs
 * alone. Results are emitted in the model's call order, even when the safe
 * group finishes out of order. Budget-refused calls still get a tool result so
 * the transcript stays paired.
 *
 * 执行一批 assistant 工具调用。
 *
 * 连续的安全工具一起运行；非安全工具是屏障，单独运行。结果按模型调用顺序返回，即使安全组
 * 完成的顺序不同。被预算拒绝的调用仍会得到一条工具结果，保持转录配对。
 */
async function executeToolBatch(input: {
  options: AgentLoopOptions;
  tools: AgentToolSpec[];
  calls: AgentToolCall[];
  round: number;
  usedToolCalls: number;
}): Promise<ToolBatchResult> {
  const { options, tools, calls, round } = input;
  const messages: AgentMessage[] = new Array(calls.length);
  let executed = 0;
  let budgetHit = false;
  let budgetHitMessage: string | undefined;
  let index = 0;

  while (index < calls.length) {
    if (isAborted(options.signal)) {
      for (; index < calls.length; index += 1) {
        messages[index] = synthetic(calls[index]!, "Tool call not executed: the turn was cancelled.");
      }
      break;
    }
    const remaining = options.maxToolCalls === undefined ? calls.length : Math.max(0, options.maxToolCalls - input.usedToolCalls - executed);
    if (remaining === 0) {
      for (; index < calls.length; index += 1) {
        messages[index] = synthetic(calls[index]!, "Tool call skipped: the turn reached its tool-call budget.");
      }
      budgetHit = true;
      budgetHitMessage = `The turn reached its ${options.maxToolCalls}-tool-call budget.`;
      break;
    }

    const safe = isSafe(tools, calls[index]!);
    const group: AgentToolCall[] = [];
    while (index < calls.length && isSafe(tools, calls[index]!) === safe) {
      group.push(calls[index]!);
      index += 1;
    }
    const runnable = group.slice(0, remaining);
    const blocked = group.slice(remaining);
    if (blocked.length > 0) {
      budgetHit = true;
      budgetHitMessage = `The turn reached its ${options.maxToolCalls}-tool-call budget.`;
    }

    const outcomes = await Promise.all(runnable.map(async (call, offset) => {
      const result = await executeOne({
        options,
        tools,
        call,
        round,
      });
      executed += 1;
      return { index: index - group.length + offset, result };
    }));
    for (const outcome of outcomes) messages[outcome.index] = outcome.result;
    for (let block = 0; block < blocked.length; block += 1) {
      const blockedIndex = index - blocked.length + block;
      messages[blockedIndex] = synthetic(blocked[block]!, "Tool call skipped: the turn reached its tool-call budget.");
    }
    if (budgetHit) break;
  }

  for (let missing = 0; missing < calls.length; missing += 1) {
    if (messages[missing] === undefined) {
      messages[missing] = synthetic(calls[missing]!, "Tool call not executed.");
    }
  }
  applyTotalResultBudget(messages, options.toolResultBudget?.totalChars);
  return {
    messages,
    executed,
    budgetHit,
    ...(budgetHitMessage === undefined ? {} : { budgetHitMessage }),
  };
}

/**
 * Keep the aggregate tool-result text within a round budget by truncating the
 * oldest results first. The newest result is the one the model just asked for.
 * 通过优先截断最旧的结果，把单回合工具结果总文本保持在预算内；最新结果是模型刚请求的。
 */
function applyTotalResultBudget(messages: AgentMessage[], totalChars: number | undefined): void {
  if (totalChars === undefined) return;
  let total = messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
  for (const message of messages) {
    if (total <= totalChars) return;
    const content = typeof message.content === "string" ? message.content : "";
    if (content.length <= 240) continue;
    const excess = total - totalChars;
    const keep = Math.max(200, content.length - excess - 40);
    const truncated = truncateResult(content, keep);
    message.content = truncated.content;
    total -= content.length - truncated.content.length;
  }
}

async function executeOne(input: {
  options: AgentLoopOptions;
  tools: AgentToolSpec[];
  call: AgentToolCall;
  round: number;
}): Promise<AgentMessage> {
  const { options, tools, call, round } = input;
  const tool = tools.find((candidate) => candidate.name === call.name);
  const startedAt = Date.now();
  await emit(options, { type: "tool_started", round, toolCallId: call.id, tool: call.name, arguments: call.arguments });
  if (tool === undefined) {
    return toolMessage(call.id, `No tool named ${call.name} is available.`, true, options, round, call, Date.now() - startedAt, false);
  }

  let request: AgentToolRequest;
  try {
    request = { round, tool, call, input: parseArguments(call.arguments) };
  } catch (error: unknown) {
    // A malformed call is a tool result, not a dead turn: the model can correct
    // it on the next round.
    // 格式错误的调用是一条工具结果，而不是死掉的回合：模型可以在下一轮纠正。
    const message = error instanceof Error ? error.message : String(error);
    return toolMessage(call.id, `Tool ${call.name} failed: ${message}`, true, options, round, call, Date.now() - startedAt, false);
  }
  let decision: AgentToolDecision;
  try {
    decision = await decideTool(options, request);
  } catch (error: unknown) {
    decision = {
      behavior: "deny",
      reason: `Authorization failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (decision.behavior !== "allow") {
    await emit(options, {
      type: "tool_decision",
      round,
      toolCallId: call.id,
      tool: call.name,
      behavior: "deny",
      reason: decision.reason,
    });
    return toolMessage(call.id, `Refused: ${decision.reason}`, true, options, round, call, Date.now() - startedAt, false, true);
  }
  request = { ...request, ...(decision.updatedInput === undefined ? {} : { input: decision.updatedInput }) };
  await emit(options, {
    type: "tool_decision",
    round,
    toolCallId: call.id,
    tool: call.name,
    behavior: "allow",
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  });

  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await tool.run(request.input, { toolCallId: call.id, signal: controller.signal });
    const { content, truncated } = truncateResult(result.content, options.toolResultBudget?.perResultChars);
    const isError = result.isError === true;
    try {
      await options.hooks?.postToolUse?.({
        ...request,
        result,
        isError,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // A post-hook is telemetry; it cannot turn a successful tool into a failure.
      // 后置 Hook 是遥测；它不能把成功的工具变成失败。
    }
    return toolMessage(call.id, content, isError, options, round, call, Date.now() - startedAt, truncated);
  } catch (error: unknown) {
    const message = isAborted(controller.signal)
      ? "Tool call cancelled."
      : `Tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`;
    return toolMessage(call.id, message, true, options, round, call, Date.now() - startedAt, false);
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Combine pre-hook and authorization decisions: deny beats ask beats allow.
 * `updatedInput` from the last allowing source wins.
 * 合并前置 Hook 与授权决定：deny 胜过 ask，ask 胜过 allow；最后一个允许来源的
 * `updatedInput` 生效。
 */
async function decideTool(options: AgentLoopOptions, request: AgentToolRequest): Promise<AgentToolDecision> {
  const decisions: AgentToolDecision[] = [];
  if (options.hooks?.preToolUse !== undefined) {
    try {
      const hook = await options.hooks.preToolUse(request);
      if (hook !== undefined) decisions.push(hook);
    } catch (error: unknown) {
      decisions.push({
        behavior: "deny",
        reason: `PreToolUse hook failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (options.authorize !== undefined) {
    try {
      decisions.push(await options.authorize(request));
    } catch (error: unknown) {
      decisions.push({
        behavior: "deny",
        reason: `Authorization failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const denied = decisions.find((decision) => decision.behavior === "deny");
  if (denied !== undefined) return denied;
  const asked = decisions.find((decision) => decision.behavior === "ask");
  if (asked !== undefined) {
    let approved = false;
    if (options.requestApproval !== undefined) {
      try {
        approved = await options.requestApproval({ ...request, reason: asked.reason });
      } catch {
        approved = false;
      }
    }
    if (!approved) return { behavior: "deny", reason: `Approval was not granted: ${asked.reason}` };
    return { behavior: "allow", reason: `Approved: ${asked.reason}` };
  }
  const withInput = [...decisions]
    .reverse()
    .find((decision): decision is Extract<AgentToolDecision, { behavior: "allow" }> =>
      decision.behavior === "allow" && decision.updatedInput !== undefined);
  return withInput === undefined ? { behavior: "allow" } : withInput;
}

async function toolMessage(
  toolCallId: string,
  content: string,
  isError: boolean,
  options: AgentLoopOptions,
  round: number,
  call: AgentToolCall,
  durationMs: number,
  truncated: boolean,
  denied = false,
): Promise<AgentMessage> {
  await emit(options, {
    type: "tool_completed",
    round,
    toolCallId,
    tool: call.name,
    isError,
    durationMs,
    truncated,
    ...(denied ? { denied: true } : {}),
  });
  return { role: "tool", toolCallId, content };
}

function synthetic(call: AgentToolCall, content: string): AgentMessage {
  return { role: "tool", toolCallId: call.id, content };
}

function appendSyntheticResults(messages: AgentMessage[], calls: AgentToolCall[], content: string): void {
  for (const call of calls) messages.push(synthetic(call, content));
}

function isSafe(tools: AgentToolSpec[], call: AgentToolCall): boolean {
  return tools.find((tool) => tool.name === call.name)?.parallelSafe === true;
}

/**
 * Keep a tool result within its character budget by truncating the middle, so
 * both the head (what was asked) and the tail (the error or result) survive.
 * 通过截断中间把工具结果保持在字符预算内，保留头部（请求了什么）与尾部（错误或结果）。
 */
export function truncateResult(content: string, limit = 8_000): { content: string; truncated: boolean } {
  if (content.length <= limit) return { content, truncated: false };
  const keep = Math.max(0, limit - 40);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return {
    content: `${content.slice(0, head)}\n... [${content.length - keep} characters truncated] ...\n${content.slice(content.length - tail)}`,
    truncated: true,
  };
}

/**
 * The default retry predicate: retry transport-shaped failures, rate limits,
 * and server errors; never retry an abort or a client error.
 * 默认重试判定：重试传输层失败、限流与服务端错误；绝不对 abort 或客户端错误重试。
 */
export function isRetryableModelError(error: unknown): boolean {
  // A user or shutdown abort is final; a timeout is not. `AbortSignal.timeout()`
  // rejects with a DOMException whose name is `TimeoutError`, which is a
  // different class from `AbortError` — treating them alike meant every
  // timed-out request failed on the first attempt.
  // 用户或关停的 abort 是终局；超时不是。`AbortSignal.timeout()` 以 `TimeoutError` 名称的
  // DOMException 拒绝，与 `AbortError` 不是同一类——把它们等同起来，让每次超时都在第一次尝试
  // 就失败。
  if (error instanceof Error && error.name === "AbortError") return false;
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError") return true;
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
  if (status !== undefined && Number.isFinite(status)) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(408|409|429|5\d\d)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed? ?out|timeout/i.test(message);
}

async function completeWithRetry(
  options: AgentLoopOptions,
  messages: AgentMessage[],
  tools: AgentToolSpec[],
): Promise<AgentModelResponse> {
  const policy = options.retry ?? {};
  const maxAttempts = Math.max(1, policy.maxAttempts ?? 3);
  const baseDelay = Math.max(0, policy.baseDelayMs ?? 250);
  const maxDelay = Math.max(baseDelay, policy.maxDelayMs ?? 4_000);
  const retryable = policy.isRetryable ?? isRetryableModelError;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isAborted(options.signal)) throw new Error("The turn was cancelled.");
    try {
      return await options.model.complete({
        messages,
        tools,
        signal: options.signal ?? new AbortController().signal,
        ...(options.onDelta === undefined ? {} : { onDelta: safeDelta(options.onDelta) }),
      });
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= maxAttempts || !retryable(error) || isAborted(options.signal)) throw error;
      const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      await sleep(delay, options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function safeDelta(sink: (delta: string) => void): (delta: string) => void {
  return (delta) => {
    try {
      sink(delta);
    } catch {
      // A broken UI sink must not lose the reply. 断开的下游不能丢回复。
    }
  };
}

async function compactIfNeeded(options: AgentLoopOptions, messages: AgentMessage[], round: number): Promise<boolean> {
  if (options.compact === undefined || options.compactThresholdTokens === undefined) return true;
  const estimate = options.estimateTokens ?? ((current: AgentMessage[]) => estimateMessages(current, options.tools));
  const tokens = estimate(messages);
  if (tokens < options.compactThresholdTokens) return true;
  const before = messages.length;
  const next = await options.compact(messages, { round, estimatedTokens: tokens });
  messages.splice(0, messages.length, ...next);
  const after = estimate(messages);
  await emit(options, { type: "compaction", round, estimatedTokens: tokens, before, after: messages.length, afterTokens: after });
  // A compaction that removes no tokens is reported, not repeated forever: two
  // consecutive no-ops mean the tail alone is over the threshold, and running
  // again would journal the same useless record every round.
  // 没有减少 token 的压缩会被报告，而不是无限重复：连续两次无效说明仅尾部就超过阈值，
  // 再跑只会在每轮记下同一条无用的记录。
  return after < tokens;
}

/** A rough fallback estimate: four characters per token. 粗略回退估算：每 token 四个字符。 */
/**
 * Estimate the tokens a transcript costs.
 *
 * Delegates to `token-estimate.ts`, which calibrates against the provider's own
 * `usage.prompt_tokens`: a fixed character ratio is wrong for every model whose
 * tokenizer differs, and measured on this machine the same Chinese sentence
 * costs 30% more on one model than another, while code costs twice what Latin
 * prose does per token.
 * 估算转录消耗的 token。
 *
 * 委托给 `token-estimate.ts`，它按 Provider 自己的 `usage.prompt_tokens` 标定：对任何
 * tokenizer 不同的模型，固定的字符比例都是错的；在本机实测，同一句中文在某个模型上贵 30%，
 * 而代码每 token 的字符数只有拉丁散文的一半。
 */
export function estimateMessages(
  messages: readonly AgentMessage[],
  tools: readonly AgentToolSpec[] = [],
  calibrator?: TokenCalibrator,
): number {
  return estimateTokens(messages, tools, calibrator).tokens;
}

/**
 * Parse the model's tool arguments, refusing a call whose JSON is unusable.
 *
 * Returning `{}` for malformed or non-object JSON ran the tool with no
 * arguments: a truncated `{"path": "src/a` became a call with no path, and a
 * path tool then either refused for the wrong reason or, worse, ran against
 * its default. A malformed call is a tool error the model can correct.
 * 解析模型的工具参数，拒绝 JSON 不可用的调用。
 *
 * 对格式错误或非对象 JSON 返回 `{}` 会在无参数下运行工具：被截断的 `{"path": "src/a` 变成
 * 一次没有路径的调用，而路径工具随后要么以错误的原因拒绝，要么更糟——按默认值执行。格式错误的
 * 调用是模型可以纠正的工具错误。
 */
function parseArguments(source: string): Record<string, unknown> {
  if (source.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The tool arguments must be a JSON object, not ${Array.isArray(parsed) ? "an array" : typeof parsed}.`);
  }
  return parsed as Record<string, unknown>;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function exceedsDuration(limitMs: number | undefined, startedAt: number): boolean {
  return limitMs !== undefined && Date.now() - startedAt >= limitMs;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const abort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function emit(options: AgentLoopOptions, event: AgentLoopEvent): Promise<void> {
  try {
    await options.onEvent?.(event);
  } catch {
    // Telemetry must not stop the turn. 遥测不能停止回合。
  }
}
