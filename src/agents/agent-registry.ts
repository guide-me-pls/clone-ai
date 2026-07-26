import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ProviderId } from "../settings/agent-settings.ts";

const execFileAsync = promisify(execFile);

interface AgentDefinition {
  id: ProviderId;
  title: string;
  command: string;
  install: { command: string; args: string[] };
  purpose: string;
}

export interface AgentProviderView {
  id: ProviderId;
  title: string;
  command: string;
  purpose: string;
  installed: boolean;
  version?: string;
}

const definitions: AgentDefinition[] = [
  {
    id: "codex-cli",
    title: "Codex CLI",
    command: "codex",
    install: { command: "npm", args: ["install", "-g", "@openai/codex"] },
    purpose: "用于长程编码、实现、测试和可验证交付。",
  },
  {
    id: "claude-code",
    title: "Claude Code",
    command: "claude",
    install: { command: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] },
    purpose: "用于代码探索、协作式实现和复杂上下文工作。",
  },
  {
    id: "pi",
    title: "Pi",
    command: "pi",
    install: { command: "npm", args: ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"] },
    purpose: "用于可扩展的终端 Agent、技能和自定义工作流。",
  },
];

export class LocalAgentRegistry {
  async list(): Promise<AgentProviderView[]> {
    return Promise.all(definitions.map((definition) => inspect(definition)));
  }

  async install(id: ProviderId): Promise<AgentProviderView> {
    const definition = definitions.find((candidate) => candidate.id === id);
    if (definition === undefined) {
      throw new Error("The requested local Agent is not supported.");
    }
    await execFileAsync(commandForPlatform(definition.install.command), definition.install.args, { windowsHide: true, timeout: 120_000 });
    return inspect(definition);
  }
}

async function inspect(definition: AgentDefinition): Promise<AgentProviderView> {
  const command = executableFor(definition.command);
  try {
    const result = await execFileAsync(command, ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32" && command.endsWith(".cmd"),
      timeout: 4_000,
      windowsHide: true,
    });
    const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/)[0];
    return { id: definition.id, title: definition.title, command: definition.command, purpose: definition.purpose, installed: true, version: version.length > 0 ? version : undefined };
  } catch (error: unknown) {
    const result = error as { stdout?: string; stderr?: string };
    const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/)[0];
    return { id: definition.id, title: definition.title, command: definition.command, purpose: definition.purpose, installed: false, version: version.length > 0 ? version : undefined };
  }
}

function commandForPlatform(command: string): string {
  return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

function executableFor(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const npmExecutable = join(process.env.APPDATA ?? "", "npm", `${command}.cmd`);
  return existsSync(npmExecutable) ? npmExecutable : command;
}
