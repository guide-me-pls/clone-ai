import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { isEffortLevel, type EffortLevel } from "../workers/effort.ts";
import type { ClonePaths } from "./clone-home.ts";

export interface CloneConfig {
  version: 1;
  workspacePath: string;
  locale: "zh-CN" | "en";
  /**
   * OpenAI-compatible endpoint used by the built-in Main Agent.
   * 内置主 Agent 使用的 OpenAI 兼容端点。
   */
  mainAgentBaseUrl?: string;
  /** Model id served by the endpoint. 端点提供的模型 ID。 */
  mainAgentModel?: string;
  /**
   * Reasoning effort for the Main Agent. Only levels the model offers should be chosen.
   * 主 Agent 的推理强度。应只选择模型实际支持的档位。
   */
  mainAgentEffort?: EffortLevel;
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

  async update(update: Partial<Pick<CloneConfig, "workspacePath" | "locale" | "mainAgentBaseUrl" | "mainAgentModel" | "mainAgentEffort">>): Promise<CloneConfig> {
    const current = await this.get();
    const next = normalizeConfig({ ...current, ...update }, this.#defaultWorkspace);
    const write = this.#writes.then(() => writeJsonAtomic(this.#paths.configFile, next));
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
    return next;
  }
}

function normalizeConfig(value: Partial<CloneConfig> | undefined, defaultWorkspace: string): CloneConfig {
  const mainAgentBaseUrl = typeof value?.mainAgentBaseUrl === "string" && value.mainAgentBaseUrl.trim().length > 0
    ? value.mainAgentBaseUrl.trim().replace(/\/$/, "")
    : undefined;
  const modelValue = typeof value?.mainAgentModel === "string" ? value.mainAgentModel.trim() : "";
  const mainAgentModel = modelValue.length > 0
    ? modelValue.replace(/^magpie\//, "")
    : undefined;
  return {
    version: 1,
    workspacePath: typeof value?.workspacePath === "string" && value.workspacePath.trim().length > 0
      ? value.workspacePath
      : defaultWorkspace,
    locale: value?.locale === "en" ? "en" : "zh-CN",
    ...(mainAgentBaseUrl === undefined ? {} : { mainAgentBaseUrl }),
    ...(mainAgentModel === undefined ? {} : { mainAgentModel }),
    ...(isEffortLevel(value?.mainAgentEffort) ? { mainAgentEffort: value.mainAgentEffort } : {}),
  };
}
