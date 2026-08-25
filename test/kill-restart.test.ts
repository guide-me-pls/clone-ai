/**
 * A child process, a real SIGKILL, and what survives.
 *
 * The claim/lease machinery was tested at the store level, but the reviewer's
 * bar is Temporal's: kill the workers and see what the semantics actually are.
 * This spawns a real process that claims a run and dies mid-execution, then
 * holds the successor to the guarantees that matter:
 *
 *   - while the child lives, no other process can take the run (exclusivity
 *     across real processes, not just two store instances);
 *   - after the kill, the run does not strand: orphan recovery returns it to
 *     the queue once the lease dies, and the successor executes it;
 *   - exactly one completion exists afterwards — the killed attempt never
 *     records a verdict it never reached.
 *
 * 一个子进程、一次真实的 SIGKILL、以及幸存下来的东西。
 *
 * 领取/租约机制此前在存储层被测试，但评审的标准是 Temporal 的：杀掉 Worker，
 * 看语义到底是什么。这里启动一个真实进程，让它领取一个 Run 并死在执行中途，
 * 然后让接替者面对真正要紧的保证：
 *
 *   - 子进程活着时，其他进程拿不走这个 Run（跨真实进程的独占，而不只是两个
 *     Store 实例之间）；
 *   - 杀掉之后，Run 不会搁浅：租约一死，孤儿恢复把它送回队列，接替者执行它；
 *   - 事后恰好存在一次完成——被杀的那次尝试绝不记录它从未到达的结论。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createRuntimeAssembly } from "../src/core/runtime-factory.ts";
import { SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { RunQueueConsumer } from "../src/application/run-queue.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";

const LEASE_MS = 1_500;

/** The successor's worker: fast, and it marks the file as its own. 接替者的 Worker：快，且在文件上留下自己的印记。 */
class SuccessorWriter implements RuntimeAdapter {
  readonly id = "draft-maker";
  readonly providerId = "successor";

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true,
      work: ["drafting", "filesystem_read", "filesystem_write"],
      evidenceKinds: ["artifact", "tool_result", "test", "observation"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    const path = join(input.workspacePath ?? process.cwd(), "outcome.md");
    await (await import("node:fs/promises")).writeFile(path, "written by the successor after the kill\n", "utf8");
    yield { type: "evidence", evidence: { kind: "artifact", summary: "outcome rewritten", locator: path } };
    yield { type: "completed", summary: "done" };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("a killed executor's run is exclusive while it lives and completes exactly once after it dies", { timeout: 60_000 }, async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-chaos-home-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-chaos-ws-"));
  const closers: Array<() => void> = [];
  t.after(async () => {
    for (const close of closers) close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, ["--experimental-strip-types", "test/fixtures/killed-worker.ts", dataDirectory, workspacePath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr += String(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill(); });

  // The child writes this marker once its adapter starts running, i.e. after
  // it has claimed the run. This is "mid-execution".
  // 子进程的适配器开始运行（也就是领取之后）会写这个标记。这就是“执行中途”。
  await waitFor(() => existsSync(join(workspacePath, "child-started.md")), 20_000, "the child to start executing");

  const store = new SqliteJournalStore(join(dataDirectory, "journal.sqlite3"));
  closers.push(() => store.close());

  // The run id is the one queued run in the journal. 该 Run id 即 Journal 中唯一的那个 Run。
  const journalEvents = await store.list();
  const runId = journalEvents.find((event) => event.type === "run.created")!.runId!;

  // ── Exclusivity across real processes: while the child lives, a second
  //    claim on the same run is refused by the transaction, not by timing.
  //    跨真实进程的独占：子进程活着时，对同一 Run 的第二次领取被事务拒绝，而不是被
  //    时机放过。
  assert.equal(
    await store.claimRun({ runId, ownerId: "impatient-successor", leaseMs: LEASE_MS }),
    undefined,
    "a live lease held by another process must not be claimable",
  );

  // ── The kill. SIGKILL: no cleanup, no release, no journal write.
  //    杀。SIGKILL：没有清理、没有释放、没有 Journal 写入。
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  assert.notEqual(child.exitCode, 0, "the child must actually die, not exit cleanly");
  assert.ok(!existsSync(join(workspacePath, "child-finished.md")), "the child died before finishing its work");

  // The killed run is stranded in `running`: the queue would never look at it
  // again — this is exactly the state orphan recovery exists for.
  // 被杀的 Run 搁浅在 `running`：队列不会再看它一眼——这正是孤儿恢复所针对的状态。
  await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 500));

  // ── The successor: a fresh process view (a fresh assembly), the same
  //    journal. Recovery runs inside the consumer's tick, so one tick both
  //    un-strands and executes.
  //    接替者：全新的进程视图（全新组装）、同一本 Journal。恢复在消费者的 tick 里
  //    运行，因此一次 tick 既解搁浅又执行。
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  closers.push(() => assembly.close());
  const consumer = new RunQueueConsumer({
    runtime: assembly.runtime,
    journal: assembly.journal,
    registry: async () => new StaticAgentRegistry([new SuccessorWriter()]),
    leaseMs: 60_000,
  });
  const started = await consumer.tick();
  await consumer.stop();

  assert.deepEqual(started, [runId], "the recovered run is executed by the successor");
  const run = assembly.runtime.getRun(runId);
  assert.equal(run.status, "completed", `the stranded run must complete, not stay ${run.status}`);

  // ── Exactly once: one completion, one verification, and the successor's
  //    file is the one on disk. The killed attempt contributed no verdict.
  //    恰好一次：一次完成、一次验证、磁盘上是接替者的文件。被杀的那次没有留下结论。
  const events = await assembly.journal.list();
  assert.equal(events.filter((event) => event.type === "run.status_changed" && (event.payload as { status?: string }).status === "completed").length, 1);
  assert.equal(events.filter((event) => event.type === "verification.completed").length, 1);
  const outcome = await readFile(join(workspacePath, "outcome.md"), "utf8");
  assert.match(outcome, /successor/);

  // The takeover is visible: the claim's attempt count shows a dead owner was
  // replaced, not that the run merely ran twice.
  // 接管可见：领取的 attempt 计数表明死掉的持有者被替换过，而不是 Run 只是跑了两次。
  const claim = await assembly.journal.readClaim!(runId);
  assert.ok(claim !== undefined);
  assert.ok(claim.attempt >= 2, `expected a stolen claim (attempt >= 2), got ${claim.attempt}`);
});
