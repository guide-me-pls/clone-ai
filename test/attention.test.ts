import assert from "node:assert/strict";
import test from "node:test";

import { buildAttention } from "../src/opportunity/attention.ts";

const now = new Date("2026-11-05T12:00:00Z");

function commitment(overrides: Record<string, unknown>): never {
  return { id: "c1", title: "Send the weekly report", status: "open", dueAt: "2026-11-04T09:00:00Z", ...overrides } as never;
}

test("an overdue commitment outranks everything else", () => {
  const items = buildAttention({
    now,
    commitments: [commitment({})],
    candidates: [{ id: "m1", summary: "A memory to review", status: "proposed" } as never],
    opportunities: [{ id: "o1", title: "An idea", whyNow: "because", status: "proposed", expectedValue: "high" } as never],
  });
  assert.equal(items[0]!.kind, "overdue_commitment");
  assert.ok(items.some((item) => item.kind === "memory_candidate"));
});

test("a commitment due in a day appears as due soon, one due next month does not appear", () => {
  const items = buildAttention({
    now,
    commitments: [
      commitment({ id: "soon", dueAt: "2026-11-06T09:00:00Z" }),
      commitment({ id: "later", dueAt: "2026-12-06T09:00:00Z" }),
    ],
  });
  assert.deepEqual(items.map((item) => item.id), ["commitment:soon"]);
  assert.equal(items[0]!.kind, "due_soon_commitment");
});

test("met commitments and connector observations keep their provenance", () => {
  const items = buildAttention({
    now,
    commitments: [commitment({ status: "met" })],
    observations: [{ externalId: "ev1", kind: "calendar_event", title: "Design review", connectorId: "calendar" }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "observation");
  assert.equal(items[0]!.untrusted, true);
  assert.equal(items[0]!.action.id, "observation:ev1");
});

test("every item points at the service that owns it", () => {
  const items = buildAttention({
    now,
    candidates: [{ id: "m1", summary: "x", status: "proposed" } as never],
    suggestions: [{ id: "s1", kind: "retire", target: "m1", title: "T", rationale: "R", suggestedAt: "" } as never],
  });
  assert.deepEqual(items.map((item) => item.action.service), ["memory", "improvement"]);
});
