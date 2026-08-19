import type { AgentSetting } from "../settings/agent-settings.ts";
import { workCapabilitiesForRole } from "../agents/capabilities.ts";
import { StaticAgentRegistry } from "../agents/static-agent-registry.ts";
import { builtInProviders } from "./built-in-providers.ts";
import type { ProviderRegistry } from "./provider-registry.ts";

export interface ConfiguredAgentRegistryOptions {
  dataDirectory: string;
  workspacePath?: string;
  /** Defaults to the built-in providers; pass an extended registry to add more. 默认使用内建 Provider；传入扩展后的 Registry 即可增加。 */
  providers?: ProviderRegistry;
}

/**
 * Provider bindings from local settings become concrete adapters by lookup,
 * not by a dispatch branch: every provider — built-in or third-party — is
 * created through the same registry, so integrating another coding agent
 * never edits this file.
 *
 * 本地 Settings 中的 Provider 绑定通过查表变成具体 Adapter，而不是分发分支：
 * 每个 Provider（内建或第三方）都由同一个 Registry 创建，因此接入另一个 Coding Agent
 * 永远不需要修改本文件。
 */
export function createConfiguredAgentRegistry(
  settings: AgentSetting[],
  options: ConfiguredAgentRegistryOptions,
): StaticAgentRegistry {
  const providers = options.providers ?? builtInProviders;
  const adapters = settings
    .filter((agent) => agent.enabled)
    .map((agent) => providers.createAdapter(agent.providerId, {
      agentId: agent.id,
      role: agent.role,
      workCapabilities: workCapabilitiesForRole(agent.role),
      dataDirectory: options.dataDirectory,
      workspacePath: options.workspacePath,
    }));
  return new StaticAgentRegistry(adapters);
}
