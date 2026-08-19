import { join } from "node:path";

import { ClaudeAgentSdkAdapter } from "./claude-agent-sdk-adapter.ts";
import { CodingCliAdapter } from "./coding-cli-adapter.ts";
import { PiAgentAdapter } from "./pi-agent-adapter.ts";
import { ProviderRegistry, type ProviderDefinition } from "./provider-registry.ts";

/**
 * The providers Clone AI ships with. Each one is an ordinary registration, so
 * a third-party provider has exactly the same standing as a built-in one.
 * Clone AI 自带的 Provider。每一个都只是一次普通注册，因此第三方 Provider 与内建
 * Provider 拥有完全相同的地位。
 */
export const codexCliProvider: ProviderDefinition = {
  id: "codex-cli",
  label: "Codex CLI",
  createAdapter: ({ agentId, workCapabilities }) => new CodingCliAdapter({
    id: agentId,
    providerId: "codex-cli",
    workCapabilities,
  }),
};

export const claudeCodeProvider: ProviderDefinition = {
  id: "claude-code",
  label: "Claude Code",
  createAdapter: ({ agentId, workCapabilities }) => (
    // CLONE_AI_CLAUDE_TRANSPORT=sdk routes Claude Code through its official SDK
    // (typed events) instead of parsed CLI stdout. Same adapter contract and
    // the same authority either way, so the Kernel is unaffected.
    // CLONE_AI_CLAUDE_TRANSPORT=sdk 让 Claude Code 走官方 SDK（有类型事件）而不是解析
    // CLI stdout。两种方式的 Adapter 合约与权限边界相同，Kernel 不受影响。
    process.env.CLONE_AI_CLAUDE_TRANSPORT === "sdk"
      ? new ClaudeAgentSdkAdapter({ id: agentId, workCapabilities })
      : new CodingCliAdapter({ id: agentId, providerId: "claude-code", workCapabilities })
  ),
};

export const piProvider: ProviderDefinition = {
  id: "pi",
  label: "Pi",
  // Pi's built-in file tools accept absolute paths, so it runs tool-free until
  // it calls back into Clone AI's workspace-bounded Tool Runtime.
  // Pi 内建文件 Tool 接受绝对路径，因此在它回调 Clone AI 受 Workspace 约束的 Tool
  // Runtime 之前，只以无 Tool 方式运行。
  supportedRoles: ["direct", "review"],
  roleRestrictionReason:
    "Pi is currently limited to tool-free direct and review roles and cannot be assigned to this executor.",
  createAdapter: ({ agentId, workCapabilities, dataDirectory, workspacePath }) => new PiAgentAdapter({
    id: agentId,
    cwd: workspacePath,
    sessionDirectory: join(dataDirectory, "pi-sessions"),
    tools: [],
    workCapabilities,
  }),
};

export function createBuiltInProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(codexCliProvider)
    .register(claudeCodeProvider)
    .register(piProvider);
}

/**
 * The process-wide registry. Host applications extend it at startup:
 * `builtInProviders.register(myProvider)` — no Clone AI source changes.
 * 进程级 Registry。宿主应用在启动时扩展它：`builtInProviders.register(myProvider)`
 * ——无需改动 Clone AI 的源码。
 */
export const builtInProviders = createBuiltInProviderRegistry();
