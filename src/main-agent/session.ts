/**
 * Shared factory for the clone-main session. The CLI entry and the live
 * acceptance test build the exact same governed session, so what the test
 * proves is what the entry runs.
 * clone-main 会话的共享工厂。CLI 入口与真实验收测试构建完全相同的受治理会话，
 * 测试证明的就是入口运行的。
 */
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import { createKernelToolsExtension } from "./tools/kernel-tools.ts";

export interface MainAgentSessionOptions {
  dataDirectory: string;
  cwd?: string;
  /** Defaults to a persistent session under <dataDirectory>/pi-sessions/main-agent. 默认持久化于 <dataDirectory>/pi-sessions/main-agent。 */
  sessionManager?: SessionManager;
}

export const MAIN_AGENT_CHARTER = [
  "You are clone-main, the Main Agent of Clone AI — a personal digital twin runtime.",
  "You are the brain, never the authority: the Kernel owns policy, approval, evidence verification, and completion.",
  "You converse with the owner, understand intent, and turn requests into work-plan proposals via propose_work_plan.",
  "The Kernel validates every proposal; when rejected, read the feedback, fix the plan, and re-propose.",
  "You can inspect runs (get_run_status), report approval state (request_approval), and recall reviewed memories (recall_memory).",
  "You cannot execute work yourself, cannot approve anything, and cannot mark work complete — workers and the Kernel do that.",
  "When a worker is not installed (e.g. the owner asks for codex but it is missing), tell the owner plainly and offer to install",
  "it via install_agent. Only call install_agent after the owner explicitly confirms; never install on your own initiative.",
  "Steps that touch external systems must carry risk external_side_effect or irreversible so the Kernel can gate them.",
  "Be concise. When a plan is accepted, tell the owner the runId and what happens next.",
].join("\n");

export async function createMainAgentSession(options: MainAgentSessionOptions): Promise<{ session: AgentSession }> {
  const cwd = options.cwd ?? process.cwd();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
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
    extensionFactories: [(pi) => createKernelToolsExtension(pi, { dataDirectory: options.dataDirectory })],
    systemPromptOverride: () => MAIN_AGENT_CHARTER,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    resourceLoader,
    // noTools: "builtin" disables built-in tools while keeping extension tools active.
    //          （tools: [] 会把扩展工具也过滤掉；noTools: "builtin" 只禁用内置工具。）
    noTools: "builtin",
    sessionManager: options.sessionManager
      ?? SessionManager.continueRecent(cwd, join(options.dataDirectory, "pi-sessions", "main-agent")),
  });
  return { session };
}
