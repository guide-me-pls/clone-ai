/**
 * One companion-facing query through Clone AI's built-in Main Agent.
 * 面向 companion 的一次查询，统一经过 Clone AI 内置 Main Agent。
 */
import type { Run } from "../core/contracts.ts";
import { join } from "node:path";
import type { MainAgentTurnSource } from "../main-agent/turn-audit.ts";
import { withMainAgentLock } from "../main-agent/prompt-lock.ts";
import { runNativeMainAgentTurn } from "../main-agent/native-runtime.ts";
import { beginInvocation, type InvocationCaller, type InvocationSurface } from "../audit/invocation-ledger.ts";
import { shouldMine } from "../memory/mining-policy.ts";

export interface MainAgentQueryResult {
  reply: string;
  /** Why the model produced no visible reply, when it failed instead of finishing. 模型没有可见回复时的失败原因。 */
  error?: string;
  /** Runs that appeared in the Kernel journal during this query. 本次查询期间出现在 Kernel Journal 中的 Run。 */
  newRuns: Array<Pick<Run, "id" | "status" | "planId">>;
}

export interface MainAgentQueryOptions {
  /** Which surface asked for this turn; recorded in the shared invocation ledger. 本回合的调用界面；写入共享调用账本。 */
  surface?: InvocationSurface;
  /** Explicit caller identity, when the transport knows it. 传输层已知时的显式调用者身份。 */
  caller?: Partial<Omit<InvocationCaller, "pid" | "ppid">>;
  /** Workspace shown in the invocation ledger. 调用账本中展示的工作区。 */
  workspacePath?: string;
  /** Test seam for the shared ledger location. 共享账本位置的测试切口。 */
  auditHome?: string;
  /** Images the owner attached to this turn. 所有者在本回合附带的图片。 */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /**
   * Called for each token as the agent produces it. The deltas exist either
   * way; without a sink they are merely accumulated and delivered at the end,
   * which makes a slow model look like a frozen interface.
   * Agent 每产出一个 token 就会调用。增量本来就存在；没有接收方时它们只是被累加、最后
   * 一次性交付，而这会让一个慢模型看起来像界面卡死。
   */
  onDelta?: (delta: string) => void;
  /**
   * The desktop turn ledger's id, when this query came from it, so the prompt
   * snapshot and the turn record can be correlated.
   * 桌面回合账本的 id（当本次查询来自它时），用于把提示词快照与回合记录对应起来。
   */
  turnId?: string;
  /** Which entry point produced this turn, for the audit. 产生本回合的入口，供审计使用。 */
  source?: MainAgentTurnSource;
  /** Cancels the model call and every in-flight tool. 取消模型调用与所有在途工具。 */
  signal?: AbortSignal;
}

export async function runMainAgentQuery(
  dataDirectory: string,
  text: string,
  options: MainAgentQueryOptions = {},
): Promise<MainAgentQueryResult> {
  const audit = await beginInvocation({
    prompt: text.length === 0 ? "(see attached image)" : text,
    surface: options.surface ?? "desktop",
    workspacePath: options.workspacePath ?? process.cwd(),
    dataDirectory,
    ...(options.caller === undefined ? {} : { caller: options.caller }),
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    ...(options.auditHome === undefined ? {} : { auditHome: options.auditHome }),
  });
  try {
    const result = await withMainAgentLock(dataDirectory, async () => {
      return runNativeMainAgentTurn({
        dataDirectory,
        text,
        source: options.source ?? "companion",
        ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
        ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
        ...(options.images === undefined ? {} : { images: options.images }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onMetadata: (metadata) => audit.note(metadata),
      });
    });
    if (shouldMine(text)) {
      try {
        const { createJournalStore } = await import("../core/sqlite-journal.ts");
        const { MemoryPipeline } = await import("../memory/memory-pipeline.ts");
        const { NativeMemoryWorker } = await import("../memory/native-memory-worker.ts");
        const { ConversationMemoryPipeline } = await import("../memory/conversation-memory-pipeline.ts");
        const journal = createJournalStore(dataDirectory);
        const conversationMemory = new ConversationMemoryPipeline(
          journal,
          new MemoryPipeline(
            journal,
            new NativeMemoryWorker({ dataDirectory }),
            { lockPath: join(dataDirectory, "memory-extraction-lock") },
          ),
        );
        await conversationMemory.record({
          session: "main-agent",
          turns: [{ at: new Date().toISOString(), speaker: "user", text }],
          objective: text,
        });
        (journal as { close?: () => void }).close?.();
      } catch {
        // Memory mining is asynchronous and must never delay or replace the reply.
        // 记忆提炼是异步增强，绝不能延迟或替换刚刚生成的回复。
      }
    }
    if (result.error === undefined) {
      await audit.complete(result);
    } else {
      await audit.fail(new Error(result.error));
    }
    return result;
  } catch (error: unknown) {
    await audit.fail(error);
    throw error;
  }
}
