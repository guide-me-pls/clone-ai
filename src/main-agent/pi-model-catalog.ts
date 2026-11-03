import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface PiModelOption {
  /** Model id within its provider. 模型在其 Provider 内的 ID。 */
  id: string;
  /** Provider id, such as magpie. Provider ID，例如 magpie。 */
  provider: string;
  /** Full provider/model reference accepted by Clone AI. Clone AI 接受的完整 provider/model 引用。 */
  reference: string;
  /** Human-readable model name. 人类可读的模型名称。 */
  label: string;
}

/**
 * Read the models explicitly configured for Pi, plus any provider whose auth
 * is already available. This exposes references only, never credentials.
 *
 * 只读取 Pi 已显式配置的模型，以及已经有可用认证的 Provider。这里只返回
 * 模型引用，绝不返回凭据。
 */
export async function listPiModels(providerId?: string): Promise<PiModelOption[]> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  const configured = await configuredModelKeys();
  const available = new Set(
    runtime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
  );
  return runtime.getModels()
    .filter((model) => providerId === undefined || model.provider === providerId)
    .filter((model) => {
      const key = `${model.provider}\0${model.id}`;
      return available.has(key) || configured?.has(key) === true;
    })
    .map((model) => ({
      id: model.id,
      provider: model.provider,
      reference: `${model.provider}/${model.id}`,
      label: model.name?.trim() || model.id,
    }));
}

export async function listPiModelIds(providerId: string): Promise<string[]> {
  return (await listPiModels(providerId)).map((model) => model.id);
}

export function piModelReference(modelId: string, providerId = "magpie"): string {
  return `${providerId}/${modelId}`;
}

/**
 * Read only the provider/model indexes from Pi's models.json file. Provider
 * credentials, headers, and base URLs are deliberately ignored.
 *
 * 只读取 Pi models.json 中的 Provider/模型索引。Provider 凭据、Header 与
 * Base URL 都会被刻意忽略。
 */
async function configuredModelKeys(): Promise<Set<string> | undefined> {
  try {
    const source = await readFile(join(getAgentDir(), "models.json"), "utf8");
    const document = JSON.parse(source) as {
      providers?: Record<string, { models?: Array<{ id?: unknown }> }>;
    };
    if (document.providers === undefined || document.providers === null) return undefined;
    const keys = new Set<string>();
    for (const [provider, config] of Object.entries(document.providers)) {
      if (!Array.isArray(config?.models)) continue;
      for (const model of config.models) {
        if (typeof model?.id === "string" && model.id.length > 0) {
          keys.add(`${provider}\0${model.id}`);
        }
      }
    }
    return keys;
  } catch {
    return undefined;
  }
}
