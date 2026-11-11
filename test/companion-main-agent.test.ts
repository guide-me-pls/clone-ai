import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCompanionServer } from "../src/companion-server.ts";
import { readMainAgentTurnRecords } from "../src/main-agent/turn-audit.ts";
import { deflateSync } from "node:zlib";

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

/** A valid, incompressible PNG of the given square size. 给定边长、合法且不可压缩的 PNG。 */
function bigPng(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let seed = 12345;
  for (let index = 0; index < raw.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[index] = seed & 0xff;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
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

test("the stream forwards tool progress before it forwards the answer", async (t) => {
  const modelServer = createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "get_authority", arguments: "{}" } }] } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (address === null || typeof address === "string") throw new Error("The fake model did not bind a port.");
  const saved = { model: process.env.CLONE_AI_NATIVE_MODEL, base: process.env.CLONE_AI_NATIVE_BASE_URL };
  process.env.CLONE_AI_NATIVE_MODEL = "test-model";
  process.env.CLONE_AI_NATIVE_BASE_URL = `http://127.0.0.1:${address.port}`;
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-companion-tools-"));
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
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await companionFetch(server.url, server.token, "/api/main-agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "what am I allowed to do?" }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const started = text.indexOf("event: tool");
    assert.ok(started >= 0, "the stream carries a tool event");
    assert.match(text.slice(started), /"phase":"started"/);
    assert.match(text.slice(started), /get_authority/);
  } finally {
    clearTimeout(timeout);
  }
});

test("a realistic image attachment is accepted instead of failing on the body cap", async (t) => {
  // The body cap must clear the attachment cap. A 1000x1000 photo is roughly
  // 667 KB of base64, which the old 32 KB body limit rejected outright.
  // 请求体上限必须高于附件上限。1000x1000 的照片约 667 KB base64，旧的 32 KB 上限会直接拒绝。
  const modelServer = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (address === null || typeof address === "string") throw new Error("The fake model did not bind a port.");
  const saved = { model: process.env.CLONE_AI_NATIVE_MODEL, base: process.env.CLONE_AI_NATIVE_BASE_URL };
  process.env.CLONE_AI_NATIVE_MODEL = "test-model";
  process.env.CLONE_AI_NATIVE_BASE_URL = `http://127.0.0.1:${address.port}`;
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-companion-image-"));
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

  // A genuinely valid PNG that clears the old 32 KB body cap but is small
  // enough for the context window: 160x160 noise, about 100 KB of base64.
  // 一张真正合法、超过旧 32 KB 请求体上限、但仍在上下文窗口内的 PNG：160x160 噪声，约 100 KB base64。
  const png = bigPng(160).toString("base64");
  assert.ok(png.length > 32_000, `the fixture must exceed the old body cap (got ${png.length})`);
  const response = await companionFetch(server.url, server.token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "what is this", attachments: [{ mimeType: "image/png", data: png }] }),
  });
  assert.equal(response.status, 200, "a realistic image must not hit the request-body cap");
});

test("shutdown completes while an SSE stream is still open", async (t) => {
  // An open event stream keeps server.close pending; a desktop window left open
  // must not block the daemon from stopping.
  // 打开的事件流会让 server.close 持续挂起；开着的桌面窗口不能让 daemon 无法停止。
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-shutdown-"));
  const server = await startCompanionServer({ port: 0, dataDirectory });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  // Hold the stream open without letting the turn finish. 保持流打开，不让回合结束。
  const response = await companionFetch(server.url, server.token, "/api/main-agent/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
    signal: controller.signal,
  }).catch(() => undefined);
  void response?.body?.getReader().read().catch(() => undefined);
  const started = Date.now();
  const outcome = await Promise.race([
    server.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
  ]);
  assert.equal(outcome, "closed", "an open stream must not block shutdown");
  assert.ok(Date.now() - started < 5_000);
});
