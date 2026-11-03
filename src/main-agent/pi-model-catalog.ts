import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Read the model ids Pi can construct from its local configuration without
 * refreshing remote catalogs. This exposes references only, never credentials.
 *
 * 只读取 Pi 根据本地配置能够构造的模型 ID，不刷新远程目录。这里只返回模型引用，
 * 绝不返回凭据。
 */
export async function listPiModelIds(providerId: string): Promise<string[]> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  return runtime.getModels()
    .filter((model) => model.provider === providerId)
    .map((model) => model.id);
}

export function piModelReference(modelId: string, providerId = "magpie"): string {
  return `${providerId}/${modelId}`;
}
