import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireMainAgentSlot,
  MainAgentCapacityError,
  mainAgentSlotsDirectory,
  withMainAgentSlot,
} from "../src/main-agent/main-agent-slots.ts";
import type { MainAgentCapacitySnapshot } from "../src/main-agent/main-agent-capacity.ts";

function snapshot(limit: number): MainAgentCapacitySnapshot {
  return {
    cpuCount: 8,
    loadAverage1m: 0,
    freeMemoryMb: 8_192,
    totalMemoryMb: 16_384,
    limit,
    pinned: false,
    reason: "test",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a third turn waits for a slot and starts when one is released", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-main-slots-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const first = await acquireMainAgentSlot(directory, { sample: () => snapshot(2), pollMs: 20 });
  const second = await acquireMainAgentSlot(directory, { sample: () => snapshot(2), pollMs: 20 });
  let thirdStarted = false;
  let waits = 0;
  const third = acquireMainAgentSlot(directory, {
    sample: () => snapshot(2),
    pollMs: 20,
    onWait: () => { waits += 1; },
  }).then((release) => {
    thirdStarted = true;
    return release;
  });
  await delay(120);
  assert.equal(thirdStarted, false, "the third turn must not start above the limit");
  assert.ok(waits > 0, "a queued turn reports that it is waiting");
  await first();
  const thirdRelease = await third;
  assert.equal(thirdStarted, true);
  await second();
  await thirdRelease();

  const fourth = await acquireMainAgentSlot(directory, { sample: () => snapshot(2), pollMs: 20 });
  await fourth();
});

test("aborting the wait rejects without taking a slot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-main-slots-abort-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const held = await acquireMainAgentSlot(directory, { sample: () => snapshot(1), pollMs: 20 });
  const controller = new AbortController();
  const waiting = acquireMainAgentSlot(directory, {
    sample: () => snapshot(1),
    signal: controller.signal,
    pollMs: 20,
  });
  controller.abort();
  await assert.rejects(waiting, MainAgentCapacityError);
  await held();
  const after = await acquireMainAgentSlot(directory, { sample: () => snapshot(1), pollMs: 20 });
  await after();
});

test("a slot whose owner is gone is reclaimed instead of shrinking the pool", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-main-slots-stale-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const slots = mainAgentSlotsDirectory(directory);
  await mkdir(slots, { recursive: true });
  const stale = join(slots, "slot-0");
  await writeFile(stale, "99999999\n", "utf8");

  const release = await acquireMainAgentSlot(directory, { sample: () => snapshot(1), pollMs: 20 });
  // The stale file is replaced by the current directory form with our pid.
  // 陈旧文件被替换成当前目录形式，属主是我们的 pid。
  const owner = JSON.parse(await readFile(join(stale, "owner"), "utf8")) as { pid: number; token: string };
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.token, "string");
  await release();
});

test("a shrinking limit stops admitting new turns into freed low indices", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-main-slots-shrink-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  let limit = 3;
  const sample = (): MainAgentCapacitySnapshot => snapshot(limit);
  const first = await acquireMainAgentSlot(directory, { sample, pollMs: 20 });
  const second = await acquireMainAgentSlot(directory, { sample, pollMs: 20 });
  const third = await acquireMainAgentSlot(directory, { sample, pollMs: 20 });

  limit = 2;
  await first();
  let admitted = false;
  const waiting = acquireMainAgentSlot(directory, { sample, pollMs: 20 }).then((release) => {
    admitted = true;
    return release;
  });
  await delay(120);
  // Two slots are still live, so the freed low index must not be reused.
  // 仍有两个存活槽位，因此刚释放的低编号不能被复用。
  assert.equal(admitted, false, "a shrink must count every live slot, not only indices below the limit");
  await second();
  const release = await waiting;
  assert.equal(admitted, true);
  await release();
  await third();
});

test("withMainAgentSlot frees the slot when the turn throws", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-main-slots-throw-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    withMainAgentSlot(directory, async () => {
      throw new Error("boom");
    }, { sample: () => snapshot(1), pollMs: 20 }),
    /boom/,
  );
  const release = await acquireMainAgentSlot(directory, { sample: () => snapshot(1), pollMs: 20 });
  await release();
});
