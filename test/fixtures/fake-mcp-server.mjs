#!/usr/bin/env node
// A tiny MCP stdio server for tests: initialize, tools/list, tools/call.
// 测试用的极简 MCP stdio 服务器：initialize、tools/list、tools/call。
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo the given text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "fail",
    description: "Always returns an error.",
    inputSchema: { type: "object", properties: {} },
  },
];

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const respond = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  if (message.method === "initialize") {
    respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } });
    return;
  }
  if (message.method === "tools/list") {
    respond({ tools });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name === "echo") {
      respond({ content: [{ type: "text", text: String(message.params.arguments?.text ?? "") }] });
      return;
    }
    if (message.params?.name === "fail") {
      respond({ content: [{ type: "text", text: "deliberate failure" }], isError: true });
      return;
    }
    respond({ content: [{ type: "text", text: "unknown tool" }], isError: true });
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
});
