import assert from "node:assert/strict";
import { cpus } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createRuntimeAssembly, type RuntimeAssembly } from "../src/core/runtime-factory.ts";
import { createKernelRuntimeSession } from "../src/main-agent/tools/kernel-tools.ts";
import { CloneConfigStore } from "../src/config/clone-config.ts";
import { resolveClonePaths } from "../src/config/clone-home.ts";

/**
 * A temporary clone home, closed before the directory is removed.
 * 一个一次性 clone home，在删除目录之前关闭。
 */
async function tempHome(t: TestContext): Promise<{ dataDirectory: string; workspacePath: string; closers: Array<() => void> }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-shared-capacity-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-shared-capacity-ws-"));
  const closers: Array<() => void> = [];
  t.after(async () => {
    for (const close of closers.reverse()) close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  return { dataDirectory, workspacePath, closers };
}

async function assemble(
  dataDirectory: string,
  workspacePath: string,
  closers: Array<() => void>,
): Promise<RuntimeAssembly> {
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  closers.push(assembly.close);
  return assembly;
}

async function pinWorkers(dataDirectory: string, limit: number): Promise<void> {
  const store = new CloneConfigStore(resolveClonePaths({ dataDirectory }));
  await store.update({ maxConcurrentWorkers: limit });
}

test("two concurrently assembled runtimes for one home share one worker limit", async (t) => {
  const { dataDirectory, workspacePath, closers } = await tempHome(t);
  await pinWorkers(dataDirectory, 1);
  // Assembled concurrently, the way two Main Agent turns dispatch at once.
  // 并发组装，正如两个 Main Agent 回合同时派发那样。
  const [first, second] = await Promise.all([
    assemble(dataDirectory, workspacePath, closers),
    assemble(dataDirectory, workspacePath, closers),
  ]);

  assert.equal(first.capacityGate, second.capacityGate, "both assemblies must draw from one gate");
  assert.equal(first.runtime.capacity().limit, 1);
  assert.equal(first.runtime.capacity().pinned, true);

  const release = await first.capacityGate.acquire();
  // The slot taken through the first assembly is visible to the second.
  // 通过第一个组装取得的槽位对第二个组装可见。
  assert.equal(second.capacityGate.active, 1);

  let secondAcquired = false;
  const pending = second.capacityGate.acquire().then((releaseSecond) => {
    secondAcquired = true;
    return releaseSecond;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondAcquired, false, "the second assembly must wait for the shared budget");
  assert.equal(second.capacityGate.waiting, 1);

  release();
  const releaseSecond = await pending;
  assert.equal(secondAcquired, true);
  assert.equal(second.capacityGate.active, 1, "one slot, not one per assembly");
  releaseSecond();
  assert.equal(first.capacityGate.active, 0);
});

test("a pin refreshed through one assembly applies to every assembly of the home", async (t) => {
  const { dataDirectory, workspacePath, closers } = await tempHome(t);
  await pinWorkers(dataDirectory, 1);
  const first = await assemble(dataDirectory, workspacePath, closers);
  const second = await assemble(dataDirectory, workspacePath, closers);
  assert.equal(second.runtime.capacity().limit, 1);

  const limit = Math.min(3, cpus().length);
  const store = new CloneConfigStore(resolveClonePaths({ dataDirectory }));
  await store.update({ maxConcurrentWorkers: 3 });
  // The desktop's settings endpoint refreshes the pin on its own assembly; the
  // other assembly must see the new value without a restart.
  // 桌面设置接口在它自己的组装上刷新固定值；另一个组装必须在无需重启的情况下看到新值。
  await first.refreshCapacityPin();

  assert.equal(first.runtime.capacity().limit, limit);
  assert.equal(second.runtime.capacity().limit, limit);
  assert.equal(second.runtime.capacity().pinned, true);
});

test("the Main Agent's kernel sessions share the daemon's budget for the home", async (t) => {
  const { dataDirectory, workspacePath, closers } = await tempHome(t);
  await pinWorkers(dataDirectory, 2);
  const daemon = await assemble(dataDirectory, workspacePath, closers);
  // createKernelRuntimeSession is what each Main Agent tool call and turn
  // builds; it must not get a second limit of its own.
  // createKernelRuntimeSession 是主 Agent 每次工具调用与每个回合构建的；它不能另得一份上限。
  const session = await createKernelRuntimeSession(dataDirectory);
  closers.push(session.close);

  // A slot held through an unrelated assembly over the same home must be
  // visible inside the Main Agent's session: it has no own limit to escape to.
  // 通过同一 home 上另一组装持有的槽位必须在主 Agent 的会话内可见：它没有自己的上限可逃。
  const release = await daemon.capacityGate.acquire();
  assert.equal(daemon.capacityGate.active, 1);
  // The session's runtime executes through this same gate; a second slot would
  // only be available if the session had built its own.
  // 会话的 Runtime 走同一个闸门执行；只有会话自建闸门时才会多出一个槽位。
  assert.equal(session.runtime.capacity().limit, daemon.runtime.capacity().limit);
  assert.equal(session.runtime.capacity().pinned, true);
  release();
  assert.equal(daemon.capacityGate.active, 0);
});

test("closing one assembly keeps the budget alive for the others; the last close retires it", async (t) => {
  const { dataDirectory, workspacePath, closers } = await tempHome(t);
  const first = await assemble(dataDirectory, workspacePath, closers);
  const second = await assemble(dataDirectory, workspacePath, closers);
  const shared = first.capacityGate;

  // The Main Agent closes a short-lived session after every tool call; that
  // must not wipe the daemon's gate. A double close releases only once.
  // 主 Agent 每次工具调用后关闭短命会话；这不能抹掉 Daemon 的闸门。重复关闭只释放一次。
  first.close();
  first.close();
  const third = await assemble(dataDirectory, workspacePath, closers);
  assert.equal(third.capacityGate, shared);

  second.close();
  third.close();
  const fresh = await assemble(dataDirectory, workspacePath, closers);
  assert.notEqual(fresh.capacityGate, shared, "the last close must remove the entry so temporary homes do not leak");
});

test("many temporary homes leave no shared gate behind", async (t) => {
  for (let index = 0; index < 12; index += 1) {
    const dataDirectory = await mkdtemp(join(tmpdir(), `clone-ai-shared-capacity-${index}-`));
    t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
    const first = await createRuntimeAssembly({ dataDirectory, workspacePath: dataDirectory });
    const gate = first.capacityGate;
    first.close();
    const second = await createRuntimeAssembly({ dataDirectory, workspacePath: dataDirectory });
    assert.notEqual(second.capacityGate, gate, "a closed home must not keep its gate");
    second.close();
  }
});
