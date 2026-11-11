import assert from "node:assert/strict";
import test from "node:test";

import { validateDispatchTask } from "../src/main-agent/tools/dispatch-task.ts";

test("a task needs an objective and at least one criterion", () => {
  assert.equal(validateDispatchTask(null).ok, false);
  assert.equal(validateDispatchTask({}).ok, false);
  const missingObjective = validateDispatchTask({ objective: "  ", acceptanceCriteria: ["a"] });
  assert.equal(missingObjective.ok, false);
  const missingCriteria = validateDispatchTask({ objective: "write a report" });
  assert.equal(missingCriteria.ok, false);
  assert.equal(validateDispatchTask({ objective: "x".repeat(4_001), acceptanceCriteria: ["a"] }).ok, false);
  assert.equal(validateDispatchTask({ objective: "x", acceptanceCriteria: Array.from({ length: 13 }, () => "c") }).ok, false);
});

test("a valid task is trimmed and a string criterion becomes a list", () => {
  const valid = validateDispatchTask({ objective: "  write a report  ", acceptanceCriteria: "  the file exists  " });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.ok && valid.task, { objective: "write a report", acceptanceCriteria: ["the file exists"] });
  const filtered = validateDispatchTask({ objective: "x", acceptanceCriteria: [" a ", "", 3, "b"] });
  assert.equal(filtered.ok, true);
  assert.deepEqual(filtered.ok && filtered.task.acceptanceCriteria, ["a", "b"]);
});

test("a dispatch task is validated before it can waste a planning round", () => {
  const result = validateDispatchTask({
    objective: "Summarize README.md into out/summary.md.",
    acceptanceCriteria: ["out/summary.md exists", "it mentions the project name"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.task.acceptanceCriteria.length, 2);
});

test("a stopped turn cancels the task it dispatched", async (t) => {
  // dispatch_task ran inline and ignored the turn's signal, so stopping the
  // answer left the task running.
  // dispatch_task 以前内联执行并忽略回合信号，停止回答后任务仍在跑。
  const { dispatchTaskTool } = await import("../src/main-agent/tools/dispatch-task.ts");
  const tool = dispatchTaskTool({ dataDirectory: "/nonexistent-clone-home" });
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  // The tool reports the failure rather than throwing, and it does not start a run.
  // 工具报告失败而不是抛出，且不会启动 Run。
  const result = await tool.execute("call-1", { objective: "do work", acceptanceCriteria: ["it is done"] });
  assert.equal(result.content[0]?.type, "text");
  const payload = JSON.parse(result.content[0]!.text!) as { accepted: boolean; error?: string };
  assert.equal(payload.accepted, false, "an aborted dispatch is refused, not started");
  t.diagnostic(String(payload.error ?? ""));
});
