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
 * Run: node --experimental-strip-types src/main-agent/clone-main.ts "<query>"
 * Session state persists under <dataDirectory>/pi-sessions/main-agent and can
 * be resumed with the same command (same cwd + session dir).
 * 会话状态持久化在 <dataDirectory>/pi-sessions/main-agent，相同命令可续跑。
 */
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { createKernelToolsExtension } from "./kernel-tools.ts";

const query = process.argv.slice(2).join(" ").trim();
if (query.length === 0) {
  console.error('Usage: node --experimental-strip-types src/main-agent/clone-main.ts "<query>"');
  process.exit(1);
}

const dataDirectory = process.env.CLONE_AI_DATA_DIR ?? join(process.cwd(), ".clone-ai");
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  // Discovery is an ungoverned injection channel. The Main Agent loads only
  // what is explicitly passed here — the same discipline as the RPC adapter's
  // --no-extensions/--no-skills/--no-context-files flags.
  // 自动发现是不受治理的注入通道。Main Agent 只加载这里显式传入的东西——与 RPC Adapter 的
  // --no-extensions/--no-skills/--no-context-files 同一纪律。
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  extensionFactories: [(pi) => createKernelToolsExtension(pi, { dataDirectory })],
  systemPromptOverride: () => [
    "You are clone-main, the Main Agent of Clone AI — a personal digital twin runtime.",
    "You are the brain, never the authority: the Kernel owns policy, approval, evidence verification, and completion.",
    "You converse with the owner, understand intent, and turn requests into work-plan proposals via propose_work_plan.",
    "The Kernel validates every proposal; when rejected, read the feedback, fix the plan, and re-propose.",
    "You can inspect runs (get_run_status), report approval state (request_approval), and recall reviewed memories (recall_memory).",
    "You cannot execute work yourself, cannot approve anything, and cannot mark work complete — workers and the Kernel do that.",
    "Steps that touch external systems must carry risk external_side_effect or irreversible so the Kernel can gate them.",
    "Be concise. When a plan is accepted, tell the owner the runId and what happens next.",
  ].join("\n"),
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  resourceLoader,
  // noTools: "builtin" disables built-in tools while keeping extension tools active.
  //          （tools: [] 会把扩展工具也过滤掉；noTools: "builtin" 只禁用内置工具。）
  noTools: "builtin",
  // continueRecent: resume the most recent Main Agent session, or start a new one.
  // continueRecent：续跑最近的 Main Agent 会话；没有则新建。
  sessionManager: SessionManager.continueRecent(process.cwd(), join(dataDirectory, "pi-sessions", "main-agent")),
});

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
