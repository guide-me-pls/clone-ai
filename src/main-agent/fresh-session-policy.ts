import type { BlackBoxProviderConfig } from "../adapters/black-box-worker.ts";

/**
 * Guarantees every worker invocation starts from an empty conversation.
 *
 * This is what makes cross-agent memory portability real: if a worker carried
 * its own chat history, switching from one product to another would lose
 * context that lives inside that vendor's session files. Because every
 * invocation is stateless, the Kernel's memory context is the *only* continuity
 * — and it travels to any agent unchanged.
 *
 * 保证每次 Worker 调用都从空对话开始。
 *
 * 这正是跨 Agent 记忆可迁移性的实现基础：如果 Worker 自带对话历史，从一个产品换到另一个
 * 就会丢失存在于该厂商会话文件里的上下文。因为每次调用都是无状态的，Kernel 的记忆上下文
 * 成为唯一的连续性来源——而它可以原样传给任何 Agent。
 */

/** Arguments that would resume a prior conversation. 会续接既往对话的参数。 */
const CONTINUATION_FLAGS = [
  "--continue",
  "--resume",
  "--session",
  "--session-id",
  "-c",
];

export interface FreshSessionViolation {
  providerId: string;
  flag: string;
}

/**
 * Removes continuation flags from a launch recipe. A provider config is owner
 * editable, so this runs at dispatch rather than trusting the file.
 * 从启动配方中移除续接参数。Provider 配置由所有者编辑，因此在派发时执行，而不是信任文件。
 */
export function enforceFreshSession(config: BlackBoxProviderConfig): {
  config: BlackBoxProviderConfig;
  removed: FreshSessionViolation[];
} {
  const args = config.args ?? [];
  const removed: FreshSessionViolation[] = [];
  const kept: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const flag = CONTINUATION_FLAGS.find((candidate) => argument === candidate || argument.startsWith(`${candidate}=`));
    if (flag === undefined) {
      kept.push(argument);
      continue;
    }
    removed.push({ providerId: config.id, flag });
    // A bare flag consumes its value; an inline --flag=value does not.
    // 裸参数会吞掉紧随其后的值；--flag=value 形式则不会。
    if (argument === flag && index + 1 < args.length && !args[index + 1]!.startsWith("-")) index += 1;
  }

  return { config: { ...config, args: kept }, removed };
}

/** Reports whether a recipe would resume a session, for tests and audits. 报告某配方是否会续接会话，供测试与审计使用。 */
export function findContinuationFlags(args: readonly string[]): string[] {
  return args.filter((argument) => CONTINUATION_FLAGS.some(
    (flag) => argument === flag || argument.startsWith(`${flag}=`),
  ));
}
