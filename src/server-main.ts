#!/usr/bin/env node
import { startCompanionServer } from "./companion-server.ts";

/**
 * Headless server entrypoint for a persistent personal agent.
 *
 * This is intentionally separate from the macOS desktop entry. It requires a
 * stable companion token and an HTTPS public origin, and expects a TLS reverse
 * proxy in front of it. The proxy must protect the UI with owner
 * authentication while leaving `/webhook` available to Meta.
 *
 * 常驻个人 Agent 的无界面服务器入口。
 *
 * 它与 macOS 桌面入口刻意分离：必须提供稳定的 Companion Token 和 HTTPS 公网地址，
 * 并部署在 TLS 反向代理之后。代理需保护 UI，同时把 `/webhook` 留给 Meta。
 */
async function main(): Promise<void> {
  process.umask(0o077);
  const publicUrl = process.env.CLONE_AI_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  const token = process.env.CLONE_AI_COMPANION_TOKEN?.trim() ?? "";
  if (publicUrl.length === 0) {
    throw new Error("CLONE_AI_PUBLIC_URL is required for server deployment.");
  }
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== "https:" && process.env.CLONE_AI_ALLOW_HTTP !== "1") {
    throw new Error("CLONE_AI_PUBLIC_URL must use HTTPS; set CLONE_AI_ALLOW_HTTP=1 only for a private test.");
  }
  if (parsed.pathname !== "/" || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error("CLONE_AI_PUBLIC_URL must be an origin without a path, query, or fragment.");
  }
  if (token.length < 32) {
    throw new Error("CLONE_AI_COMPANION_TOKEN must contain at least 32 characters.");
  }
  const proxySecret = process.env.CLONE_AI_PROXY_SECRET?.trim() ?? "";
  if (proxySecret.length < 32) {
    throw new Error("CLONE_AI_PROXY_SECRET must contain at least 32 characters.");
  }
  if (proxySecret === token) {
    throw new Error("CLONE_AI_PROXY_SECRET must be different from CLONE_AI_COMPANION_TOKEN.");
  }
  const port = parsePort(process.env.CLONE_AI_PORT, 4317);
  const server = await startCompanionServer({
    host: process.env.CLONE_AI_HOST?.trim() || "0.0.0.0",
    port,
    serverMode: true,
    publicBaseUrl: parsed.origin,
    token,
    proxySecret,
  });
  console.log(JSON.stringify({
    event: "clone-ai.server.ready",
    publicUrl,
    localUrl: server.url,
    port,
  }));

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("CLONE_AI_PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
