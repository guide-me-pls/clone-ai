import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { buildInstructions, decideTool, NativeAgentWorker, type NativeModelClient } from "../src/workers/native-agent-worker.ts";
import type { AgentModelRequest, AgentModelResponse } from "../src/agent/loop.ts";
import { fileTools } from "../src/workers/native-worker-factory.ts";
import type { ExecutionAssignment, ExecutionEvent } from "../src/core/contracts.ts";
import { resolveGrants } from "../src/authority/path-gateway.ts";

async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-native-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function assignment(path: string, scopes: ExecutionAssignment["step"]["scopes"] = []): ExecutionAssignment {
  return {
    run: { id: "run-1", taskId: "task-1", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "task-1", triggerId: "t", title: "t", objective: "read a file", acceptanceCriteria: [], createdAt: "" },
    step: { id: "s1", title: "s1", instructions: "Read the note.", risk: "read_only", acceptanceCriteria: ["note read"], scopes },
    executor: { agentId: "native", providerId: "native" },
    workspacePath: path,
  };
}

function fakeClient(
  responses: Array<AgentModelResponse | ((request: AgentModelRequest) => AgentModelResponse)>,
  requests: AgentModelRequest[] = [],
): NativeModelClient {
  let index = 0;
  return {
    async complete(request) {
      requests.push(request);
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next === undefined) throw new Error("No scripted response.");
      return typeof next === "function" ? next(request) : next;
    },
  };
}

test("the gate refuses paths outside the grants, network without a scope, and external effects", async (t) => {
  const directory = await workspace(t);
  const grants = { readRoots: [realpathSync(directory)], writeRoots: [realpathSync(directory)], network: false };
  const root = realpathSync(directory);
  assert.deepEqual(decideTool({ risk: "read", grants, workspace: root }), { allowed: true });
  assert.equal(decideTool({ risk: "write", grants, workspace: root, path: "notes/today.md" }).allowed, true);
  assert.equal(decideTool({ risk: "write", grants, workspace: root, path: "../escape.md" }).allowed, false);
  assert.equal(decideTool({ risk: "network", grants, workspace: directory }).allowed, false);
  assert.equal(decideTool({ risk: "external", grants, workspace: directory }).allowed, false);
  // The worker never offers a tool whose risk the step did not grant, so a
  // network tool is refused at the offering stage; the gate also refuses it.
  // Worker 从不提供步骤未授权风险等级的工具，因此网络工具在提供阶段就被排除；闸门同样会拒绝。
  assert.equal(decideTool({ risk: "network", grants: { ...grants, network: true }, workspace: directory }).allowed, true);
});

test("a refused call returns a tool error to the model instead of killing the run", async (t) => {
  const directory = await workspace(t);
  await writeFile(join(directory, "note.md"), "remember the blue template", "utf8");
  const requests: AgentModelRequest[] = [];
  const worker = new NativeAgentWorker({
    id: "native",
    label: "Native",
    createClient: () => fakeClient([
      {
        content: null,
        toolCalls: [
          { id: "r", name: "read_file", arguments: JSON.stringify({ path: "note.md" }) },
          { id: "w", name: "write_file", arguments: JSON.stringify({ path: "../escape.md" }) },
          { id: "f", name: "fetch_url", arguments: JSON.stringify({ url: "https://example.com" }) },
        ],
      },
      { content: "read the note", toolCalls: [] },
    ], requests),
    tools: [
      { name: "read_file", description: "read", risk: "read", pathOf: (input) => String(input.path), run: async (c) => ({ output: await readFile(join(directory, String(c.input.path)), "utf8") }) },
      { name: "write_file", description: "write", risk: "write", pathOf: (input) => String(input.path), run: async () => ({ output: "written" }) },
      // Offered but not granted: the worker filters it out before the model sees it.
      // 提供但未授权：Worker 在模型看到它之前就把它过滤掉。
      { name: "fetch_url", description: "fetch", risk: "network", run: async () => ({ output: "fetched" }) },
    ],
  });

  const base = assignment(directory);
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute({ ...base, step: { ...base.step, risk: "reversible_write" } })) events.push(event);
  const toolMessages = requests[1]!.messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 3);
  assert.match(String(toolMessages[0]!.content), /blue template/);
  // The write is refused because its path escapes; the network tool is not offered.
  // 写入因路径逃逸被拒；网络工具根本不会被提供。
  assert.match(String(toolMessages[1]!.content), /outside the step's granted scopes/);
  assert.match(String(toolMessages[2]!.content), /No tool named fetch_url/);
  assert.equal(events.at(-1)?.type, "completed");
});

