/**
 * What a desktop launch supplies to the sidecar. There is no owner working
 * directory: the app does not read a folder from config, and the branded
 * `CLONE_AI_DESKTOP_DEFAULT_WORKSPACE` is gone. `CLONE_AI_WORKSPACE` remains a
 * developer override for tests and one-off runs; everything else uses the
 * clone home as the internal base.
 *
 * 桌面启动传给 sidecar 的东西。没有所有者工作目录：App 不再从配置读取文件夹，
 * 带品牌的 `CLONE_AI_DESKTOP_DEFAULT_WORKSPACE` 也已移除。`CLONE_AI_WORKSPACE` 仍是
 * 测试与一次性运行使用的开发者覆盖；其余情况以 clone home 作为内部基准。
 */
export async function resolveDesktopLaunchConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ clientPath?: string; workspacePath?: string }> {
  const clientPath = env.CLONE_AI_DESKTOP_CLIENT_PATH?.trim();
  const explicitWorkspace = env.CLONE_AI_WORKSPACE?.trim();
  return {
    ...(clientPath ? { clientPath } : {}),
    ...(explicitWorkspace ? { workspacePath: explicitWorkspace } : {}),
  };
}
