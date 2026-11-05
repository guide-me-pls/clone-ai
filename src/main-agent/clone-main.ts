/**
 * clone-main entry: a persistent Main Agent on the Pi SDK.
 * clone-main 入口：Pi SDK 上的常驻 Main Agent。
 *
 * The agent carries the conversation, proposes work plans, requests approval
 * status, recalls memory, and inspects runs - all through proposal-only tools
 * whose other end is the Kernel. It has no built-in file, shell, or write
 * tools, mirroring the tool-free posture of the RPC adapter.
 * 该 Agent 负责对话、提案工作计划、查询审批状态、召回记忆与查看 Run——全部经由
 * 提案型工具，工具的另一端是 Kernel。它没有任何内置文件/Shell/写入工具，
 * 与 RPC 版 Adapter 的无工具姿态保持一致。
 *
 * Run: npm run main -- "<query>"
 * Session state persists under <dataDirectory>/pi-sessions/main-agent and can
 * be resumed with the same command (same cwd + session dir).
 * 会话状态持久化在 <dataDirectory>/pi-sessions/main-agent，相同命令可续跑。
 */
import { defaultLegacyDirectory, migrateLegacyCloneHome, prepareCloneHome, resolveClonePaths } from "../config/clone-home.ts";
import { createMainAgentSession } from "./session.ts";
import { recordPromptSnapshot } from "./prompt-snapshot.ts";
import { beginMainAgentTurn, finishMainAgentTurn, observeMainAgentSession } from "./turn-audit.ts";
import { collectSessionUsage, recordUsage } from "../observability/usage.ts";

const query = process.argv.slice(2).join(" ").trim();
if (query.length === 0) {
  console.error('Usage: npm run main -- "<query>"');
  process.exit(1);
}

// The CLI resolves the owner's home exactly as the daemon does, so running a
// query from a terminal and from the desktop reach the same state.
// CLI 与 Daemon 用完全相同的方式解析所有者主目录，因此从终端和桌面发起的查询
// 到达同一份状态。
const paths = resolveClonePaths();
await prepareCloneHome(paths);
await migrateLegacyCloneHome({
  legacyDirectory: defaultLegacyDirectory(paths.workspacePath),
  targetDirectory: paths.dataDirectory,
});
const { session, prompt } = await createMainAgentSession({ dataDirectory: paths.dataDirectory, query });

// The turn's inputs are recorded before the model sees them, so a failed run
// can be attributed to a prompt revision instead of guessed at.
// 本回合的输入在模型看到之前就被记录，因此失败的运行可以归因到某一版提示词，而不是靠猜。
const snapshot = await recordPromptSnapshot(paths.dataDirectory, prompt);
const sessionFile = session.sessionManager.getSessionFile();
const turn = await beginMainAgentTurn({
  dataDirectory: paths.dataDirectory,
  text: query,
  source: "main-cli",
  ...(sessionFile === undefined ? {} : { sessionFile }),
  ...(prompt.modelId === undefined ? {} : { modelId: prompt.modelId }),
  ...(prompt.provider === undefined ? {} : { provider: prompt.provider }),
  ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
  ...(snapshot === undefined ? {} : { promptMaterialHash: snapshot.materialHash }),
});
observeMainAgentSession(session, turn);
let reply = "";
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    reply += event.assistantMessageEvent.delta;
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

const started = Date.now();
const beforeStats = (() => {
  try {
    return session.getSessionStats();
  } catch {
    return undefined;
  }
})();
let turnStatus: "completed" | "failed" = "completed";
let turnError: string | undefined;
try {
  await session.prompt(query);
  process.stdout.write("\n");
} catch (error: unknown) {
  turnStatus = "failed";
  turnError = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  const usage = collectSessionUsage(session, Date.now() - started, beforeStats);
  try {
    await recordUsage(paths.dataDirectory, { ...usage, turnId: turn.turnId });
  } catch {
    // Usage is telemetry; losing it must not hide the reply or the error.
    // 用量是遥测；丢掉它不能盖住回复或错误。
  }
  await finishMainAgentTurn(turn, {
    status: turnStatus,
    reply,
    ...(turnError === undefined ? {} : { error: turnError }),
    usage: { ...usage, turnId: turn.turnId },
  });
  session.dispose();
}
