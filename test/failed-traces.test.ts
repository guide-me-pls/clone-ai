import assert from "node:assert/strict";
import test from "node:test";

import { buildTraces } from "../src/audit/failed-traces.ts";
import { projectRunAudits } from "../src/audit/run-audit.ts";
import type { JournalEvent } from "../src/core/contracts.ts";

const base = { occurredAt: "2026-11-04T09:00:00.000Z", payload: {} };
let eventId = 0;
const event = (value: Omit<JournalEvent, "id">): JournalEvent => ({ ...value, id: `e${eventId++}` });

function eventsOf(options: { retries?: number; cancelled?: boolean; withLabel?: boolean } = {}): JournalEvent[] {
  const events: JournalEvent[] = [
    event({ ...base, sequence: 1, type: "trigger.received", payload: { id: "g1", kind: "query", summary: "整理周报", occurredAt: base.occurredAt, payload: {} } }),
    event({ ...base, sequence: 2, type: "task.created", taskId: "t1", payload: { id: "t1", title: "整理周报", objective: "整理", acceptanceCriteria: [], createdAt: base.occurredAt, triggerId: "g1" } }),
    event({ ...base, sequence: 3, type: "run.created", taskId: "t1", runId: "run-1", payload: { id: "run-1", taskId: "t1" } }),
    event({ ...base, sequence: 4, type: "plan.created", taskId: "t1", runId: "run-1", payload: { summary: "整理", steps: [{ id: "s1", title: "扫描", risk: "read_only", agentId: "draft-maker" }] } }),
  ];
  let sequence = 5;
  for (let index = 0; index < (options.retries ?? 1); index += 1) {
    events.push(event({ ...base, sequence: sequence++, type: "execution.started", taskId: "t1", runId: "run-1", payload: { stepId: "s1", providerId: "pi", adapterId: "draft-maker" } }));
  }
  events.push(event({
    ...base,
    sequence: sequence++,
    type: "execution.failed",
    taskId: "t1",
    runId: "run-1",
    occurredAt: "2026-11-04T09:01:00.000Z",
    payload: { stepId: "s1", message: "400 invalid model for owner@example.com token ghp_fakefake12345678", report: { category: "nonzero_exit" } },
  }));
  events.push(event({ ...base, sequence: sequence++, type: "run.status_changed", taskId: "t1", runId: "run-1", occurredAt: "2026-11-04T09:01:00.000Z", payload: { status: options.cancelled === true ? "cancelled" : "failed" } }));
  if (options.withLabel === true) {
    events.push(event({ ...base, sequence: sequence++, type: "audit.labeled", runId: "run-1", occurredAt: "2026-11-04T09:02:00.000Z", payload: { verdict: "fail", note: "stale" } }));
  }
  return events;
}

test("an explicit failure becomes one trace with a redacted reason", () => {
  const events = eventsOf();
  const [trace] = buildTraces(projectRunAudits(events), events, [], new Date("2026-11-04T10:00:00.000Z"));
  assert.ok(trace);
  assert.equal(trace.kind, "explicit");
  assert.equal(trace.failure?.category, "nonzero_exit");
  assert.equal(trace.failure?.reason?.includes("owner@example.com"), false);
  assert.match(trace.failure?.reason ?? "", /\[redacted|redacted/);
  assert.equal(trace.plan[0]?.title, "扫描");
  assert.equal(trace.executions[0]?.providerId, "pi");
});

test("implicit signals: retries, a cancel, and the owner saying 'no, again'", () => {
  const retryEvents = eventsOf({ retries: 3 });
  const [retryTrace] = buildTraces(projectRunAudits(retryEvents), retryEvents, [], new Date("2026-11-04T10:00:00.000Z"));
  assert.ok(retryTrace?.signals.some((signal) => signal.startsWith("retry>=3")));

  const cancelled = eventsOf({ cancelled: true });
  const [cancelTrace] = buildTraces(projectRunAudits(cancelled), cancelled, [], new Date("2026-11-04T10:00:00.000Z"));
  assert.ok(cancelTrace?.signals.includes("cancelled-by-owner"));

  const corrected = eventsOf();
  const messages = [{ at: "2026-11-04T09:05:00.000Z", speaker: "user", text: "不对，重来" }];
  const [correctedTrace] = buildTraces(projectRunAudits(corrected), corrected, messages, new Date("2026-11-04T10:00:00.000Z"));
  assert.ok(correctedTrace?.signals.some((signal) => signal.startsWith("owner-correction")));
  assert.equal(correctedTrace?.kind, "implicit");
});

test("a correction outside the window, or from the assistant, is not a signal", () => {
  const events = eventsOf();
  const messages = [
    { at: "2026-11-04T12:00:00.000Z", speaker: "user", text: "不对，重来" },
    { at: "2026-11-04T09:05:00.000Z", speaker: "assistant", text: "不对，重来" },
  ];
  const [trace] = buildTraces(projectRunAudits(events), events, messages, new Date("2026-11-04T13:00:00.000Z"));
  assert.equal(trace?.signals.some((signal) => signal.startsWith("owner-correction")), false);
});