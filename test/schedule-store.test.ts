import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("one dispatch failure is visible and cannot suppress another due schedule", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedule-failure-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "schedules.json");
  const store = new ScheduleStore(path);
  await store.addDaily({ query: "第一个定时任务", time: "08:00" });
  await store.addDaily({ query: "第二个定时任务", time: "08:00" });
  const calls: string[] = [];
  const scheduler = new LocalScheduler({
    store,
    run: async (schedule) => {
      calls.push(schedule.query);
      if (schedule.query === "第一个定时任务") throw new Error("simulated dispatch failure");
    },
  });
  const when = new Date(2035, 0, 2, 9, 0);
  await scheduler.tick(when);
  await scheduler.tick(when);
  assert.deepEqual(calls, ["第一个定时任务", "第二个定时任务"]);
  const occurrences = await new ScheduleStore(path).listOccurrences();
  assert.equal(occurrences.find((item) => item.schedule.query === "第一个定时任务")?.status, "unknown");
  assert.equal(occurrences.find((item) => item.schedule.query === "第二个定时任务")?.status, "dispatched");
});

test("a claimed but unstarted occurrence survives restart and is dispatched once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedule-restart-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "schedules.json");
  const first = new ScheduleStore(path);
  await first.addDaily({ query: "重启后继续执行", time: "08:00" });
  const when = new Date(2035, 0, 2, 9, 0);
  assert.equal((await first.claimDue(when)).length, 1);

  const restarted = new ScheduleStore(path);
  const calls: string[] = [];
  const scheduler = new LocalScheduler({ store: restarted, run: async (schedule) => { calls.push(schedule.query); } });
  await scheduler.tick(when);
  await scheduler.tick(when);
  assert.deepEqual(calls, ["重启后继续执行"]);
  assert.equal((await restarted.listOccurrences())[0]?.status, "dispatched");
});

test("two schedule stores cannot claim the same occurrence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedule-race-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "schedules.json");
  const first = new ScheduleStore(path);
  await first.addDaily({ query: "只触发一次", time: "08:00" });
  const second = new ScheduleStore(path);
  const when = new Date(2035, 0, 2, 9, 0);
  const claimed = await Promise.all([first.claimDue(when), second.claimDue(when)]);
  assert.equal(claimed.flat().length, 1);
  assert.equal((await first.listOccurrences()).length, 1);
});

test("an interrupted dispatch stays unknown until an explicit retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedule-unknown-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "schedules.json");
  const store = new ScheduleStore(path);
  await store.addDaily({ query: "检查中断后的结果", time: "08:00" });
  const when = new Date(2035, 0, 2, 9, 0);
  await store.claimDue(when);
  const occurrence = (await store.listOccurrences())[0]!;
  assert.ok(await store.beginOccurrence(occurrence.id, "abandoned-dispatcher"));
  const calls: string[] = [];
  const restarted = new ScheduleStore(path);
  const scheduler = new LocalScheduler({ store: restarted, run: async (schedule) => { calls.push(schedule.query); } });
  await scheduler.tick(when);
  assert.deepEqual(calls, []);
  assert.equal((await restarted.listOccurrences())[0]?.status, "unknown");

  await restarted.resolveOccurrence(occurrence.id, "retry");
  await scheduler.tick(when);
  assert.deepEqual(calls, ["检查中断后的结果"]);
  assert.equal((await restarted.listOccurrences())[0]?.status, "dispatched");
  await assert.rejects(restarted.resolveOccurrence(occurrence.id, "retry"), /Only an unknown occurrence/);
});

test("a second scheduler cannot steal an active dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedule-active-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "schedules.json");
  const firstStore = new ScheduleStore(path);
  await firstStore.addDaily({ query: "正在执行的任务", time: "08:00" });
  const when = new Date(2035, 0, 2, 9, 0);
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const first = new LocalScheduler({ store: firstStore, run: async () => { started(); await running; } });
  const secondCalls: string[] = [];
  const second = new LocalScheduler({
    store: new ScheduleStore(path),
    run: async (schedule) => { secondCalls.push(schedule.query); },
  });
  const firstTick = first.tick(when);
  await entered;
  await second.tick(when);
  assert.deepEqual(secondCalls, []);
  assert.equal((await firstStore.listOccurrences())[0]?.status, "dispatching");
  release();
  await firstTick;
  assert.equal((await firstStore.listOccurrences())[0]?.status, "dispatched");
});

test("pausing a schedule prevents an already-pending occurrence from starting", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedule-pause-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new ScheduleStore(join(directory, "schedules.json"));
  const schedule = await store.addDaily({ query: "暂停时不要执行", time: "08:00" });
  const when = new Date(2035, 0, 2, 9, 0);
  await store.claimDue(when);
  await store.setEnabled(schedule.id, false);
  const calls: string[] = [];
  const scheduler = new LocalScheduler({ store, run: async (item) => { calls.push(item.query); } });
  await scheduler.tick(when);
  assert.deepEqual(calls, []);
  assert.equal((await store.listOccurrences())[0]?.status, "pending");
  await store.setEnabled(schedule.id, true);
  await scheduler.tick(when);
  assert.deepEqual(calls, ["暂停时不要执行"]);
});

test("stopping waits for an in-flight dispatch before returning", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedule-stop-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new ScheduleStore(join(directory, "schedules.json"));
  await store.addDaily({ query: "等待正在执行的任务", time: "08:00" });
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const scheduler = new LocalScheduler({ store, run: async () => { started(); await running; } });
  const tick = scheduler.tick(new Date(2035, 0, 2, 9, 0));
  await entered;
  let stopped = false;
  const stop = Promise.resolve(scheduler.stop()).then(() => { stopped = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false);
  } finally {
    release();
    await Promise.all([tick, stop]);
  }
  assert.equal(stopped, true);
});

test("legacy schedules are imported once without rewriting the original file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-schedule-migrate-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "schedules.json");
  const original = JSON.stringify({ schedules: [{
    id: "legacy", kind: "daily", query: "保留原来的计划", time: "08:00", enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }] });
  await writeFile(path, original, "utf8");
  const store = new ScheduleStore(path);
  assert.deepEqual((await store.list()).map((schedule) => schedule.id), ["legacy"]);
  await store.addDaily({ query: "新的计划", time: "09:00" });
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal((await new ScheduleStore(path).list()).length, 2);
});
