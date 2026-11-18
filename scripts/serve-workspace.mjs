#!/usr/bin/env node
/**
 * Read-only static server for a workspace under review by the browser MCP.
 *
 * Usage:
 *   node scripts/serve-workspace.mjs --root /path/to/workspace [--port 8135]
 *
 * Serves only files inside `--root`, on loopback, with correct MIME types for
 * ES modules. No directory listing, no writes, no uploads.
 * 供浏览器 MCP 审查工作区的只读静态服务器。
 * 只服务 `--root` 内的文件、只绑定回环、为 ES 模块提供正确 MIME；无目录列表、无写入、无上传。
 */
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const root = resolve(value("root", process.cwd()));
const port = Number(value("port", "8135"));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("--port must be an integer between 1 and 65535.");
  process.exit(2);
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function inside(candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    if (pathname.includes("\0") || pathname.split("/").some((part) => part === "..")) {
      response.writeHead(403).end("forbidden");
      return;
    }
    const target = normalize(join(root, pathname));
    const actual = await realpath(target).catch(() => undefined);
    if (actual === undefined || !inside(actual)) {
      response.writeHead(404).end("not found");
      return;
    }
    const info = await stat(actual);
    if (!info.isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(actual);
    response.writeHead(200, {
      "content-type": types[extname(actual).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404).end("not found");
  }
});

server.once("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Pick another with --port.`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}/`);
  console.log("read-only, loopback only; Ctrl-C to stop.");
});
