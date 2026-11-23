/**
 * Tests for the sandboxed agent-exec MCP server, its allowlist and installer helpers.
 * 沙箱化 agent-exec MCP 服务器、其白名单与安装器辅助函数的测试。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_TIMEOUT_MS,
  MAX_STREAM_BYTES,
  parseAgentExecConfig,
  runTool,
  toolDefinitions,
  type AgentExecCommand,
  type AgentExecConfigLoad,
} from "../src/mcp/agent-exec-server.ts";
import {
  AGENT_EXEC_SERVER_ID,
  agentExecSandboxProfile,
  agentExecServer,
  agentExecToolDeclarations,
  detectAgentExecCommands,
  mergeAgentExecCommands,
} from "../src/integrations/agent-exec-mcp.ts";
import { mergeMcpConfig } from "../src/integrations/mcp-config.ts";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function sandboxFile(t: TestContext, workspace: string): Promise<string> {
  const directory = await tempDir(t, "agent-exec-profile-");
  const path = join(directory, "profile.sb");
  await writeFile(path, agentExecSandboxProfile(workspace), "utf8");
  return path;
}

function loadConfig(workspace: string, commands: AgentExecCommand[], sandboxProfile?: string, allowUnsandboxed = false): AgentExecConfigLoad {
  return {
    config: {
      workspace,
      commands,
      ...(sandboxProfile === undefined ? {} : { sandboxProfile }),
      ...(allowUnsandboxed ? { allowUnsandboxed: true } : {}),
    },
    errors: [],
  };
}

const nodeEval = (source: string): string[] => [process.execPath, "-e", source];

test("agent-exec declares a read lister and a write command runner", () => {
  const declarations = agentExecToolDeclarations();
  const byName = new Map(declarations.map((tool) => [tool.name, tool]));
  assert.deepEqual(declarations.map((tool) => tool.name).sort(), ["list_commands", "run_command"]);
  assert.equal(byName.get("list_commands")?.risk, "read");
  assert.equal(byName.get("run_command")?.risk, "write");
  assert.equal(byName.get("run_command")?.pathField, undefined);
  for (const tool of declarations) assert.ok((tool.description ?? "").length > 30, `${tool.name} description is too short`);
  assert.deepEqual(toolDefinitions().map((tool) => tool.name).sort(), ["list_commands", "run_command"]);
});

test("the server entry pins the workspace, node path and config path", () => {
  const server = agentExecServer({
    workspace: "/tmp/project",
    serverPath: "/clone/mcp-servers/agent-exec-server.ts",
    configPath: "/clone/agent-exec.json",
    nodePath: "/usr/local/bin/node",
  });
  assert.equal(server.id, AGENT_EXEC_SERVER_ID);
  assert.equal(server.enabled, true);
  assert.equal(server.transport, "stdio");
  assert.equal(server.command, "/usr/local/bin/node");
  assert.deepEqual(server.args, ["--experimental-strip-types", "/clone/mcp-servers/agent-exec-server.ts", "--config", "/clone/agent-exec.json"]);
  assert.equal(server.cwd, "/tmp/project");
  assert.equal(server.timeoutMs, 660_000);
  assert.equal(DEFAULT_TIMEOUT_MS, 240_000);
  assert.equal(MAX_STREAM_BYTES, 50_000);
});

test("mergeMcpConfig preserves another server and the agent-exec entry is idempotent", () => {
  const server = agentExecServer({ workspace: "/w", serverPath: "/clone/a.ts", configPath: "/clone/a.json", nodePath: "/node" });
  const merged = mergeMcpConfig({ servers: [{ id: "agent-tools", enabled: true, command: "x" }, { id: AGENT_EXEC_SERVER_ID, enabled: false, command: "old" }] }, server);
  assert.equal(merged.servers.length, 2);
  assert.ok(merged.servers.some((entry) => entry.id === "agent-tools"));
  assert.equal(merged.servers.find((entry) => entry.id === AGENT_EXEC_SERVER_ID)?.enabled, true);
  assert.deepEqual(mergeMcpConfig(merged, server), merged);
});

test("the config parser accepts a valid allowlist and caps a timeout", () => {
  const parsed = parseAgentExecConfig({
    workspace: "/tmp/project",
    sandboxProfile: "/tmp/profile.sb",
    allowUnsandboxed: false,
    commands: [{ name: "test", argv: ["npm", "run", "test"], description: "tests", timeoutMs: 999_999_999 }],
  });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.config?.workspace, "/tmp/project");
  assert.equal(parsed.config?.commands[0]?.timeoutMs, 600_000);
  assert.equal(parsed.config?.allowUnsandboxed, undefined);
});

test("the config parser reports every malformed allowlist entry", () => {
  const parsed = parseAgentExecConfig({
    workspace: "relative/path",
    sandboxProfile: "relative.sb",
    commands: [
      { name: "bad name", argv: ["x"] },
      { name: "dup", argv: ["x"] },
      { name: "dup", argv: ["y"] },
      { name: "empty", argv: [] },
      { name: "control", argv: ["x\n"] },
      "not an object",
    ],
  });
  assert.equal(parsed.config, undefined);
  assert.ok(parsed.errors.some((error) => /workspace/.test(error)));
  assert.ok(parsed.errors.some((error) => /sandboxProfile/.test(error)));
  assert.ok(parsed.errors.some((error) => /name/.test(error)));
  assert.ok(parsed.errors.some((error) => /duplicate/.test(error)));
  assert.ok(parsed.errors.some((error) => /argv/.test(error)));
  assert.ok(parsed.errors.some((error) => /commands\[5\]/.test(error)));
});

test("the Seatbelt profile confines writes, denies network and protects .git", async (t) => {
  const workspace = await tempDir(t, "agent-exec-profile-ws-");
  const profile = agentExecSandboxProfile(workspace);
  const realWorkspace = realpathSync(workspace);
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, new RegExp(realWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(profile, new RegExp(`${realWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.git`));
  assert.match(profile, /deny file-write\*/);
  assert.throws(() => agentExecSandboxProfile(homedir()), /home directory|filesystem root/);
  assert.throws(() => agentExecSandboxProfile("/"), /home directory|filesystem root/);
});

