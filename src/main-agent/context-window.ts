/**
 * Token-aware context accounting and deterministic compaction.
 *
 * The character budget was a stand-in for a real window: it neither knew the
 * model's context size nor recorded what it dropped. This module estimates
 * tokens, derives the same three levels Claude Code uses (compact, warn,
 * blocked), and compacts a transcript into a boundary note, a bounded summary,
 * and a verbatim tail. Everything it removes stays in the turn ledger, so
 * `search_history` can still find it.
 *
 * 按 token 计算的上下文记账与确定性压缩。
 *
 * 字符预算只是窗口的替身：它既不知道模型的上下文大小，也不记录丢了什么。本模块估算 token，
 * 推导与 Claude Code 相同的三档（压缩、警告、阻断），并把转录压成边界说明、有界摘要与逐字
 * 保留的尾部。被移除的内容仍在回合台账里，`search_history` 依然找得到。
 */

export interface ContextWindowPolicy {
  /** The model's context window in tokens. 模型的上下文窗口（token）。 */
  contextWindow: number;
  /** Output tokens reserved from the window; defaults to 20,000. 从窗口预留的输出 token；默认 20,000。 */
  maxOutputTokens?: number;
  /** Fraction of the effective window kept free; defaults to 0.2. 有效窗口保留的空白比例；默认 0.2。 */
  reserveFraction?: number;
  /** Extra reserve in tokens; defaults to 13,000. 额外预留 token；默认 13,000。 */
  extraReserve?: number;
  /** Warning margin below the compact threshold; defaults to 20,000. 压缩阈值下方的警告余量；默认 20,000。 */
  warningMargin?: number;
  /** Distance from the effective window at which the turn is blocked; defaults to 3,000. 距有效窗口多近时阻断回合；默认 3,000。 */
  blockedMargin?: number;
}

export interface ContextLevels {
  effectiveWindow: number;
  compactAt: number;
  warnAt: number;
  blockedAt: number;
}

/** Derive the three levels from a window and reserves. 从窗口与预留推导三档水位。 */
export function contextLevels(policy: ContextWindowPolicy): ContextLevels {
  const outputReserve = Math.max(0, policy.maxOutputTokens ?? 20_000);
  const effectiveWindow = Math.max(1, policy.contextWindow - Math.min(outputReserve, policy.contextWindow));
  const fraction = clampFraction(policy.reserveFraction ?? 0.2);
  const extraReserve = Math.max(0, policy.extraReserve ?? 13_000);
  // Two independent caps: a percentage of the window and a fixed headroom.
  // 两个独立上限：窗口的百分比与固定余量。
  const compactAt = Math.round(Math.min(
    Math.floor(effectiveWindow * (1 - fraction)),
    effectiveWindow - extraReserve,
  ));
  return {
    effectiveWindow,
    compactAt: Math.max(1, compactAt),
    warnAt: Math.max(1, compactAt - Math.max(0, policy.warningMargin ?? 20_000)),
    blockedAt: Math.max(1, effectiveWindow - Math.max(0, policy.blockedMargin ?? 3_000)),
  };
}

import type { AgentMessage } from "../agent/loop.ts";
import { estimateMessages } from "../agent/loop.ts";

export type ContextPressure = "normal" | "warn" | "compact" | "blocked";

/** Classify an estimate against the levels. 把估算值对照三档水位分类。 */
export function contextPressure(estimatedTokens: number, levels: ContextLevels): ContextPressure {
  if (estimatedTokens >= levels.blockedAt) return "blocked";
  if (estimatedTokens >= levels.compactAt) return "compact";
  if (estimatedTokens >= levels.warnAt) return "warn";
  return "normal";
}

/** One compacted transcript: the summary note plus the messages kept verbatim. 一份压缩结果：摘要说明加上逐字保留的消息。 */
export interface CompactionOutcome {
  messages: AgentMessage[];
  summary: string;
  droppedMessages: number;
  keptMessages: number;
}

export interface CompactionOptions {
  /** Estimated tokens; when absent the char-based estimate is used. 估算的 token 数；缺省时使用按字符的估算。 */
  estimatedTokens?: number;
  /** Token budget for the kept verbatim tail. 逐字保留尾部的 token 预算。 */
  keepTailTokens?: number;
  /** Maximum characters in the generated summary; defaults to 4,000. 生成的摘要最大字符数；默认 4,000。 */
  summaryChars?: number;
  /** Per-message excerpt length in the summary; defaults to 400. 摘要中每条消息的摘录长度；默认 400。 */
  excerptChars?: number;
  /** Trailing messages that must stay verbatim regardless of the budget. 无论预算如何都必须逐字保留的尾部消息数。 */
  preserveLast?: number;
}

