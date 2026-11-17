import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { isEffortLevel, type EffortLevel } from "../workers/effort.ts";
import type { ClonePaths } from "./clone-home.ts";

export interface CloneConfig {
  version: 1;
  workspacePath: string;
  locale: "zh-CN" | "en";
  /**
   * Model id for the Main Agent, as the OpenAI-compatible endpoint names it.
   * When omitted, CLONE_AI_NATIVE_MODEL is used; without either, a turn fails.
   * `CLONE_AI_MAIN_MODEL` overrides this for one-off runs.
   * 主 Agent 的模型 id，采用 OpenAI 兼容端点的命名。省略时使用 CLONE_AI_NATIVE_MODEL；
   * 没有两者时回合会失败。`CLONE_AI_MAIN_MODEL` 可覆盖本次运行。
   */
  mainAgentModel?: string;
  /**
   * Reasoning effort for the Main Agent, passed to the model provider. Only levels the model offers should be chosen.
   * 主 Agent 的推理强度，传给模型供应商。应只选择模型支持的档位。
   */
  mainAgentEffort?: EffortLevel;
  /**
   * The OpenAI-compatible endpoint the Main Agent and every native worker call.
   * Stored here so an app launched from Finder — where the environment is
   * empty — still has an endpoint. The environment overrides it for one-off
   * runs; without either, a turn fails and names what is missing.
   * 主 Agent 与所有原生 Worker 调用的 OpenAI 兼容端点。存放在这里，使从 Finder 启动、
   * 环境为空的 App 仍有端点。一次性运行可用环境变量覆盖；两者都没有时，回合会失败并
   * 指明缺什么。
   */
  mainAgentBaseUrl?: string;
  /**
   * Credential for that endpoint. The file is written 0600 and is never
   * returned by the settings API; the environment still wins when set.
   * 该端点的凭据。文件以 0600 写入，设置接口绝不返回它；环境变量设置时仍优先。
   */
  mainAgentApiKey?: string;
  /**
   * Owner-pinned ceiling on concurrent worker executions. Omitted or 0 means
   * auto: the Kernel measures CPU and free memory each time it dispatches.
   * 所有者固定的并发 Worker 上限。省略或 0 表示自动：Kernel 每次派发时测量 CPU 与空闲内存。
   */
  maxConcurrentWorkers?: number;
}

export class CloneConfigStore {
  readonly #paths: ClonePaths;
  readonly #defaultWorkspace: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(paths: ClonePaths) {
    this.#paths = paths;
    this.#defaultWorkspace = paths.workspacePath;
  }

  async get(): Promise<CloneConfig> {
    const value = await readJsonFile<Partial<CloneConfig>>(this.#paths.configFile);
    return normalizeConfig(value, this.#defaultWorkspace);
  }

  async update(update: Partial<Pick<CloneConfig, "workspacePath" | "locale" | "mainAgentModel" | "mainAgentEffort" | "mainAgentBaseUrl" | "mainAgentApiKey" | "maxConcurrentWorkers">>): Promise<CloneConfig> {
    const current = await this.get();
    const next = normalizeConfig({ ...current, ...update }, this.#defaultWorkspace);
    const write = this.#writes.then(() => writeJsonAtomic(this.#paths.configFile, next));
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
    return next;
  }
}

function normalizeConfig(value: Partial<CloneConfig> | undefined, defaultWorkspace: string): CloneConfig {
  const mainAgentModel = nonEmpty(value?.mainAgentModel);
  const mainAgentBaseUrl = nonEmpty(value?.mainAgentBaseUrl)?.replace(/\/+$/, "");
  const mainAgentApiKey = nonEmpty(value?.mainAgentApiKey);
  return {
    version: 1,
    workspacePath: typeof value?.workspacePath === "string" && value.workspacePath.trim().length > 0
      ? value.workspacePath
      : defaultWorkspace,
    locale: value?.locale === "en" ? "en" : "zh-CN",
    ...(mainAgentModel === undefined ? {} : { mainAgentModel }),
    ...(mainAgentBaseUrl === undefined ? {} : { mainAgentBaseUrl }),
    ...(mainAgentApiKey === undefined ? {} : { mainAgentApiKey }),
    ...(isEffortLevel(value?.mainAgentEffort) ? { mainAgentEffort: value.mainAgentEffort } : {}),
    ...(typeof value?.maxConcurrentWorkers === "number" && Number.isFinite(value.maxConcurrentWorkers) && value.maxConcurrentWorkers > 0
      ? { maxConcurrentWorkers: Math.trunc(value.maxConcurrentWorkers) }
      : {}),
  };
}

/** A trimmed non-empty string, or undefined. 去空白后的非空字符串，否则 undefined。 */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
