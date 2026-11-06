/**
 * The owner's Main Agent preferences, read without any agent SDK.
 *
 * A one-off run may override the model or effort through the environment; the
 * persistent choice lives in `config.json`. The native loop and the settings
 * page both read these, so what the owner chose is what actually runs.
 *
 * 所有者的主 Agent 偏好，读取时不依赖任何 Agent SDK。
 *
 * 一次性运行可以用环境变量覆盖模型或强度；持久选择保存在 `config.json`。原生循环与
 * 设置页都读取这里，因此所有者选的就是实际运行的。
 */
import { CloneConfigStore } from "../config/clone-config.ts";
import { resolveClonePaths } from "../config/clone-home.ts";
import { isEffortLevel, type EffortLevel } from "../workers/effort.ts";

export async function readMainAgentEffortPreference(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EffortLevel | undefined> {
  const fromEnv = environment.CLONE_AI_MAIN_EFFORT?.trim();
  if (isEffortLevel(fromEnv)) return fromEnv;
  const paths = resolveClonePaths({ dataDirectory });
  const config = await new CloneConfigStore(paths).get();
  return config.mainAgentEffort;
}

export async function readMainAgentModelPreference(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnv = environment.CLONE_AI_MAIN_MODEL?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const paths = resolveClonePaths({ dataDirectory });
  const config = await new CloneConfigStore(paths).get();
  const model = config.mainAgentModel?.trim();
  return model === undefined || model.length === 0 ? undefined : model;
}