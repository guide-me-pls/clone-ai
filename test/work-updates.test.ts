import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendWorkUpdate, describeWorkUpdate, readWorkUpdates } from "../src/main-agent/work-updates.ts";

test("a work update survives a restart and reads as one sentence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-work-updates-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const at = "2026-11-04T09:00:00.000Z";
  await appendWorkUpdate(directory, { id: "r1:completed", runId: "r1", title: "整理周报", status: "completed", summary: "完成 3 个步骤", at, evidenceCount: 2 });
  await appendWorkUpdate(directory, { id: "r2:failed", runId: "r2", title: "发邮件", status: "failed", summary: "cancelled by owner", at: "2026-11-04T09:05:00.000Z", evidenceCount: 0 });
  // Re-appending the same id converges instead of duplicating. 同一 id 重复追加会收敛而不是重复。
  await appendWorkUpdate(directory, { id: "r1:completed", runId: "r1", title: "整理周报", status: "completed", summary: "完成 3 个步骤", at, evidenceCount: 2 });

  const updates = await readWorkUpdates(directory);
  assert.equal(updates.length, 2);
  assert.equal(updates[0]!.runId, "r1");
  assert.match(describeWorkUpdate(updates[0]!), /任务「整理周报」已完成：完成 3 个步骤，2 条证据。/);
  assert.match(describeWorkUpdate(updates[1]!), /失败/);
});