export const COMPACTION_PREAMBLE = "Earlier conversation (compacted deterministically; background only, full text is in the turn ledger and search_history):";

/**
 * Compact a transcript deterministically.
 *
 * The system message is preserved; everything between becomes a bounded
 * summary note; the newest messages stay verbatim within the tail budget.
 * 确定性地压缩转录。
 *
 * System 消息保留；中间部分变成有界摘要说明；最新消息在尾部预算内保持原文。
 */
export function compactTranscript(
  messages: readonly AgentMessage[],
  options: CompactionOptions = {},
): CompactionOutcome {
  if (messages.length === 0) return { messages: [], summary: "", droppedMessages: 0, keptMessages: 0 };
  const hasSystem = messages[0]!.role === "system";
  const system = hasSystem ? messages[0]! : undefined;
  const all = hasSystem ? messages.slice(1) : [...messages];
  const preserveLast = Math.max(0, Math.min(options.preserveLast ?? 0, all.length));
  const body = preserveLast === 0 ? all : all.slice(0, all.length - preserveLast);
  const preserved = preserveLast === 0 ? [] : all.slice(all.length - preserveLast);
  const estimatedTokens = options.estimatedTokens ?? estimateMessages(messages);
  const budget = options.keepTailTokens ?? Math.max(1, Math.floor(estimatedTokens * 0.66));
  const keep: AgentMessage[] = [];
  let kept = 0;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const message = body[index]!;
    // A tool result without its call (or a call without its result) is a
    // transcript the provider rejects. The kept tail starts at a message that
    // is not a dangling result, and never splits a pair.
    // 没有对应调用的工具结果（或没有结果的调用）是 Provider 会拒绝的转录。保留的尾部从一条
    // 不是悬空结果的消息开始，且绝不拆开一对调用与结果。
    if (message.role === "tool") break;
    let size = estimateMessages([message]);
    const next = body[index + 1];
    if (next?.role === "tool" && next.toolCallId !== undefined && message.toolCalls?.some((call) => call.id === next.toolCallId)) {
      size += estimateMessages([next]);
    }
    if (keep.length > 0 && kept + size > budget) break;
    keep.unshift(...(next?.role === "tool" && next.toolCallId !== undefined && message.toolCalls?.some((call) => call.id === next.toolCallId) ? [message, next] : [message]));
    kept += size;
  }
  const dropped = body.slice(0, body.length - keep.length);
  const excerptLimit = Math.max(40, options.excerptChars ?? 400);
  const summaryLimit = Math.max(200, options.summaryChars ?? 4_000);
  const summaryBody = dropped
    .map((message) => `- ${trim(messageText(message), excerptLimit)}`)
    .join("\n")
    .slice(0, summaryLimit);
  const summary = summaryBody.length === 0 ? "" : `${COMPACTION_PREAMBLE}\n${summaryBody}`;
  const next: AgentMessage[] = [];
  if (system !== undefined) next.push(system);
  if (summary.length > 0) next.push({ role: "system", content: summary });
  next.push(...keep, ...preserved);
  return {
    messages: next,
    summary,
    droppedMessages: dropped.length,
    keptMessages: keep.length + preserved.length,
  };
}

/** One message as a collapsed, capped excerpt for a summary. 一条消息压成单行、有上限的摘要摘录。 */
export function compressForSummary(message: AgentMessage, limit = 400): string {
  return trim(messageText(message).replace(/\s+/g, " ").trim(), Math.max(20, limit));
}

/** The plain text of one message, for a summary excerpt. 一条消息的纯文本，用于摘要摘录。 */
export function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => part.type === "text" ? part.text : "[image]")
      .join(" ");
  }
  return "";
}

/** A char-based token estimate used only when a caller has no better counter. 仅在调用方没有更好计数时使用的按字符估算。 */
export function estimateChars(messages: readonly unknown[]): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message === "string") chars += message.length;
    else if (typeof message === "object" && message !== null) {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") chars += content.length;
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "object" && part !== null) {
            const value = part as { text?: unknown; image_url?: { url?: unknown } };
            if (typeof value.text === "string") chars += value.text.length;
            else if (typeof value.image_url?.url === "string") chars += value.image_url.url.length;
          }
        }
      }
      const calls = (message as { toolCalls?: unknown }).toolCalls;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (typeof call === "object" && call !== null) {
            const value = call as { name?: unknown; arguments?: unknown };
            if (typeof value.name === "string") chars += value.name.length;
            if (typeof value.arguments === "string") chars += value.arguments.length;
          }
        }
      }
    }
  }
  return chars;
}

function trim(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0.2;
  return Math.min(0.9, Math.max(0, value));
}
