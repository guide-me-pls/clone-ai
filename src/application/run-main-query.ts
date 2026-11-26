/**
 * One companion-facing query through the Main Agent.
 *
 * There is one runtime: the in-process native loop. It dispatches work to the
 * Kernel and assembles context; it never executes. Removing the Pi branch means
 * a missing endpoint fails clearly instead of silently falling back to an SDK.
 *
 * 面向 companion 的一次 Main Agent 查询。
 *
 * 只有一个运行时：进程内的原生循环。它向 Kernel 派发工作并组装上下文，绝不执行。
 * 移除 Pi 分支意味着端点缺失会清晰失败，而不是静默回退到某个 SDK。
 */
import type { Run } from "../core/contracts.ts";
import { attachmentManifest, type DocumentAttachment } from "../main-agent/attachments.ts";
import { conversationIdOf } from "../main-agent/conversation.ts";
import { withMainAgentSlot } from "../main-agent/main-agent-slots.ts";
import { withMainAgentLock } from "../main-agent/prompt-lock.ts";
import { runNativeMainAgentTurn, type NativeToolEvent } from "../main-agent/native-runtime.ts";
import { skillRootsFor } from "../skills/skill-loader.ts";
import type { OwnerQuestionBroker } from "../main-agent/owner-questions.ts";
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
   * Text documents the owner attached to this turn. Their bodies reach the
   * model in this turn only; the ledger keeps a manifest, not the contents.
   * 所有者在本回合附带的文本文档。正文只在本回合交给模型；台账只记清单，不记内容。
   */
  documents?: DocumentAttachment[];
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
  source?: "cli" | "main-cli" | "companion" | "server" | "whatsapp" | "unknown";
  /** Cancels the model call and every in-flight tool. 取消模型调用与所有在途工具。 */
  signal?: AbortSignal;
  /** Progress for each tool call, for a live timeline. 每次工具调用的进度，用于实时时间线。 */
  onToolEvent?: (event: NativeToolEvent) => void;
  /**
   * Called when the turn is waiting for a capacity slot. A streamed surface can
   * open its response and show the wait instead of looking frozen.
   * 回合等待容量槽位时调用。流式界面可以打开响应并显示等待状态，而不是看起来卡死。
   */
  onQueued?: (info: { limit: number }) => void;
  /**
   * The task this turn belongs to. Omitted means the owner's main conversation;
   * different ids carry different histories and do not block each other.
   * 本回合所属的任务。缺省表示所有者的主对话；不同 id 携带不同历史，互不阻塞。
   */
  conversationId?: string;
  /**
   * The model and effort the owner picked in the composer for this turn.
   * Omitted means the persisted Settings default; other surfaces pass neither.
   * 所有者在输入框中为本回合选择的模型与强度。缺省表示设置里的默认值；其他入口都不传。
   */
  model?: string;
  effort?: string;
  /** The owner-question broker; without it the Main Agent cannot ask with buttons. 所有者提问经纪人；没有它 Main Agent 无法用按钮提问。 */
  questions?: OwnerQuestionBroker;
}

export async function runMainAgentQuery(
  dataDirectory: string,
  text: string,
  options: MainAgentQueryOptions = {},
): Promise<MainAgentQueryResult> {
  const images = options.images ?? [];
  const documents = options.documents ?? [];
  const manifest = attachmentManifest(documents);
  // The ledger records what the owner typed and which documents came with it,
  // never the document bodies: a later turn must not replay 100k characters it
  // never asked to see.
  // 台账记录所有者输入的正文与随行文档清单，绝不记录文档正文：之后的回合不应重放它
  // 从未要求看到的 100k 字符。
  const basePrompt = text.length > 0
    ? text
    : documents.length > 0 ? "" : images.length > 0 ? "(see attached image)" : "(empty message)";
  const auditedPrompt = [basePrompt, manifest].filter((part) => part.length > 0).join("\n\n");
  const audit = await beginInvocation({
    prompt: auditedPrompt,
    surface: options.surface ?? "desktop",
    workspacePath: options.workspacePath ?? process.cwd(),
    dataDirectory,
    ...(options.caller === undefined ? {} : { caller: options.caller }),
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    ...(options.auditHome === undefined ? {} : { auditHome: options.auditHome }),
  });
  const conversationId = conversationIdOf(options.conversationId);
  try {
    // The conversation lock fails fast on a collision inside one task; the
    // slot pool queues across tasks, because a busy machine is not a mistake
    // the caller can fix. Lock first so a duplicate prompt never waits for a
    // slot it could not use.
    // 对话锁在同一任务内碰撞时立即失败；槽位池在不同任务间排队，因为机器忙不是调用方能
    // 修正的错误。先拿锁，使重复的 prompt 不会去等一个它用不上的槽位。
    const result = await withMainAgentLock(dataDirectory, () => withMainAgentSlot(
      dataDirectory,
      () => runNativeMainAgentTurn({
        dataDirectory,
        text,
        ledgerText: auditedPrompt,
        source: options.source ?? "companion",
        conversationId,
        // The workspace is what the Main Agent's project instructions, its
        // briefing and its sense of "what can a worker see" are built from.
        // Omitting it used the daemon's process.cwd(): a request about a
        // project in ~/work was answered while reading this repository's rules.
        // 工作区决定了 Main Agent 的项目指令、简报，以及"Worker 能看到什么"。
        // 省略它就等于用守护进程的 process.cwd()：一个关于 ~/work 项目的问题，
        // 回答时读的却是本仓库的规则。
        ...(options.workspacePath === undefined ? {} : { cwd: options.workspacePath }),
        // The Main Agent gets the same skill roots the settings page scans.
        // Without them the listing and the Skill(...) tools never reach a turn.
        // Main Agent 拿到与设置页相同的技能根目录；没有它，技能列表与 Skill(...) 工具
        // 永远到不了一个回合里。
        skillRoots: skillRootsFor(dataDirectory, options.workspacePath ?? process.cwd()),
        ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
        ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
        ...(options.images === undefined ? {} : { images: options.images }),
        ...(options.documents === undefined ? {} : { documents: options.documents }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onToolEvent === undefined ? {} : { onToolEvent: options.onToolEvent }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.questions === undefined ? {} : { questions: options.questions }),
        onMetadata: (metadata) => audit.note(metadata),
      }),
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onQueued === undefined
          ? {}
          : { onWait: (snapshot: { limit: number }) => options.onQueued?.({ limit: snapshot.limit }) }),
      },
    ), conversationId);
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