test("a read-only step's instructions say what was refused", async (t) => {
  const directory = await workspace(t);
  const grants = resolveGrants([{ domain: "files", resource: "/", access: "read" }] as never, { workspace: directory, home: "/home/owner" });
  const text = buildInstructions(assignment(directory), grants.dropped.map((item) => `${item.scope.domain}:${item.scope.resource} (${item.reason})`));
  assert.match(text, /Read the note/);
  assert.match(text, /Acceptance criteria/);
  assert.match(text, /too broad/);
});

test("a realpath-mismatched workspace still admits paths inside it, and refuses escapes", async (t) => {
  // The workspace root itself may be behind a symlink that the grants already
  // canonicalised (/tmp -> /private/tmp on macOS). Resolving the target but not
  // the workspace used to refuse every file inside it.
  // 工作区根可能位于授权已规范化的符号链接之后（macOS 上 /tmp -> /private/tmp）。
  // 只规范化目标而不规范化工作区，会把其中每个文件都拒掉。
  const directory = await workspace(t);
  const root = realpathSync(directory);
  const grants = { readRoots: [root], writeRoots: [root], network: false };
  // The workspace is named through its uncanonicalised path here.
  // 这里用未规范化的路径指代工作区。
  assert.equal(decideTool({ risk: "write", grants, workspace: directory, path: "out/hello.txt" }).allowed, true);
  assert.equal(decideTool({ risk: "write", grants, workspace: directory, path: "../escape.md" }).allowed, false);
});

test("exact usage from the model client reaches the completed event", async (t) => {
  const directory = await workspace(t);
  const worker = new NativeAgentWorker({
    id: "agent-1",
    label: "A",
    providerId: "native",
    workCapabilities: ["drafting", "external_action"],
    tools: [],
    createClient: () => fakeClient([
      { content: "done", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]),
  });
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute(assignment(directory))) events.push(event);
  const completed = events.find((event) => event.type === "completed");
  assert.ok(completed !== undefined && completed.type === "completed");
  const usage = completed.usage;
  assert.ok(usage !== undefined);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.totalTokens, 15);
  assert.equal(usage.modelCalls, 1);
  assert.equal(typeof usage.durationMs, "number");

  const capabilities = await worker.capabilities();
  assert.equal(worker.id, "agent-1");
  assert.equal(worker.providerId, "native");
  assert.deepEqual(capabilities.work, ["drafting"]);
});

test("successful writes become artifact evidence the verifier can check", async (t) => {
  const directory = await workspace(t);
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: fileTools(),
    createClient: () => fakeClient([
      { content: null, toolCalls: [{ id: "w", name: "write_file", arguments: JSON.stringify({ path: "out/note.md", content: "hi" }) }] },
      { content: "wrote it", toolCalls: [] },
    ]),
  });
  const base = assignment(directory);
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute({ ...base, step: { ...base.step, risk: "reversible_write" } })) events.push(event);
  const evidence = events.filter((event) => event.type === "evidence");
  assert.ok(evidence.some((event) => event.type === "evidence" && event.evidence.kind === "artifact" && event.evidence.locator === "out/note.md"));
  assert.equal(await readFile(join(directory, "out/note.md"), "utf8"), "hi");
});

test("a missing input named in the instructions fails instead of allowing invention", async (t) => {
  const directory = await workspace(t);
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: fileTools(),
    createClient: () => fakeClient([
      {
        content: null,
        toolCalls: [
          { id: "r", name: "read_file", arguments: JSON.stringify({ path: "docs/absent.md" }) },
          { id: "w", name: "write_file", arguments: JSON.stringify({ path: "out/summary.md", content: "invented" }) },
        ],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      { content: "done", toolCalls: [] },
    ]),
  });
  const base = assignment(directory);
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute({
    ...base,
    step: { ...base.step, instructions: "Read docs/absent.md and write out/summary.md." },
  })) events.push(event);
  const failed = events.find((event) => event.type === "failed");
  assert.ok(failed !== undefined && failed.type === "failed");
  assert.equal(failed.report?.category, "no_artifact");
  assert.equal(failed.report?.signature, "native-missing-input");
  assert.equal(failed.usage?.totalTokens, 15);
  assert.equal(events.some((event) => event.type === "completed"), false);
});

