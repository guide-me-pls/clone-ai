import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const slotsModule = new URL("../src/main-agent/main-agent-slots.ts", import.meta.url).href;

function acquireInChild(directory: string, holdMs: number, logPath: string): Promise<{ code: number | null; stderr: string }> {
  // Each child is a separate process, which is the only way to prove that the
  // cap is not an in-process semaphore. The log records the real acquisition
  // and release instants so the parent can assert the intervals do not overlap.
  // 每个子进程都是独立进程，这是证明上限不是进程内信号量的唯一方式。日志记录真实的获取与
  // 释放时刻，父进程据此断言两个区间不重叠。
  const script = `
    (async () => {
      const { appendFileSync } = await import("node:fs");
      const { acquireMainAgentSlot } = await import(${JSON.stringify(slotsModule)});
      const release = await acquireMainAgentSlot(${JSON.stringify(directory)}, {
        sample: () => ({ cpuCount: 8, loadAverage1m: 0, freeMemoryMb: 8192, totalMemoryMb: 16384, limit: 1, pinned: false, reason: "cross-process" }),
        pollMs: 10,
      });
      appendFileSync(${JSON.stringify(logPath)}, "start " + process.pid + " " + Date.now() + "\\n");
      await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
      appendFileSync(${JSON.stringify(logPath)}, "end " + process.pid + " " + Date.now() + "\\n");
      await release();
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

async function waitFor(path: string, pattern: RegExp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (pattern.test(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${path}`);
}

test("two processes cannot hold the same slot at once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-slots-processes-"));
  const logPath = join(directory, "timeline.log");
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const first = acquireInChild(directory, 600, logPath);
  await waitFor(logPath, /^start \d+ \d+/m, 10_000);
  const second = acquireInChild(directory, 50, logPath);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));

  const timeline = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => line.split(" "));
  const starts = timeline.filter((parts) => parts[0] === "start").map((parts) => ({ pid: parts[1], at: Number(parts[2]) }));
  const ends = timeline.filter((parts) => parts[0] === "end").map((parts) => ({ pid: parts[1], at: Number(parts[2]) }));
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  const firstStart = starts[0]!;
  const secondStart = starts.find((start) => start.pid !== firstStart.pid)!;
  const firstEnd = ends.find((end) => end.pid === firstStart.pid)!;
  assert.ok(
    secondStart.at >= firstEnd.at - 5,
    `the second process acquired at ${secondStart.at}, before the first released at ${firstEnd.at}`,
  );
});
