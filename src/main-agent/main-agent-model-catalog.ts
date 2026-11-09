/**
 * The models the Main Agent settings can choose from.
 *
 * The native runtime talks to an OpenAI-compatible endpoint, so the catalog is
 * the gateway's own model list. This module used to read the Pi SDK catalog;
 * after removing the SDK it asks the local gateway directly and caches nothing,
 * because the owner may add or remove models between visits.
 *
 * 主 Agent 设置可选的模型。
 *
 * 原生运行时对接 OpenAI 兼容端点，因此目录就是网关自己的模型列表。本模块原先读取
 * Pi SDK 目录；移除 SDK 后直接询问本地网关，且不做缓存，因为所有者可能在两次访问之间
 * 增删模型。
 */
import { inspectMagpieGateway } from "../integrations/magpie-gateway.ts";

export interface MainAgentModelOption {
  /** Model id as the endpoint names it. 端点使用的模型 ID。 */
  id: string;
  /** Provider id, such as magpie. Provider ID，例如 magpie。 */
  provider: string;
  /** Reference accepted by Clone AI; the native loop uses the id directly. Clone AI 接受的引用；原生循环直接使用该 id。 */
  reference: string;
  /** Human-readable model name. 人类可读的模型名称。 */
  label: string;
}

/**
 * Models exposed by the local gateway. A different provider id returns nothing:
 * there is no second catalog any more.
 * 本地网关暴露的模型。其他 Provider ID 返回空：已经不存在第二个目录。
 */
export async function listMainAgentModels(providerId?: string): Promise<MainAgentModelOption[]> {
  if (providerId !== undefined && providerId !== "magpie") return [];
  const gateway = await inspectMagpieGateway();
  if (!gateway.running) return [];
  return gateway.models.map((model) => ({
    id: model.id,
    provider: "magpie",
    reference: model.id,
    label: model.name?.trim() || model.id,
  }));
}

export async function listMainAgentModelIds(providerId?: string): Promise<string[]> {
  return (await listMainAgentModels(providerId)).map((model) => model.id);
}

/** The native loop takes the model id as-is; there is no provider prefix. 原生循环直接使用模型 id，没有 Provider 前缀。 */
export function mainAgentModelReference(modelId: string): string {
  return modelId.trim();
}