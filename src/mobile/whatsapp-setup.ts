import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readJsonFile, writeJsonAtomic } from "../config/json-file.ts";
import { augmentedExecutablePath, resolveExecutable } from "../workers/executable-resolver.ts";
import { readWhatsAppCloudConfig } from "./whatsapp-bridge.ts";
import {
  WHATSAPP_BRIDGE_STATE_FILE_NAME,
  WHATSAPP_ENV_FILE_NAME,
  WHATSAPP_TUNNEL_LOG_FILE_NAME,
  WHATSAPP_TUNNEL_STATE_FILE_NAME,
} from "./whatsapp-files.ts";
import { allowedWhatsAppNumbers } from "./whatsapp.ts";

const execFileAsync = promisify(execFile);

interface StoredPid {
  pid: number;
  startedAt: string;
}

interface TunnelState extends StoredPid {
  url?: string;
  port: number;
}

interface BridgeState {
  pid: number;
  running: boolean;
  buildId?: string;
  startedAt: string;
  webhookVerifiedAt?: string;
  lastMessageAt?: string;
}

export interface WhatsAppSetupInput {
  accessToken?: string;
  phoneNumberId?: string;
  verifyToken?: string;
  appSecret?: string;
  allowedNumbers?: string;
  graphVersion?: string;
}

/** Invalid owner input, separate from a process or network failure. 所有者输入错误，区别于进程或网络故障。 */
export class WhatsAppBindingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppBindingInputError";
  }
}

export interface WhatsAppSetupStatus {
  configured: boolean;
  bindingEnabled: boolean;
  missing: string[];
  phoneNumberId: string;
  verifyToken: string;
  allowedNumbers: string[];
  bridge: {
    running: boolean;
    pid?: number;
    port: number;
    webhookVerifiedAt?: string;
    lastMessageAt?: string;
    error?: string;
    stale?: boolean;
  };
  tunnel: {
    cloudflaredInstalled: boolean;
    running: boolean;
    managed: boolean;
    url?: string;
    webhookUrl?: string;
    installCommand: string;
    error?: string;
  };
  ready: boolean;
}

/**
 * UI-facing binding service for the WhatsApp phone bridge.
 *
 * It writes secrets only to the owner's 0600 env file, starts the bridge as a
 * detached process so closing the window does not stop it, and exposes status
 * without returning access tokens or app secrets.
 *
 * 面向 UI 的 WhatsApp 手机桥绑定服务。
 *
 * 密钥只写入所有者的 0600 环境文件；桥以脱离进程启动，关闭窗口不会停止它；状态接口
 * 永远不返回 Access Token 或 App Secret。
 */
export class WhatsAppSetupService {
  readonly #dataDirectory: string;
  readonly #publicBaseUrl: string | undefined;
  readonly #envFile: string;
  readonly #bridgeStateFile: string;
  readonly #tunnelStateFile: string;
  readonly #tunnelLogFile: string;
  #bridgeError: string | undefined;
  #tunnelError: string | undefined;

  constructor(dataDirectory: string, publicBaseUrl?: string) {
    this.#dataDirectory = dataDirectory;
    this.#publicBaseUrl = publicBaseUrl?.replace(/\/+$/, "") || undefined;
    this.#envFile = join(dataDirectory, WHATSAPP_ENV_FILE_NAME);
    this.#bridgeStateFile = join(dataDirectory, WHATSAPP_BRIDGE_STATE_FILE_NAME);
    this.#tunnelStateFile = join(dataDirectory, WHATSAPP_TUNNEL_STATE_FILE_NAME);
    this.#tunnelLogFile = join(dataDirectory, WHATSAPP_TUNNEL_LOG_FILE_NAME);
  }

