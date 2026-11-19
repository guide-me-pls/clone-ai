import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeMainAgentCapacity,
  readMainAgentCapacityPin,
  sampleMainAgentCapacity,
} from "../src/main-agent/main-agent-capacity.ts";
import { CloneConfigStore } from "../src/config/clone-config.ts";
import { resolveClonePaths } from "../src/config/clone-home.ts";

const BASE = {
  loadAverage1m: 0,
  freeMemoryBytes: 8 * 1024 * 1024 * 1024,
  totalMemoryBytes: 16 * 1024 * 1024 * 1024,
};

test("auto capacity follows cores, load and free memory", () => {
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 8 }).limit, 4);
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 4 }).limit, 2);
  // Two tasks must be able to start on a small laptop. 小笔记本上也要能启动两个任务。
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 2 }).limit, 2);
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 1 }).limit, 1);
  // A very large host is still bounded. 很大的主机仍有上限。
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 32 }).limit, 8);
  // Half-busy cores halve the budget. 核数一半忙时预算减半。
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 8, loadAverage1m: 4 }).limit, 2);
  // The "two" is a floor only while the machine has room: a loaded two-core
  // host admits one turn at a time. 只有机器有余量时"两个"才是下限：负载已高的双核主机
  // 一次只接纳一个回合。
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 2, loadAverage1m: 2 }).limit, 1);
  // macOS reports only free pages; that reading must not collapse the limit.
  // macOS 只报告空闲页；这个读数不得把上限压垮。
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 18, freeMemoryBytes: 400 * 1024 * 1024 }).limit, 8);
  // A low-memory eight-core host still runs its CPU budget. 内存低的八核主机仍按其 CPU 预算运行。
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 8, freeMemoryBytes: 1.2 * 1024 * 1024 * 1024 }).limit, 4);
});

test("a pinned limit wins but never exceeds the cores", () => {
  const pinned = computeMainAgentCapacity({ ...BASE, cpuCount: 8, pinnedLimit: 3 });
  assert.equal(pinned.limit, 3);
  assert.equal(pinned.pinned, true);
  assert.match(pinned.reason, /pinned 3/);
  assert.equal(computeMainAgentCapacity({ ...BASE, cpuCount: 4, pinnedLimit: 9 }).limit, 4);
});

test("the live sampler reports a usable limit and the pin is read from config", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-main-capacity-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const live = sampleMainAgentCapacity();
  assert.ok(live.limit >= 1);
  assert.equal(await readMainAgentCapacityPin(directory), undefined);
  const store = new CloneConfigStore(resolveClonePaths({ dataDirectory: directory }));
  await store.update({ maxConcurrentMainAgents: 2 });
  assert.equal(await readMainAgentCapacityPin(directory), 2);
  await store.update({ maxConcurrentMainAgents: 0 });
  assert.equal(await readMainAgentCapacityPin(directory), undefined);
});
