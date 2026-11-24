/**
 * Tests for the settings MCP catalog and the safe enable/disable toggle.
 * 设置页 MCP 目录与安全启用/停用切换的测试。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { readToolCatalog, setMcpServerEnabled, skillRootsFor } from "../src/mcp/mcp-catalog.ts";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeMcp(home: string, value: unknown): Promise<void> {
  await writeFile(join(home, "mcp.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("the catalog projects MCP servers without command, args or env", async (t) => {
  const home = await tempDir(t, "mcp-catalog-home-");
  const workspace = await tempDir(t, "mcp-catalog-ws-");
  await writeMcp(home, {
    version: 1,
    servers: [
      {
        id: "alpha",
        enabled: true,
        command: "node",
        args: ["--token", "x"],
        env: { SECRET_TOKEN: "sk-live" },
        tools: [
          { name: "read", risk: "read", description: "Read a thing.", pathField: "path" },
          { name: "fetch", risk: "network" },
        ],
        custom: "keep",
      },
      { id: "beta", enabled: false, command: "node", tools: [{ name: "write", risk: "write" }] },
    ],
  });
  const catalog = await readToolCatalog(home, workspace);
  assert.deepEqual(catalog.mcpErrors, []);
  assert.deepEqual(catalog.servers.map((server) => [server.id, server.enabled, server.transport, server.tools.length]), [
    ["alpha", true, "stdio", 2],
    ["beta", false, "stdio", 1],
  ]);
  assert.equal(catalog.servers[0]?.tools[0]?.pathField, "path");
  assert.equal(catalog.servers[0]?.tools[1]?.risk, "network");
  const serialized = JSON.stringify(catalog);
  assert.equal(serialized.includes("sk-live"), false, "an env value must never reach the catalog");
  assert.equal(serialized.includes('"command"'), false, "the command must not reach the catalog");
  assert.equal(serialized.includes('"args"'), false, "args must not reach the catalog");
  assert.equal(serialized.includes('"env"'), false, "the env object must not reach the catalog");
});

test("the toggle rewrites only enabled and preserves the rest of mcp.json", async (t) => {
  const home = await tempDir(t, "mcp-toggle-home-");
  const workspace = await tempDir(t, "mcp-toggle-ws-");
  await writeMcp(home, {
    version: 1,
    servers: [
      {
        id: "alpha",
        enabled: true,
        command: "node",
        args: ["--token", "x"],
        env: { SECRET_TOKEN: "sk-live" },
        tools: [{ name: "read", risk: "read" }],
        custom: "keep",
      },
      { id: "beta", enabled: true, command: "node", tools: [{ name: "write", risk: "write" }] },
    ],
  });
  const catalog = await setMcpServerEnabled(home, workspace, "alpha", false);
  assert.equal(catalog.servers.find((server) => server.id === "alpha")?.enabled, false);
  const raw = JSON.parse(await readFile(join(home, "mcp.json"), "utf8")) as {
    version: number;
    servers: Array<Record<string, unknown>>;
  };
  assert.equal(raw.version, 1);
  assert.equal(raw.servers[0]?.enabled, false);
  assert.equal(raw.servers[0]?.custom, "keep");
  assert.deepEqual(raw.servers[0]?.args, ["--token", "x"]);
  assert.deepEqual(raw.servers[0]?.env, { SECRET_TOKEN: "sk-live" });
  assert.equal(raw.servers[1]?.enabled, true);
  const info = await stat(join(home, "mcp.json"));
  assert.equal(info.mode & 0o777, 0o600, "settings writes stay owner-only");
});

test("the toggle rejects unknown, duplicate and malformed servers", async (t) => {
  const home = await tempDir(t, "mcp-toggle-bad-");
  const workspace = await tempDir(t, "mcp-toggle-bad-ws-");
  await writeMcp(home, {
    servers: [
      { id: "duplicate", enabled: true, command: "node" },
      { id: "duplicate", enabled: true, command: "node" },
    ],
  });
  await assert.rejects(() => setMcpServerEnabled(home, workspace, "missing", true), /No MCP server named/);
  await assert.rejects(() => setMcpServerEnabled(home, workspace, "duplicate", true), /More than one MCP server/);
  await assert.rejects(() => setMcpServerEnabled(home, workspace, "duplicate", "yes" as unknown as boolean), /enabled must be a boolean/);
  const empty = await tempDir(t, "mcp-toggle-empty-");
  await assert.rejects(() => setMcpServerEnabled(empty, workspace, "alpha", true), /No mcp\.json/);
});

test("a malformed mcp.json is reported instead of hidden", async (t) => {
  const home = await tempDir(t, "mcp-malformed-home-");
  const workspace = await tempDir(t, "mcp-malformed-ws-");
  await writeFile(join(home, "mcp.json"), "{ not json", "utf8");
  const catalog = await readToolCatalog(home, workspace);
  assert.equal(catalog.servers.length, 0);
  assert.match(catalog.mcpErrors[0] ?? "", /not valid JSON/);
  await assert.rejects(() => setMcpServerEnabled(home, workspace, "alpha", true));
});

test("a root workspace does not create a /.clone/skills root", () => {
  assert.deepEqual(skillRootsFor("/home/owner/.clone", "/"), ["/home/owner/.clone/skills"]);
  assert.deepEqual(skillRootsFor("/home/owner/.clone", "/home/owner"), ["/home/owner/.clone/skills"]);
});

test("the catalog lists skills and reports unparseable ones", async (t) => {
  const home = await tempDir(t, "mcp-skills-home-");
  const workspace = await tempDir(t, "mcp-skills-ws-");
  const root = join(workspace, ".clone", "skills");
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill.\n---\nDo the thing.\n", "utf8");
  await mkdir(join(root, "broken"), { recursive: true });
  await writeFile(join(root, "broken", "SKILL.md"), "---\nname: broken\n---\nNo description.\n", "utf8");
  const catalog = await readToolCatalog(home, workspace);
  assert.deepEqual(catalog.skillRoots, skillRootsFor(home, workspace));
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0]?.name, "demo");
  assert.equal(catalog.skills[0]?.description, "A demo skill.");
  assert.equal(catalog.skills[0]?.path.endsWith("SKILL.md"), true);
  assert.equal("body" in (catalog.skills[0] as unknown as Record<string, unknown>), false, "the skill body is not sent to the settings page");
  assert.equal(catalog.rejectedSkills.length, 1);
  assert.match(catalog.rejectedSkills[0]?.path ?? "", /broken\/SKILL\.md/);
});
