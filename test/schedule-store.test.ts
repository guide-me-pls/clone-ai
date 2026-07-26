import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalScheduler } from "../src/scheduling/local-scheduler.ts";
import { ScheduleStore } from "../src/scheduling/schedule-store.ts";

test("a daily schedule is claimed once per local day", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedules-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const store = new ScheduleStore(join(directory, "schedules.json"));
  await store.addDaily({ query: "整理今天需要推进的事情", time: "09:30" });
  const dueAtNineThirty = new Date(2026, 0, 2, 9, 30);

  assert.equal((await store.claimDue(dueAtNineThirty)).length, 1);
  assert.equal((await store.claimDue(new Date(2026, 0, 2, 16, 0))).length, 0);
  assert.equal((await store.claimDue(new Date(2026, 0, 3, 9, 30))).length, 1);
});

test("the local scheduler dispatches claimed schedules through the supplied runtime boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-scheduler-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const store = new ScheduleStore(join(directory, "schedules.json"));
  await store.addDaily({ query: "准备每日简报", time: "08:00" });
  const calls: string[] = [];
  const scheduler = new LocalScheduler({ store, run: async (schedule) => { calls.push(schedule.query); } });

  await scheduler.tick(new Date(2026, 0, 2, 8, 0));
  await scheduler.tick(new Date(2026, 0, 2, 8, 30));
  assert.deepEqual(calls, ["准备每日简报"]);
});

test("weekly, monthly, yearly, and five-field Cron schedules claim only when their recurrence matches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-recurrence-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const store = new ScheduleStore(join(directory, "schedules.json"));
  await store.add({ query: "每周一准备本周计划", kind: "weekly", weekdays: [1], time: "09:00" });
  await store.add({ query: "每月复盘", kind: "monthly", dayOfMonth: 15, time: "10:00" });
  await store.add({ query: "年度目标回顾", kind: "yearly", month: 7, dayOfMonth: 26, time: "11:00" });
  await store.add({ query: "工作日上午检查", kind: "cron", cron: "0 9 * * 1-5" });

  assert.deepEqual((await store.claimDue(new Date(2024, 6, 26, 8, 59))).map((schedule) => schedule.query), []);
  assert.deepEqual((await store.claimDue(new Date(2024, 6, 26, 11, 0))).map((schedule) => schedule.query), ["年度目标回顾"]);
  assert.deepEqual((await store.claimDue(new Date(2024, 0, 1, 9, 0))).map((schedule) => schedule.query), ["每周一准备本周计划", "工作日上午检查"]);
  assert.deepEqual((await store.claimDue(new Date(2024, 0, 15, 10, 0))).map((schedule) => schedule.query), ["每周一准备本周计划", "每月复盘"]);
  assert.deepEqual((await store.claimDue(new Date(2024, 0, 15, 10, 0))).map((schedule) => schedule.query), []);
});
