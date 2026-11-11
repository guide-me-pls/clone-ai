import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mcpToolName, McpHost, parseMcpToolName, parseTools } from "../src/mcp/mcp-host.ts";

const serverPath = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const config = {
  name: "fake",
  command: process.execPath,
  args: [serverPath],
  timeoutMs: 10_000,
};

test("a stdio server lists namespaced tools and answers a call", async (t) => {
  const host = new McpHost([config]);
  t.after(async () => host.close());
  await host.connectAll();
  assert.deepEqual(host.failures, []);
  const tools = host.tools();
  assert.deepEqual(tools.map((tool) => tool.name), ["mcp__fake__echo", "mcp__fake__fail"]);
  const result = await host.call("mcp__fake__echo", { text: "hello" });
  assert.equal(result.isError, false);
  assert.equal(result.content[0]?.text, "hello");
});

test("a tool error is reported without rejecting the call", async (t) => {
  const host = new McpHost([config]);
  t.after(async () => host.close());
  await host.connectAll();
  const result = await host.call("mcp__fake__fail", {});
  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /deliberate failure/);
});

test("a server that cannot start is recorded and contributes no tools", async () => {
  const host = new McpHost([{ name: "missing", command: "/definitely/not/a/command" }]);
  await host.connectAll();
  assert.equal(host.failures.length, 1);
  assert.equal(host.failures[0]?.server, "missing");
  assert.deepEqual(host.tools(), []);
  await host.close();
});

test("names round-trip through the namespace", () => {
  assert.equal(mcpToolName("github", "search"), "mcp__github__search");
  assert.deepEqual(parseMcpToolName("mcp__github__search"), { server: "github", tool: "search" });
  assert.equal(parseMcpToolName("read_file"), undefined);
});

test("tool parsing drops entries without a name and defaults a missing schema", () => {
  const tools = parseTools({
    tools: [
      { name: "a", description: "A" },
      { description: "no name" },
      { name: "b", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
    ],
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["a", "b"]);
  assert.deepEqual(tools[0]?.inputSchema, { type: "object", properties: {} });
});

test("an MCP server receives only the environment it declared", async () => {
  // The host used to hand the server the owner's whole environment, API keys
  // included; the worker client already narrows it.
  // 宿主过去把所有者完整的环境交给服务器，包含 API 密钥；Worker 客户端已经收窄了它。
  const { environmentFor } = await import("../src/workers/mcp-client.ts");
  const source = { PATH: "/bin", HOME: "/home/owner", ANTHROPIC_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp_x", LANG: "en_US.UTF-8" };
  const named = environmentFor({ env: ["GITHUB_TOKEN"] }, source);
  assert.equal(named.GITHUB_TOKEN, "ghp_x");
  assert.equal(named.ANTHROPIC_API_KEY, undefined, "an undeclared credential must not leak");
  assert.equal(named.PATH, "/bin", "the baseline variables survive");

  const explicit = environmentFor({ env: { EXTRA: "value" } }, source);
  assert.equal(explicit.EXTRA, "value");
  assert.equal(explicit.ANTHROPIC_API_KEY, undefined, "the object form also stays narrow");
});

test("duplicate server names and duplicate tool names are refused, not silently shadowed", async () => {
  // Two servers with one name both registered tools under one prefix, and the
  // loop's first-wins lookup hid the second.
  // 两个同名服务器把工具注册在同一前缀下，循环的先到先得查找遮住了第二个。
  const { McpHost, mcpToolName } = await import("../src/mcp/mcp-host.ts");
  assert.throws(() => new McpHost([
    { name: "dup", command: "x" },
    { name: "dup", command: "y" },
  ]), /Duplicate MCP server name/);
  assert.equal(mcpToolName("a", "b"), "mcp__a__b");
});
