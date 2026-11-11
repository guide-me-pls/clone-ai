import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { runQuery } from "../src/application/run-query.ts";
import { createJournalStore, SqliteJournalStore } from "../src/core/sqlite-journal.ts";
import { createRuntimeAssembly } from "../src/core/runtime-factory.ts";
import { defaultWorkerProfiles } from "../src/config/worker-settings.ts";
import { createScriptedAgentRegistry, ScriptedExecutionAdapter } from "./fixtures/scripted-adapter.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";

/**
 * Reads the journal through the same seam the writers use.
 *
 * Hardcoding one backend here would make the assertion depend on storage
 * configuration rather than on behaviour: the moment the daemon defaults to
 * SQLite, a JSONL reader sees an empty history and the test fails while the
 * product is fine.
 *
 * 通过与写入端相同的 seam 读取 Journal。
 *
 * 在这里写死某一种后端，会让断言依赖于存储配置而非行为：一旦 Daemon 默认改用
 * SQLite，JSONL 读取器就会看到空历史，于是产品正常而测试失败。
 */
async function journalEvents(dataDirectory: string) {
  const journal = createJournalStore(dataDirectory);
  try {
    return await journal.list();
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

async function home(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-routing-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("an explicit request reaches the worker the owner named", async (t) => {
  const dataDirectory = await home(t);

  const result = await runQuery(
    dataDirectory,
    "请让 evidence-reviewer 复核这份材料",
    {},
    undefined,
    { agents: createScriptedAgentRegistry(), workspacePath: dataDirectory },
  );

  assert.equal(result.status, "waiting_review");
  assert.equal(result.routing?.selectedAgentId, "evidence-reviewer");
  assert.equal(result.routing?.source, "explicit");
});

test("a direct query never dispatches after another executor rejects its claim", async (t) => {
  const dataDirectory = await home(t);
  const original = SqliteJournalStore.prototype.claimRun;
  let rejected = 0;
  SqliteJournalStore.prototype.claimRun = async function (input) {
    if (input.ownerId.startsWith("direct-")) {
      rejected += 1;
      return undefined;
    }
    return original.call(this, input);
  };
  t.after(() => { SqliteJournalStore.prototype.claimRun = original; });

  const result = await runQuery(dataDirectory, "请让 evidence-reviewer 复核这份材料", {}, undefined, {
    agents: createScriptedAgentRegistry(), workspacePath: dataDirectory,
  });
  const events = await journalEvents(dataDirectory);
  assert.equal(rejected, 1);
  assert.equal(result.status, "queued");
  assert.equal(events.some((event) => event.type === "execution.started" || event.type === "subagent.dispatched"), false);
});

test("a direct query rechecks a run that another executor completed before its claim", async (t) => {
  const dataDirectory = await home(t);
  const agents = createScriptedAgentRegistry();
  const original = SqliteJournalStore.prototype.claimRun;
  let interrupted = false;
  SqliteJournalStore.prototype.claimRun = async function (input) {
    if (input.ownerId.startsWith("direct-") && !interrupted) {
      interrupted = true;
      const competingOwner = "other-consumer";
      assert.ok(await original.call(this, { ...input, ownerId: competingOwner }));
      const other = await createRuntimeAssembly({ dataDirectory, workspacePath: dataDirectory });
      try {
        assert.equal((await other.runtime.execute(input.runId, agents)).status, "waiting_review");
        assert.equal((await other.runtime.reviewVerification(input.runId, "accept")).status, "completed");
      } finally {
        other.close();
        await this.releaseClaim({ runId: input.runId, ownerId: competingOwner });
      }
    }
    return original.call(this, input);
  };
  t.after(() => { SqliteJournalStore.prototype.claimRun = original; });

  const result = await runQuery(dataDirectory, "请让 evidence-reviewer 复核这份材料", {}, undefined, {
    agents, workspacePath: dataDirectory,
  });
  const events = await journalEvents(dataDirectory);
  assert.equal(result.status, "completed");
  assert.equal(events.filter((event) => event.type === "execution.started" || event.type === "subagent.dispatched").length, 1);
});

test("a named worker that cannot run blocks the query instead of substituting", async (t) => {
  const dataDirectory = await home(t);
  // Only the researcher can run; the owner asks for someone else entirely.
  // 只有 researcher 能运行；而所有者点名了另一个完全不同的 Worker。
  const onlyResearcher = new StaticAgentRegistry([
    new ScriptedExecutionAdapter("context-researcher", "demo", ["research", "filesystem_read"]),
  ]);

  const result = await runQuery(
    dataDirectory,
    "请使用 evidence-reviewer 复核这份材料",
    {},
    undefined,
    { agents: onlyResearcher, workspacePath: dataDirectory },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.blocked?.code, "REQUESTED_AGENT_UNAVAILABLE");
  assert.equal(result.blocked?.requestedAgentId, "evidence-reviewer");
  // The available worker was never used as a stand-in.
  // 可用的那个 Worker 从未被拿来顶替。
  assert.equal(result.routing, undefined);
  assert.equal(result.subagentsCompleted, 0);
});

test("a blocked query is journaled and its run is closed, not left planning", async (t) => {
  const dataDirectory = await home(t);
  const empty = new StaticAgentRegistry([]);

  const result = await runQuery(
    dataDirectory,
    "请使用 draft-maker 写一份报告",
    {},
    undefined,
    { agents: empty, workspacePath: dataDirectory },
  );
  assert.equal(result.status, "blocked");

  const events = await journalEvents(dataDirectory);
  const blocked = events.find((event) => event.type === "dispatch.blocked");
  assert.ok(blocked, "the refusal must be auditable");
  assert.equal((blocked.payload as { requestedAgentId?: string }).requestedAgentId, "draft-maker");

  // A refused run must not linger as if it were still being planned.
  // 被拒绝的 Run 不能滞留成"仍在规划中"的样子。
  const statuses = events
    .filter((event) => event.type === "run.status_changed")
    .map((event) => (event.payload as { status: string }).status);
  assert.ok(statuses.includes("failed"), `run should be closed, saw ${statuses.join(", ")}`);
});

test("a planner failure closes its run instead of leaving it planning", async (t) => {
  const dataDirectory = await home(t);
  const planner = {
    async plan(): Promise<never> {
      throw new Error("planner exploded");
    },
  };

  await assert.rejects(
    runQuery(dataDirectory, "调研一下这个库的现状", {}, undefined, {
      planner,
      agents: createScriptedAgentRegistry(),
      workspacePath: dataDirectory,
    }),
    /planner exploded/,
  );

  const events = await journalEvents(dataDirectory);
  const statuses = events
    .filter((event) => event.type === "run.status_changed")
    .map((event) => event.payload as { status?: string; reason?: string });
  assert.equal(statuses.at(-1)?.status, "failed");
  assert.match(statuses.at(-1)?.reason ?? "", /planning failed: planner exploded/);
});

test("the dispatch decision is journaled before the worker runs", async (t) => {
  const dataDirectory = await home(t);

  await runQuery(dataDirectory, "请让 draft-maker 起草说明", {}, undefined, {
    agents: createScriptedAgentRegistry(),
    workspacePath: dataDirectory,
  });

  const events = await journalEvents(dataDirectory);
  const decisionIndex = events.findIndex((event) => event.type === "dispatch.decided");
  const firstExecution = events.findIndex((event) => (
    event.type === "execution.started" || event.type === "subagent.dispatched"
  ));

  assert.ok(decisionIndex >= 0, "the routing decision must be recorded");
  // Recording after the fact would be useless for a supervisor that dies mid-dispatch.
  // 事后补记对派发中途死掉的 Supervisor 毫无价值。
  assert.ok(firstExecution < 0 || decisionIndex < firstExecution, "the decision must precede execution");
});

test("routing without an explicit request still records why a worker was chosen", async (t) => {
  const dataDirectory = await home(t);

  const result = await runQuery(dataDirectory, "调研一下这个库的现状", {}, undefined, {
    agents: createScriptedAgentRegistry(),
    workspacePath: dataDirectory,
  });

  assert.equal(result.status, "waiting_review");
  assert.equal(result.routing?.selectedAgentId, "context-researcher");
  assert.equal(result.routing?.source, "rule");
});

test("a disabled worker cannot be selected even when it is the best match", async (t) => {
  const dataDirectory = await home(t);
  const profiles = defaultWorkerProfiles().map((profile) => (
    profile.id === "context-researcher" ? { ...profile, enabled: false } : profile
  ));

  const result = await runQuery(
    dataDirectory,
    "请使用 context-researcher 调研这个库",
    {},
    { agents: profiles },
    { agents: createScriptedAgentRegistry(), workspacePath: dataDirectory },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.blocked?.code, "REQUESTED_AGENT_DISABLED");
});

test("a caller that stops waiting aborts the run it started", async (t) => {
  // runQuery accepted no signal, so a stopped desktop turn or a cancelled
  // dispatch_task left the run executing.
  // runQuery 以前不接受 signal，因此停止的桌面回合或取消的 dispatch_task 会让 Run 继续执行。
  const dataDirectory = await home(t);
  const controller = new AbortController();
  controller.abort(new Error("the owner stopped the turn"));
  // An aborted caller ends the attempt, and the Kernel refuses to finish a run
  // whose execution claim is gone; either way no completion is recorded.
  // 中止的调用方结束该次尝试，Kernel 拒绝完成已失去执行领取的 Run；两种情况下都不会记录完成。
  await assert.rejects(
    () => runQuery(
      dataDirectory,
      "请只回复：收到。",
      {},
      undefined,
      { agents: createScriptedAgentRegistry(), workspacePath: dataDirectory, signal: controller.signal },
    ),
    /lost its execution claim|cancelled|aborted/i,
  );
  const events = await journalEvents(dataDirectory);
  assert.equal(
    events.some((event) => event.type === "run.status_changed" && (event.payload as { status?: string }).status === "completed"),
    false,
    "an aborted run must not report completion",
  );
});
