import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCompanionServer } from "../src/companion-server.ts";
import { readMainAgentTurnRecords } from "../src/main-agent/turn-audit.ts";
import { companionFetch } from "./helpers/companion-api.ts";

// The conversation-driven entry exists and validates input without touching a
// model; the full chain is covered by the gated live acceptance test.
// 对话驱动入口存在且不触碰模型就校验输入；完整链路由门控的真实验收测试覆盖。
test("the companion main-agent route rejects an empty request before any model call", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-companion-"));
  const server = await startCompanionServer({ port: 0, dataDirectory });
  // after-hooks run in registration order, so the server (and the SQLite
  // handle it owns) must be closed before the directory is removed; on Windows
  // an open handle makes the unlink fail with EBUSY.
  // after 钩子按注册顺序执行，因此必须先关闭 Server（及其持有的 SQLite 句柄）再删目录；
  // Windows 上未关闭的句柄会让 unlink 以 EBUSY 失败。
  t.after(async () => {
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const rejected = await companionFetch(server.url, server.token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "  " }),
  });
  assert.equal(rejected.status, 400);
  const body = await rejected.json() as { error?: string };
  assert.match(body.error ?? "", /enter a request/i);
});


test("a client disconnect cancels the native turn", async (t) => {
  const modelServer = createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (address === null || typeof address === "string") throw new Error("The fake model did not bind a port.");
  const saved = {
    model: process.env.CLONE_AI_NATIVE_MODEL,
    base: process.env.CLONE_AI_NATIVE_BASE_URL,
  };
  process.env.CLONE_AI_NATIVE_MODEL = "test-model";
  process.env.CLONE_AI_NATIVE_BASE_URL = `http://127.0.0.1:${address.port}`;
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-companion-abort-"));
  const server = await startCompanionServer({ port: 0, dataDirectory });
  t.after(async () => {
    await server.close();
    modelServer.closeAllConnections?.();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    if (saved.model === undefined) delete process.env.CLONE_AI_NATIVE_MODEL;
    else process.env.CLONE_AI_NATIVE_MODEL = saved.model;
    if (saved.base === undefined) delete process.env.CLONE_AI_NATIVE_BASE_URL;
    else process.env.CLONE_AI_NATIVE_BASE_URL = saved.base;
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await companionFetch(server.url, server.token, "/api/main-agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body !== null);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: delta")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(buffer, /event: delta/);
    controller.abort();

    let status: string | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const records = await readMainAgentTurnRecords(dataDirectory);
      status = records.at(-1)?.status;
      if (status === "interrupted") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status, "interrupted");
  } finally {
    clearTimeout(timeout);
  }
});
