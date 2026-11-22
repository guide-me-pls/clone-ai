/**
 * Tests for the agent-tools MCP server, its mcp.json entry and the worker wiring.
 * agent-tools MCP 服务器、其 mcp.json 条目与 Worker 接线的测试。
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import {
  PROTECTED_RELATIVE_ROOTS,
  globToRegExp,
  handleMessage,
  htmlToText,
  isPrivateAddress,
  runTool,
  toolDefinitions,
} from "../src/mcp/agent-tools-server.ts";
import {
  AGENT_TOOLS_SERVER_ID,
  agentToolsServer,
  agentToolsServerPath,
  agentToolsToolDeclarations,
} from "../src/integrations/agent-tools-mcp.ts";
import { mergeMcpConfig } from "../src/integrations/mcp-config.ts";
import { canonicalPath, forbiddenRoots } from "../src/authority/scope.ts";
import { workerTools } from "../src/workers/native-worker-factory.ts";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("agent-tools declares seven read-only tools, each with an explicit risk", () => {
  const declarations = agentToolsToolDeclarations();
  const byName = new Map(declarations.map((tool) => [tool.name, tool]));
  assert.deepEqual(declarations.map((tool) => tool.name).sort(), [
    "current_time",
    "fetch_url",
    "find_files",
    "git_diff",
    "git_log",
    "git_status",
    "search_text",
  ]);
  for (const tool of declarations) {
    assert.ok(tool.risk === "read" || tool.risk === "network", `${tool.name} has risk ${tool.risk}`);
    assert.ok((tool.description ?? "").length > 30, `${tool.name} description is too short`);
  }
  assert.equal(byName.get("fetch_url")?.risk, "network");
  assert.equal(byName.get("search_text")?.pathField, "path");
  assert.equal(byName.get("find_files")?.pathField, "path");
  assert.equal(byName.get("git_diff")?.pathField, "path");
  for (const forbidden of ["git_commit", "run_command", "write_file", "http_post"]) {
    assert.equal(byName.has(forbidden), false, `${forbidden} must not be declared`);
  }
});

test("the server entry pins the workspace, the node path and the copied server", () => {
  const serverPath = agentToolsServerPath("/home/owner/.clone");
  assert.equal(serverPath, join("/home/owner/.clone", "mcp-servers", "agent-tools-server.ts"));
  const server = agentToolsServer({ workspace: "/tmp/project", serverPath, nodePath: "/usr/local/bin/node" });
  assert.equal(server.id, AGENT_TOOLS_SERVER_ID);
  assert.equal(server.enabled, true);
  assert.equal(server.transport, "stdio");
  assert.equal(server.command, "/usr/local/bin/node");
  assert.deepEqual(server.args, ["--experimental-strip-types", serverPath]);
  assert.equal(server.cwd, "/tmp/project");
  assert.equal(server.timeoutMs, 120_000);
  assert.deepEqual((server.tools ?? []).map((tool) => tool.name).sort(), toolDefinitions().map((tool) => tool.name).sort());
});

test("mergeMcpConfig preserves other servers and is idempotent for this one", () => {
  const server = agentToolsServer({ workspace: "/w", serverPath: "/clone/mcp-servers/agent-tools-server.ts", nodePath: "/node" });
  const existing = {
    servers: [
      { id: "other", enabled: true, command: "other" },
      { id: AGENT_TOOLS_SERVER_ID, enabled: false, command: "old" },
    ],
  };
  const merged = mergeMcpConfig(existing, server);
  assert.equal(merged.servers.length, 2);
  assert.ok(merged.servers.some((entry) => entry.id === "other"));
  assert.equal(merged.servers.find((entry) => entry.id === AGENT_TOOLS_SERVER_ID)?.enabled, true);
  assert.deepEqual(mergeMcpConfig(merged, server), merged, "rerunning the installer is idempotent");
  assert.deepEqual(mergeMcpConfig(undefined, server).servers, [server]);
});

test("the server's protected-root list mirrors the kernel's", () => {
  const home = canonicalPath(homedir());
  const expected = forbiddenRoots().map((root) => relative(home, root)).sort();
  assert.deepEqual([...PROTECTED_RELATIVE_ROOTS].sort(), expected, "add a new kernel-protected root here too");
});

test("private and reserved addresses are recognised, public ones are not", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "192.0.2.1", "198.51.100.1", "203.0.113.1",
    "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("globToRegExp covers *, ?, ** and stays anchored", () => {
  assert.equal(globToRegExp("*.ts").test("a.ts"), true);
  assert.equal(globToRegExp("*.ts").test("src/a.ts"), false);
  assert.equal(globToRegExp("**/*.ts").test("src/a.ts"), true);
  assert.equal(globToRegExp("**/*.ts").test("a.ts"), true);
  assert.equal(globToRegExp("src/" + "**").test("src/a/b.ts"), true);
  assert.equal(globToRegExp("a?c").test("abc"), true);
  assert.equal(globToRegExp("a?c").test("a/c"), false);
  assert.equal(globToRegExp("a.b").test("axb"), false);
});