  async initialize(): Promise<void> {
    await chmod(this.#envFile, 0o600).catch(() => undefined);
    const status = await this.status();
    if (!status.configured || !status.bindingEnabled || status.bridge.running) return;
    await this.startBridge().catch((error: unknown) => {
      this.#bridgeError = error instanceof Error ? error.message : String(error);
    });
  }

  async status(): Promise<WhatsAppSetupStatus> {
    const env = await readEnvFile(this.#envFile);
    const merged = mergeEnvironment(process.env, env);
    const parsed = readWhatsAppCloudConfig(merged);
    const config = parsed.config;
    const port = parsePort(merged.CLONE_AI_WHATSAPP_PORT, 4318);
    const bindingEnabled = env.CLONE_AI_WHATSAPP_ENABLED !== "0";
    const buildId = await this.#buildId();
    const bridgeState = await readJsonFile<BridgeState>(this.#bridgeStateFile).catch(() => undefined);
    const bridgeProcessAlive = bridgeState !== undefined && await isManagedProcess(bridgeState.pid, "whatsapp-main.ts");
    const bridgeRunning = bridgeState?.running === true && bridgeState.buildId === buildId && bridgeProcessAlive;
    const tunnelState = await readJsonFile<TunnelState>(this.#tunnelStateFile).catch(() => undefined);
    const tunnelProcessRunning = tunnelState !== undefined && await isManagedProcess(tunnelState.pid, "cloudflared");
    const tunnelUrl = tunnelProcessRunning ? tunnelState?.url : undefined;
    const managedBaseUrl = this.#publicBaseUrl;
    const cloudflared = resolveExecutable("cloudflared");
    const brew = resolveExecutable("brew");
    const missing = parsed.missing;
    return {
      configured: missing.length === 0,
      bindingEnabled,
      missing,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
      verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
      allowedNumbers: (env.WHATSAPP_ALLOWED_NUMBERS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      bridge: {
        running: bridgeRunning,
        ...(bridgeState === undefined ? {} : { pid: bridgeState.pid }),
        port,
        ...(bridgeState?.webhookVerifiedAt === undefined ? {} : { webhookVerifiedAt: bridgeState.webhookVerifiedAt }),
        ...(bridgeState?.lastMessageAt === undefined ? {} : { lastMessageAt: bridgeState.lastMessageAt }),
        ...(this.#bridgeError === undefined ? {} : { error: this.#bridgeError }),
        ...(bridgeProcessAlive && !bridgeRunning ? { stale: true } : {}),
      },
      tunnel: {
        cloudflaredInstalled: managedBaseUrl !== undefined || cloudflared.resolvedPath !== undefined,
        running: managedBaseUrl !== undefined || tunnelProcessRunning,
        managed: managedBaseUrl !== undefined,
        ...(managedBaseUrl !== undefined
          ? { url: managedBaseUrl, webhookUrl: `${managedBaseUrl}/webhook` }
          : tunnelUrl === undefined ? {} : {
              url: tunnelUrl,
              webhookUrl: `${tunnelUrl}/webhook`,
            }),
        installCommand: brew.resolvedPath !== undefined
          ? "brew install cloudflared"
          : "安装 Homebrew，然后运行：brew install cloudflared",
        ...(this.#tunnelError === undefined ? {} : { error: this.#tunnelError }),
      },
      ready: missing.length === 0
        && bindingEnabled
        && bridgeRunning
        && (managedBaseUrl !== undefined || tunnelProcessRunning)
        && bridgeState?.webhookVerifiedAt !== undefined
    };
  }

  async saveBinding(input: WhatsAppSetupInput): Promise<WhatsAppSetupStatus> {
    const current = await readEnvFile(this.#envFile);
    const verifyToken = {
      ...current,
      ...(fillSecret(input.verifyToken) === undefined ? {} : { WHATSAPP_VERIFY_TOKEN: fillSecret(input.verifyToken) }),
    }.WHATSAPP_VERIFY_TOKEN || randomBytes(18).toString("base64url");
    const next: Record<string, string> = {
      ...current,
      WHATSAPP_ACCESS_TOKEN: chooseSecret(input.accessToken, current.WHATSAPP_ACCESS_TOKEN),
      WHATSAPP_PHONE_NUMBER_ID: chooseSecret(input.phoneNumberId, current.WHATSAPP_PHONE_NUMBER_ID),
      WHATSAPP_VERIFY_TOKEN: verifyToken,
      WHATSAPP_APP_SECRET: chooseSecret(input.appSecret, current.WHATSAPP_APP_SECRET),
      WHATSAPP_ALLOWED_NUMBERS: fillSecret(input.allowedNumbers) ?? current.WHATSAPP_ALLOWED_NUMBERS ?? "",
      WHATSAPP_GRAPH_VERSION: fillSecret(input.graphVersion) ?? current.WHATSAPP_GRAPH_VERSION ?? "v23.0",
      CLONE_AI_WHATSAPP_ENABLED: "1",
    };
    const parsed = readWhatsAppCloudConfig(next);
    if (parsed.config === undefined) {
      throw new WhatsAppBindingInputError(`WhatsApp 绑定还不完整：${parsed.missing.join("、")}`);
    }
    if (allowedWhatsAppNumbers(next.WHATSAPP_ALLOWED_NUMBERS.split(",")).size === 0) {
      throw new WhatsAppBindingInputError("至少填写一个允许使用手机通道的 WhatsApp 号码。");
    }
    await this.#writeEnv(next);
    this.#bridgeError = undefined;
    if ((await this.status()).bridge.running) await this.stopBridge();
    await this.startBridge();
    return this.status();
  }

  async startBridge(): Promise<void> {
    const env = await readEnvFile(this.#envFile);
    const merged = mergeEnvironment(process.env, env);
    const parsed = readWhatsAppCloudConfig(merged);
    if (parsed.config === undefined) throw new Error(`WhatsApp 绑定还不完整：${parsed.missing.join("、")}`);
    const current = await readJsonFile<BridgeState>(this.#bridgeStateFile).catch(() => undefined);
    const buildId = await this.#buildId();
    if (current?.running === true
      && current.buildId === buildId
      && await isManagedProcess(current.pid, "whatsapp-main.ts")) return;
    if (current !== undefined && await isManagedProcess(current.pid, "whatsapp-main.ts")) {
      await this.stopBridge();
    }
    const pid = await this.#spawnDetached({
      command: process.execPath,
      args: ["--experimental-strip-types", join(dirname(fileURLToPath(import.meta.url)), "whatsapp-main.ts")],
      logFile: join(this.#dataDirectory, "whatsapp-bridge.log"),
      env: {
        PATH: augmentedExecutablePath(),
        HOME: process.env.HOME ?? "",
        USER: process.env.USER ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        LANG: process.env.LANG ?? "",
        CLONE_HOME: this.#dataDirectory,
        CLONE_AI_WHATSAPP_ENV_FILE: this.#envFile,
        CLONE_AI_WHATSAPP_HOST: process.env.CLONE_AI_WHATSAPP_HOST ?? "127.0.0.1",
        CLONE_AI_WHATSAPP_PORT: process.env.CLONE_AI_WHATSAPP_PORT ?? "4318",
        CLONE_AI_WHATSAPP_BUILD_ID: buildId,
      },
    });
    await writeJsonAtomic(join(this.#dataDirectory, "whatsapp-setup-pid.json"), {
      pid,
      startedAt: new Date().toISOString(),
    }).catch(() => undefined);
    try {
      await waitFor(async () => {
        const current = await this.status();
        return current.bridge.running ? true : undefined;
      }, 8_000);
      this.#bridgeError = undefined;
    } catch {
      const log = await readFile(join(this.#dataDirectory, "whatsapp-bridge.log"), "utf8").catch(() => "");
      this.#bridgeError = tail(log) || "手机桥没有在 8 秒内启动。";
      await stopPid(pid, "whatsapp-main.ts");
      throw new Error(this.#bridgeError);
    }
  }

  async stopBridge(): Promise<void> {
    const current = await readJsonFile<BridgeState>(this.#bridgeStateFile).catch(() => undefined);
    if (current !== undefined) await stopPid(current.pid, "whatsapp-main.ts");
    await unlink(this.#bridgeStateFile).catch(() => undefined);
    this.#bridgeError = undefined;
  }

  async startTunnel(): Promise<WhatsAppSetupStatus> {
    if (this.#publicBaseUrl !== undefined) return this.status();
    const cloudflared = resolveExecutable("cloudflared");
    if (cloudflared.resolvedPath === undefined) {
      throw new Error("没有找到 cloudflared。先点击安装，或运行：brew install cloudflared");
    }
    const current = await readJsonFile<TunnelState>(this.#tunnelStateFile).catch(() => undefined);
    if (current !== undefined && await isManagedProcess(current.pid, "cloudflared")) return this.status();
    const status = await this.status();
    if (!status.bridge.running) await this.startBridge();
    const before = (await stat(this.#tunnelLogFile).catch(() => undefined))?.size ?? 0;
    const bridgeStatus = await this.status();
    const pid = await this.#spawnDetached({
      command: cloudflared.resolvedPath,
      args: ["tunnel", "--url", `http://127.0.0.1:${bridgeStatus.bridge.port}`, "--no-autoupdate"],
      logFile: this.#tunnelLogFile,
      env: {
        PATH: augmentedExecutablePath(),
        HOME: process.env.HOME ?? "",
        USER: process.env.USER ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        LANG: process.env.LANG ?? "",
      },
    });
    let url: string | undefined;
    try {
      url = await waitFor(async () => {
        const content = await readFile(this.#tunnelLogFile, "utf8").catch(() => "");
        return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(content.slice(before))?.[0];
      }, 30_000);
    } catch {
      this.#tunnelError = tail(await readFile(this.#tunnelLogFile, "utf8").catch(() => ""))
        || "cloudflared 没有在 30 秒内生成公网地址。";
      await stopPid(pid, "cloudflared");
      throw new Error(this.#tunnelError);
    }
    this.#tunnelError = undefined;
    await writeJsonAtomic(this.#tunnelStateFile, {
      pid,
      startedAt: new Date().toISOString(),
      url,
      port: bridgeStatus.bridge.port,
    } satisfies TunnelState);
    await chmod(this.#tunnelStateFile, 0o600).catch(() => undefined);
    return this.status();
  }

  async stopTunnel(): Promise<WhatsAppSetupStatus> {
    if (this.#publicBaseUrl !== undefined) return this.status();
    const current = await readJsonFile<TunnelState>(this.#tunnelStateFile).catch(() => undefined);
    if (current !== undefined) await stopPid(current.pid, "cloudflared");
    await unlink(this.#tunnelStateFile).catch(() => undefined);
    this.#tunnelError = undefined;
    return this.status();
  }

  async installCloudflared(): Promise<{ installed: boolean; output: string }> {
    if (this.#publicBaseUrl !== undefined) {
      throw new Error("服务器部署已有固定 HTTPS 入口，不需要安装 cloudflared。");
    }
    if (process.platform !== "darwin") throw new Error("一键安装目前只支持 macOS。");
    const brew = resolveExecutable("brew");
    if (brew.resolvedPath === undefined) throw new Error("没有找到 Homebrew，无法自动安装 cloudflared。");
    try {
      const result = await execFileAsync(brew.resolvedPath, ["install", "cloudflared"], {
        timeout: 5 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PATH: augmentedExecutablePath() },
      });
      return { installed: resolveExecutable("cloudflared").resolvedPath !== undefined, output: tail(`${result.stdout}\n${result.stderr}`) };
    } catch (error: unknown) {
      const detail = error as { stdout?: string; stderr?: string; message?: string };
      throw new Error(tail(`${detail.stdout ?? ""}\n${detail.stderr ?? ""}`) || detail.message || "cloudflared 安装失败。");
    }
  }

  async verifyCloudCredentials(): Promise<{ verifiedName?: string; displayPhoneNumber?: string }> {
    const parsed = readWhatsAppCloudConfig(mergeEnvironment(process.env, await readEnvFile(this.#envFile)));
    if (parsed.config === undefined) throw new Error(`WhatsApp 绑定还不完整：${parsed.missing.join("、")}`);
    const config = parsed.config;
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}`);
    url.searchParams.set("fields", "display_phone_number,verified_name");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${config.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Meta 拒绝了这组凭据（HTTP ${response.status}）。请检查 Phone Number ID 和 Access Token。`);
    }
    const body = await response.json().catch(() => ({})) as { display_phone_number?: unknown; verified_name?: unknown };
    return {
      ...(typeof body.verified_name === "string" ? { verifiedName: body.verified_name } : {}),
      ...(typeof body.display_phone_number === "string" ? { displayPhoneNumber: body.display_phone_number } : {}),
    };
  }

  async #writeEnv(values: Record<string, string>): Promise<void> {
    const ordered = [
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_ALLOWED_NUMBERS",
      "WHATSAPP_GRAPH_VERSION",
      "CLONE_AI_WHATSAPP_PORT",
      "CLONE_AI_WHATSAPP_ENABLED",
    ];
    const lines = [
      "# Clone AI WhatsApp bridge. This file must stay private.",
      ...ordered.map((key) => `${key}=${envValue(values[key] ?? "")}`),
    ];
    await mkdir(dirname(this.#envFile), { recursive: true });
    const temporary = `${this.#envFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#envFile);
    await chmod(this.#envFile, 0o600);
  }

  async #spawnDetached(input: {
    command: string;
    args: string[];
    logFile: string;
    env: NodeJS.ProcessEnv;
  }): Promise<number> {
    await mkdir(dirname(input.logFile), { recursive: true });
    const log = await open(input.logFile, "a", 0o600);
    try {
      const child = spawn(input.command, input.args, {
        cwd: this.#dataDirectory,
        detached: true,
        env: input.env,
        stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (child.pid === undefined) throw new Error("The mobile bridge process did not expose a PID.");
      child.unref();
      return child.pid;
    } finally {
      await log.close();
    }
  }

  async #buildId(): Promise<string> {
    const directory = dirname(fileURLToPath(import.meta.url));
    const files = ["whatsapp-main.ts", "whatsapp-bridge.ts", "whatsapp.ts", "whatsapp-files.ts"];
    const parts = await Promise.all(files.map(async (file) => {
      const entry = await stat(join(directory, file));
      return `${entry.size}:${Math.floor(entry.mtimeMs)}`;
    }));
    return parts.join("-");
  }
}

export function parseWhatsAppEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    values[key] = unquote(line.slice(separator + 1).trim());
  }
  return values;
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  return parseWhatsAppEnv(await readFile(path, "utf8").catch(() => ""));
}

function mergeEnvironment(base: NodeJS.ProcessEnv, values: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(values)) {
    if (value.length > 0) merged[key] = value;
  }
  return merged;
}

function chooseSecret(input: string | undefined, existing: string | undefined): string {
  return fillSecret(input) ?? existing ?? "";
}

function fillSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function envValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("WhatsApp 配置值不能包含换行。");
  return value;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isManagedProcess(pid: number, marker: string): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  try {
    const result = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    });
    return result.stdout.includes(marker);
  } catch {
    return false;
  }
}

async function stopPid(pid: number, marker: string): Promise<void> {
  if (!await isManagedProcess(pid, marker)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the deadline check and the signal.
    // 进程可能在截止检查与信号之间已经退出。
  }
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the mobile bridge.");
}

function tail(value: string): string {
  const lines = value.trim().split("\n").filter(Boolean);
  return lines.slice(-12).join("\n").slice(-2_000);
}
