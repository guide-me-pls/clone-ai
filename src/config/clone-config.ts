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

  async update(update: Partial<Pick<CloneConfig, "workspacePath" | "locale" | "mainAgentModel" | "mainAgentEffort">>): Promise<CloneConfig> {
    const current = await this.get();
    const next = normalizeConfig({ ...current, ...update }, this.#defaultWorkspace);
    const write = this.#writes.then(() => writeJsonAtomic(this.#paths.configFile, next));
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
    return next;
  }
}

function normalizeConfig(value: Partial<CloneConfig> | undefined, defaultWorkspace: string): CloneConfig {
  const mainAgentModel = typeof value?.mainAgentModel === "string" && value.mainAgentModel.trim().length > 0
    ? value.mainAgentModel.trim()
    : undefined;
  return {
    version: 1,
    workspacePath: typeof value?.workspacePath === "string" && value.workspacePath.trim().length > 0
      ? value.workspacePath
      : defaultWorkspace,
    locale: value?.locale === "en" ? "en" : "zh-CN",
    ...(mainAgentModel === undefined ? {} : { mainAgentModel }),
    ...(isEffortLevel(value?.mainAgentEffort) ? { mainAgentEffort: value.mainAgentEffort } : {}),
  };
}
