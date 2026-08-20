import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { OpportunityService } from "../src/opportunity/opportunity-service.ts";
import { dedupeOpportunities, scanOpportunities } from "../src/opportunity/opportunity.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";

async function setup(t: TestContext): Promise<{ service: OpportunityService; journal: JsonlJournalStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-opp-"));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { service: new OpportunityService(journal), journal, directory };
}

test("a commitment due within 72 hours produces a deadline opportunity", async (t) => {
  const { service, journal } = await setup(t);
  const now = new Date("2026-08-19T08:00:00.000Z");
  await journal.append({
    type: "state.commitment.recorded",
    payload: {
      id: "commit-1",
      title: "提交季度报告",
      kind: "deadline",
      dueAt: new Date("2026-08-20T08:00:00.000Z").toISOString(),
      status: "active",
      provenance: { authoredBy: "owner" },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  });

  const cards = await service.scanAndRecord(now);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.source, "deadline");
  assert.match(cards[0]?.whyNow ?? "", /24 小时/);

  // A second scan must not duplicate the card.
  // 再次扫描不得重复记录卡片。
  assert.equal((await service.scanAndRecord(now)).length, 0);
  assert.equal((await service.list()).length, 1);
});

test("a failed run produces a follow-up opportunity", async (t) => {
  const { service, journal } = await setup(t);
  await journal.append({ type: "run.created", runId: "run-9", payload: { id: "run-9", taskId: "t", status: "created", createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" } });
  await journal.append({
    type: "run.status_changed",
    runId: "run-9",
    payload: { status: "failed", reason: "Worker exhausted its attempt budget." },
  });

  const cards = await service.scanAndRecord(new Date("2026-08-19T08:00:00.000Z"));
  assert.ok(cards.some((card) => card.source === "failed_task"));
});

test("dismissed opportunities are recorded", async (t) => {
  const { service, journal } = await setup(t);
  await journal.append({
    type: "opportunity.proposed",
    payload: {
      id: "opp-x", title: "t", source: "observation", whyNow: "w", observedBasis: [],
      proposedResult: "r", expectedValue: "low", confidence: "low", risk: "read_only",
      requiredAuthority: "prepare_auto", status: "proposed", createdAt: "2026-08-19T00:00:00.000Z",
    },
  });

  await service.resolve("opp-x", "dismissed");
  const events = await journal.list();
  assert.ok(events.some((event) => event.type === "opportunity.resolved"));
  assert.equal((events.find((event) => event.type === "opportunity.resolved")?.payload as { status?: string }).status, "dismissed");
});

test("scanOpportunities deduplicates cards serving the same entity", () => {
  const now = new Date("2026-08-19T08:00:00.000Z");
  const card = (id: string, serves?: { kind: "goal" | "commitment" | "run"; id: string; title: string }) => ({
    id, title: "t", source: "deadline" as const, whyNow: "w", observedBasis: [],
    proposedResult: "r", expectedValue: "low" as const, confidence: "low" as const,
    risk: "read_only" as const, requiredAuthority: "prepare_auto" as const,
    ...(serves === undefined ? {} : { serves }),
    status: "proposed" as const, createdAt: now.toISOString(),
  });

  const result = dedupeOpportunities([
    card("a", { kind: "commitment", id: "c1", title: "x" }),
    card("b", { kind: "commitment", id: "c1", title: "x" }),
    card("c", { kind: "goal", id: "g1", title: "y" }),
  ]);
  assert.equal(result.length, 2);
});
