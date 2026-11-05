/**
 * Reasoning-effort levels, as the CLIs and the gateway spell them.
 *
 * The gateway reports which levels a model actually supports, so the level is a
 * per-model choice rather than a global knob. Nothing here guesses: a provider
 * declares the levels it accepts in providers.json, and the UI offers only
 * those.
 *
 * 推理强度档位，跟随各 CLI 与网关的写法。
 *
 * 网关会报告每个模型实际支持哪些档位，所以强度是"按模型"的选择，而不是全局旋钮。这里
 * 不做猜测：Provider 在 providers.json 里声明自己接受的档位，界面只列出这些档位。
 */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Narrow a declared list to levels we understand, preserving order. 把声明的档位收敛到已知集合，保留顺序。 */
export function effortChoices(values: unknown): EffortLevel[] {
  if (!Array.isArray(values)) return [...EFFORT_LEVELS];
  return values.filter(isEffortLevel);
}
