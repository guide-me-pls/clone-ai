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
import { join } from "node:path";

import { createMainAgentSession } from "./session.ts";

const query = process.argv.slice(2).join(" ").trim();
if (query.length === 0) {
  console.error('Usage: npm run main -- "<query>"');
  process.exit(1);
}

const dataDirectory = process.env.CLONE_AI_DATA_DIR ?? join(process.cwd(), ".clone-ai");
const { session } = await createMainAgentSession({ dataDirectory });

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt(query);
  process.stdout.write("\n");
} finally {
  session.dispose();
}
