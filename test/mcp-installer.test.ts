import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { readToolCatalog } from "../src/mcp/mcp-catalog.ts";
import { installMcpServer, probeMcpPackage, removeMcpServer, resolveNpxCommand, type ProbedTool } from "../src/mcp/mcp-installer.ts";
import { environmentFor } from "../src/workers/mcp-client.ts";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A stdio MCP server with two tools. 一个带两个工具的 stdio MCP 服务器。 */
const FAKE_SERVER = `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }) + "\\n");
      continue;
    }
    if (message.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "read_thing", description: "Read a thing" }, { name: "write_thing", description: "Write a thing" }] } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } }) + "\\n");
  }
});
`;

async function fakeServer(directory: string): Promise<string> {
  const path = join(directory, "fake-mcp-server.mjs");
  await writeFile(path, FAKE_SERVER);
  await chmod(path, 0o755);
  return path;
}

const probed: ProbedTool[] = [
  { name: "read_thing", description: "Read a thing", inputSchema: {} },
  { name: "write_thing", description: "Write a thing", inputSchema: {} },
];

function injectedProbe(tools: ProbedTool[] = probed): (input: { command: string; args: string[] }) => Promise<ProbedTool[]> {
  return async () => tools;
}

test("probing a package returns its tools and closes the process", async (t) => {
  const directory = await tempDir(t, "clone-mcp-probe-");
  const serverPath = await fakeServer(directory);

  const tools = await probeMcpPackage({
    id: "fake",
    command: process.execPath,
    args: [serverPath],
    cwd: directory,
    timeoutMs: 10_000,
  });

  assert.deepEqual(tools.map((tool) => tool.name), ["read_thing", "write_thing"]);
  assert.equal(tools[0]?.description, "Read a thing");
});

test("installing without the owner's acknowledgement writes nothing", async (t) => {
  const home = await tempDir(t, "clone-mcp-install-home-");
  const workspace = await tempDir(t, "clone-mcp-install-ws-");

  await assert.rejects(
    installMcpServer({
      dataDirectory: home,
      workspacePath: workspace,
      id: "fake",
      package: "pkg@1.0.0",
      tools: [{ name: "read_thing", risk: "read" }],
      acknowledgeInstall: false,
      probe: injectedProbe(),
    }),
    /owner must confirm/,
  );
  await assert.rejects(readFile(join(home, "mcp.json"), "utf8"), /ENOENT/);
});

test("the package spec must be an npm name", async (t) => {
  const home = await tempDir(t, "clone-mcp-install-home-");
  const workspace = await tempDir(t, "clone-mcp-install-ws-");

  for (const spec of ["", "not a package", "-oops", "../escape"]) {
    await assert.rejects(
      installMcpServer({
        dataDirectory: home,
        workspacePath: workspace,
        id: "fake",
        package: spec,
        tools: [{ name: "read_thing", risk: "read" }],
        acknowledgeInstall: true,
        probe: injectedProbe(),
      }),
      /package spec is required|not an npm package spec/,
      `expected "${spec}" to be refused`,
    );
  }
});

test("a package that exposes an undeclared tool is refused", async (t) => {
  const home = await tempDir(t, "clone-mcp-install-home-");
  const workspace = await tempDir(t, "clone-mcp-install-ws-");

  await assert.rejects(
    installMcpServer({
      dataDirectory: home,
      workspacePath: workspace,
      id: "fake",
      package: "pkg@1.0.0",
      tools: [{ name: "read_thing", risk: "read" }],
      acknowledgeInstall: true,
      probe: injectedProbe(),
    }),
    /does not declare \(write_thing\)/,
  );
  await assert.rejects(readFile(join(home, "mcp.json"), "utf8"), /ENOENT/);
});

test("a duplicate server id is refused", async (t) => {
  const home = await tempDir(t, "clone-mcp-install-home-");
  const workspace = await tempDir(t, "clone-mcp-install-ws-");
  await writeFile(join(home, "mcp.json"), JSON.stringify({ servers: [{ id: "fake", enabled: true, command: "node" }] }, null, 2));

  await assert.rejects(
    installMcpServer({
      dataDirectory: home,
      workspacePath: workspace,
      id: "fake",
      package: "pkg@1.0.0",
      tools: [{ name: "read_thing", risk: "read" }],
      acknowledgeInstall: true,
      probe: injectedProbe(),
    }),
    /already installed/,
  );
});

test("installing writes one enabled entry with the owner's risks and keeps the rest of the file", async (t) => {
  const home = await tempDir(t, "clone-mcp-install-home-");
  const workspace = await tempDir(t, "clone-mcp-install-ws-");
  await writeFile(join(home, "mcp.json"), JSON.stringify({
    version: 3,
    extra: { keep: true },
    servers: [{ id: "old", enabled: true, command: "node" }],
  }, null, 2));

  const npx = resolveNpxCommand();
  const catalog = await installMcpServer({
    dataDirectory: home,
    workspacePath: workspace,
    id: "fake",
    package: "@scope/pkg@1.2.3",
    args: ["--flag", "value"],
    tools: [
      { name: "read_thing", risk: "read", pathField: "path" },
      { name: "write_thing", risk: "write" },
    ],
    acknowledgeInstall: true,
    probe: async (input) => {
      assert.equal(input.command, npx);
      assert.deepEqual(input.args, ["--yes", "@scope/pkg@1.2.3", "--flag", "value"]);
      assert.equal(input.cwd, workspace);
      return probed;
    },
  });

  const raw = JSON.parse(await readFile(join(home, "mcp.json"), "utf8")) as {
    version: number;
    extra: { keep: boolean };
    servers: Array<{ id: string; enabled: boolean; command: string; args: string[]; tools: Array<{ name: string; risk: string; pathField?: string }> }>;
  };
  assert.equal(raw.version, 3, "unknown top-level fields survive");
  assert.deepEqual(raw.extra, { keep: true });
  assert.deepEqual(raw.servers.map((server) => server.id), ["old", "fake"]);
  const installed = raw.servers[1]!;
  assert.equal(installed.enabled, true);
  assert.equal(installed.command, npx);
  assert.deepEqual(installed.args, ["--yes", "@scope/pkg@1.2.3", "--flag", "value"]);
  assert.deepEqual(installed.tools, [
    { name: "read_thing", risk: "read", pathField: "path" },
    { name: "write_thing", risk: "write" },
  ]);
  assert.equal((await stat(join(home, "mcp.json"))).mode & 0o777, 0o600, "mcp.json stays owner-only");

  const entry = catalog.servers.find((server) => server.id === "fake");
  assert.deepEqual(entry?.tools.map((tool) => [tool.name, tool.risk]), [["read_thing", "read"], ["write_thing", "write"]]);
});

