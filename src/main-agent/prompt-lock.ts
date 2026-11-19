import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MAIN_AGENT_DEFAULT_CONVERSATION_ID } from "./conversation.ts";
import { tryAcquireDirectoryLock } from "./file-lock.ts";

/**
 * Exclusive lock around one conversation's Main Agent prompt.
 *
 * One conversation is one thread: two concurrent prompts for the same task —
 * GUI stream plus CLI, or two tabs — would interleave writes. This lock fails
 * closed: a second prompt in the same conversation is refused rather than
 * queued, so the owner sees the collision. Different conversations have
 * different lock paths and proceed independently, bounded by the slot pool.
 *
 * 针对一个对话的 Main Agent prompt 互斥锁。
 *
 * 一个对话就是一条线索：同一任务的两并发 prompt——GUI 流加上 CLI，或两个标签页——会交错
 * 写入。这把锁失败即关闭：同一对话的第二次 prompt 被拒绝而不是排队，好让所有者看见碰撞。
 * 不同对话各有锁路径、互不阻塞，只受槽位池约束。
 */
export class MainAgentBusyError extends Error {
  constructor() {
    super("The Main Agent is already answering another request in this conversation.");
    this.name = "MainAgentBusyError";
  }
}

export function mainAgentLockPath(
  dataDirectory: string,
  conversationId: string = MAIN_AGENT_DEFAULT_CONVERSATION_ID,
): string {
  const directory = join(dataDirectory, "pi-sessions", "main-agent");
  // The default conversation keeps the historical path, so an in-flight turn
  // from an older build is still respected after an upgrade. Other ids are
  // hashed: the path never depends on unsanitized request text.
  // 默认对话沿用历史路径，使旧版本仍在执行的回合在升级后仍被尊重。其他 id 做哈希：
  // 路径绝不依赖未经清洗的请求文本。
  if (conversationId === MAIN_AGENT_DEFAULT_CONVERSATION_ID) return join(directory, "prompt.lock");
  const digest = createHash("sha256").update(conversationId).digest("hex").slice(0, 16);
  return join(directory, `prompt-${digest}.lock`);
}

export async function withMainAgentLock<T>(
  dataDirectory: string,
  run: () => Promise<T>,
  conversationId: string = MAIN_AGENT_DEFAULT_CONVERSATION_ID,
): Promise<T> {
  const path = mainAgentLockPath(dataDirectory, conversationId);
  await mkdir(dirname(path), { recursive: true });
  const lock = await tryAcquireDirectoryLock(path);
  if (lock === undefined) throw new MainAgentBusyError();
  try {
    return await run();
  } finally {
    await lock.release();
  }
}
