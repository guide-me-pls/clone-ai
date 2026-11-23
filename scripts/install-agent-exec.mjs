#!/usr/bin/env node
/**
 * Install (or print) the bundled `agent-exec` MCP server in a clone home.
 *
 * Usage:
 *   node --experimental-strip-types scripts/install-agent-exec.mjs \
 *     --workspace /path/to/project [--clone-home ~/.clone] [--print] [--replace]
 *
 * What it writes:
 *   <clone home>/mcp-servers/agent-exec-server.ts  a copy of the sandboxed server
 *   <clone home>/agent-exec.sandbox                the Seatbelt profile
 *   <clone home>/agent-exec.json                   the owner-written command allowlist
 *   <clone home>/mcp.json                          an enabled `agent-exec` entry
 *
 * The `--print` flag writes nothing. Existing commands in agent-exec.json are
 * preserved unless `--replace` is passed; detected commands are added by name.
 * 安装（或打印）clone home 中的内置 `agent-exec` MCP 服务器。
 *
 * 写入：服务器副本、Seatbelt profile、命令白名单与 `mcp.json` 条目。`--print` 不写任何文件。
 * 已有的 agent-exec.json 命令默认保留，检测到的命令按名字追加；`--replace` 才会替换。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  agentExecConfigPath,
  agentExecSandboxPath,
  agentExecSandboxProfile,
  agentExecServer,
  agentExecServerPath,
  agentExecServerSource,
  detectAgentExecCommands,
  mergeAgentExecCommands,
} from "../src/integrations/agent-exec-mcp.ts";
import { mergeMcpConfig } from "../src/integrations/mcp-config.ts";
import { parseAgentExecConfig } from "../src/mcp/agent-exec-server.ts";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const workspace = resolve(value("workspace", process.cwd()));
const cloneHome = resolve(value("clone-home", join(homedir(), ".clone")));
const printOnly = args.includes("--print");
const replace = args.includes("--replace");
const home = homedir();

const workspaceInfo = await stat(workspace).catch(() => undefined);
if (workspaceInfo === undefined || !workspaceInfo.isDirectory()) {
  console.error(`--workspace must be an existing directory: ${workspace}`);
  process.exit(2);
}
if (workspace === home || workspace === "/") {
  console.error("--workspace must not be the home directory or the filesystem root.");
  process.exit(2);
}

const serverPath = agentExecServerPath(cloneHome);
const configPath = agentExecConfigPath(cloneHome);
const sandboxPath = agentExecSandboxPath(cloneHome);
const mcpFile = join(cloneHome, "mcp.json");

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let existingCommands = [];
let allowUnsandboxed = false;
const existingRaw = await readJson(configPath);
if (existingRaw !== undefined) {
  const parsed = parseAgentExecConfig(existingRaw, configPath);
  if (parsed.config === undefined) {
    console.error(parsed.errors.join("\n"));
    console.error(`Fix or remove ${configPath}; refusing to overwrite an invalid allowlist.`);
    process.exit(1);
  }
  existingCommands = parsed.config.commands;
  allowUnsandboxed = parsed.config.allowUnsandboxed === true;
}

const detected = await detectAgentExecCommands(workspace);
const commands = replace ? detected : mergeAgentExecCommands(existingCommands, detected);
const config = {
  workspace,
  commands,
  sandboxProfile: sandboxPath,
  ...(allowUnsandboxed ? { allowUnsandboxed: true } : {}),
};
const profile = agentExecSandboxProfile(workspace);
const server = agentExecServer({ workspace, serverPath, configPath, nodePath: process.execPath });
const mcp = mergeMcpConfig(await readJson(mcpFile), server);

if (printOnly) {
  console.log(JSON.stringify({ config, profile, mcp, serverPath, configPath, sandboxPath }, null, 2));
  process.exit(0);
}

await mkdir(dirname(serverPath), { recursive: true });
await writeFile(serverPath, await readFile(agentExecServerSource(), "utf8"), "utf8");
await writeFile(sandboxPath, profile, "utf8");
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
await writeFile(mcpFile, JSON.stringify(mcp, null, 2) + "\n", "utf8");

console.log(`Installed agent-exec MCP for ${workspace}`);
console.log(`  ${serverPath}`);
console.log(`  ${sandboxPath}`);
console.log(`  ${configPath}`);
console.log(`  ${mcpFile}`);
console.log("");
if (commands.length === 0) {
  console.log("No test command was detected. Add commands to agent-exec.json before relying on it.");
} else {
  console.log("The worker can run:");
  for (const command of commands) console.log(`  ${command.name}: ${command.argv.join(" ")}`);
}
console.log("");
console.log("Commands run without a shell, in a minimal environment, under the macOS sandbox:");
console.log("writes stay in the workspace and temp, network is off, protected locations and .git are read-only.");
if (process.platform === "darwin") {
  const { existsSync } = await import("node:fs");
  if (!existsSync("/usr/bin/sandbox-exec")) {
    console.log("WARNING: /usr/bin/sandbox-exec is missing; run_command will refuse to execute.");
  }
} else {
  console.log("WARNING: this platform has no sandbox; run_command refuses unless allowUnsandboxed is set.");
}
console.log("Restart the runtime to rebuild the worker's tool table from the new mcp.json.");
