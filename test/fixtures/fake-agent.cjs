"use strict";
// A scripted stand-in for a headless coding agent. It reads the prompt from
// argv or stdin, optionally writes files, prints text, and exits — exactly the
// black-box surface Clone AI supervises.
// 无头 Coding Agent 的脚本化替身。它从 argv 或 stdin 读取 Prompt，可选地写文件、打印
// 文本，然后退出——正是 Clone AI 所监督的黑盒表面。
const { writeFileSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

const mode = process.env.FAKE_AGENT_MODE ?? "produce";
const say = (text) => process.stdout.write(`${text}\n`);

if (mode === "hang") {
  say("working forever");
  setInterval(() => {}, 1000);
  return;
}

if (mode === "credential-error") {
  process.stderr.write("Error: ANTHROPIC_API_KEY is missing. Not logged in, please authenticate.\n");
  process.exit(1);
}

if (mode === "credential-error-worded-differently") {
  process.stderr.write("fatal: unauthorized — no api key found for this account; authentication failed\n");
  process.exit(1);
}

if (mode === "unrelated-error") {
  process.stderr.write("panic: internal assertion tripped in module qux while compacting the arena\n");
  process.exit(3);
}

if (mode === "talks-but-writes-nothing") {
  say("I have completed the task and saved the report.");
  process.exit(0);
}

if (mode === "env-probe") {
  say(`probe=${process.env.CLONE_AI_TEST_SECRET ?? "absent"}`);
  process.exit(0);
}

if (mode === "memory-candidates") {
  // Writes whatever the test put in FAKE_MEMORY_CANDIDATES_JSON verbatim.
  // 把测试放在 FAKE_MEMORY_CANDIDATES_JSON 的内容原样写入候选文件。
  const target = join(process.cwd(), "out", "candidates.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, process.env.FAKE_MEMORY_CANDIDATES_JSON ?? "[]", "utf8");
  say("Wrote memory candidates.");
  process.exit(0);
}

if (mode === "memory-mine-fail") {
  process.stderr.write("mining failed: model unavailable\n");
  process.exit(2);
}

// Default: behave like an agent that actually does the work.
// 默认：表现得像一个真正干活的 Agent。
const target = join(process.cwd(), process.env.FAKE_AGENT_OUTPUT ?? "out/report.md");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `# report\n\nprompt bytes: ${(process.argv.slice(2).join(" ") || "").length}\n`, "utf8");
say("Wrote the report.");
process.exit(0);
