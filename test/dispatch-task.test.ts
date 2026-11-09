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
