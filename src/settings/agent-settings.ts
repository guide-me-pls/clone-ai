import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AgentRole = "direct" | "research" | "draft" | "review" | "external";
export type ProviderId = "codex-cli" | "claude-code" | "pi";

export interface AgentSetting {
  id: string;
  title: string;
  role: AgentRole;
  description: string;
  purpose: string;
  providerId: ProviderId;
  enabled: boolean;
  required?: boolean;
}

export interface CloneSettings {
  agents: AgentSetting[];
}

const DEFAULT_AGENTS: AgentSetting[] = [
  {
    id: "direct-responder",
    title: "直接执行器",
    role: "direct",
    description: "处理无需拆分的本地请求。",
    purpose: "让简单问题不被不必要地拆成子任务。",
    providerId: "codex-cli",
    enabled: true,
    required: true,
  },
  {
    id: "context-researcher",
    title: "上下文研究员",
    role: "research",
    description: "收集约束、已有信息和待确认事项。",
    purpose: "用于调研、比较、分析和需要先理解背景的任务。",
    providerId: "claude-code",
    enabled: true,
  },
  {
    id: "draft-maker",
    title: "草拟与交付 Agent",
    role: "draft",
    description: "把上下文转化为可编辑的本地交付物。",
    purpose: "用于计划、文档、代码、邮件和其他可回退产物。",
    providerId: "codex-cli",
    enabled: true,
  },
  {
    id: "evidence-reviewer",
    title: "证据复核员",
    role: "review",
    description: "检查计划、产物和证据是否足以支持下一步。",
    purpose: "用于复杂任务和外部动作前的独立复核。",
    providerId: "pi",
    enabled: true,
  },
  {
    id: "external-operator",
    title: "外部执行 Agent",
    role: "external",
    description: "执行会影响外部世界的最后一步。",
    purpose: "用于发送、发布、提交、预约或购买；始终逐步等待你的确认。",
    providerId: "codex-cli",
    enabled: true,
  },
];

/**
 * Return a fresh default catalog so callers never mutate the module-level
 * settings. The catalog is planning metadata, not an execution grant.
 *
 * 返回一份全新的默认 Agent 目录，避免调用方修改模块级设置。这个目录只是规划元数据，
 * 不是执行授权。
 */
export function defaultAgentSettings(): AgentSetting[] {
  return DEFAULT_AGENTS.map((agent) => ({ ...agent }));
}

export class AgentSettingsStore {
  readonly #path: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async get(): Promise<CloneSettings> {
    try {
      const source = await readFile(this.#path, "utf8");
      return normalize(JSON.parse(source) as Partial<CloneSettings>);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return { agents: defaultAgentSettings() };
      }
      throw error;
    }
  }

  async updateAgent(id: string, update: { enabled?: boolean; providerId?: ProviderId }): Promise<CloneSettings> {
    const current = await this.get();
    const agent = current.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) {
      throw new Error("The requested agent setting does not exist.");
    }
    if (agent.required && update.enabled === false) {
      throw new Error("The direct executor is required for local requests.");
    }
    if (update.providerId !== undefined && !providerIds.has(update.providerId)) {
      throw new Error("The requested agent provider is not supported.");
    }
    if (update.providerId !== undefined && !providerIsAllowedForRole(update.providerId, agent.role)) {
      throw new Error("Pi is currently limited to tool-free direct and review roles and cannot be assigned to this executor.");
    }
    const next = {
      agents: current.agents.map((candidate) => candidate.id === id ? { ...candidate, ...update } : candidate),
    };
    await this.write(next);
    return next;
  }

  async setEnabled(id: string, enabled: boolean): Promise<CloneSettings> {
    return this.updateAgent(id, { enabled });
  }

  private async write(settings: CloneSettings): Promise<void> {
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(this.#path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    });
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
  }
}

function normalize(input: Partial<CloneSettings>): CloneSettings {
  const configured = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  return {
    agents: DEFAULT_AGENTS.map((agent) => {
      const saved = configured.get(agent.id);
      const savedProvider = saved?.providerId as ProviderId | undefined;
      return {
        ...agent,
        enabled: agent.required ? true : saved?.enabled ?? agent.enabled,
        providerId:
          savedProvider !== undefined
          && providerIds.has(savedProvider)
          && providerIsAllowedForRole(savedProvider, agent.role)
            ? savedProvider
            : agent.providerId,
      };
    }),
  };
}

const providerIds = new Set<ProviderId>(["codex-cli", "claude-code", "pi"]);

function providerIsAllowedForRole(providerId: ProviderId, role: AgentRole): boolean {
  return providerId !== "pi" || role === "direct" || role === "review";
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
