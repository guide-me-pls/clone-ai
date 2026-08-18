// A scripted stand-in for a Pi JSONL RPC subprocess. FAKE_PI_MODE selects a
// failure shape; the default is the happy path. All output uses writeSync so
// process.exit can never truncate a record that a test depends on.
// Pi JSONL RPC 子进程的确定性替身。FAKE_PI_MODE 选择故障形态，默认走幸福路径。
// 全部输出使用 writeSync，保证 process.exit 不会截断测试依赖的记录。
import { writeSync } from "node:fs";

const mode = process.env.FAKE_PI_MODE ?? "";
let buffer = "";

function write(value) {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const command = JSON.parse(line);
    if (command.type === "abort") {
      write({ type: "response", command: "abort", success: true });
      continue;
    }
    if (command.type !== "prompt") continue;
    write({ type: "response", command: "prompt", success: true, id: command.id });
    write({ type: "agent_start" });

    if (mode === "no-settle") {
      // A crash after real progress: the process ends cleanly but never settles.
      // 有真实进展后的崩溃：进程干净退出，但从未 settle。
      write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Half-done work." } });
      process.exit(0);
    }
    if (mode === "die-mid-line") {
      // Death in the middle of writing a record: no trailing newline.
      // 死在写记录的半途：没有结尾换行。
      writeSync(1, '{"type":"message_upd');
      process.exit(1);
    }
    if (mode === "garbage") {
      writeSync(1, "this line is not a protocol event\n");
      write({ type: "agent_settled" });
      process.exit(0);
    }
    if (mode === "ignore-abort") {
      // Wedged worker: blocks forever and never reads stdin again, so a
      // cooperative abort can never reach it. Only a kill ends this process.
      // 卡死的 Worker：永久阻塞、不再读 stdin，协作式 abort 永远送达不了；只有 kill 能结束它。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }

    write({ type: "turn_start" });
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Fixture Pi completed." } });
    write({ type: "agent_settled" });
    if (mode === "double-settle") write({ type: "agent_settled" });
  }
});
