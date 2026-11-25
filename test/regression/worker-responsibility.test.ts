import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { runQuery } from "../../src/application/run-query.ts";
import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../../src/core/contracts.ts";
import { createJournalStore } from "../../src/core/sqlite-journal.ts";
import { buildResponsibilityPlan } from "../../src/planning/fallback-planner.ts";
import { StaticAgentRegistry } from "../../src/workers/static-worker-registry.ts";
import { createScriptedAgentRegistry } from "../fixtures/scripted-adapter.ts";

async function home(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-responsibility-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function journalEvents(dataDirectory: string) {
  const journal = createJournalStore(dataDirectory);
  try {
    return await journal.list();
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

test("a read responsibility is one read-only step with the Main Agent's criteria", () => {
  const plan = buildResponsibilityPlan({
    query: "读取三份需求文档并提取接口",
    responsibility: "read",
    executorId: "worker",
    acceptanceCriteria: ["三份文档都读到", "接口字段逐条列出"],
  });

  const step = plan.steps[0]!;
  assert.equal(step.id, "read-only-lookup");
  assert.equal(step.agentId, "worker");
  assert.equal(step.risk, "read_only");
  assert.deepEqual(step.requiredCapabilities, ["research", "filesystem_read"]);
  assert.deepEqual(step.acceptanceCriteria, ["三份文档都读到", "接口字段逐条列出"]);
  assert.equal(plan.steps.length, 1);
});

test("a write responsibility is one reversible-write order that must produce an artifact", () => {
  const plan = buildResponsibilityPlan({
    query: "按照需求文档实现 ToolBox 上传接口",
    responsibility: "write",
    executorId: "worker",
    acceptanceCriteria: ["api/toolbox.py 实现上传接口"],
  });

  const step = plan.steps[0]!;
  assert.equal(step.id, "local-delivery");
  assert.equal(step.agentId, undefined, "a subagent step names its executor on the order");
  assert.equal(step.risk, "reversible_write");
  assert.deepEqual(step.acceptanceCriteria, ["api/toolbox.py 实现上传接口"]);

  const order = step.subagents![0]!;
  assert.equal(order.id, "deliver");
  assert.equal(order.agentId, "worker");
  assert.equal(order.risk, "reversible_write");
  assert.deepEqual(order.requiredCapabilities, ["drafting", "filesystem_read", "filesystem_write"]);
  // A no-op write cannot satisfy this: the Kernel demands an artifact locator.
  // 空写满足不了它：Kernel 要求一个带 locator 的产物。
  assert.equal(order.expectedArtifacts[0]?.kind, "artifact");
  assert.equal(order.expectedArtifacts[0]?.required, true);
  assert.equal(order.expectedArtifacts[0]?.locatorRequired, true);
});

test("a responsibility plan falls back to its own criterion only when none is given", () => {
  const read = buildResponsibilityPlan({ query: "看一下这个库", responsibility: "read", executorId: "worker" });
  assert.ok(read.steps[0]!.acceptanceCriteria.length > 0);

  const write = buildResponsibilityPlan({ query: "实现这个功能", responsibility: "write", executorId: "worker" });
  assert.match(write.steps[0]!.acceptanceCriteria[0]!, /实现这个功能/);
});

test("a read dispatch carries the criteria into the plan and returns the worker's answer", async (t) => {
  const dataDirectory = await home(t);
  const result = await runQuery(
    dataDirectory,
    "读取需求文档并回答",
    {
      kind: "query",
      payload: {
        source: "main-agent",
        responsibility: "read",
        acceptanceCriteria: ["答案来自文档", "没有修改任何文件"],
      },
    },
    undefined,
    { agents: createScriptedAgentRegistry(), workspacePath: dataDirectory },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.assignments?.map((assignment) => assignment.agentId), ["worker"]);
  assert.ok(result.result !== undefined, "the worker's answer must come back to the caller");
  assert.match(result.result!.summary, /worker completed step/);

  const events = await journalEvents(dataDirectory);
  const plan = events.find((event) => event.type === "plan.created" && event.runId === result.runId);
  assert.ok(plan, "the responsibility plan must be journaled");
  const step = (plan.payload as { steps: Array<{ risk: string; acceptanceCriteria: string[] }> }).steps[0]!;
  assert.equal(step.risk, "read_only");
  // The Main Agent's criteria are the plan's criteria, not a canned string.
  // 主 Agent 的标准就是计划的标准，而不是固定文案。
  assert.deepEqual(step.acceptanceCriteria, ["答案来自文档", "没有修改任何文件"]);
});

test("a write dispatch completes with an artifact and cannot pass on a read observation", async (t) => {
  const dataDirectory = await home(t);
  const completed = await runQuery(
    dataDirectory,
    "实现这个功能并写入文件",
    {
      kind: "query",
      payload: {
        source: "main-agent",
        responsibility: "write",
        acceptanceCriteria: ["产物已写入"],
      },
    },
    undefined,
    { agents: createScriptedAgentRegistry(), workspacePath: dataDirectory },
  );
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.assignments?.map((assignment) => assignment.agentId), ["worker"]);

  const observationOnly = await runQuery(
    await home(t),
    "实现这个功能并写入文件",
    {
      kind: "query",
      payload: {
        source: "main-agent",
        responsibility: "write",
        acceptanceCriteria: ["产物已写入"],
      },
    },
    undefined,
    {
      agents: new StaticAgentRegistry([new ObservationOnlyAdapter()]),
      workspacePath: dataDirectory,
    },
  );
  // A write task that only read and answered is not done. The run either fails
  // the artifact contract or stops for the owner; it must never report success.
  // 只读取并回答的写任务不算完成。Run 要么未满足产物合同而失败，要么停下来等所有者；
  // 绝不能报告成功。
  assert.notEqual(observationOnly.status, "completed");
});

test("an unknown responsibility is refused instead of silently planned", async (t) => {
  const dataDirectory = await home(t);
  await assert.rejects(
    () => runQuery(
      dataDirectory,
      "读取文件",
      { kind: "query", payload: { source: "main-agent", responsibility: "review" } },
      undefined,
      { agents: createScriptedAgentRegistry(), workspacePath: dataDirectory },
    ),
    /Unknown dispatch responsibility/,
  );
});

class ObservationOnlyAdapter implements RuntimeAdapter {
  readonly id = "worker";
  readonly providerId = "demo";

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false,
      cancellation: false,
      approvalCallback: false,
      parallelAssignments: true,
      work: ["direct_response", "research", "review", "drafting", "filesystem_read", "filesystem_write"],
      evidenceKinds: ["observation", "artifact", "tool_result", "test"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    yield {
      type: "evidence",
      evidence: {
        kind: "observation",
        summary: "Read a file and answered without writing anything.",
        locator: `answer:${input.step.id}`,
      },
    };
    yield { type: "completed", summary: "No file was written." };
  }
}
