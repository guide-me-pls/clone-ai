import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Loopback-only access control for the companion daemon.
 *
 * Binding to 127.0.0.1 is not authentication: any local process, or a
 * browser page that rebinds DNS onto loopback, can otherwise approve runs
 * and install CLIs. A per-boot bearer plus a Host/Origin check closes that.
 *
 * Companion Daemon 的仅回环访问控制。
 *
 * 绑到 127.0.0.1 不是鉴权：本机任意进程，或把 DNS  rebound 到回环的网页，都能批准
 * Run、安装 CLI。每次启动一张 bearer，再加上 Host/Origin 检查，才能把这个口封上。
 */
export function issueCompanionToken(): string {
  return randomBytes(32).toString("hex");
}

export async function persistCompanionToken(dataDirectory: string, token: string): Promise<string> {
  const path = join(dataDirectory, "companion.token");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows cannot always chmod 0600; the file still lives in the owner's home.
    // Windows 不一定能 chmod 0600；文件仍然只在所有者主目录里。
  }
  return path;
}

export interface CompanionEndpoint {
  url: string;
  pid: number;
  startedAt: string;
}

/** Publish the loopback endpoint so local channel bridges can find the live daemon. 发布回环地址，供本地消息通道找到正在运行的 Daemon。 */
export async function persistCompanionEndpoint(
  dataDirectory: string,
  url: string,
  startedAt = new Date().toISOString(),
): Promise<string> {
  const path = join(dataDirectory, "companion-endpoint.json");
  await mkdir(dataDirectory, { recursive: true });
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
    throw new Error("The companion endpoint must be an HTTP loopback URL.");
  }
  const endpoint: CompanionEndpoint = {
    url: parsed.origin,
    pid: process.pid,
    startedAt,
  };
  await writeFile(path, `${JSON.stringify(endpoint)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows cannot always chmod 0600; the endpoint contains no bearer.
    // Windows 不一定能 chmod 0600；地址文件本身不包含 bearer。
  }
  return path;
}

/** Read a previously published endpoint; validation rejects a non-loopback value. 读取已发布地址；校验会拒绝非回环地址。 */
export async function readCompanionEndpoint(dataDirectory: string): Promise<CompanionEndpoint | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDirectory, "companion-endpoint.json"), "utf8")) as Partial<CompanionEndpoint>;
    if (typeof parsed.url !== "string" || typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return undefined;
    const url = new URL(parsed.url);
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return undefined;
    return { url: url.origin, pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

export async function clearCompanionEndpoint(dataDirectory: string): Promise<void> {
  await unlink(join(dataDirectory, "companion-endpoint.json")).catch(() => undefined);
}

/** Remove only a stale endpoint, never one republished by a newer daemon. 只删除陈旧地址，绝不删除新 Daemon 已重新发布的地址。 */
export async function clearCompanionEndpointIfOwned(dataDirectory: string, startedAt: string): Promise<void> {
  const current = await readCompanionEndpoint(dataDirectory);
  if (current?.startedAt === startedAt && current.pid === process.pid) {
    await clearCompanionEndpoint(dataDirectory);
  }
}

export function loopbackHostname(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader.trim().length === 0) return undefined;
  try {
    const url = new URL(`http://${hostHeader.trim()}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return normalizeHostname(url.hostname);
  } catch {
    return undefined;
  }
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function normalizeCompanionHost(host: string): string {
  const normalized = normalizeHostname(host.trim());
  if (normalized === "localhost") return "127.0.0.1";
  if (normalized === "127.0.0.1" || normalized === "::1") return normalized;
  throw new Error("The companion daemon must bind to a literal loopback address.");
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[([^\]]+)\]$/, "$1");
}

export function originIsLoopback(origin: string | undefined, listenPort: number): boolean {
  if (origin === undefined || origin.length === 0) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!isLoopbackHostname(normalizeHostname(url.hostname))) return false;
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return port === listenPort;
  } catch {
    return false;
  }
}

export function readBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1];
}

export function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isUnauthenticatedCompanionPath(method: string, pathname: string): boolean {
  if (method === "GET" && pathname === "/api/health") return true;
  if (
    method === "GET"
    && (
      pathname === "/"
      || pathname === "/style.css"
      || pathname === "/components.css"
      || pathname === "/app.js"
      || pathname === "/components.js"
      || pathname === "/audit.css"
      || pathname === "/audit.js"
      || pathname === "/memory.css"
      || pathname === "/memory.js"
    )
  ) return true;
  return false;
}

export function authorizeCompanionRequest(input: {
  method: string;
  pathname: string;
  hostHeader: string | undefined;
  originHeader: string | undefined;
  authorization: string | undefined;
  token: string;
  listenPort: number;
}): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  const hostname = loopbackHostname(input.hostHeader);
  if (!isLoopbackHostname(hostname)) {
    return { ok: false, status: 403, error: "Companion APIs are loopback-only." };
  }
  if (!originIsLoopback(input.originHeader, input.listenPort)) {
    return { ok: false, status: 403, error: "Companion APIs reject a non-loopback Origin." };
  }
  if (isUnauthenticatedCompanionPath(input.method, input.pathname)) return { ok: true };
  if (!tokensMatch(input.token, readBearerToken(input.authorization))) {
    return { ok: false, status: 401, error: "Companion APIs require a bearer token." };
  }
  return { ok: true };
}

export function injectCompanionToken(html: string, token: string): string {
  const tag = `<script>window.CLONE_AI_TOKEN=${JSON.stringify(token)};</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : `${tag}${html}`;
}
