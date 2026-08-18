"use strict";
// A scripted stand-in for a coding CLI. Tests launch plain `node` with
// NODE_OPTIONS=--require pointing here, so this module runs before node tries
// to resolve the CLI arguments and fully controls stdout/stderr and the exit.
// 用于测试的确定性 CLI 替身。测试用 NODE_OPTIONS=--require 指向本文件，使其在 node
// 解析 CLI 参数之前运行，从而完全控制 stdout、stderr 与退出码。
const { writeSync } = require("node:fs");

const mode = process.env.FAKE_CODING_CLI_MODE ?? "";
const evidence = process.env.FAKE_CODING_CLI_EVIDENCE;

if (mode === "big-stderr") {
  // Far beyond a 64 KiB pipe buffer: a parent that defers stderr consumption
  // until stdout ends deadlocks right here.
  // 远超 64 KiB 管道缓冲区：父进程若等 stdout 结束后才读 stderr，就会在这里互锁。
  const chunk = Buffer.from("stderr flood ".repeat(4096), "utf8");
  for (let index = 0; index < 10; index += 1) writeSync(2, chunk);
}

let text = "Work finished.";
if (evidence !== undefined) text += `\nCLONE_AI_EVIDENCE: ${evidence}`;
writeSync(1, `${JSON.stringify({ text })}\n`);
process.exit(0);
