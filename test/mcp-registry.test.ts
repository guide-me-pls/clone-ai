/**
 * The curated MCP marketplace: what it offers and how an entry becomes an
 * install request. These checks pin the parts that make a marketplace install
 * different from the free-text form — a reviewed package, a pinned version, and
 * argv/env built on the server rather than accepted from the client.
 *
 * 精选 MCP 市场：提供什么，以及条目如何变成安装请求。这些检查钉住市场安装不同于自由文本
 * 表单的地方——核对过的包、固定的版本，以及在服务器而非客户端构造的 argv/env。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { assertPackageSpec } from "../src/mcp/mcp-installer.ts";
import { MCP_REGISTRY, resolveRegistryServer, searchMcpRegistry } from "../src/mcp/mcp-registry.ts";

test("every entry has a unique id, a pinned npm package and both languages", () => {
  const ids = new Set<string>();
  for (const entry of MCP_REGISTRY) {
    assert.match(entry.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, entry.id);
    assert.equal(ids.has(entry.id), false, `duplicate entry id ${entry.id}`);
    ids.add(entry.id);
    assert.doesNotThrow(() => assertPackageSpec(entry.package), entry.package);
    assert.match(entry.package, /@\d+\.\d+\.\d+$/, `${entry.package} must pin one version`);
    assert.ok(entry.name["zh-CN"].length > 0 && entry.name.en.length > 0, `${entry.id} needs both names`);
    assert.ok(entry.summary["zh-CN"].length > 0 && entry.summary.en.length > 0, `${entry.id} needs both summaries`);
    assert.ok(entry.tags.length > 0, `${entry.id} needs search tags`);
  }
  assert.ok(MCP_REGISTRY.length >= 5, "the marketplace should offer the reviewed keyless servers");
});

test("search matches Chinese and English terms and returns everything for an empty query", () => {
  assert.deepEqual(searchMcpRegistry("文件").map((entry) => entry.id), ["filesystem"]);
  assert.deepEqual(searchMcpRegistry("记忆").map((entry) => entry.id), ["memory"]);
  assert.deepEqual(searchMcpRegistry("browser").map((entry) => entry.id), ["playwright", "chrome-devtools"]);
  assert.deepEqual(searchMcpRegistry("   ").map((entry) => entry.id), MCP_REGISTRY.map((entry) => entry.id));
  assert.deepEqual(searchMcpRegistry("no-such-server"), []);
});

test("a filesystem install takes typed directories and is read-only by default", () => {
  const resolved = resolveRegistryServer({
    entryId: "filesystem",
    inputs: { directory: "/Users/owner/Documents, /Users/owner/Notes" },
    dataDirectory: "/Users/owner/.clone",
  });
  assert.equal(resolved.id, "filesystem");
  assert.equal(resolved.package, "@modelcontextprotocol/server-filesystem@2.4.0");
  assert.deepEqual(resolved.args, ["/Users/owner/Documents", "/Users/owner/Notes", "--read-only"]);
  assert.equal(resolved.env, undefined);

  const writable = resolveRegistryServer({
    entryId: "filesystem",
    inputs: { directory: "/Users/owner/Documents", readOnly: false },
    dataDirectory: "/Users/owner/.clone",
  });
  assert.deepEqual(writable.args, ["/Users/owner/Documents"]);
});

test("a marketplace install refuses a relative directory, a missing input or an unknown key", () => {
  const base = { dataDirectory: "/Users/owner/.clone" };
  assert.throws(
    () => resolveRegistryServer({ ...base, entryId: "filesystem", inputs: { directory: "./docs" } }),
    /absolute path/,
  );
  assert.throws(
    () => resolveRegistryServer({ ...base, entryId: "filesystem", inputs: {} }),
    /needs "Allowed directories"/,
  );
  assert.throws(
    () => resolveRegistryServer({ ...base, entryId: "filesystem", inputs: { directory: "/tmp", args: "--root" } }),
    /no input named "args"/,
  );
  assert.throws(
    () => resolveRegistryServer({ ...base, entryId: "missing", inputs: {} }),
    /No MCP marketplace entry/,
  );
});

test("the memory entry keeps its graph in the clone home, outside the npx cache", () => {
  const resolved = resolveRegistryServer({
    entryId: "memory",
    inputs: {},
    dataDirectory: "/Users/owner/.clone",
  });
  assert.deepEqual(resolved.env, { MEMORY_FILE_PATH: "/Users/owner/.clone/mcp-memory.jsonl" });
  assert.deepEqual(resolved.args, []);
});

test("chrome-devtools is installed with Google's usage statistics switched off", () => {
  const resolved = resolveRegistryServer({
    entryId: "chrome-devtools",
    inputs: {},
    dataDirectory: "/Users/owner/.clone",
  });
  assert.deepEqual(resolved.args, ["--no-usage-statistics"]);
});