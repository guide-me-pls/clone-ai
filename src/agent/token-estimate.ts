/**
 * Token accounting for the agent loop, calibrated against the provider.
 *
 * A token count is a property of the tokenizer, and every model has its own:
 * measured against this machine's gateway, the same Chinese sentence costs 265
 * tokens on kimi-k3.1-pro and 346 on gpt-6.1-terra, and a code sample costs
 * 2.0–2.6 characters per token where Latin prose costs 3.2–4.4. Any fixed
 * character ratio is therefore wrong for at least two of those cases.
 *
 * The provider already reports the true number on every response
 * (`usage.prompt_tokens`), so this module treats that as the ground truth: it
 * observes the ratio the provider actually charged and uses it for the next
 * estimate. The character heuristic is only the bootstrap before the first
 * response, and it is deliberately conservative — compacting a little early
 * costs a summary, compacting too late costs the request.
 *
 * token 记账，按 Provider 的实测值标定。
 *
 * Token 数是 tokenizer 的属性，每个模型都不同：在本机网关上实测，同一句中文在 kimi-k3.1-pro
 * 上是 265 token，在 gpt-6.1-terra 上是 346；一段代码每 token 2.0–2.6 字符，而拉丁散文是
 * 3.2–4.4。因此任何固定的字符比例至少对其中两种情况是错的。
 *
 * Provider 每次响应都会报真值（`usage.prompt_tokens`），因此本模块把它当作基准：观测 Provider
 * 实际收取的比例，并用它做下一次估算。字符启发式只用于第一次响应之前的引导，且刻意保守——
 * 早压缩的代价是一段摘要，晚压缩的代价是整个请求被拒。
 */

import type { AgentMessage, AgentToolSpec } from "./loop.ts";

/** Tokens a provider charges for one image, regardless of its pixel size. Provider 对一张图片收取的 token 数，与像素尺寸无关。 */
export const IMAGE_TOKENS = 1_568;

/**
 * The bootstrap ratio, in characters per token.
 *
 * Chosen from the lowest measured value across the three models (kimi's 3.15
 * for Latin prose) rather than the average: an estimate that is too high
 * under-reports tokens, which is the failure that loses a request.
 * 引导比例，单位是每 token 字符数。
 *
 * 取三个模型中的最低实测值（kimi 的拉丁散文 3.15）而不是平均：估算偏高会低估 token 数，
 * 而低估正是丢掉请求的失败方向。
 */
export const BOOTSTRAP_CHARS_PER_TOKEN = 3.15;

/** How the estimate was produced, so a caller can report it honestly. 估算的来源，使调用方能如实报告。 */
export type EstimateSource = "bootstrap" | "calibrated";

export interface TokenEstimate {
  tokens: number;
  /** Characters per token the estimate used. 估算使用的每 token 字符数。 */
  charsPerToken: number;
  source: EstimateSource;
  /** Responses observed so far. 已观测到的响应数。 */
  samples: number;
}

export interface TokenCalibratorOptions {
  /** Starting ratio before any response. 任何响应之前的起始比例。 */
  charsPerToken?: number;
  /**
   * Weight of a new sample. A low weight tolerates a single odd request (a
   * system prompt larger than the history, say) without throwing the ratio off.
   * 新样本的权重。低权重能容忍单个异常请求（例如比历史还大的 System Prompt），而不会让比例
   * 大幅偏移。
   */
  smoothing?: number;
}

/**
 * Learns the provider's real characters-per-token from its usage reports.
 *
 * Every estimate says whether it is bootstrapped or calibrated: a caller that
 * shows the number to an owner must not present a guess as a measurement.
 * 从 Provider 的用量报告里学习真实的每 token 字符数。
 *
 * 每次估算都会说明它是引导值还是已标定值：把数字展示给所有者的调用方，不能把猜测当作测量。
 */
export class TokenCalibrator {
  readonly #bootstrap: number;
  readonly #smoothing: number;
  #ratio: number;
  #samples = 0;

  constructor(options: TokenCalibratorOptions = {}) {
    this.#bootstrap = options.charsPerToken !== undefined && options.charsPerToken > 0
      ? options.charsPerToken
      : BOOTSTRAP_CHARS_PER_TOKEN;
    this.#ratio = this.#bootstrap;
    this.#smoothing = options.smoothing !== undefined && options.smoothing > 0 && options.smoothing <= 1
      ? options.smoothing
      : 0.3;
  }

  get samples(): number {
    return this.#samples;
  }

  get charsPerToken(): number {
    return this.#ratio;
  }

  /**
   * Record what the provider actually charged for a request this module
   * estimated. A cached prompt still reports the full prompt token count, so
   * the ratio stays comparable.
   * 记录 Provider 对一次本模块估算过的请求实际收取的用量。缓存命中的提示词仍报告完整的
   * prompt token 数，因此比例保持可比。
   */
  observe(estimatedCharacters: number, promptTokens: number | undefined): void {
    if (promptTokens === undefined || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
    if (estimatedCharacters <= 0) return;
    const observed = estimatedCharacters / promptTokens;
    // A ratio outside this band means the report was not for this request
    // (a proxy that bills a different prompt, or a provider that counts
    // cached tokens separately). Ignore it rather than corrupt the estimate.
    // 比例超出这个区间，说明报告不是这次请求的（代理按不同提示词计费，或 Provider 单独统计
    // 缓存 token）。忽略它，而不是污染估算。
    if (observed < 1 || observed > 12) return;
    this.#ratio = this.#samples === 0
      ? observed
      : this.#ratio * (1 - this.#smoothing) + observed * this.#smoothing;
    this.#samples += 1;
  }
}

/** The characters in a transcript plus its tool table, before any ratio is applied. 应用任何比例之前的转录与工具表字符数。 */
export function countCharacters(
  messages: readonly AgentMessage[],
  tools: readonly AgentToolSpec[] = [],
): { characters: number; images: number } {
  let characters = 0;
  let images = 0;
  for (const message of messages) {
    if (typeof message.content === "string") characters += message.content.length;
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") characters += part.text.length;
        else images += 1;
      }
    }
    for (const call of message.toolCalls ?? []) {
      characters += call.name.length + call.arguments.length;
    }
  }
  // Tool schemas are re-sent on every round; a table of twenty tools is
  // thousands of tokens that the transcript alone never shows.
  // 工具 Schema 每轮重发；二十个工具的表是几千个 token，只看转录永远看不到。
  for (const tool of tools) {
    characters += tool.name.length + tool.description.length;
    if (tool.parameters !== undefined) characters += JSON.stringify(tool.parameters).length;
  }
  return { characters, images };
}

/**
 * Estimate the tokens a request costs, using the calibrated ratio when one has
 * been observed.
 * 估算一次请求的 token 消耗；已观测到比例时使用标定值。
 */
export function estimateTokens(
  messages: readonly AgentMessage[],
  tools: readonly AgentToolSpec[] = [],
  calibrator?: TokenCalibrator,
): TokenEstimate {
  const { characters, images } = countCharacters(messages, tools);
  const ratio = calibrator?.charsPerToken ?? BOOTSTRAP_CHARS_PER_TOKEN;
  return {
    tokens: Math.ceil(characters / ratio) + images * IMAGE_TOKENS,
    charsPerToken: ratio,
    source: calibrator === undefined || calibrator.samples === 0 ? "bootstrap" : "calibrated",
    samples: calibrator?.samples ?? 0,
  };
}
