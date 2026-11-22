#!/usr/bin/env node
/**
 * Install (or print) the bundled `agent-tools` MCP server in a clone home.
 *
 * Usage:
 *   node --experimental-strip-types scripts/install-agent-tools.mjs \
 *     --workspace /path/to/project [--clone-home ~/.clone] [--print]
 *
 * What it writes:
 *   <clone home>/mcp-servers/agent-tools-server.ts  a copy of the read-only server
 *   <clone home>/mcp.json                           an enabled `agent-tools` entry
 *
 * Every other MCP server in `mcp.json` is preserved. The network tool is not
 * enabled by installing: a step still needs a network scope to be offered
 * `fetch_url`.
 * 安装（或打印）clone home 中的内置 `agent-tools` MCP 服务器。
 *
 * 写入：服务器副本与已启用的 `agent-tools` 条目；`mcp.json` 中的其他服务器保持不变。
 * 安装不会自动启用网络：步骤仍需网络 Scope 才会拿到 `fetch_url`。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  agentToolsServer,
  agentToolsServerPath,
  agentToolsServerSource,
} from "../src/integrations/agent-tools-mcp.ts";
import { mergeMcpConfig } from "../src/integrations/mcp-config.ts";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const workspace = resolve(value("workspace", process.cwd()));
const cloneHome = resolve(value("clone-home", join(homedir(), ".clone")));
const printOnly = args.includes("--print");
const serverPath = agentToolsServerPath(cloneHome);
const sourcePath = agentToolsServerSource();
const server = agentToolsServer({ workspace, serverPath, nodePath: process.execPath });
const mcpFile = join(cloneHome, "mcp.json");

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const mcp = mergeMcpConfig(await readJson(mcpFile), server);

if (printOnly) {
  console.log(JSON.stringify({ mcp, serverPath, sourcePath }, null, 2));
  process.exit(0);
}

await mkdir(dirname(serverPath), { recursive: true });
await writeFile(serverPath, await readFile(sourcePath, "utf8"), "utf8");
await writeFile(mcpFile, JSON.stringify(mcp, null, 2) + "\n", "utf8");

console.log(`Installed agent-tools MCP for ${workspace}`);
console.log(`  ${serverPath}`);
console.log(`  ${mcpFile}`);
console.log("");
console.log("The worker will see these tools:");
console.log("  " + server.tools.map((tool) => `${server.id}.${tool.name} (${tool.risk})`).join(", "));
console.log("");
console.log("Read-only: no write or shell tool is declared. `fetch_url` is a network tool and is");
console.log("offered only to a step that declared a network scope. Restart the runtime to rebuild");
console.log("the worker's tool table from the new mcp.json.");
