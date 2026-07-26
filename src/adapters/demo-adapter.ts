import type { AgentRegistry, ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../core/contracts.ts";
import type { AgentSetting } from "../settings/agent-settings.ts";

/**
 * Deterministic agents make the orchestration semantics observable without
 * pretending that a model provider is wired in. The same interface is the
 * seam for Codex, Claude Code, Pi, and custom local workers.
 */
export class DemoExecutionAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly #providerId: string;

  constructor(id = "operator", providerId = "demo") {
    this.id = id;
    this.#providerId = providerId;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    const title = input.workOrder?.title ?? input.step.title;
    yield { type: "progress", message: `${this.#providerId} is preparing: ${title}` };
    yield {
      type: "evidence",
      evidence: {
        kind: "artifact",
        summary: `${title} produced a deterministic demo artifact through the ${this.#providerId} role binding.`,
        locator: `demo://${input.run.id}/${input.step.id}/${input.workOrder?.id ?? this.id}`,
      },
    };
    if (input.workOrder !== undefined) {
      yield { type: "completed", summary: `${this.id} returned evidence for ${input.workOrder.id}.` };
    }
  }
}

/** A small in-memory registry used only by the demo. */
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
}

export function createDemoAgentRegistry(settings?: AgentSetting[]): StaticAgentRegistry {
  const enabledAgents = settings === undefined
    ? defaultAgentIds.map((id) => ({ id, providerId: "demo" }))
    : settings.filter((agent) => agent.enabled).map((agent) => ({ id: agent.id, providerId: agent.providerId }));
  return new StaticAgentRegistry(enabledAgents.map((agent) => new DemoExecutionAdapter(agent.id, agent.providerId)));
}

const defaultAgentIds = ["direct-responder", "context-researcher", "draft-maker", "evidence-reviewer", "external-operator"];
