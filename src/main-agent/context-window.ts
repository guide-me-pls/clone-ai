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
  // Where the kept stretch begins in `body`; everything before it is dropped.
  // 保留片段在 `body` 中的起点；此前的消息都被丢弃。
  let start = body.length;
  // A tool result only makes sense with the assistant call that produced it, so
  // the walk starts at the last message that can open a kept stretch. Starting
  // at the very end used to break on a trailing `tool` message, leaving `keep`
  // empty and the whole tail budget unused.
  // 工具结果只有配上产生它的 assistant 调用才有意义，因此从最后一条能开启保留片段的消息开始走。
  // 过去从最末尾开始，遇到结尾的 `tool` 消息就中断，`keep` 为空，整个尾部预算被浪费。
  let index = body.length - 1;
  while (index >= 0 && body[index]!.role === "tool") index -= 1;
  // The results an assistant tool call owns: every `tool` message directly
  // after it, as long as they all answer its call ids. A call with a result the
  // provider would reject makes the whole turn unusable, so the walk stops.
  // 一次 assistant 工具调用所拥有的结果：紧随其后的所有 `tool` 消息，且它们都对应它的调用 id。
  // 若某个结果会让 Provider 拒绝，这整个回合就不可用，于是停止。
  const resultsAt = (at: number): AgentMessage[] | undefined => {
    const call = body[at];
    if (call === undefined || call.role !== "assistant" || (call.toolCalls?.length ?? 0) === 0) return [];
    const results: AgentMessage[] = [];
    for (let nextAt = at + 1; nextAt < body.length; nextAt += 1) {
      const next = body[nextAt]!;
      if (next.role !== "tool") break;
      if (next.toolCallId === undefined || call.toolCalls?.some((item) => item.id === next.toolCallId) !== true) return undefined;
      results.push(next);
    }
    return results;
  };
  for (; index >= 0; index -= 1) {
    const message = body[index]!;
    // A result is kept with its call, or dropped with it; it never starts the
    // tail, and the kept stretch stays a suffix of the transcript.
    // 结果要么随它的调用一起保留，要么一起被丢；它绝不作为尾部的起点，保留片段始终是转录的后缀。
    if (message.role === "tool") break;
    const results = resultsAt(index);
    // A call whose results are missing or unmatched cannot be kept without
    // handing the provider a transcript it rejects.
    // 结果缺失或对不上的调用不能被保留，否则会把 Provider 拒绝的转录交出去。
    if (results === undefined) break;
    if (results.length === 0 && (message.toolCalls?.length ?? 0) > 0) break;
    const size = estimateMessages([message]) + results.reduce((total, result) => total + estimateMessages([result]), 0);
    const room = kept + size <= budget;
    // The tail is already empty, so nothing would survive the compaction if this
    // walk stopped here: keep the newest turn even when it alone exceeds the
    // budget, then stop.
    // 此时尾部还是空的，若在此停下压缩后什么都不会留下：即使最新一轮本身超出预算也要保留，
    // 然后停止。
    if (!room && keep.length > 0) break;
    keep.unshift(message, ...results);
    kept += size;
    start = index;
    // The tail has to hold the conversation's latest turn: once the newest user
    // message is in, the walk may only continue while the budget allows. A
    // transcript that ends in a tool result is exactly this case, so the kept
    // stretch is the tool call and its result plus the request that asked for it.
    // 尾部必须含有对话的最近一轮：最新的用户消息进来之后，只有预算允许才能继续。
    // 以工具结果结尾的转录正是这种情况，因此保留片段是工具调用与其结果，加上提出请求的消息。
    if (message.role === "user" && !room) break;
  }
  // A transcript whose tail is a lone tool result, or an unusable call/result
  // pair, has no suffix the provider accepts; the newest usable message is kept
  // anyway rather than compacting the conversation into nothing.
  // 尾部只有一条工具结果、或调用/结果配对不可用时，没有 Provider 能接受的后缀；此时仍然保留
  // 最新一条可用消息，而不是把对话压成空。
  if (keep.length === 0) {
    for (let at = body.length - 1; at >= 0; at -= 1) {
      const message = body[at]!;
      if (message.role === "tool") continue;
      const results = resultsAt(at);
      if (results === undefined) continue;
      if (results.length === 0 && (message.toolCalls?.length ?? 0) > 0) continue;
      keep.push(message, ...results);
      start = at;
      break;
    }
  }
  const dropped = body.slice(0, Math.min(start, body.length - keep.length));
  const excerptLimit = Math.max(40, options.excerptChars ?? 400);
  const summaryLimit = Math.max(200, options.summaryChars ?? 4_000);
  const droppedLines = dropped.map((message) => `- ${trim(messageText(message), excerptLimit)}`);
  // The newest dropped user turn is the current goal; a compacted transcript
  // that lost it cannot continue the work the user asked for.
  // 最新的被丢用户回合就是当前目标；丢掉它的压缩转录无法继续用户要求的工作。
  const currentGoalAt = ((): number => {
    for (let at = dropped.length - 1; at >= 0; at -= 1) {
      const message = dropped[at]!;
      if (message.role === "user" && messageText(message).trim().length > 0) return at;
    }
    return -1;
  })();
  const droppedChars = droppedLines.reduce((total, line) => total + line.length + 1, 0);
  let excerptBody: string;
  if (droppedChars <= summaryLimit) {
    excerptBody = droppedLines.join("\n");
  } else {
    // The summary used to be taken from the front of the dropped messages, so a
    // 149-message compaction kept the oldest tasks and cut off the current
    // request. When it must shrink, the newest lines win; the oldest kept lines
    // are evicted to make room for the current goal.
    // 摘要过去从被丢消息的前端截取，于是一次 149 条消息的压缩保留了最旧的任务、切掉了当前请求。
    // 需要收缩时，最新的行优先；为了让出空间给当前目标，已保留的最旧行会被淘汰。
    const picked: Array<{ at: number; line: string }> = [];
    let used = 0;
    for (let at = droppedLines.length - 1; at >= 0; at -= 1) {
      const line = droppedLines[at]!;
      if (used + line.length + 1 > summaryLimit) continue;
      picked.push({ at, line });
      used += line.length + 1;
    }
    if (currentGoalAt >= 0 && !picked.some((entry) => entry.at === currentGoalAt)) {
      const goalLine = droppedLines[currentGoalAt]!;
      // `picked` is newest-first, so the oldest kept line is at the end.
      // `picked` 按最新在前排列，因此已保留的最旧一行在末尾。
      while (used + goalLine.length + 1 > summaryLimit && picked.length > 0) {
        const evicted = picked.pop()!;
        used -= evicted.line.length + 1;
      }
      picked.push({ at: currentGoalAt, line: trim(goalLine, Math.max(20, summaryLimit - used - 1)) });
    }
    excerptBody = picked.sort((left, right) => left.at - right.at).map((entry) => entry.line).join("\n");
  }
  const summary = excerptBody.length === 0 ? "" : `${COMPACTION_PREAMBLE}\n${excerptBody}`;
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
