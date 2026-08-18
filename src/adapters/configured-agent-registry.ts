import { join } from "node:path";

import type { AgentSetting } from "../settings/agent-settings.ts";
import { workCapabilitiesForRole } from "../agents/capabilities.ts";
import { StaticAgentRegistry } from "./demo-adapter.ts";
import { CodingCliAdapter } from "./coding-cli-adapter.ts";
import { PiAgentAdapter, type PiToolName } from "./pi-agent-adapter.ts";

export interface ConfiguredAgentRegistryOptions {
  dataDirectory: string;
  workspacePath?: string;
}

/**
 * Provider bindings from local settings become concrete adapters here.
 * Codex and Claude run behind the supervised CodingCliAdapter boundary;
 * Pi remains limited to tool-free direct and review roles.
 *
 * 本地 Settings 中的 Provider 配置会在这里变成具体 Adapter。Codex 与 Claude 通过受监督的
 * CodingCliAdapter 边界运行；Pi 目前仍限于无 Tool 的 direct 与 review 角色。
 */
export function createConfiguredAgentRegistry(
  settings: AgentSetting[],
  options: ConfiguredAgentRegistryOptions,
): StaticAgentRegistry {
  const adapters = settings
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const workCapabilities = workCapabilitiesForRole(agent.role);
      if (agent.providerId === "codex-cli" || agent.providerId === "claude-code") {
        return new CodingCliAdapter({ id: agent.id, providerId: agent.providerId, workCapabilities });
      }
      if (agent.role !== "direct" && agent.role !== "review") {
        throw new Error(
          `Agent ${agent.id} cannot use Pi yet; the first Pi integration is limited to tool-free direct and review roles.`,
        );
      }
      return new PiAgentAdapter({
        id: agent.id,
        cwd: options.workspacePath,
        sessionDirectory: join(options.dataDirectory, "pi-sessions"),
        tools: toolsForRole(agent.role),
        workCapabilities,
      });
    });
  return new StaticAgentRegistry(adapters);
}

function toolsForRole(_role: AgentSetting["role"]): PiToolName[] {
  // Pi's built-in file tools accept absolute paths. Until Pi calls back into
  // Clone AI's workspace-bounded Tool Runtime, this adapter receives no tools.
  // Pi 内建文件 Tool 接受绝对路径。在 Pi 通过 Clone AI 受 Workspace 限制的 Tool Runtime
  // 回调前，此 Adapter 不授予任何 Tool。
  return [];
}
