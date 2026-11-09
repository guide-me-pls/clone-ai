#!/usr/bin/env node
/**
 * Starts the local companion on a fixed port for a browser preview.
 *
 * The desktop sidecar picks a free port and prints it for the native shell;
 * a preview needs a predictable one. Everything else (assets, token injection,
 * loopback origin) is the same server.
 *
 * 在固定端口启动本地 companion，用于浏览器预览。
 *
 * 桌面 sidecar 会选一个空闲端口并告知原生外壳；预览需要可预测的端口。其余部分
 * （资源、token 注入、loopback 来源）都是同一个服务器。
 */
import { startCompanionServer } from "../src/companion-server.ts";

const port = Number(process.env.PORT ?? process.env.CLONE_AI_PORT ?? 4317);
const server = await startCompanionServer({
  port,
  host: "127.0.0.1",
  clientPath: new URL("../apps/desktop/ui/index.html", import.meta.url).pathname,
});
console.log(`clone-ai companion listening on ${server.url}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
