import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AgentLoop } from "../src/loop/agent-loop.ts";
import type { LoopModel, ModelTurn } from "../src/loop/contracts.ts";
import { JsonFileLoopCheckpointStore } from "../src/loop/checkpoint.ts";
import { JsonlLoopJournal } from "../src/loop/journal.ts";
import { restoreLoopRun } from "../src/loop/recovery.ts";
import { ToolRegistry, createWorkspaceTools } from "../src/loop/tools.ts";

const fixture = fileURLToPath(new URL("./fixtures/crashing-loop.mts", import.meta.url));

// The in-process resume tests hand the generator back politely; this test does
// not. The first process dies without cleanup, and a second real process must
// rebuild the world from disk alone. This is the Phase 0 recovery proof.
// 进程内的 resume 测试是礼貌地归还 Generator；这个测试不是。第一个进程不做清理直接死掉，
// 第二个真实进程必须仅凭磁盘重建世界。这就是 Phase 0 的恢复证明。
test("a run killed mid-flight is resumed by a fresh process and completes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-restart-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const runId = "00000000-0000-0000-0000-0000000000c1";

  const crash = await runToCrash(directory, runId);
  assert.equal(crash.code, 137, `the crashing process should die at its scripted point: ${crash.stderr}`);

  const journal = new JsonlLoopJournal(join(directory, "journal.jsonl"));
  const checkpoints = new JsonFileLoopCheckpointStore(join(directory, "checkpoints"));

  const restored = await restoreLoopRun({ runId, journal, checkpoints });
  assert.equal(restored.status, "waiting_tools");
  assert.equal(restored.goal, "Survive a crash between planning and execution.");
  assert.deepEqual(restored.pendingToolCalls.map((call) => call.id), ["crash-read"]);

  const finalModel: LoopModel = {
    async respond(): Promise<ModelTurn> {
      return { kind: "final", text: "Recovered after the crash and finished the task." };
    },
  };
  const loop = new AgentLoop({
    model: finalModel,
    modelFactory: () => finalModel,
    tools: new ToolRegistry(createWorkspaceTools(directory)),
    journal,
    checkpoints,
  });

  const resumed = [];
  for await (const event of loop.resume(runId)) resumed.push(event);

  assert.deepEqual(resumed.map((event) => event.type), [
    "tool.requested",
    "tool.completed",
    "context.built",
    "model.started",
    "model.completed",
    "verification.completed",
    "run.completed",
  ]);

  const events = await journal.list(runId);
  assert.equal(events.filter((event) => event.type === "tool.completed").length, 1);
  assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
  const finalState = await restoreLoopRun({ runId, journal, checkpoints });
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.finalAnswer, "Recovered after the crash and finished the task.");
});

function runToCrash(directory: string, runId: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", fixture, directory, runId], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stderr }));
  });
}
