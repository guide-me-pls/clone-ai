#!/usr/bin/env node
import { access, chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { resolveClonePaths } from "../config/clone-home.ts";
import { readJsonFile, writeJsonAtomic } from "../config/json-file.ts";
import {
  LocalMainAgentRemote,
  readWhatsAppCloudConfig,
  startWhatsAppBridgeServer,
  WhatsAppBridge,
  WhatsAppCloudSender,
  WhatsAppInboxStore,
} from "./whatsapp-bridge.ts";
import { WHATSAPP_BRIDGE_STATE_FILE_NAME, WHATSAPP_ENV_FILE_NAME } from "./whatsapp-files.ts";

/**
 * Standalone phone bridge entrypoint.
 *
 * Run this as a separate LaunchAgent from the desktop app. Keeping it outside
 * the Electron/WKWebView process means closing the window cannot kill the
 * WhatsApp listener, and the public tunnel only reaches this narrow HTTP
 * surface instead of the companion API.
 *
 * 独立手机桥入口。
 *
 * 它应作为单独的 LaunchAgent 运行，与桌面 App 分离。这样关闭窗口不会杀死 WhatsApp
 * 监听，公网隧道也只能触达这层很窄的 HTTP 面，而不是 Companion API。
 */
export async function runWhatsAppBridge(): Promise<number> {
  const paths = resolveClonePaths();
  const releaseLock = await acquireBridgeLock(paths.dataDirectory);
  const envFile = process.env.CLONE_AI_WHATSAPP_ENV_FILE?.trim()
    || join(paths.dataDirectory, WHATSAPP_ENV_FILE_NAME);
  if (await exists(envFile)) {
    const mode = (await stat(envFile)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(`${envFile} is readable by other users; run chmod 600 on it.`);
      await releaseLock();
      return 1;
    }
    loadEnvFile(envFile);
  } else if (process.env.CLONE_AI_WHATSAPP_ENV_FILE !== undefined) {
    console.error("CLONE_AI_WHATSAPP_ENV_FILE points to a file that does not exist.");
    await releaseLock();
    return 1;
  }
  const { config, missing } = readWhatsAppCloudConfig(process.env);
  if (config === undefined) {
    console.error(`WhatsApp bridge is not configured. Missing: ${missing.join(", ")}`);
    await releaseLock();
    return 1;
  }
  const store = new WhatsAppInboxStore(join(paths.dataDirectory, "whatsapp-inbox.sqlite3"));
  const statusFile = join(paths.dataDirectory, WHATSAPP_BRIDGE_STATE_FILE_NAME);
  const previousStatus = await readJsonFile<{
    webhookVerifiedAt?: string;
    lastMessageAt?: string;
  }>(statusFile).catch(() => undefined);
  const startedAt = new Date().toISOString();
  let webhookVerifiedAt = previousStatus?.webhookVerifiedAt;
  let lastMessageAt = previousStatus?.lastMessageAt;
  const writeStatus = async (running: boolean): Promise<void> => {
    await writeJsonAtomic(statusFile, {
      pid: process.pid,
      running,
      buildId: process.env.CLONE_AI_WHATSAPP_BUILD_ID ?? "",
      startedAt,
      ...(webhookVerifiedAt === undefined ? {} : { webhookVerifiedAt }),
      ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    });
    await chmod(statusFile, 0o600).catch(() => undefined);
  };
  const bridge = new WhatsAppBridge({
    config,
    store,
    sender: new WhatsAppCloudSender(config),
    mainAgent: new LocalMainAgentRemote(paths.dataDirectory),
    approvalDirectory: paths.dataDirectory,
    log: (event) => console.log(JSON.stringify(event)),
    onWebhookVerified: () => {
      webhookVerifiedAt = new Date().toISOString();
      void writeStatus(true);
    },
    onMessageAccepted: () => {
      lastMessageAt = new Date().toISOString();
      void writeStatus(true);
    },
  });
  bridge.startApprovals();
  bridge.kick();
  const server = await startWhatsAppBridgeServer({ config, bridge });
  await writeStatus(true);
  console.log(JSON.stringify({
    event: "whatsapp.bridge.ready",
    url: server.url,
    inbox: store.counts(),
  }));
  const shutdown = async (): Promise<void> => {
    bridge.stop();
    await server.close();
    store.close();
    await writeStatus(false).catch(() => undefined);
    await releaseLock();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  return new Promise<number>(() => undefined);
}

/**
 * Refuse a second bridge for the same clone home.
 *
 * Two processes draining one inbox can requeue each other's in-flight turns.
 * The lock contains only a PID and timestamp; a dead owner is reclaimed.
 *
 * 同一个 Clone Home 只允许一个桥进程。
 *
 * 两个进程同时消费一个收件箱，会把对方正在处理的回合重新排队。锁文件只含 PID 与
 * 时间戳；持有者已经死亡时允许回收。
 */
async function acquireBridgeLock(dataDirectory: string): Promise<() => Promise<void>> {
  await mkdir(dataDirectory, { recursive: true });
  const path = join(dataDirectory, "whatsapp-bridge.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => {
        await unlink(path).catch(() => undefined);
      };
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      const owner = await readLockOwner(path);
      if (owner !== undefined && isProcessAlive(owner)) {
        throw new Error(`The Clone AI WhatsApp bridge is already running as PID ${owner}.`);
      }
      await unlink(path).catch(() => undefined);
    }
  }
  throw new Error("Could not acquire the Clone AI WhatsApp bridge lock.");
}

async function readLockOwner(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWhatsAppBridge()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
