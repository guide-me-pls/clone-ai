import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { builtInProviders } from "../workers/provider-catalog.ts";
import type { ProviderRegistry } from "../workers/provider-registry.ts";

export type AgentRole = "direct" | "research" | "draft" | "review" | "external";
/**
 * A provider id is whatever the provider registry knows at runtime, not a
 * closed union: a third-party provider must be selectable without editing
 * this file.
 * Provider ID 是 Provider Registry 在运行时认识的任意标识，而不是封闭联合类型：
 * 第三方 Provider 必须无需修改本文件就能被选中。
 */
export type ProviderId = string;

export interface WorkerProfile {
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
  agents: WorkerProfile[];
}

const DEFAULT_AGENTS: WorkerProfile[] = [
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
export function defaultWorkerProfiles(): WorkerProfile[] {
  return DEFAULT_AGENTS.map((agent) => ({ ...agent }));
}

export class WorkerSettingsStore {
  readonly #path: string;
  readonly #providers: ProviderRegistry;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string, providers: ProviderRegistry = builtInProviders) {
    this.#path = path;
    this.#providers = providers;
  }

  async get(): Promise<CloneSettings> {
    try {
      const source = await readFile(this.#path, "utf8");
      return normalize(JSON.parse(source) as Partial<CloneSettings>, this.#providers);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return { agents: defaultWorkerProfiles() };
      }
      throw error;
    }
  }

  async updateAgent(id: string, update: { enabled?: boolean; providerId?: ProviderId }): Promise<CloneSettings> {
    const providers = this.#providers;
    const current = await this.get();
    const agent = current.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) {
      throw new Error("The requested agent setting does not exist.");
    }
    if (agent.required && update.enabled === false) {
      throw new Error("The direct executor is required for local requests.");
    }
    if (update.providerId !== undefined && !providers.has(update.providerId)) {
      throw new Error(
        `Unknown execution provider "${update.providerId}". Registered providers: ${providers.ids().join(", ") || "none"}.`,
      );
    }
    if (update.providerId !== undefined && !providers.supportsRole(update.providerId, agent.role)) {
      throw new Error(
        providers.get(update.providerId)?.roleRestrictionReason
          ?? `Provider ${update.providerId} does not support the ${agent.role} role.`,
      );
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

function normalize(input: Partial<CloneSettings>, providers: ProviderRegistry): CloneSettings {
  const configured = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  return {
    agents: DEFAULT_AGENTS.map((agent) => {
      const saved = configured.get(agent.id);
      const savedProvider = saved?.providerId;
      // An unknown or role-incompatible saved provider falls back to the
      // default instead of failing: settings may outlive a provider being
      // unregistered.
      // 未知或与角色不兼容的已保存 Provider 会回退到默认值而不是报错：设置可能比某个
      // Provider 的注册存活得更久。
      return {
        ...agent,
        enabled: agent.required ? true : saved?.enabled ?? agent.enabled,
        providerId:
          savedProvider !== undefined
          && providers.has(savedProvider)
          && providers.supportsRole(savedProvider, agent.role)
            ? savedProvider
            : agent.providerId,
      };
    }),
  };
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** @deprecated Renamed to WorkerProfile. 已更名为 WorkerProfile。 */
export type AgentSetting = WorkerProfile;