test("removing a server deletes only that entry", async (t) => {
  const home = await tempDir(t, "clone-mcp-remove-home-");
  const workspace = await tempDir(t, "clone-mcp-remove-ws-");
  await writeFile(join(home, "mcp.json"), JSON.stringify({
    servers: [
      { id: "keep", enabled: true, command: "node" },
      { id: "drop", enabled: true, command: "node" },
    ],
  }, null, 2));

  const catalog = await removeMcpServer(home, workspace, "drop");
  const raw = JSON.parse(await readFile(join(home, "mcp.json"), "utf8")) as { servers: Array<{ id: string }> };
  assert.deepEqual(raw.servers.map((server) => server.id), ["keep"]);
  assert.equal(catalog.servers.some((server) => server.id === "drop"), false);
  await assert.rejects(removeMcpServer(home, workspace, "drop"), /No MCP server named/);
});

test("the catalog projects the installed server without its command", async (t) => {
  const home = await tempDir(t, "clone-mcp-catalog-home-");
  const workspace = await tempDir(t, "clone-mcp-catalog-ws-");
  await installMcpServer({
    dataDirectory: home,
    workspacePath: workspace,
    id: "fake",
    package: "pkg@1.0.0",
    tools: [{ name: "read_thing", risk: "read" }],
    acknowledgeInstall: true,
    probe: injectedProbe([probed[0]!]),
  });

  const catalog = await readToolCatalog(home, workspace);
  assert.deepEqual(catalog.mcpErrors, []);
  const serialized = JSON.stringify(catalog);
  assert.equal(serialized.includes("\"command\""), false, "the projection drops the command");
  assert.deepEqual(catalog.servers.map((server) => [server.id, server.enabled, server.tools.length]), [["fake", true, 1]]);
});

test("an install carries environment values to the probe and into mcp.json", async (t) => {
  const home = await tempDir(t, "clone-mcp-env-home-");
  const workspace = await tempDir(t, "clone-mcp-env-ws-");
  const memoryFile = join(home, "mcp-memory.jsonl");
  let seen: Record<string, string> | undefined;
  await installMcpServer({
    dataDirectory: home,
    workspacePath: workspace,
    id: "keeper",
    package: "pkg@1.0.0",
    env: { MEMORY_FILE_PATH: memoryFile },
    tools: [{ name: "read_thing", risk: "read" }, { name: "write_thing", risk: "write" }],
    acknowledgeInstall: true,
    probe: async (input) => {
      seen = input.env;
      return probed;
    },
  });
  assert.deepEqual(seen, { MEMORY_FILE_PATH: memoryFile });
  const raw = JSON.parse(await readFile(join(home, "mcp.json"), "utf8")) as { servers: Array<{ env?: Record<string, string> }> };
  assert.deepEqual(raw.servers[0]?.env, { MEMORY_FILE_PATH: memoryFile });
  const serialized = JSON.stringify(await readToolCatalog(home, workspace));
  assert.equal(serialized.includes("MEMORY_FILE_PATH"), false, "the catalog projection drops env");
});

test("an invalid environment is refused before anything is probed or written", async (t) => {
  const home = await tempDir(t, "clone-mcp-env-bad-home-");
  const workspace = await tempDir(t, "clone-mcp-env-bad-ws-");
  let probedNow = false;
  const probe = async (): Promise<ProbedTool[]> => {
    probedNow = true;
    return probed;
  };
  for (const env of [{ "BAD-NAME": "x" }, { OK: 7 }, "not-an-object"]) {
    await assert.rejects(
      installMcpServer({
        dataDirectory: home,
        workspacePath: workspace,
        id: "keeper",
        package: "pkg@1.0.0",
        env,
        tools: [{ name: "read_thing", risk: "read" }],
        acknowledgeInstall: true,
        probe,
      }),
      /valid environment variable name|env\..* must be a string|env must be an object/,
      `expected ${JSON.stringify(env)} to be refused`,
    );
  }
  assert.equal(probedNow, false, "the probe must not run for an invalid environment");
  await assert.rejects(readFile(join(home, "mcp.json"), "utf8"), /ENOENT/);
});

test("npx resolves next to the runtime's Node and runs with the daemon's minimal PATH", async () => {
  const npx = resolveNpxCommand();
  assert.match(npx, /npx$/, "the resolver must name an npx");
  const env = environmentFor({ env: {} }, { PATH: "/usr/bin:/bin", HOME: process.env.HOME });
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(npx, ["--version"], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, `npx did not run with a launchd PATH: ${result.stderr || result.error?.message || ""}`);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
