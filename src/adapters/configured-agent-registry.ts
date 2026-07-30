import { join } from "node:path";

import type { AgentSetting } from "../settings/agent-settings.ts";
import { workCapabilitiesForRole } from "../agents/capabilities.ts";
import { DemoExecutionAdapter, StaticAgentRegistry } from "./demo-adapter.ts";
import { PiAgentAdapter, type PiToolName } from "./pi-agent-adapter.ts";

export interface ConfiguredAgentRegistryOptions {
  dataDirectory: string;
  workspacePath?: string;
}

/**
 * Provider bindings from local settings become concrete adapters here.
 * Codex and Claude remain deterministic adapters until their own integrations
 * are implemented; Pi is the first real execution provider.
 *
 * 本地 Settings 中的 Provider 配置会在这里变成具体 Adapter。Codex 与 Claude 在各自的
 * 真正集成完成前仍使用确定性的 Demo Adapter；Pi 是第一个真实执行 Provider。
 */
export function createConfiguredAgentRegistry(
  settings: AgentSetting[],
  options: ConfiguredAgentRegistryOptions,
): StaticAgentRegistry {
  const adapters = settings
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const workCapabilities = workCapabilitiesForRole(agent.role);
      if (agent.providerId !== "pi") {
        return new DemoExecutionAdapter(agent.id, agent.providerId, workCapabilities);
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
  return [];
}
