import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { startCompanionServer, type RunningCompanionServer } from "../src/companion-server.ts";
import { companionFetch } from "./helpers/companion-api.ts";

async function companion(t: TestContext): Promise<{ url: string; token: string; dataDirectory: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-desktop-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-desktop-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  return { url: server.url, token: server.token, dataDirectory };
}

function runScript(script: string, args: string[], dataDirectory: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Override every home variable: the repair lane and other callers may leave
    // CLONE_AI_HOME or CLONE_HOME in the environment, and the script prefers
    // them over CLONE_AI_DATA_DIR. The test's data directory must win.
    // 覆盖所有 home 变量：修复通道等调用方可能在环境里留下 CLONE_AI_HOME 或 CLONE_HOME，
    // 而脚本优先使用它们而不是 CLONE_AI_DATA_DIR。测试的数据目录必须胜出。
    const child = spawn(process.execPath, ["--experimental-strip-types", join(process.cwd(), script), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, CLONE_HOME: dataDirectory, CLONE_AI_HOME: dataDirectory, CLONE_AI_DATA_DIR: dataDirectory },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("authority is editable from the desktop API", async (t) => {
  const { url, token } = await companion(t);

  const initial = await companionFetch(url, token, "/api/authority");
  assert.equal(initial.status, 200);
  const config = (await initial.json() as { config: { domains: Record<string, string>; policies: unknown[] } }).config;
  assert.deepEqual(config.domains, {});
  assert.deepEqual(config.policies, []);

  const updated = await companionFetch(url, token, "/api/authority/domains", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain: "files", level: "prepare" }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as { config: { domains: Record<string, string> } };
  assert.equal(updatedBody.config.domains.files, "prepare");

  const created = await companionFetch(url, token, "/api/authority/policies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "整理下载目录",
      scopes: [{ domain: "files", access: "read", resource: "/tmp/downloads" }],
      maxAutonomy: "prepare",
    }),
  });
  assert.equal(created.status, 201);
  const policy = (await created.json() as { policy: { id: string; revokedAt?: string } }).policy;
  assert.ok(policy.id.length > 0);

  const revoked = await companionFetch(url, token, `/api/authority/policies/${encodeURIComponent(policy.id)}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.notEqual((await revoked.json() as { policy: { revokedAt?: string } }).policy.revokedAt, undefined);
});

test("the desktop export writes outside the data directory", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const parent = await mkdtemp(join(tmpdir(), "clone-ai-export-parent-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(dataDirectory, "memories.md"), "# memory\n", "utf8");

  const response = await companionFetch(url, token, "/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination: parent }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    destination: string;
    manifest: { format: string; files: Array<{ path: string }> };
    summary: string;
  };
  assert.equal(body.manifest.format, "clone-ai-export/1");
  assert.ok(body.destination.startsWith(parent));
  assert.ok(body.manifest.files.some((file) => file.path === "memories.md"));
  assert.match(body.summary, /Exported/);
  await access(join(body.destination, "manifest.json"));

  const inside = await companionFetch(url, token, "/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination: dataDirectory }),
  });
  assert.equal(inside.status, 400);
});

test("a rendered table exports as CSV into an owner-chosen folder", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const parent = await mkdtemp(join(tmpdir(), "clone-ai-table-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const csv = "位置,状态\nsrc/a.js,已修改\n";
  const post = (destination: string, content: string) => companionFetch(url, token, "/api/tables/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination, csv: content }),
  });

  const response = await post(parent, csv);
  assert.equal(response.status, 200);
  const body = await response.json() as { path: string; name: string; bytes: number };
  assert.ok(body.path.startsWith(parent));
  assert.match(body.name, /^clone-ai-table-.*\.csv$/);
  assert.equal(body.bytes, Buffer.byteLength(csv, "utf8"));
  assert.equal(await readFile(body.path, "utf8"), csv);

  // The write is owner-initiated but still bounded: no empty table, no relative
  // path, no missing folder, and never the clone data directory.
  // 写入由所有者发起，但仍有边界：空表、相对路径、不存在的目录与 clone 数据目录都不行。
  assert.equal((await post(parent, "  ")).status, 400);
  assert.equal((await post("relative-folder", "a,b\n")).status, 400);
  assert.equal((await post(join(parent, "missing"), "a,b\n")).status, 400);
  assert.equal((await post(dataDirectory, "a,b\n")).status, 400);
});

test("bad cases and improvement are reachable without the CLI", async (t) => {
  const { url, token } = await companion(t);

  const cases = await companionFetch(url, token, "/api/reporting/bad-cases");
  assert.equal(cases.status, 200);
  assert.equal(typeof (await cases.json() as { text: string }).text, "string");

  const improvement = await companionFetch(url, token, "/api/improvement");
  assert.equal(improvement.status, 200);
  const body = await improvement.json() as { enabled: boolean; suggestions: unknown[] };
  assert.equal(typeof body.enabled, "boolean");
  assert.ok(Array.isArray(body.suggestions));
});

test("maintenance scripts replace the removed CLI", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-scripts-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));

  const traces = await runScript("scripts/traces.mjs", ["list"], dataDirectory);
  assert.equal(traces.code, 0, traces.stderr);
  assert.match(traces.stdout, /No failed traces/);

  const repair = await runScript("scripts/repair.mjs", ["--dry-run"], dataDirectory);
  assert.equal(repair.code, 0, repair.stderr);
  assert.match(repair.stdout, /No failed traces/);

  const selfcheck = await runScript("scripts/selfcheck.mjs", ["list"], dataDirectory);
  assert.equal(selfcheck.code, 0, selfcheck.stderr);
  assert.match(selfcheck.stdout, /No self-check rounds/);

  const audit = await runScript("scripts/audit-export.mjs", [], dataDirectory);
  assert.equal(audit.code, 0, audit.stderr);
});
