/**
 * Reasoning-effort names, as the gateway and the providers spell them.
 *
 * The gateway reports which levels a model actually supports, and it declares
 * more than this list: `360/openai/gpt-6.1-terra` offers
 * `none, low, medium, high, xhigh, max, ultra`. The provider is therefore the
 * authority for a turn's effort — `normalizeEffort` only trims and bounds the
 * name, and an unknown one reaches the provider as the owner wrote it. The
 * known list below is the picker's fallback when the gateway declares nothing,
 * and the conservative set a self-review proposal may choose from.
 *
 * 推理强度名称，跟随网关与各 Provider 的写法。
 *
 * 网关会报告每个模型实际支持哪些档位，而且它声明的比下面这个列表多：
 * `360/openai/gpt-6.1-terra` 提供 `none, low, medium, high, xhigh, max, ultra`。
 * 因此一个回合的强度以 Provider 为权威——`normalizeEffort` 只做去空白与长度限制，未知
 * 档位按所有者所写原样送达 Provider。下面的已知列表是网关没有声明时选择器的兜底，也是
 * 自审提案可以选择的保守集合。
 */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** A name in the known fallback list. 已知兜底列表中的名称。 */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The effort name a request carries, trimmed and bounded; undefined means
 * "use the configured default".
 *
 * The gateway accepts levels this build has never heard of (`none`, `ultra`),
 * so the check cannot be membership in a list without rejecting a level the
 * model advertises. What is still refused is a value that is not a name at
 * all: a non-string, an empty or whitespace-only string, or one longer than a
 * provider would ever return.
 *
 * 请求携带的强度名称，去空白并限制长度；undefined 表示"使用配置的默认值"。
 *
 * 网关接受本版本从未听说过的档位（`none`、`ultra`），因此校验不能是"在列表中"，否则
 * 会拒绝模型宣称支持的档位。仍然拒绝的是根本不像名称的值：非字符串、空或纯空白字符串、
 * 以及长到 Provider 不可能返回的值。
 */
export const MAX_EFFORT_LENGTH = 64;

export function normalizeEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EFFORT_LENGTH) return undefined;
  return trimmed;
}
