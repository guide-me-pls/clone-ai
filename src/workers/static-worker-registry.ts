import type { AgentRegistry, RuntimeAdapter } from "../core/contracts.ts";

/**
 * The registry the Runtime dispatches through: adapters resolved once at
 * startup and addressed by agent id. It holds no authority of its own — an
 * adapter that is absent simply cannot be dispatched to.
 *
 * Runtime 派发时使用的注册表：启动时解析一次 Adapter，之后按 Agent ID 寻址。它自身不持有
 * 任何权限——不存在的 Adapter 就是无法被派发。
 */
export class StaticAgentRegistry implements AgentRegistry {
  readonly #agents: Map<string, RuntimeAdapter>;

  constructor(agents: RuntimeAdapter[]) {
    this.#agents = new Map(agents.map((agent) => [agent.id, agent]));
    if (this.#agents.size !== agents.length) {
      throw new Error("Agent identifiers must be unique.");
    }
  }

  get(agentId: string): RuntimeAdapter | undefined {
    return this.#agents.get(agentId);
  }

  list(): RuntimeAdapter[] {
    return [...this.#agents.values()];
  }
}
