import type { AgentSetting } from "../settings/agent-settings.ts";
import { workCapabilitiesForRole } from "../agents/capabilities.ts";
import { StaticAgentRegistry } from "../agents/static-agent-registry.ts";
import { loadProviderRegistry } from "./built-in-providers.ts";
import type { OutcomeCatalog } from "../core/failure-analysis.ts";
import type { ProviderRegistry } from "./provider-registry.ts";

export interface ConfiguredAgentRegistryOptions {
  dataDirectory: string;
  workspacePath?: string;
  /** Optional already-loaded registry, mainly for extensions and tests. 可选的已加载 Registry。 */
  providers?: ProviderRegistry;
  /** Owner-editable diagnostic catalog passed to black-box providers. 传给黑盒 Provider 的所有者诊断目录。 */
  failureCatalog?: import("../core/failure-analysis.ts").OutcomeCatalog;
}

/**
 * Resolves settings through the JSON-backed Provider Registry. Production
 * loads user overrides before creating adapters; tests may inject a registry.
 * 通过 JSON-backed Provider Registry 解析设置。生产入口先加载用户覆盖再创建 Adapter；测试
 * 可以注入 Registry。
 */
export async function createConfiguredAgentRegistry(
  settings: AgentSetting[],
  options: ConfiguredAgentRegistryOptions,
): Promise<StaticAgentRegistry> {
  const providers = options.providers ?? await loadProviderRegistry(options.dataDirectory);
  const adapters = settings
    .filter((agent) => agent.enabled)
    .map((agent) => providers.createAdapter(agent.providerId, {
      agentId: agent.id,
      role: agent.role,
      workCapabilities: workCapabilitiesForRole(agent.role),
      dataDirectory: options.dataDirectory,
      workspacePath: options.workspacePath,
      failureCatalog: options.failureCatalog,
    }));
  return new StaticAgentRegistry(adapters);
}
