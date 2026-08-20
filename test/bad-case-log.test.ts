import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { BadCaseLog, collectBadCases } from "../src/reporting/bad-case-log.ts";
import type { JournalEvent } from "../src/core/contracts.ts";

function event(sequence: number, type: string, payload: Record<string, unknown>, runId?: string): JournalEvent {
  return {
    id: `e-${sequence}`,
    sequence,
    type: type as JournalEvent["type"],
    occurredAt: `2026-08-19T0${Math.min(sequence, 9)}:00:00.000Z`,
    ...(runId === undefined ? {} : { runId }),
    payload,
  };
}

test("collectBadCases picks failures only, newest last", () => {
  const records = collectBadCases([
    event(1, "run.status_changed", { status: "completed" }, "r1"),
    event(2, "run.status_changed", { status: "failed", reason: "budget exhausted" }, "r1"),
    event(3, "subagent.failed", { workOrderId: "w1", agentId: "codex-cli", message: "exit 2" }, "r1"),
    event(4, "verification.completed", { passed: true }),
    event(5, "verification.completed", { passed: false, summary: "missing artifact" }),
  ]);

  assert.deepEqual(records.map((record) => record.sequence), [2, 3, 5]);
  assert.equal(records[1]?.agentId, "codex-cli");
  assert.equal(records[2]?.message, "missing artifact");
});

test("BadCaseLog appends once per sequence and survives restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-badcase-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const log = new BadCaseLog({ dataDirectory: directory });
  const events = [
    event(1, "run.status_changed", { status: "failed", reason: "timeout" }, "r1"),
    event(2, "dispatch.blocked", { reason: "codex not installed" }),
  ];

  const first = await log.appendNew(events);
  assert.equal(first.length, 2);
  // Same events again: nothing appended. 同样的事件再次出现：不追加。
  assert.equal((await log.appendNew(events)).length, 0);

  // A brand-new instance (restart) also does not duplicate. 全新实例（重启）也不会重复。
  const restarted = new BadCaseLog({ dataDirectory: directory });
  assert.equal((await restarted.appendNew(events)).length, 0);
  const fresh = await restarted.appendNew([event(3, "agent.install_failed", { agentId: "pi", message: "npm ERR" })]);
  assert.equal(fresh.length, 1);

  const text = await log.readLog();
  assert.match(text, /\[seq 1\] run.status_changed \(r1\)/);
  assert.match(text, /\[seq 2\] dispatch.blocked/);
  assert.match(text, /\[seq 3\] agent.install_failed \(pi\)/);
  assert.doesNotMatch(text, /seq 1[\s\S]*seq 1/);
});
