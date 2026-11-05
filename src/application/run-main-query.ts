/**
 * One companion-facing query through the Main Agent. The session is the
 * persistent clone-main conversation; the reply is the agent's words, and the
 * accepted runs are read back from the Kernel journal — the caller gets both,
 * clearly separated, because words are not evidence.
 * 面向 companion 的一次 Main Agent 查询。会话即持久的 clone-main 对话；reply 是 Agent
 * 的话语，acceptedRuns 则从 Kernel Journal 读回——两者分开返回，因为话语不是证据。
 */
import { basename, join } from "node:path";

import type { Run } from "../core/contracts.ts";
import type { ConversationMemoryPipeline } from "../memory/conversation-memory-pipeline.ts";
import { shouldMine } from "../memory/mining-policy.ts";
import { createKernelRuntimeSession } from "../main-agent/tools/kernel-tools.ts";
import { createMainAgentSession } from "../main-agent/session.ts";
import { recordPromptSnapshot } from "../main-agent/prompt-snapshot.ts";
import { withMainAgentLock } from "../main-agent/prompt-lock.ts";
import { collectSessionUsage, recordUsage } from "../observability/usage.ts";
import { beginInvocation, type InvocationCaller, type InvocationSurface } from "../audit/invocation-ledger.ts";

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
    const before = new Set((await currentRuns(dataDirectory)).map((run) => run.id));

    const { session, prompt } = await createMainAgentSession({ dataDirectory, query: text });
    // Recorded before the prompt, not after: a crash mid-turn must still leave
    // the exact inputs behind, because those are what a later replay needs.
    // 在 prompt 之前记录而不是之后：中途崩溃也必须留下确切的输入，因为那正是日后回放所需的。
    await recordPromptSnapshot(
      dataDirectory,
      prompt,
      options.turnId === undefined ? {} : { turnId: options.turnId },
    );
    const sessionFile = session.sessionManager.getSessionFile();
    audit.note({
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(prompt.modelId === undefined ? {} : { modelId: prompt.modelId }),
      ...(prompt.provider === undefined ? {} : { provider: prompt.provider }),
      ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
    });
    let conversationMemory: ConversationMemoryPipeline | undefined;
    try {
      const { createJournalStore } = await import("../core/sqlite-journal.ts");
      const { MemoryPipeline } = await import("../memory/memory-pipeline.ts");
      const { AgentMemoryWorker } = await import("../memory/agent-memory-worker.ts");
      const { ConversationMemoryPipeline } = await import("../memory/conversation-memory-pipeline.ts");
      if (shouldMine(text)) {
        const journal = createJournalStore(dataDirectory);
        conversationMemory = new ConversationMemoryPipeline(
          journal,
          new MemoryPipeline(journal, new AgentMemoryWorker({}), { lockPath: join(dataDirectory, "memory-extraction-lock") }),
        );
      }
    } catch {
      // Mining is optional; a missing mining path must not fail the reply.
      // 提炼是可选的；提炼路径缺失不能导致回复失败。
    }
    let reply = "";
    // Declared before the subscription so the callback never touches a
    // binding that is still in its temporal dead zone.
    // 在订阅之前声明，避免回调触碰仍处于暂时性死区的绑定。
    let lastError: string | undefined;
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const assistant = event.message as {
          stopReason?: string;
          errorMessage?: string;
        };
        if (assistant.stopReason === "error") {
          lastError = assistant.errorMessage?.trim() || "The model ended the turn with an error.";
        } else if (assistant.stopReason === "aborted") {
          lastError = "The model call was interrupted before it completed.";
        }
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        reply += delta;
        // A failing sink must not abort the run: the owner would lose the work
        // over a broken pipe to a window they already closed.
        // 接收方出错不能中断本次运行：否则所有者会因为一个已关闭窗口的断开管道而丢掉工作。
        try {
          options.onDelta?.(delta);
        } catch {
          // The transport is gone; the reply is still assembled and returned.
          // 传输已断开；回复仍会被组装并返回。
        }
      }
    });
    const started = Date.now();
    const beforeStats = readSessionStats(session);
    try {
      await session.prompt(text.length === 0 ? "(see attached image)" : text, options.images === undefined || options.images.length === 0 ? undefined : { images: options.images });
    } finally {
      try {
        await recordUsage(dataDirectory, collectSessionUsage(session, Date.now() - started, beforeStats));
      } catch {
        // Usage is telemetry; losing it must not hide the reply or the error.
        // 用量是遥测；丢掉它不能盖住回复或错误。
      }
      session.dispose();
    }
    // Mining runs after the reply: the owner's turn is already answered, and a
    // slow or broken miner must never delay or alter it.
    // 提炼在回复之后运行：所有者这一回合已经得到回答，慢或坏掉的提炼器绝不能推迟或改变它。
    if (conversationMemory !== undefined) {
      await conversationMemory.record({
        session: basename(sessionFile ?? "main-agent"),
        turns: [{ at: new Date().toISOString(), speaker: "user", text }],
        objective: text,
      }).catch(() => undefined);
    }

    const newRuns = (await currentRuns(dataDirectory))
      .filter((run) => !before.has(run.id))
      .map((run) => ({ id: run.id, status: run.status, planId: run.planId }));
    return {
      reply: reply.trim(),
      ...(reply.trim().length === 0 && lastError !== undefined ? { error: lastError } : {}),
      newRuns,
    };
    });
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

async function currentRuns(dataDirectory: string): Promise<Run[]> {
  const { runtime, close } = await createKernelRuntimeSession(dataDirectory);
  try { return runtime.listRuns(); } finally { close(); }
}

function readSessionStats(session: { getSessionStats(): { tokens: { input: number; output: number; total: number }; cost: number } }) {
  try {
    return session.getSessionStats();
  } catch {
    return undefined;
  }
}
