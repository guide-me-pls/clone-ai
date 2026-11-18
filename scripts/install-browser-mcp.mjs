#!/usr/bin/env node
/**
 * Install (or print) the local Playwright MCP entry in a clone home.
 *
 * Usage:
 *   node --experimental-strip-types scripts/install-browser-mcp.mjs \
 *     --workspace /path/to/project [--port 8135] [--clone-home ~/.clone] [--print]
 *
 * What it writes:
 *   <clone home>/mcp.json       enabled `playwright` server, local observation tools
 *   <clone home>/policies.json  a narrow standing policy for 127.0.0.1 read
 *
 * It does not start the preview server; run `scripts/serve-workspace.mjs`.
 * 安装（或打印）clone home 中的本地 Playwright MCP 条目。
 * 不会启动预览服务器；预览服务器由 `scripts/serve-workspace.mjs` 启动。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  BROWSER_MCP_DEFAULT_PORT,
  browserMcpInstructions,
  browserMcpPolicy,
  browserMcpServer,
  mergeAuthority,
  mergeMcpConfig,
} from "../src/integrations/browser-mcp.ts";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const workspace = resolve(value("workspace", process.cwd()));
const port = Number(value("port", String(BROWSER_MCP_DEFAULT_PORT)));
const cloneHome = resolve(value("clone-home", join(homedir(), ".clone")));
const printOnly = args.includes("--print");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("--port must be an integer between 1 and 65535.");
  process.exit(2);
}

const mcpFile = join(cloneHome, "mcp.json");
const policiesFile = join(cloneHome, "policies.json");
const server = browserMcpServer(workspace, port);
const policy = browserMcpPolicy();

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const mcp = mergeMcpConfig(await readJson(mcpFile), server);
const authority = mergeAuthority(await readJson(policiesFile), policy);

if (printOnly) {
  console.log(JSON.stringify({ mcp, authority }, null, 2));
  console.log("\n" + browserMcpInstructions(port));
  process.exit(0);
}

await mkdir(dirname(mcpFile), { recursive: true });
await writeFile(mcpFile, JSON.stringify(mcp, null, 2) + "\n", "utf8");
await writeFile(policiesFile, JSON.stringify(authority, null, 2) + "\n", "utf8");

console.log(`Installed browser MCP for ${workspace}`);
console.log(`  ${mcpFile}`);
console.log(`  ${policiesFile}`);
console.log("");
console.log("Start the read-only preview server in another terminal:");
console.log(`  node scripts/serve-workspace.mjs --root ${workspace} --port ${port}`);
console.log("");
console.log("The worker will see these tools:");
console.log("  " + server.tools.map((tool) => `${server.id}.${tool.name} (${tool.risk})`).join(", "));
console.log("");
console.log("Safety: the browser is headless, rooted at the workspace, limited to the local origin,");
console.log("and only the observation subset is declared (no browser_run_code_unsafe, no file upload).");