test("search_text finds lines, honours globs, and skips noise and binaries", async (t) => {
  const root = await tempDir(t, "agent-tools-search-");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "const needle = 1;\nsecond line\n");
  await writeFile(join(root, "src", "b.js"), "// needle in js\n");
  await writeFile(join(root, "node_modules", "pkg", "skip.ts"), "needle\n");
  await writeFile(join(root, ".git", "config"), "needle\n");
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));

  const all = await runTool("search_text", { query: "needle", path: root });
  assert.equal(all.isError, undefined);
  assert.match(all.text, /src\/a\.ts:1:/);
  assert.match(all.text, /src\/b\.js:1:/);
  assert.doesNotMatch(all.text, /node_modules/);
  assert.doesNotMatch(all.text, /\.git/);
  assert.doesNotMatch(all.text, /blob\.bin/);

  const typed = await runTool("search_text", { query: "needle", path: root, glob: "*.ts" });
  assert.match(typed.text, /src\/a\.ts/);
  assert.doesNotMatch(typed.text, /b\.js/);

  const regex = await runTool("search_text", { query: "needle|second", path: root, regex: true });
  assert.match(regex.text, /src\/a\.ts:2:/);

  const bad = await runTool("search_text", { query: "(", path: root, regex: true });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /regular expression/);

  const capped = await runTool("search_text", { query: "needle", path: root, maxResults: 1 });
  assert.match(capped.text, /stopped at 1 matches/);

  const missing = await runTool("search_text", { query: "needle", path: join(root, "nope") });
  assert.equal(missing.isError, true);
});

test("find_files returns relative paths by glob", async (t) => {
  const root = await tempDir(t, "agent-tools-find-");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "");
  await writeFile(join(root, "src", "b.js"), "");
  await writeFile(join(root, "node_modules", "pkg", "skip.ts"), "");

  const found = await runTool("find_files", { pattern: "**/*.ts", path: root });
  assert.match(found.text, /src\/a\.ts/);
  assert.doesNotMatch(found.text, /node_modules/);
  const js = await runTool("find_files", { pattern: "*.js", path: root });
  assert.match(js.text, /src\/b\.js/);
  assert.doesNotMatch(js.text, /a\.ts/);
  const none = await runTool("find_files", { pattern: "*.rs", path: root });
  assert.equal(none.text, "No files matched.");
});

test("a search above a protected directory does not descend into it", async (t) => {
  const home = await tempDir(t, "agent-tools-home-");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_rsa"), "needle\n");
  await writeFile(join(home, "project.ts"), "needle\n");

  const result = await runTool("search_text", { query: "needle", path: home }, { home });
  assert.match(result.text, /project\.ts/);
  assert.doesNotMatch(result.text, /id_rsa/);

  const files = await runTool("find_files", { pattern: "**/*", path: home }, { home });
  assert.doesNotMatch(files.text, /id_rsa/);

  const direct = await runTool("search_text", { query: "needle", path: join(home, ".ssh") }, { home });
  assert.equal(direct.isError, true);
  assert.match(direct.text, /protected/);

  const link = join(home, "ssh-link");
  await symlink(join(home, ".ssh"), link);
  const throughLink = await runTool("search_text", { query: "needle", path: link }, { home });
  assert.equal(throughLink.isError, true, "a symlink into a protected directory must not pass");
  assert.match(throughLink.text, /protected/);
});

test("current_time is deterministic through the clock seam", async () => {
  const fixed = new Date("2026-11-22T12:34:56.000Z");
  const result = await runTool("current_time", {}, { now: () => fixed });
  const parsed = JSON.parse(result.text) as { iso: string; epochMs: number; timeZone: string; offsetMinutes: number };
  assert.equal(parsed.iso, "2026-11-22T12:34:56.000Z");
  assert.equal(parsed.epochMs, fixed.getTime());
  assert.equal(typeof parsed.timeZone, "string");
  assert.equal(Number.isInteger(parsed.offsetMinutes), true);
});

