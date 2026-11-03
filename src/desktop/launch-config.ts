import { CloneConfigStore } from "../config/clone-config.ts";
import { resolveClonePaths } from "../config/clone-home.ts";

export async function resolveDesktopLaunchConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ clientPath?: string; workspacePath?: string }> {
  const clientPath = env.CLONE_AI_DESKTOP_CLIENT_PATH?.trim();
  const defaultWorkspace = env.CLONE_AI_DESKTOP_DEFAULT_WORKSPACE?.trim();
  if (!defaultWorkspace) return clientPath ? { clientPath } : {};

  const paths = resolveClonePaths({ cwd: defaultWorkspace, env });
  const config = await new CloneConfigStore(paths).get();
  const workspacePath = env.CLONE_AI_WORKSPACE?.trim() || config.workspacePath;
  return { ...(clientPath ? { clientPath } : {}), workspacePath };
}
