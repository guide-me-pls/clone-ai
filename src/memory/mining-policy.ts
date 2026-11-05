/**
 * Which conversations are worth a mining call.
 *
 * Conversation mining was opt-in because it costs one model call per turn. The
 * price was the thing a personal agent most needs: learning from what the owner
 * says without being asked. A cheap local filter lets the default be "on for
 * turns that could contain a durable statement", which is the trade the owner
 * actually wants: no cost for "thanks" and "what time is it", a real call for
 * "I prefer X" and "from now on Y".
 *
 * The filter is deliberately generous. A missed statement is a memory never
 * learned; an extra call is a few cents. The tests below pin the cases that
 * matter in both directions.
 *
 * 哪些对话值得一次提炼调用。
 *
 * 对话提炼此前默认关闭，因为每轮要花一次模型调用。代价恰恰是个人 Agent 最需要的能力：在没被要求
 * 时也从所有者的话里学习。一个廉价的本地过滤器让默认变成"可能含有持久陈述的回合才开启"——这正是
 * 所有者真正想要的取舍：对"谢谢""现在几点"零成本，对"我偏好 X""以后 Y"付一次真实调用。
 *
 * 过滤器刻意宽松：漏掉一条陈述就是一条永远学不到的记忆；多一次调用只是几分钱。
 */
export type MiningMode = "off" | "filtered" | "all";

/**
 * Signals that an owner's turn states something durable. Chinese and English
 * are both matched because the owner writes in either.
 * 表示所有者这一轮陈述了持久内容的信号。中英文都匹配，因为所有者两种都会写。
 */
const DURABLE_SIGNALS: readonly RegExp[] = [
  /我(更|比较)?(喜欢|偏好|习惯|讨厌|不喜欢|希望|要求|需要|想要)/,
  /(以后|今后|从今|之后|每次|每逢|每周|每月|每年|默认|总是|一律)/,
  /我(住|在|叫|是|用|有|养|负责|不)/,
  /(记住|记得|别忘|注意|务必|一定)/,
  /\b(i (prefer|like|hate|always|usually|never|live in|work at|use)|remember|from now on|every (week|month|year|friday)|my (name|address|team|manager))\b/i,
];

export function miningModeFromEnvironment(environment: NodeJS.ProcessEnv = process.env): MiningMode {
  const raw = environment.CLONE_AI_MEMORY_MINING?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return "off";
  if (raw === "1" || raw === "all") return "all";
  // Unset or anything unrecognised: the default. Mining is on for turns that
  // look like they state something, which is what a personal agent needs.
  // 未设置或无法识别时取默认：只为看起来在陈述某些内容的回合开启提炼，这正是个人 Agent 所需要的。
  return "filtered";
}

/** Whether this turn should be mined under the given mode. 在给定模式下这一轮是否应被提炼。 */
export function shouldMine(text: string, mode: MiningMode = miningModeFromEnvironment()): boolean {
  const trimmed = text.trim();
  if (mode === "off" || trimmed.length === 0) return false;
  // A one-word reply cannot carry a durable statement, and neither can a pure
  // question about the system.
  // 一词的回答不可能承载持久陈述，关于系统本身的纯提问也不可能。
  if (trimmed.length < 4) return false;
  if (mode === "all") return true;
  return DURABLE_SIGNALS.some((signal) => signal.test(trimmed));
}
