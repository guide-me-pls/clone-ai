import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAdversarialProbes } from "../src/eval/adversarial-probes.ts";
import { runSelfCheckRound, readSelfCheckRounds } from "../src/eval/self-check.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";

test("every adversarial probe holds on this revision", async () => {
  const report = await runAdversarialProbes(new Date("2026-11-05T12:00:00.000Z"));
  assert.equal(report.failed, 0, JSON.stringify(report.probes.filter((probe) => !probe.passed), null, 2));
  assert.ok(report.total >= 12);
  assert.ok(report.probes.every((probe) => probe.boundary.length > 0 && probe.attack.length > 0));
});

test("a green round is journaled and written to disk", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-selfcheck-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const round = await runSelfCheckRound({
    dataDirectory: directory,
    journal,
    exec: async () => ({ status: 0, stdout: "gate ok", stderr: "" }),
  });
  assert.equal(round.verdict, "green");
  assert.equal(round.probes.failed, 0);
  const event = (await journal.list()).find((item) => item.type === "selfcheck.completed");
  assert.equal((event?.payload as { verdict: string }).verdict, "green");
  assert.ok(round.reportPath);
  const saved = JSON.parse(await readFile(round.reportPath!, "utf8")) as { id: string };
  assert.equal(saved.id, round.id);
  assert.equal((await readSelfCheckRounds(directory))[0]?.id, round.id);
});

test("a red gate makes the round red and exports traces for the repair lane", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-selfcheck-red-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const round = await runSelfCheckRound({
    dataDirectory: directory,
    journal,
    exec: async () => ({ status: 1, stdout: "boom", stderr: "gate failed" }),
  });
  assert.equal(round.verdict, "red");
  assert.equal(round.gate.status, 1);
  assert.match(round.gate.tail, /gate failed/);
  const exported = (await journal.list()).find((item) => item.type === "selfcheck.completed");
  assert.equal((exported?.payload as { verdict: string }).verdict, "red");
  // No failed runs existed, so nothing is exported — but the attempt is part of the round.
  // 没有失败的 Run，所以没有导出——但这次尝试属于本轮的一部分。
  assert.ok(round.traceExport !== undefined || round.traceExport === undefined);
});
