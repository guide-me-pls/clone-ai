import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sandboxAvailable } from "./black-box-cli-worker.ts";
import { listEffectiveProviderConfigs } from "../config/provider-config-store.ts";
import type { ProviderId } from "../config/worker-settings.ts";
import {
  resolveExecutable,
  type ExecutableResolutionSource,
} from "./executable-resolver.ts";

const execFileAsync = promisify(execFile);

export interface WorkerProviderStatus {
  id: ProviderId;
  title: string;
  command: string;
  args: string[];
  env: string[];
  promptVia?: "arg" | "stdin";
  purpose: string;
  installed: boolean;
  installable: boolean;
  userConfigured: boolean;
  executionBlocked: boolean;
  resolvedPath?: string;
  resolutionSource?: ExecutableResolutionSource;
  hostAccess?: "unrestricted";
  sandbox?: "seatbelt";
  version?: string;
}

const installers: Readonly<Record<string, { command: string; args: string[] }>> = {
  "codex-cli": { command: "npm", args: ["install", "-g", "@openai/codex"] },
  "claude-code": { command: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] },
  pi: { command: "npm", args: ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"] },
};

/**
 * Inspect every configured black-box command through one generic registry.
 * 新增 Provider 不需要增加 Agent 分支；所有黑盒命令都通过同一个通用 Registry 检测。
 */
export class WorkerRegistry {
  readonly #dataDirectory: string;

  constructor(dataDirectory: string) {
    this.#dataDirectory = dataDirectory;
  }

  async list(): Promise<WorkerProviderStatus[]> {
    const configs = await listEffectiveProviderConfigs(this.#dataDirectory);
    const providerStore = await import("../config/provider-config-store.ts");
    const userIds = new Set((await providerStore.readUserProviderConfigs(this.#dataDirectory)).map((provider) => provider.id));
    return Promise.all(configs.map((config) => inspect(config, userIds.has(config.id))));
  }

  async install(id: ProviderId): Promise<WorkerProviderStatus> {
    const installer = installers[id];
    if (installer === undefined) throw new Error(`Provider ${id} has no automatic installer; install its command and restart Clone AI.`);
    const resolution = resolveExecutable(commandForPlatform(installer.command));
    await execFileAsync(resolution.resolvedPath ?? commandForPlatform(installer.command), installer.args, {
      windowsHide: true,
      timeout: 120_000,
    });
    const provider = (await this.list()).find((candidate) => candidate.id === id);
    if (provider === undefined) throw new Error(`Provider ${id} disappeared after installation.`);
    if (!provider.installed) throw new Error(`Provider ${id} was not found on PATH after installation.`);
    return provider;
  }
}

async function inspect(config: Awaited<ReturnType<typeof listEffectiveProviderConfigs>>[number], userConfigured: boolean): Promise<WorkerProviderStatus> {
  const resolution = resolveExecutable(config.command);
  return view(config, userConfigured, resolution.resolvedPath !== undefined, resolution);
}

function view(
  config: Awaited<ReturnType<typeof listEffectiveProviderConfigs>>[number],
  userConfigured: boolean,
  installed: boolean,
  resolution?: ReturnType<typeof resolveExecutable>,
  version?: string,
): WorkerProviderStatus {
  return {
    id: config.id,
    title: config.label ?? config.id,
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? [],
    ...(config.promptVia === undefined ? {} : { promptVia: config.promptVia }),
    purpose: `Black-box provider: ${config.label ?? config.id}`,
    installed,
    installable: installers[config.id] !== undefined,
    userConfigured,
    executionBlocked: config.hostAccess !== "unrestricted" && !sandboxAvailable(config),
    ...(resolution?.resolvedPath === undefined ? {} : { resolvedPath: resolution.resolvedPath }),
    ...(resolution?.source === undefined ? {} : { resolutionSource: resolution.source }),
    ...(config.hostAccess === "unrestricted" ? { hostAccess: "unrestricted" as const } : {}),
    ...(config.sandbox === "seatbelt" ? { sandbox: "seatbelt" as const } : {}),
    ...(version === undefined ? {} : { version }),
  };
}

function commandForPlatform(command: string): string {
  return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}
