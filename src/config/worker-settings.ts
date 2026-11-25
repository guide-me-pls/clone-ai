import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { builtInProviders } from "../workers/provider-catalog.ts";
import type { ProviderRegistry } from "../workers/provider-registry.ts";

export type AgentRole = "general" | "direct" | "research" | "draft" | "review" | "external";
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

/**
 * One executor, not a roster of roles. The native provider is the only
 * execution provider, so four profiles with four role names were four labels on
 * the same worker: only their capability sets differed. Responsibility is now
 * declared per step by the Main Agent's plan; the worker itself is general.
 * External actions still have no executor until a governed connector exists.
 *
 * 一个执行者，而不是一份角色名单。原生 Provider 是唯一的执行 Provider，因此四个角色
 * Profile 只是同一个 Worker 上的四个标签：只有能力集不同。职责现在由主 Agent 的计划按
 * 每一步声明；Worker 本身是通用的。在有受治理的连接器之前，外部动作仍没有执行者。
 */
const DEFAULT_AGENTS: WorkerProfile[] = [
  {
    id: "worker",
    title: "执行 Worker",
    role: "general",
    description: "在本机读取、修改与交付；每一步能做什么由计划声明，工具调用由 Kernel 校验。",
    purpose: "执行所有本地工作；职责按任务与步骤声明，不再按角色拆分。",
    providerId: "native",
    enabled: true,
    required: true,
  },
];

/**
 * Return a fresh default catalog so callers never mutate the module-level
 * settings. There is one provider, the native worker; the external role has no
 * default agent until a governed action connector exists.
 *
 * 返回一份全新的默认 Agent 目录，避免调用方修改模块级设置。只有一个 Provider——
 * 原生 Worker；external 角色在有受治理的动作连接器之前没有默认 Agent。
 */
export function defaultWorkerProfiles(_environment: NodeJS.ProcessEnv = process.env): WorkerProfile[] {
  return defaultAgents();
}

function defaultAgents(): WorkerProfile[] {
  return DEFAULT_AGENTS.map((agent) => ({ ...agent }));
}

export class WorkerSettingsStore {
  readonly #path: string;
  readonly #providers: ProviderRegistry;
  readonly #environment: NodeJS.ProcessEnv;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string, providers: ProviderRegistry = builtInProviders, environment: NodeJS.ProcessEnv = process.env) {
    this.#path = path;
    this.#providers = providers;
    this.#environment = environment;
  }

  async get(): Promise<CloneSettings> {
    try {
      const source = await readFile(this.#path, "utf8");
      return normalize(JSON.parse(source) as Partial<CloneSettings>, this.#providers, this.#environment);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return { agents: defaultWorkerProfiles(this.#environment) };
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
      throw new Error("The executor is required for local work.");
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

function normalize(input: Partial<CloneSettings>, providers: ProviderRegistry, environment: NodeJS.ProcessEnv): CloneSettings {
  const configured = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  return {
    agents: defaultAgents().map((agent) => {
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