test("a failed read the instructions do not name is returned to the model, not fatal", async (t) => {
  const directory = await workspace(t);
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: fileTools(),
    createClient: () => fakeClient([
      { content: null, toolCalls: [{ id: "r", name: "read_file", arguments: JSON.stringify({ path: "wrong/guess.md" }) }] },
      { content: "recovered", toolCalls: [] },
    ]),
  });
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute(assignment(directory))) events.push(event);
  assert.equal(events.some((event) => event.type === "completed"), true);
});

test("a budget-exhausted worker reports a comparable budget category", async (t) => {
  const directory = await workspace(t);
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: fileTools(),
    createClient: () => fakeClient([
      { content: null, toolCalls: [{ id: "r", name: "read_file", arguments: JSON.stringify({ path: "a.md" }) }] },
    ]),
  });
  const base = assignment(directory);
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute({
    ...base,
    workOrder: {
      id: "w",
      role: "custom",
      title: "t",
      objective: "read",
      inputs: [],
      requiredCapabilities: [],
      expectedArtifacts: [],
      acceptanceCriteria: [],
      risk: "read_only",
      budget: { maxDurationMs: 10_000, maxAttempts: 1, maxToolCalls: 1 },
    },
  })) events.push(event);
  const failed = events.find((event) => event.type === "failed");
  assert.ok(failed?.type === "failed");
  assert.equal(failed.report?.category, "budget_exceeded");
  assert.equal(failed.report?.signature, "budget-tool-calls");
});

test("a model-call budget is reported when the loop cannot finish in time", async (t) => {
  const directory = await workspace(t);
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: [],
    createClient: () => fakeClient([
      { content: null, toolCalls: [{ id: "a", name: "missing", arguments: "{}" }] },
      { content: null, toolCalls: [{ id: "b", name: "missing", arguments: "{}" }] },
    ]),
  });
  const base = assignment(directory);
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute({
    ...base,
    workOrder: {
      id: "w",
      role: "custom",
      title: "t",
      objective: "loop",
      inputs: [],
      requiredCapabilities: [],
      expectedArtifacts: [],
      acceptanceCriteria: [],
      risk: "read_only",
      budget: { maxDurationMs: 10_000, maxAttempts: 1, maxModelCalls: 1 },
    },
  })) events.push(event);
  const failed = events.find((event) => event.type === "failed");
  assert.ok(failed?.type === "failed");
  assert.equal(failed.report?.category, "budget_exceeded");
  assert.equal(failed.report?.signature, "budget-model-calls");
});

test("a round limit from the worker default is still reported as a failure", async (t) => {
  const directory = await workspace(t);
  // No work order, hence no plan budget: the limit comes from the worker default.
  // 没有 WorkOrder，因此没有计划预算：上限来自 Worker 的默认值。
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    maxRounds: 1,
    tools: [],
    createClient: () => fakeClient([
      { content: null, toolCalls: [{ id: "a", name: "missing", arguments: "{}" }] },
      { content: null, toolCalls: [{ id: "b", name: "missing", arguments: "{}" }] },
    ]),
  });
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute(assignment(directory))) events.push(event);
  const failed = events.find((event) => event.type === "failed");
  assert.ok(failed?.type === "failed", "a round limit must not be reported as completed");
  assert.equal(failed.report?.category, "budget_exceeded");
  assert.equal(events.some((event) => event.type === "completed"), false);
});

test("cancel stops a running worker instead of letting it finish its timeout", async (t) => {
  const directory = await workspace(t);
  let reachedModel = false;
  let sawAbort = false;
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    tools: [],
    timeoutMs: 30_000,
    createClient: () => ({
      async complete(input) {
        reachedModel = true;
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); }, { once: true });
        });
        return { content: "never", toolCalls: [] };
      },
    }),
  });
  const base = assignment(directory);
  const events: ExecutionEvent[] = [];
  const run = (async () => {
    for await (const event of worker.execute({ ...base, step: { ...base.step, risk: "reversible_write" } })) events.push(event);
  })();
  while (!reachedModel) await new Promise((resolve) => setTimeout(resolve, 5));
  const sessionId = events.find((event) => event.type === "session_started");
  assert.ok(sessionId?.type === "session_started");
  await worker.cancel(sessionId.sessionId);
  await run;
  assert.equal(sawAbort, true, "the model call must be aborted");
  const failed = events.find((event) => event.type === "failed");
  assert.ok(failed?.type === "failed", "a cancelled execution ends as failed/aborted, not completed");
});
