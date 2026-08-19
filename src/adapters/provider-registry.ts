import type { RuntimeAdapter } from "../core/contracts.ts";
import type { OutcomeCatalog } from "../core/failure-analysis.ts";
import type { AgentRole } from "../settings/agent-settings.ts";

export interface ProviderAdapterInput {
  /** Agent id from settings; becomes the adapter's identity. 来自设置的 Agent ID；成为 Adapter 的身份。 */
  agentId: string;
  role: AgentRole;
  workCapabilities: string[];
  dataDirectory: string;
  workspacePath?: string;
  /** Owner-editable diagnostic catalog. 所有者可编辑的诊断目录。 */
  failureCatalog?: OutcomeCatalog;
}

export interface ProviderDefinition {
  /** Stable id stored in settings, e.g. "claude-code". 存入设置的稳定 ID，例如 "claude-code"。 */
  id: string;
  /** Human label for settings UIs. 面向设置界面的可读名称。 */
  label: string;
  /**
   * Roles this provider may serve. Omit to allow every role. A provider that
   * is deliberately limited (Pi runs tool-free today) states that here instead
   * of hiding the rule inside the registry.
   * 该 Provider 可以承担的角色；省略表示不限。刻意受限的 Provider（Pi 目前无 Tool）
   * 在这里声明，而不是把规则藏在 Registry 里。
   */
  supportedRoles?: readonly AgentRole[];
  /** Why a role is refused, shown to the owner. 拒绝某个角色的原因，展示给所有者。 */
  roleRestrictionReason?: string;
  createAdapter(input: ProviderAdapterInput): RuntimeAdapter;
}

/**
 * The open extension point for execution providers. Clone AI ships built-in
 * providers through exactly this interface, so integrating another coding
 * agent means registering a definition — never editing the Kernel, the
 * settings union, or a dispatch branch.
 *
 * 执行 Provider 的开放扩展点。Clone AI 自带的 Provider 也完全走这个接口，因此接入另一个
 * Coding Agent 只需注册一份定义——不用改 Kernel、不用改设置里的联合类型、不用加分发分支。
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderDefinition>();

  register(definition: ProviderDefinition): this {
    if (this.#providers.has(definition.id)) {
      throw new Error(`Provider ${definition.id} is already registered.`);
    }
    this.#providers.set(definition.id, definition);
    return this;
  }

  has(providerId: string): boolean {
    return this.#providers.has(providerId);
  }

  get(providerId: string): ProviderDefinition | undefined {
    return this.#providers.get(providerId);
  }

  list(): ProviderDefinition[] {
    return [...this.#providers.values()];
  }

  ids(): string[] {
    return [...this.#providers.keys()];
  }

  /**
   * Role support is a provider's own declaration, so an unsupported pairing
   * fails with the provider's stated reason instead of a hardcoded message.
   * 角色支持是 Provider 自己的声明，因此不支持的组合会带着该 Provider 声明的原因失败，
   * 而不是一句写死的提示。
   */
  supportsRole(providerId: string, role: AgentRole): boolean {
    const definition = this.#providers.get(providerId);
    if (definition === undefined) return false;
    return definition.supportedRoles === undefined || definition.supportedRoles.includes(role);
  }

  createAdapter(providerId: string, input: ProviderAdapterInput): RuntimeAdapter {
    const definition = this.#providers.get(providerId);
    if (definition === undefined) {
      throw new Error(
        `Unknown execution provider "${providerId}". Registered providers: ${this.ids().join(", ") || "none"}.`,
      );
    }
    if (!this.supportsRole(providerId, input.role)) {
      throw new Error(
        definition.roleRestrictionReason
          ?? `Provider ${providerId} does not support the ${input.role} role.`,
      );
    }
    return definition.createAdapter(input);
  }
}
