import assert from "node:assert/strict";
import test from "node:test";

import type { JournalEvent } from "../src/core/contracts.ts";
import { assertTransition, replay } from "../src/core/run-state.ts";

/**
 * The journal is shared by several processes. A projection rebuild must reflect
 * what was recorded even when one raced writer recorded a transition a later
 * reader would not have allowed — otherwise a single bad event makes the whole
 * journal unreadable and the app cannot start.
 * Journal 被多个进程共享。投影重建必须如实反映记录内容，即使某个竞态写入者记录了一次
 * 后见之明不允许的转换——否则一个坏事件就让整本 Journal 不可读，App 无法启动。
 */
test("replay keeps the last recorded status through a raced transition instead of throwing", () => {
  const at = "2026-11-18T06:14:08.000Z";
  const events: JournalEvent[] = [
    {
      id: "e1", sequence: 1, type: "run.created", occurredAt: at, taskId: "task-1", runId: "run-1",
      payload: { id: "run-1", taskId: "task-1", status: "created", createdAt: at, updatedAt: at },
    },
    { id: "e2", sequence: 2, type: "run.status_changed", occurredAt: at, taskId: "task-1", runId: "run-1", payload: { status: "running" } },
    { id: "e3", sequence: 3, type: "run.status_changed", occurredAt: at, taskId: "task-1", runId: "run-1", payload: { status: "failed", reason: "executor died" } },
    // A second process kept executing the same run after the first one failed it.
    // 第二个进程在第一个进程把 Run 判失败之后仍在执行同一个 Run。
    { id: "e4", sequence: 4, type: "run.status_changed", occurredAt: at, taskId: "task-1", runId: "run-1", payload: { status: "verifying" } },
  ];

  const projection = replay(events);

  assert.equal(projection.runs["run-1"]?.status, "verifying", "the projection must reflect the last recorded status");
});

/**
 * Replay tolerance must not become write tolerance: a live executor that tries
 * the same change is still refused before the event reaches the journal.
 * 重放的宽容不能变成写入的宽容：实时执行器尝试同样的变更时，仍会在事件进入 Journal 之前被拒绝。
 */
test("live writers still refuse the raced transition", () => {
  assert.throws(() => assertTransition("failed", "verifying"), /Invalid run status transition: failed -> verifying/);
  assert.doesNotThrow(() => assertTransition("running", "verifying"));
});
