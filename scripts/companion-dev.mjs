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
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { prepareAutomationHome } from "./automation-home.mjs";
import { startCompanionServer } from "../src/companion-server.ts";

const port = Number(process.env.PORT ?? process.env.CLONE_AI_PORT ?? 4317);
// This server is for previews and eval runs, not the owner's runtime. Without
// this guard the default data directory is `~/.clone`, so a preview started
// without an explicit home would write the owner's journal and hold the Main
// Agent prompt lock — the collision observed on 2026-11-18.
// 这台服务器用于预览与评测运行，不是所有者的运行时。没有这道闸门，默认数据目录就是
// `~/.clone`，未显式指定 home 的预览就会写所有者的 Journal 并持有 Main Agent 提示锁——
// 即 2026-11-18 观察到的碰撞。
const configuredHome = process.env.CLONE_HOME ?? process.env.CLONE_AI_HOME ?? process.env.CLONE_AI_DATA_DIR;
// The target to avoid is this machine's live runtime home, not whatever
// CLONE_AI_DATA_DIR currently names: an eval runner sets that variable to its
// own isolated directory and must be allowed through.
// 要避开的目标是本机正在使用的运行时 home，而不是 CLONE_AI_DATA_DIR 当前指向的目录：
// 评测运行会把该变量设成自己的隔离目录，必须放行。
const liveHome = resolve(join(homedir(), ".clone"));
if (configuredHome !== undefined && configuredHome.trim().length > 0
  && resolve(configuredHome) === liveHome && process.env.CLONE_AI_ALLOW_OWNER_HOME !== "1") {
  console.error(`companion-dev refuses the owner's live clone home (${liveHome}). Set CLONE_AI_DATA_DIR to an isolated directory, or CLONE_AI_ALLOW_OWNER_HOME=1 to override.`);
  process.exit(1);
}
if (configuredHome === undefined || configuredHome.trim().length === 0) {
  // A preview with no home is a normal case (the launch config just runs
  // `npm run companion:dev`): give it its own home instead of the owner's.
  // 没有 home 的预览是正常情况（启动配置只运行 `npm run companion:dev`）：给它自己的
  // home，而不是所有者的。
  const home = await prepareAutomationHome({
    repoRoot: resolve(import.meta.dirname, ".."),
    purpose: "preview",
  });
  process.env.CLONE_AI_DATA_DIR = home.dataDirectory;
  console.log(`companion-dev using isolated home ${home.dataDirectory}`);
}
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
