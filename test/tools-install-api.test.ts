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