test("git_status, git_diff and git_log read a repository without writing", async (t) => {
  if (!gitAvailable()) {
    t.skip("git is not installed");
    return;
  }
  const root = await tempDir(t, "agent-tools-git-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "file.txt"), "one\n");
  const status = await runTool("git_status", { path: root });
  assert.match(status.text, /file\.txt/);

  execFileSync("git", ["-c", "user.email=agent@example.com", "-c", "user.name=Agent", "add", "file.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.email=agent@example.com", "-c", "user.name=Agent", "commit", "-q", "-m", "first"], { cwd: root });
  const log = await runTool("git_log", { path: root });
  assert.match(log.text, /first/);

  await writeFile(join(root, "file.txt"), "one\ntwo\n");
  const diff = await runTool("git_diff", { path: root });
  assert.match(diff.text, /\+two/);
  const staged = await runTool("git_diff", { path: root, staged: true });
  assert.equal(staged.text, "(no output)");

  const injected = await runTool("git_diff", { path: root, commit: `--output=${join(root, "pwned")}` });
  assert.equal(injected.isError, true, "a revision that looks like an option is refused");
  assert.equal(existsSync(join(root, "pwned")), false);

  const marker = join(root, "external-diff-ran");
  execFileSync("git", ["config", "diff.external", `sh -c 'touch ${marker}' #`], { cwd: root });
  const inspected = await runTool("git_diff", { path: root });
  assert.match(inspected.text, /\+two/);
  assert.equal(existsSync(marker), false, "a repository-configured external diff must not run");

  const outside = await runTool("git_status", { path: join(root, "missing") });
  assert.equal(outside.isError, true);
});

test("fetch_url refuses private hosts, non-HTTP schemes and credentials", async () => {
  const privateHost = await runTool("fetch_url", { url: "http://127.0.0.1:8135/" });
  assert.equal(privateHost.isError, true);
  assert.match(privateHost.text, /private|refused/i);

  const localhost = await runTool("fetch_url", { url: "http://localhost:3000/" });
  assert.equal(localhost.isError, true);

  const file = await runTool("fetch_url", { url: "file:///etc/passwd" });
  assert.equal(file.isError, true);
  assert.match(file.text, /http/i);

  const credentials = await runTool("fetch_url", { url: "https://user:pw@example.com/" });
  assert.equal(credentials.isError, true);
  assert.match(credentials.text, /credentials/i);

  const redirect = await runTool("fetch_url", { url: "https://example.com/" }, {
    fetchImpl: (async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/" } })) as typeof fetch,
    lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(redirect.isError, true);
  assert.match(redirect.text, /private|refused/i);
});

test("fetch_url reads a public response, follows a redirect and strips HTML", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://example.com/") {
      return new Response("", { status: 302, headers: { location: "/page.html" } });
    }
    return new Response(
      "<html><head><style>x{}</style></head><body><h1>Hello</h1><script>bad()</script><p>World &amp; more</p></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }) as typeof fetch;
  const result = await runTool("fetch_url", { url: "https://example.com/" }, {
    fetchImpl: fakeFetch,
    lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(result.isError, undefined);
  assert.match(result.text, /Hello/);
  assert.match(result.text, /World & more/);
  assert.doesNotMatch(result.text, /bad\(\)/);
  assert.doesNotMatch(result.text, /x\{\}/);
  assert.deepEqual(calls, ["https://example.com/", "https://example.com/page.html"]);
});

test("htmlToText removes scripts, styles and tags", () => {
  assert.equal(htmlToText("<p>a</p><script>x</script><style>y</style><b>b</b>"), "a b");
});

test("handleMessage answers initialize and tools/list and refuses an unknown tool", async () => {
  const initialized = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal((initialized?.result as { serverInfo: { name: string } }).serverInfo.name, "agent-tools");
  const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal((listed?.result as { tools: unknown[] }).tools.length, 7);
  const notification = await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification, undefined);
  const unknown = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal((unknown?.result as { isError: boolean }).isError, true);
});

test("workerTools loads the installed server from mcp.json and calls it", async (t) => {
  const home = await tempDir(t, "agent-tools-wire-home-");
  const workspace = await tempDir(t, "agent-tools-wire-ws-");
  await writeFile(join(workspace, "note.txt"), "hello from the workspace\n");
  const server = agentToolsServer({
    workspace,
    serverPath: join(import.meta.dirname, "..", "src", "mcp", "agent-tools-server.ts"),
    nodePath: process.execPath,
  });
  await writeFile(join(home, "mcp.json"), JSON.stringify({ servers: [server] }, null, 2));

  const tools = workerTools({ dataDirectory: home });
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("read_file"), "built-in tools stay");
  assert.ok(names.includes("agent-tools.search_text"), "the declared search tool is exposed");
  assert.ok(names.includes("agent-tools.fetch_url"), "the network tool is exposed to the table; the step gate decides");

  const search = tools.find((tool) => tool.name === "agent-tools.search_text");
  assert.ok(search !== undefined);
  t.after(async () => { await search.close?.(); });
  const result = await search.run({ name: search.name, input: { query: "hello", path: workspace } }, { workspace });
  assert.match(result.output, /note\.txt:1:/);
  assert.equal(result.isError, undefined);
});

test("the server speaks MCP over stdio as a real child process", async (t) => {
  const serverPath = join(import.meta.dirname, "..", "src", "mcp", "agent-tools-server.ts");
  const child = spawn(process.execPath, ["--experimental-strip-types", serverPath], {
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
      const message = JSON.parse(line) as Record<string, unknown>;
      pending.shift()?.(message);
    }
  });
  const nextMessage = (): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the MCP server")), 10_000);
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
  assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, "agent-tools");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listed = await nextMessage();
  const names = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["current_time", "fetch_url", "find_files", "git_diff", "git_log", "git_status", "search_text"]);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "current_time", arguments: {} } });
  const called = await nextMessage();
  const content = (called.result as { content: Array<{ text: string }> }).content;
  assert.match(content[0]?.text ?? "", /"iso"/);
});
