import type { AgentRegistry, RuntimeAdapter, SubagentWorkOrder } from "../core/contracts.ts";

/**
 * The planner asks for capabilities; this dispatcher chooses an installed
 * adapter. A preferred agent id is only a routing hint and never bypasses the
 * capability contract.
 *
 * Planner 提出所需能力；Dispatcher 再选择已安装的 Adapter。首选 Agent ID
 * 仅是路由提示，绝不能绕过能力合同。
 */
export class CapabilityDispatcher {
  readonly #registry: AgentRegistry;

  constructor(registry: AgentRegistry) {
    this.#registry = registry;
  }

  async select(order: SubagentWorkOrder): Promise<RuntimeAdapter> {
    // Explicit selection is checked, not blindly trusted. If no agent is
    // named, the first compatible installed adapter is used for now.
    // 显式指定的 Agent 也必须经过检查，不能被盲目信任；未指定时，当前暂时选择第一个
    // 已安装且能力匹配的 Adapter，未来再加入成本、健康度和成功率的路由策略。
    if (order.agentId !== undefined) {
      const preferred = this.#registry.get(order.agentId);
      if (preferred === undefined) {
        throw new Error(`No adapter is registered for preferred agent ${order.agentId}.`);
      }
      await assertAdapterCanExecute(preferred, order);
      return preferred;
    }

    for (const adapter of this.#registry.list()) {
      if (await adapterSupports(adapter, order.requiredCapabilities)) {
        return adapter;
      }
    }

    throw new Error(
      `No registered adapter satisfies work order ${order.id}: ${order.requiredCapabilities.join(", ")}.`,
    );
  }
}

async function assertAdapterCanExecute(adapter: RuntimeAdapter, order: SubagentWorkOrder): Promise<void> {
  const capabilities = await adapter.capabilities();
  const missing = order.requiredCapabilities.filter((capability) => !capabilities.work.includes(capability));
  if (missing.length > 0) {
    throw new Error(
      `Adapter ${adapter.id} cannot execute work order ${order.id}; missing capabilities: ${missing.join(", ")}.`,
    );
  }
}

async function adapterSupports(adapter: RuntimeAdapter, required: readonly string[]): Promise<boolean> {
  const capabilities = await adapter.capabilities();
  return required.every((capability) => capabilities.work.includes(capability));
}
