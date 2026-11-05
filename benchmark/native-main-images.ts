#!/usr/bin/env node
/**
 * Live validation for image attachments in the native Main Agent.
 *
 * Generates a solid red PNG, sends it as an OpenAI-style data URL, captures the
 * outgoing request, and checks that the image part was present and the model
 * answered red. The report records the exact model, endpoint, token usage and
 * checks so the run is reproducible.
 *
 * 原生主 Agent 图片附件的实机验证。
 *
 * 生成一张纯红 PNG，以 OpenAI 风格 data URL 发送，捕获发出的请求，并检查图片部分确实
 * 存在、模型回答了红色。报告记录确切的模型、端点、token 用量与检查项，使运行可复现。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { prepareCloneHome, resolveClonePaths } from "../src/config/clone-home.ts";
import { runNativeMainAgentTurn } from "../src/main-agent/native-runtime.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";

const resultsDirectory = join(fileURLToPath(new URL(".", import.meta.url)), "results");
const MODEL = process.env.CLONE_AI_BENCH_MAIN_MODEL ?? "360/anthropic/claude-sonnet-5-5";
const BASE_URL = (process.env.CLONE_AI_NATIVE_BASE_URL ?? "http://127.0.0.1:3425").replace(/\/$/, "");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

/** A solid red RGB PNG, base64. 纯红色 RGB PNG，base64。 */
function redPng(size: number): string {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = 255;
      raw[pixel + 1] = 0;
      raw[pixel + 2] = 0;
    }
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

interface CapturedBody {
  messages: Array<{ role: string; content?: unknown }>;
}

const directory = await mkdtemp(join(tmpdir(), "clone-ai-native-image-"));
try {
  await prepareCloneHome(resolveClonePaths({ dataDirectory: directory }));
  const image = redPng(64);
  let captured: CapturedBody | undefined;
  const realFetch = fetch;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}")) as CapturedBody;
    return realFetch(url, init);
  }) as typeof fetch;

  const result = await runNativeMainAgentTurn({
    dataDirectory: directory,
    text: "What is the dominant color of this image? Answer with one word.",
    source: "cli",
    endpoint: { baseUrl: BASE_URL, model: MODEL },
    fetchImpl,
    images: [{ type: "image", data: image, mimeType: "image/png" }],
  });

  const user = captured?.messages.find((message) => message.role === "user");
  const parts = Array.isArray(user?.content) ? user.content as Array<{ type?: string; image_url?: { url?: string } }> : [];
  const imagePart = parts.find((part) => part.type === "image_url");
  const checks = {
    imagePartPresent: imagePart !== undefined && String(imagePart.image_url?.url ?? "").startsWith("data:image/png;base64,"),
    replyMentionsRed: /red|红色/i.test(result.reply),
    noError: result.error === void 0,
  };

  const journal = createJournalStore(directory);
  let totalTokens = 0;
  let modelCalls = 0;
  try {
    const events = await journal.list();
    for (const event of events) {
      if (event.type !== "usage.recorded") continue;
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.totalTokens === "number") totalTokens += payload.totalTokens;
      if (typeof payload.modelCalls === "number") modelCalls += payload.modelCalls;
    }
  } finally {
    (journal as { close?: () => void }).close?.();
  }

  console.log(`Native image validation: model=${MODEL} endpoint=${BASE_URL} imageBytes=${Buffer.from(image, "base64").length}`);
  console.log(`  reply=${JSON.stringify(result.reply.slice(0, 200))}`);
  console.log(`  checks=${JSON.stringify(checks)} tokens=${totalTokens} modelCalls=${modelCalls}`);

  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const reportPath = join(resultsDirectory, `native-main-images-${stamp}.json`);
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    ranAt: new Date().toISOString(),
    model: MODEL,
    endpoint: BASE_URL,
    imageBytes: Buffer.from(image, "base64").length,
    reply: result.reply,
    totalTokens,
    modelCalls,
    checks,
  }, null, 2)}\n`, "utf8");
  console.log(`Report: ${reportPath}`);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
} finally {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
