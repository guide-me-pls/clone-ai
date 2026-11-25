import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { startCompanionServer, type RunningCompanionServer } from "../src/companion-server.ts";
import { companionFetch } from "./helpers/companion-api.ts";

async function companion(t: TestContext): Promise<{ url: string; token: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-tools-home-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-tools-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  return { url: server.url, token: server.token };
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function errorOf(response: Response): Promise<string> {
  const body = await response.json() as { error?: unknown };
  return typeof body.error === "string" ? body.error : "";
}

test("installing an MCP server needs the owner's acknowledgement", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/tools/install", post({
    id: "fake",
    package: "pkg@1.0.0",
    tools: [{ name: "read_thing", risk: "read" }],
  }));
  assert.equal(response.status, 400);
  assert.match(await errorOf(response), /owner must confirm/);
});

test("the install route rejects a package spec that is not an npm name", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/tools/install", post({
    id: "fake",
    package: "-oops",
    tools: [{ name: "read_thing", risk: "read" }],
    acknowledgeInstall: true,
  }));
  assert.equal(response.status, 400);
  assert.match(await errorOf(response), /not an npm package spec/);
});

test("the install route needs at least one declared tool", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/tools/install", post({
    id: "fake",
    package: "pkg@1.0.0",
    tools: [],
    acknowledgeInstall: true,
  }));
  assert.equal(response.status, 400);
  assert.match(await errorOf(response), /at least one declared tool/);
});

test("the probe route rejects an empty package without spawning anything", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/tools/probe", post({ package: "" }));
  assert.equal(response.status, 400);
  assert.match(await errorOf(response), /package spec is required/);
});

test("the remove route reports an unknown server", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/tools/mcp/missing", { method: "DELETE" });
  assert.equal(response.status, 400);
  assert.match(await errorOf(response), /No MCP server named/);
});

test("the catalog route still serves the declaration view", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/tools");
  assert.equal(response.status, 200);
  const body = await response.json() as { servers: unknown[]; skills: unknown[]; skillRoots: string[] };
  assert.deepEqual(body.servers, []);
  assert.ok(Array.isArray(body.skills));
  assert.ok(Array.isArray(body.skillRoots));
});

test("the marketplace route serves the reviewed entries and searches them", async (t) => {
  const { url, token } = await companion(t);
  const all = await companionFetch(url, token, "/api/tools/registry");
  assert.equal(all.status, 200);
  const body = await all.json() as { entries: Array<{ id: string; package: string }>; total: number };
  assert.ok(body.total >= 5);
  assert.deepEqual(body.entries.map((entry) => entry.id), ["filesystem", "memory", "sequential-thinking", "playwright", "chrome-devtools"]);

  const filtered = await companionFetch(url, token, "/api/tools/registry?q=browser");
  const filteredBody = await filtered.json() as { entries: Array<{ id: string }> };
  assert.deepEqual(filteredBody.entries.map((entry) => entry.id), ["playwright", "chrome-devtools"]);
});

test("the marketplace probe route refuses an unknown entry or a missing input before spawning anything", async (t) => {
  const { url, token } = await companion(t);
  const unknown = await companionFetch(url, token, "/api/tools/probe-registry", post({ entryId: "missing", inputs: {} }));
  assert.equal(unknown.status, 400);
  assert.match(await errorOf(unknown), /No MCP marketplace entry/);

  const missing = await companionFetch(url, token, "/api/tools/probe-registry", post({ entryId: "filesystem", inputs: {} }));
  assert.equal(missing.status, 400);
  assert.match(await errorOf(missing), /needs "Allowed directories"/);
});

test("the marketplace install route still needs the owner's acknowledgement", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/tools/install-registry", post({
    entryId: "filesystem",
    inputs: { directory: "/tmp" },
    tools: [{ name: "read_file", risk: "read" }],
  }));
  assert.equal(response.status, 400);
  assert.match(await errorOf(response), /owner must confirm/);
});

test("the skill market installs, reads and removes a built-in skill", async (t) => {
  const { url, token } = await companion(t);
  const registry = await companionFetch(url, token, "/api/skills/registry");
  assert.equal(registry.status, 200);
  const market = await registry.json() as { entries: Array<{ name: string; installed: boolean; body: string }>; total: number };
  assert.deepEqual(market.entries.map((entry) => entry.name), ["weekly-review", "document-review", "release-notes", "deliverable-check"]);
  assert.equal(market.entries.every((entry) => entry.installed === false), true);
  assert.match(market.entries[0]?.body ?? "", /周复盘/);

  const refused = await companionFetch(url, token, "/api/skills/install", post({ name: "weekly-review" }));
  assert.equal(refused.status, 400);
  assert.match(await errorOf(refused), /owner must confirm/);

  const unknown = await companionFetch(url, token, "/api/skills/install", post({ name: "no-such-skill", acknowledgeInstall: true }));
  assert.equal(unknown.status, 400);
  assert.match(await errorOf(unknown), /No built-in skill/);

  const installed = await companionFetch(url, token, "/api/skills/install", post({ name: "weekly-review", acknowledgeInstall: true }));
  assert.equal(installed.status, 200);
  const catalog = await installed.json() as { skills: Array<{ name: string }> };
  assert.ok(catalog.skills.some((skill) => skill.name === "weekly-review"));

  const after = await companionFetch(url, token, "/api/skills/registry");
  const afterMarket = await after.json() as { entries: Array<{ name: string; installed: boolean }> };
  assert.equal(afterMarket.entries.find((entry) => entry.name === "weekly-review")?.installed, true);

  const detail = await companionFetch(url, token, "/api/skills/weekly-review");
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { skill: { name: string; body: string; allowedTools: string[] } };
  assert.equal(detailBody.skill.name, "weekly-review");
  assert.match(detailBody.skill.body, /周复盘/);
  assert.deepEqual(detailBody.skill.allowedTools, ["read_file", "search_text", "git_log"]);

  const missing = await companionFetch(url, token, "/api/skills/no-such-skill");
  assert.equal(missing.status, 404);

  const removed = await companionFetch(url, token, "/api/skills/weekly-review", { method: "DELETE" });
  assert.equal(removed.status, 200);
  const removedCatalog = await removed.json() as { skills: Array<{ name: string }> };
  assert.equal(removedCatalog.skills.some((skill) => skill.name === "weekly-review"), false);
});