test("detectAgentExecCommands takes only safe package scripts", async (t) => {
  const workspace = await tempDir(t, "agent-exec-detect-npm-");
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    scripts: { test: "node --test", typecheck: "tsc --noEmit", lint: "eslint .", deploy: "ship it", check: "npm run lint", gate: "gate", build: "build" },
  }));
  const commands = await detectAgentExecCommands(workspace);
  assert.deepEqual(commands.map((command) => command.name).sort(), ["build", "check", "gate", "lint", "test", "typecheck"]);
  assert.deepEqual(commands.find((command) => command.name === "test")?.argv, ["npm", "run", "test"]);
  assert.equal(commands.some((command) => command.name === "deploy"), false);
});

test("detectAgentExecCommands recognises the other project types", async (t) => {
  const python = await tempDir(t, "agent-exec-detect-py-");
  await writeFile(join(python, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  assert.deepEqual((await detectAgentExecCommands(python))[0]?.argv, ["python3", "-m", "pytest"]);

  const go = await tempDir(t, "agent-exec-detect-go-");
  await writeFile(join(go, "go.mod"), "module example\n");
  assert.deepEqual((await detectAgentExecCommands(go))[0]?.argv, ["go", "test", "./..."]);

  const rust = await tempDir(t, "agent-exec-detect-rust-");
  await writeFile(join(rust, "Cargo.toml"), "[package]\nname = \"x\"\n");
  assert.deepEqual((await detectAgentExecCommands(rust))[0]?.argv, ["cargo", "test"]);

  const maven = await tempDir(t, "agent-exec-detect-maven-");
  await writeFile(join(maven, "pom.xml"), "<project/>");
  assert.deepEqual((await detectAgentExecCommands(maven))[0]?.argv, ["mvn", "test"]);

  const gradle = await tempDir(t, "agent-exec-detect-gradle-");
  await writeFile(join(gradle, "build.gradle"), "plugins {}\n");
  assert.deepEqual((await detectAgentExecCommands(gradle))[0]?.argv, ["gradle", "test"]);

  const empty = await tempDir(t, "agent-exec-detect-empty-");
  assert.deepEqual(await detectAgentExecCommands(empty), []);
});

test("mergeAgentExecCommands keeps the owner's commands and appends new names", () => {
  const merged = mergeAgentExecCommands(
    [{ name: "test", argv: ["owner-test"] }],
    [{ name: "test", argv: ["detected-test"] }, { name: "typecheck", argv: ["tsc"] }],
  );
  assert.deepEqual(merged, [{ name: "test", argv: ["owner-test"] }, { name: "typecheck", argv: ["tsc"] }]);
});

test("list_commands returns the allowlist and a bad config is reported", async () => {
  const listed = await runTool("list_commands", {}, loadConfig("/tmp", [{ name: "test", argv: ["npm", "test"] }]));
  assert.equal(listed.isError, undefined);
  assert.match(listed.text, /"name": "test"/);
  const broken = await runTool("list_commands", {}, { errors: ["config is broken"] });
  assert.equal(broken.isError, true);
  assert.match(broken.text, /config is broken/);
});

test("run_command refuses an unknown name and lists the available ones", async () => {
  const result = await runTool("run_command", { name: "nope" }, loadConfig("/tmp", [{ name: "test", argv: ["npm", "test"] }]));
  assert.equal(result.isError, true);
  assert.match(result.text, /no command named "nope"/);
  assert.match(result.text, /Available: test/);
});

test("run_command refuses to run without a sandbox unless explicitly allowed", async (t) => {
  const workspace = await tempDir(t, "agent-exec-unsandboxed-");
  const marker = join(workspace, "marker");
  const result = await runTool("run_command", { name: "write" }, loadConfig(workspace, [
    { name: "write", argv: nodeEval(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`) },
  ]));
  assert.equal(result.isError, true);
  assert.match(result.text, /sandbox|refus|unsandboxed/i);
  assert.equal(existsSync(marker), false);
});

test("run_command executes an allowlisted command under the sandbox", async (t) => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    t.skip("the live Seatbelt probe is macOS-only");
    return;
  }
  const workspace = await tempDir(t, "agent-exec-live-ws-");
  const profile = await sandboxFile(t, workspace);
  const result = await runTool("run_command", { name: "echo" }, loadConfig(workspace, [
    { name: "echo", argv: nodeEval("console.log('sandbox-ok')") },
  ], profile));
  assert.equal(result.isError, undefined);
  assert.match(result.text, /sandbox: seatbelt/);
  assert.match(result.text, /sandbox-ok/);
});

test("the sandbox denies a write outside the workspace and inside .git", async (t) => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    t.skip("the live Seatbelt probe is macOS-only");
    return;
  }
  const workspace = await tempDir(t, "agent-exec-deny-ws-");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const profile = await sandboxFile(t, workspace);
  const outside = join(homedir(), `.agent-exec-probe-${process.pid}-${Date.now()}`);
  t.after(async () => rm(outside, { force: true }));
  const outsideResult = await runTool("run_command", { name: "outside" }, loadConfig(workspace, [
    { name: "outside", argv: nodeEval(`require("node:fs").writeFileSync(${JSON.stringify(outside)}, "x")`) },
  ], profile));
  assert.equal(outsideResult.isError, true);
  assert.equal(existsSync(outside), false, "a write outside the workspace must not land");

  const gitMarker = join(workspace, ".git", "probe");
  const gitResult = await runTool("run_command", { name: "git-write" }, loadConfig(workspace, [
    { name: "git-write", argv: nodeEval(`require("node:fs").writeFileSync(${JSON.stringify(gitMarker)}, "x")`) },
  ], profile));
  assert.equal(gitResult.isError, true);
  assert.equal(existsSync(gitMarker), false, "the workspace .git must stay read-only");
});

test("a command that runs too long is timed out and killed", async (t) => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    t.skip("the live Seatbelt probe is macOS-only");
    return;
  }
  const workspace = await tempDir(t, "agent-exec-timeout-ws-");
  const profile = await sandboxFile(t, workspace);
  const started = Date.now();
  const result = await runTool("run_command", { name: "slow" }, loadConfig(workspace, [
    { name: "slow", argv: nodeEval("setTimeout(() => {}, 60_000)"), timeoutMs: 500 },
  ], profile));
  assert.equal(result.isError, true);
  assert.match(result.text, /timed out after 500 ms/);
  assert.ok(Date.now() - started < 10_000, "the timeout must not wait for the command");
});

test("a large command output keeps the tail and reports truncation", async (t) => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    t.skip("the live Seatbelt probe is macOS-only");
    return;
  }
  const workspace = await tempDir(t, "agent-exec-output-ws-");
  const profile = await sandboxFile(t, workspace);
  const result = await runTool("run_command", { name: "loud" }, loadConfig(workspace, [
    { name: "loud", argv: nodeEval("process.stdout.write('x'.repeat(120_000))") },
  ], profile));
  assert.equal(result.isError, undefined);
  assert.match(result.text, /output: truncated/);
  assert.ok(result.text.length < 110_000, `expected a capped output, got ${result.text.length}`);
});

test("the server speaks MCP over stdio and lists the allowlist", async (t) => {
  const workspace = await tempDir(t, "agent-exec-stdio-ws-");
  const directory = await tempDir(t, "agent-exec-stdio-config-");
  const configPath = join(directory, "agent-exec.json");
  await writeFile(configPath, JSON.stringify({
    workspace,
    commands: [{ name: "test", argv: ["npm", "run", "test"], description: "tests" }],
  }), "utf8");
  const serverPath = join(import.meta.dirname, "..", "src", "mcp", "agent-exec-server.ts");
  const child = spawn(process.execPath, ["--experimental-strip-types", serverPath, "--config", configPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => child.kill());
  const pending: Array<(message: Record<string, unknown>) => void> = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      pending.shift()?.(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const nextMessage = (): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for agent-exec")), 10_000);
    pending.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  const initialized = await nextMessage();
  assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, "agent-exec");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listed = await nextMessage();
  const names = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["list_commands", "run_command"]);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_commands", arguments: {} } });
  const called = await nextMessage();
  const content = (called.result as { content: Array<{ text: string }> }).content;
  assert.match(content[0]?.text ?? "", /"name": "test"/);
});
