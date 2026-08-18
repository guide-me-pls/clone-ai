"use strict";
// A scripted stand-in for a coding CLI. Tests launch plain `node` with
// NODE_OPTIONS=--require pointing here, so this module runs before node tries
// to resolve the CLI arguments and fully controls stdout/stderr and the exit.
// 用于测试的确定性 CLI 替身。测试用 NODE_OPTIONS=--require 指向本文件，使其在 node
// 解析 CLI 参数之前运行，从而完全控制 stdout、stderr 与退出码。
const { writeSync } = require("node:fs");

const mode = process.env.FAKE_CODING_CLI_MODE ?? "";
const evidence = process.env.FAKE_CODING_CLI_EVIDENCE;

// A clean exit with no protocol output: what the wrong binary looks like.
// 干净退出但没有任何协议输出：指向错误二进制时就是这个样子。
if (mode === "silent") process.exit(0);

if (mode === "garbage") {
  writeSync(1, "this line is not a JSONL protocol event\n");
  process.exit(0);
}

if (mode === "big-stderr") {
  // Far beyond a 64 KiB pipe buffer: a parent that defers stderr consumption
  // until stdout ends deadlocks right here.
  // 远超 64 KiB 管道缓冲区：父进程若等 stdout 结束后才读 stderr，就会在这里互锁。
  const chunk = Buffer.from("stderr flood ".repeat(4096), "utf8");
  for (let index = 0; index < 10; index += 1) writeSync(2, chunk);
}

if (mode === "hang") {
  writeSync(1, `${JSON.stringify({ text: "Starting work that never finishes." })}\n`);
  // Block forever without returning to node's CLI-argument resolution; only
  // the supervisor's kill can end this process.
  // 永久阻塞而不回到 node 的 CLI 参数解析；只有 Supervisor 的 kill 能结束本进程。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (mode === "own-session") {
  // Real CLIs repeat their own session id on every event line.
  // 真实 CLI 会在每一行事件上重复自己的会话 ID。
  writeSync(1, `${JSON.stringify({ session_id: "cli-own-session", text: "First half. " })}\n`);
  writeSync(1, `${JSON.stringify({ session_id: "cli-own-session", text: "Second half." })}\n`);
  process.exit(0);
}

let text = "Work finished.";
if (mode === "env-probe") text = `secret=${process.env.CLONE_AI_TEST_SECRET ?? "absent"}`;
if (evidence !== undefined) text += `\nCLONE_AI_EVIDENCE: ${evidence}`;
writeSync(1, `${JSON.stringify({ text })}\n`);
process.exit(0);
