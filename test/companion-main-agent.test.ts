import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    // The aborted turn's audit append may land just after the server closes;
    // retry the directory removal rather than racing that last write.
    // 被中止回合的审计追加可能在 Server 关闭后才落盘；重试删除目录，而不是与最后一笔写入竞速。
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
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
  let calls = 0;
  const modelServer = createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
    // The loop has no default round cap: the model must answer to end the turn.
    // First call asks for a tool, the next answers, as a real model would.
    // 循环没有默认轮次上限：模型必须回答才能结束回合。第一次调用请求工具，下一次回答，
    // 与真实模型一致。
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (calls === 1) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "get_authority", arguments: "{}" } }] } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "You may read files." } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    }
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

test("the Main Agent reads its project instructions from the internal base", async (t) => {
  // The daemon's cwd is the checkout it was started from. The internal base
  // locates project rules, but it is not named in the prompt: there is no
  // configured working directory.
  // Daemon 的 cwd 是它被启动时所在的检出。内部基准用于定位项目规则，但它不在 Prompt
  // 里点名：没有配置的工作目录。
  const captured: Array<Record<string, unknown>> = [];
  const modelServer = createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (address === null || typeof address === "string") throw new Error("The fake model did not bind a port.");
  const saved = { model: process.env.CLONE_AI_NATIVE_MODEL, base: process.env.CLONE_AI_NATIVE_BASE_URL };
  process.env.CLONE_AI_NATIVE_MODEL = "test-model";
  process.env.CLONE_AI_NATIVE_BASE_URL = `http://127.0.0.1:${address.port}`;
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "clone-ai-workspace-rules-"));
  await writeFile(join(workspaceDirectory, "AGENTS.md"), "# Workspace rules\n\nWORKSPACE_MARKER_ONLY_IN_THE_CONFIGURED_FOLDER\n");
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-companion-workspace-"));
  const server = await startCompanionServer({ port: 0, dataDirectory, workspacePath: workspaceDirectory });
  t.after(async () => {
    await server.close();
    modelServer.closeAllConnections?.();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    if (saved.model === undefined) delete process.env.CLONE_AI_NATIVE_MODEL;
    else process.env.CLONE_AI_NATIVE_MODEL = saved.model;
    if (saved.base === undefined) delete process.env.CLONE_AI_NATIVE_BASE_URL;
    else process.env.CLONE_AI_NATIVE_BASE_URL = saved.base;
    await rm(workspaceDirectory, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const response = await companionFetch(server.url, server.token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "What does this workspace do?" }),
  });
  assert.equal(response.status, 200);
  const messages = (captured[0]?.messages ?? []) as Array<{ role: string; content?: string }>;
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(system, /WORKSPACE_MARKER_ONLY_IN_THE_CONFIGURED_FOLDER/);
  assert.match(system, /This computer is the workspace/);
  assert.match(system, /no filesystem tool of your own/);
  assert.doesNotMatch(system, /Current workspace:/, "the prompt must not name a configured folder");
  assert.doesNotMatch(system, /rules for changing Clone AI/, "the daemon's cwd must not supply the project rules");
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
    // The stream's writer can still be closing when the server returns; a
    // single recursive rm then races an ENOTEMPTY. Retry briefly.
    // 服务器返回时流的写入方可能仍在关闭；一次性递归删除会撞上 ENOTEMPTY。短暂重试。
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

test("a turn sends the model and effort chosen in the composer to the provider", async (t) => {
  // The composer's pickers must change what the provider is asked for, not only
  // the audit row. The effort was previously read and recorded but never put
  // into the request body, so this test also pins that wiring.
  // 输入框的选择器必须改变真正发给 Provider 的请求，而不只是审计行。强度此前只被读取与
  // 记录、从未进入请求体，因此这个测试同时钉住这条接线。
  const bodies: Array<{ model?: string; reasoning_effort?: string }> = [];
  const modelServer = createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += String(chunk); });
    request.on("end", () => {
      try {
        bodies.push(JSON.parse(raw) as { model?: string; reasoning_effort?: string });
      } catch {
        bodies.push({});
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (address === null || typeof address === "string") throw new Error("The fake model did not bind a port.");
  const saved = {
    model: process.env.CLONE_AI_NATIVE_MODEL,
    base: process.env.CLONE_AI_NATIVE_BASE_URL,
    effort: process.env.CLONE_AI_MAIN_EFFORT,
  };
  process.env.CLONE_AI_NATIVE_MODEL = "settings-model";
  process.env.CLONE_AI_NATIVE_BASE_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.CLONE_AI_MAIN_EFFORT;
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-companion-choice-"));
  const server = await startCompanionServer({ port: 0, dataDirectory });
  t.after(async () => {
    await server.close();
    modelServer.closeAllConnections?.();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    if (saved.model === undefined) delete process.env.CLONE_AI_NATIVE_MODEL;
    else process.env.CLONE_AI_NATIVE_MODEL = saved.model;
    if (saved.base === undefined) delete process.env.CLONE_AI_NATIVE_BASE_URL;
    else process.env.CLONE_AI_NATIVE_BASE_URL = saved.base;
    if (saved.effort === undefined) delete process.env.CLONE_AI_MAIN_EFFORT;
    else process.env.CLONE_AI_MAIN_EFFORT = saved.effort;
    await rm(dataDirectory, { recursive: true, force: true });
  });

  // The owner's pick in the composer travels with the turn.
  // 所有者输入框里的选择随回合发送。
  const chosen = await companionFetch(server.url, server.token, "/api/main-agent/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "quick question",
      turnId: "turn-chosen",
      conversationId: "conversation-chosen",
      model: "composer-model",
      effort: "high",
    }),
  });
  assert.equal(chosen.status, 200);
  await chosen.text();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.model, "composer-model");
  assert.equal(bodies[0]?.reasoning_effort, "high");

  // A turn without a pick keeps the configured default and provider default effort.
  // 没有选择时沿用配置的默认模型与 Provider 默认强度。
  const fallback = await companionFetch(server.url, server.token, "/api/main-agent/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "another question",
      turnId: "turn-default",
      conversationId: "conversation-chosen",
    }),
  });
  assert.equal(fallback.status, 200);
  await fallback.text();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]?.model, "settings-model");
  assert.equal("reasoning_effort" in (bodies[1] ?? {}), false);

  // A level the gateway declares but this build's fallback list omits travels
  // as written. The picker lists the gateway's per-model levels, so refusing
  // `ultra` here would reject a level the model advertises.
  // 网关声明、但本版本兜底列表没有的档位按所写送达。选择器列出网关的按模型档位，因此
  // 在这里拒绝 `ultra` 会拒绝模型宣称支持的档位。
  const declaredOnly = await companionFetch(server.url, server.token, "/api/main-agent/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "go deeper",
      turnId: "turn-declared-only",
      conversationId: "conversation-chosen",
      model: "composer-model",
      effort: "ultra",
    }),
  });
  assert.equal(declaredOnly.status, 200);
  await declaredOnly.text();
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2]?.reasoning_effort, "ultra");
});
