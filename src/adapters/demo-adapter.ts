import type { AgentRegistry, ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../core/contracts.ts";
import type { AgentSetting } from "../settings/agent-settings.ts";

/**
 * Deterministic agents make the orchestration semantics observable without
 * pretending that a model provider is wired in. The same interface is the
 * seam for Codex, Claude Code, Pi, and custom local workers.
 *
 * 确定性 Agent 能让编排语义可观察，而不假装已接入真实模型 Provider。同一接口是 Codex、
 * Claude Code、Pi 和自定义本地 Worker 的替换边界。
 */
export class DemoExecutionAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly providerId: string;
  readonly #workCapabilities: string[];

  constructor(id = "operator", providerId = "demo", workCapabilities: string[] = ["general"]) {
    this.id = id;
    this.providerId = providerId;
    this.#workCapabilities = [...workCapabilities];
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false,
      cancellation: false,
      approvalCallback: false,
      parallelAssignments: true,
      work: [...this.#workCapabilities],
      // The deterministic demo simulates external receipts on purpose. A real
      // provider may only declare "receipt" when a trusted runtime produced it.
      // 确定性 Demo 有意模拟外部 Receipt；真实 Provider 只有在 Receipt 由可信运行时
      // 产生时才可以声明该类型。
      evidenceKinds: ["artifact", "tool_result", "receipt", "test", "observation"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    const title = input.workOrder?.title ?? input.step.title;
    const risk = input.workOrder?.risk ?? input.step.risk;
    yield { type: "progress", message: `${this.providerId} is preparing: ${title}` };
    yield {
      type: "evidence",
      evidence: {
        kind: risk === "external_side_effect" || risk === "irreversible" ? "receipt" : "artifact",
        summary: `${title} produced a deterministic demo artifact through the ${this.providerId} role binding.`,
        locator: `demo://${input.run.id}/${input.step.id}/${input.workOrder?.id ?? this.id}`,
      },
    };
    yield {
      type: "completed",
      summary: input.workOrder !== undefined
        ? `${this.id} returned evidence for ${input.workOrder.id}.`
        : `${this.id} completed step ${input.step.id}.`,
    };
  }
}

/**
 * A small in-memory registry used only by the demo.
 * 仅供 Demo 使用的小型内存 Registry。
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

export function createDemoAgentRegistry(settings?: AgentSetting[]): StaticAgentRegistry {
  const enabledAgents = settings === undefined
    ? defaultAgentIds.map((id) => ({ id, providerId: "demo" }))
    : settings.filter((agent) => agent.enabled).map((agent) => ({ id: agent.id, providerId: agent.providerId }));
  return new StaticAgentRegistry(enabledAgents.map((agent) => (
    new DemoExecutionAdapter(agent.id, agent.providerId, capabilitiesForAgentId(agent.id))
  )));
}

const defaultAgentIds = ["direct-responder", "context-researcher", "draft-maker", "evidence-reviewer", "external-operator"];

function capabilitiesForAgentId(agentId: string): string[] {
  if (agentId === "context-researcher") return ["research", "filesystem_read"];
  if (agentId === "draft-maker") return ["drafting", "filesystem_read", "filesystem_write"];
  if (agentId === "evidence-reviewer") return ["review"];
  if (agentId === "external-operator") return ["external_action"];
  return ["direct_response"];
}
