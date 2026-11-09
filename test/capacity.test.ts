import assert from "node:assert/strict";
import test from "node:test";

import { CapacityGate, computeCapacity } from "../src/core/capacity.ts";

test("capacity is bound by CPU first on a small, idle machine", () => {
  const snapshot = computeCapacity({
    cpuCount: 4,
    loadAverage1m: 0.1,
    freeMemoryBytes: 16 * 1024 * 1024 * 1024,
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
  });
  assert.equal(snapshot.limit, 3);
  assert.match(snapshot.reason, /CPU/);
  assert.equal(snapshot.pinned, false);
});

test("capacity is bound by free memory when memory is scarce", () => {
  const snapshot = computeCapacity({
    cpuCount: 16,
    loadAverage1m: 0.2,
    freeMemoryBytes: 2 * 1024 * 1024 * 1024,
    totalMemoryBytes: 32 * 1024 * 1024 * 1024,
  });
  // (2048 - 1024) / 768 = 1
  assert.equal(snapshot.limit, 1);
  assert.match(snapshot.reason, /memory/);
});

test("a loaded machine allows fewer slots than an idle one", () => {
  const base = { cpuCount: 8, freeMemoryBytes: 32 * 1024 * 1024 * 1024, totalMemoryBytes: 32 * 1024 * 1024 * 1024 };
  const idle = computeCapacity({ ...base, loadAverage1m: 0 });
  const busy = computeCapacity({ ...base, loadAverage1m: 7 });
  assert.equal(idle.limit, 6);
  assert.equal(busy.limit, 2);
  assert.ok(busy.limit < idle.limit);
});

test("an owner pin wins, capped by the core count", () => {
  const base = { cpuCount: 4, loadAverage1m: 0, freeMemoryBytes: 32 * 1024 * 1024 * 1024, totalMemoryBytes: 32 * 1024 * 1024 * 1024 };
  const pinned = computeCapacity({ ...base, pinnedLimit: 2 });
  assert.equal(pinned.limit, 2);
  assert.equal(pinned.pinned, true);
  const tooHigh = computeCapacity({ ...base, pinnedLimit: 64 });
  assert.equal(tooHigh.limit, 4);
});

test("the gate never exceeds the limit and releases waiters in order", async () => {
  const gate = new CapacityGate(() => computeCapacity({
    cpuCount: 8,
    loadAverage1m: 0,
    freeMemoryBytes: 64 * 1024 * 1024 * 1024,
    totalMemoryBytes: 64 * 1024 * 1024 * 1024,
    pinnedLimit: 2,
  }));
  assert.equal(gate.snapshot().limit, 2);

  const first = await gate.acquire();
  const second = await gate.acquire();
  assert.equal(gate.active, 2);

  let thirdAcquired = false;
  const third = gate.acquire().then((release) => { thirdAcquired = true; return release; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(thirdAcquired, false);
  assert.equal(gate.waiting, 1);

  first();
  const thirdRelease = await third;
  assert.equal(thirdAcquired, true);
  assert.equal(gate.active, 2);
  second();
  thirdRelease();
  assert.equal(gate.active, 0);
});

test("a cancelled wait releases the queue slot", async () => {
  const gate = new CapacityGate(() => computeCapacity({
    cpuCount: 2, loadAverage1m: 0,
    freeMemoryBytes: 64 * 1024 * 1024 * 1024,
    totalMemoryBytes: 64 * 1024 * 1024 * 1024,
    pinnedLimit: 1,
  }));
  const held = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(gate.waiting, 0);
  held();
  assert.equal(gate.active, 0);
});
