import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { runQuery } from "../src/application/run-query.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { defaultWorkerProfiles } from "../src/config/worker-settings.ts";
import { createScriptedAgentRegistry, ScriptedExecutionAdapter } from "./fixtures/scripted-adapter.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";

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

  assert.equal(result.status, "completed");
  assert.equal(result.routing?.selectedAgentId, "evidence-reviewer");
  assert.equal(result.routing?.source, "explicit");
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

  const events = await new JsonlJournalStore(join(dataDirectory, "journal.jsonl")).list();
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

test("the dispatch decision is journaled before the worker runs", async (t) => {
  const dataDirectory = await home(t);

  await runQuery(dataDirectory, "请让 draft-maker 起草说明", {}, undefined, {
    agents: createScriptedAgentRegistry(),
    workspacePath: dataDirectory,
  });

  const events = await new JsonlJournalStore(join(dataDirectory, "journal.jsonl")).list();
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

  assert.equal(result.status, "completed");
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
