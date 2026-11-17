import { join } from "node:path";

import { startCompanionServer } from "./companion-server.ts";
import { resolveDesktopLaunchConfig } from "./desktop/launch-config.ts";

const pkgProcess = process as NodeJS.Process & { pkg?: unknown };
async function main(): Promise<void> {
  // Every file this process creates — the journal, the endpoint file, the
  // bridge secrets — is the owner's. Server mode already does this; the desktop
  // sidecar must not be the one path that leaves them world-readable.
  // 本进程创建的每个文件——Journal、端点文件、桥密钥——都属于所有者。服务器模式已经这
  // 样做；桌面 sidecar 不该成为那个把文件留成全局可读的路径。
  process.umask(0o077);
  const launch = await resolveDesktopLaunchConfig();
  const fallbackClientPath = pkgProcess.pkg === undefined
    ? join(process.cwd(), "apps", "desktop", "ui", "index.html")
    : join(__dirname, "..", "ui", "index.html");
  const companion = await startCompanionServer({
    port: 0,
    clientPath: launch.clientPath ?? fallbackClientPath,
    ...(launch.workspacePath === undefined ? {} : { workspacePath: launch.workspacePath }),
  });

  // The Tauri shell consumes this one machine-readable line before creating its window.
  // Tauri Shell 会在创建窗口前读取这一行机器可读信息。
  console.log(`CLONE_AI_READY ${companion.url}`);

  const shutdown = async () => {
    await companion.close();
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
