/**
 * The chaos-test child: claims a run, starts executing, and is killed by the
 * parent before finishing. Run with:
 *   node --experimental-strip-types test/fixtures/killed-worker.ts <home> <workspace>
 *
 * It queues a single reversible step, claims it through the RunQueueConsumer
 * (lease 1.5s), writes "child-started.md" the moment its worker begins, then
 * sleeps far longer than the parent will tolerate. The parent SIGKILLs it in
 * that window; whatever this process never wrote is the whole point.
 *
 * 混沌测试的子进程：领取一个 Run、开始执行，然后被父进程在完成前杀掉。用法：
 *   node --experimental-strip-types test/fixtures/killed-worker.ts <home> <workspace>
 *
 * 它排入一个可逆步骤，经 RunQueueConsumer 领取（租约 1.5 秒），worker 一开始就写
 * "child-started.md"，然后睡得远比父进程愿意等的时间长。父进程就在那个窗口里
 * SIGKILL 它；这个进程没来得及写的一切，正是测试的意义所在。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRuntimeAssembly } from "../../src/core/runtime-factory.ts";
import { RunQueueConsumer } from "../../src/application/run-queue.ts";
import { StaticAgentRegistry } from "../../src/workers/static-worker-registry.ts";
import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../../src/core/contracts.ts";

const [dataDirectory, workspacePath] = process.argv.slice(2);
if (dataDirectory === undefined || workspacePath === undefined) {
  console.error("usage: killed-worker.ts <dataDirectory> <workspacePath>");
  process.exit(2);
}

class SlowWorker implements RuntimeAdapter {
  readonly id = "draft-maker";
  readonly providerId = "child";

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true,
      work: ["drafting", "filesystem_read", "filesystem_write"],
      evidenceKinds: ["artifact", "tool_result", "test", "observation"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    await writeFile(join(input.workspacePath ?? process.cwd(), "child-started.md"), "claimed and executing\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    await writeFile(join(input.workspacePath ?? process.cwd(), "child-finished.md"), "never written in this test\n", "utf8");
    yield { type: "completed", summary: "unreachable in this test" };
  }
}

const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
try {
  const { run } = await assembly.runtime.acceptTrigger({
    kind: "signal",
    summary: "chaos: a run that will be killed mid-execution",
    payload: { trigger: "chaos" },
  });
  await assembly.runtime.attachPlan(run.id, {
    summary: "write an outcome file",
    steps: [{
      id: "write",
      title: "写出结果文件",
      instructions: "把结果写入 outcome.md。",
      risk: "reversible_write",
      acceptanceCriteria: ["形成一份可核对的交付物"],
      agentId: "draft-maker",
      requiredCapabilities: ["drafting", "filesystem_write"],
    }],
  });

  const consumer = new RunQueueConsumer({
    runtime: assembly.runtime,
    journal: assembly.journal,
    registry: async () => new StaticAgentRegistry([new SlowWorker()]),
    leaseMs: 1_500,
  });
  await consumer.tick();
  // Stay alive for the in-flight execution — until the parent kills it.
  // 为在途执行保持存活——直到父进程杀掉它。
  await consumer.stop();
} finally {
  assembly.close();
}
