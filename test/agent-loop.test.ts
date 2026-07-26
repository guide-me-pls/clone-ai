import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentLoop } from "../src/loop/agent-loop.ts";
import type { ContinuationCapableModel, LoopModel, ModelContinuation, ModelTurn, ResponseVerifier, VerificationOutcome } from "../src/loop/contracts.ts";
import { JsonFileLoopCheckpointStore } from "../src/loop/checkpoint.ts";
import { JsonlLoopJournal } from "../src/loop/journal.ts";
import { OpenAIResponsesModel } from "../src/loop/openai-responses-model.ts";
import { restoreLoopRun } from "../src/loop/recovery.ts";
import { ToolRegistry, createWorkspaceTools } from "../src/loop/tools.ts";

test("the minimal loop persists an LLM-selected read tool chain and final answer", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-loop-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const journal = new JsonlLoopJournal(join(workspace, "journal.jsonl"));
  const checkpoints = new JsonFileLoopCheckpointStore(join(workspace, "checkpoints"));
  const loop = new AgentLoop({
    model: new ScriptedModel([
      { kind: "tool_calls", calls: [{ id: "call-list", name: "list_files", arguments: { path: "." } }] },
      { kind: "tool_calls", calls: [{ id: "call-read", name: "read_file", arguments: { path: "journal.jsonl" } }] },
      { kind: "final", text: "I listed the workspace and read the journal." },
    ]),
    tools: new ToolRegistry(createWorkspaceTools(workspace)),
    journal,
    checkpoints,
  });

  const events = [];
  for await (const event of loop.run("Inspect the local workspace.")) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "context.built",
      "model.started",
      "model.completed",
      "tool.requested",
      "tool.completed",
      "context.built",
      "model.started",
      "model.completed",
      "tool.requested",
      "tool.completed",
      "context.built",
      "model.started",
      "model.completed",
      "verification.completed",
      "run.completed",
    ],
  );
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.equal((await journal.list()).length, events.length);
  const finalState = await restoreLoopRun({ runId: events[0]!.runId, journal, checkpoints });
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.budget.modelCalls, 3);
  assert.equal(finalState.budget.toolCalls, 2);
});

test("a checkpoint restores pending tools without asking the model to plan again", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-checkpoint-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const journal = new JsonlLoopJournal(join(workspace, "journal.jsonl"));
  const checkpoints = new JsonFileLoopCheckpointStore(join(workspace, "checkpoints"));
  const loop = new AgentLoop({
    model: new ScriptedModel([{ kind: "tool_calls", calls: [{ id: "pending-read", name: "read_file", arguments: { path: "journal.jsonl" } }] }]),
    tools: new ToolRegistry(createWorkspaceTools(workspace)),
    journal,
    checkpoints,
  });

  const iterator = loop.run("Inspect the journal.");
  for (let index = 0; index < 4; index += 1) {
    await iterator.next();
  }
  await iterator.return(undefined);

  const state = await restoreLoopRun({ runId: (await journal.list())[0]!.runId, journal, checkpoints });
  assert.equal(state.status, "waiting_tools");
  assert.deepEqual(state.pendingToolCalls, [{ id: "pending-read", name: "read_file", arguments: { path: "journal.jsonl" } }]);
  assert.deepEqual(state.messages, [{ role: "user", content: "Inspect the journal." }]);
});

test("a resumed loop executes pending reads and continues the provider conversation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-resume-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const journal = new JsonlLoopJournal(join(workspace, "journal.jsonl"));
  const checkpoints = new JsonFileLoopCheckpointStore(join(workspace, "checkpoints"));
  const turns: ModelTurn[] = [
    { kind: "tool_calls", calls: [{ id: "resume-read", name: "read_file", arguments: { path: "journal.jsonl" } }] },
    { kind: "final", text: "The resumed run read its journal." },
  ];
  const createModel = (continuation?: ModelContinuation) => new ResumableScriptedModel(turns, continuation);
  const loop = new AgentLoop({
    model: createModel(),
    modelFactory: createModel,
    tools: new ToolRegistry(createWorkspaceTools(workspace)),
    journal,
    checkpoints,
  });

  const runId = "00000000-0000-0000-0000-000000000001";
  const iterator = loop.run("Resume this read-only task.", runId);
  for (let index = 0; index < 4; index += 1) {
    await iterator.next();
  }
  await iterator.return(undefined);

  const resumedEvents = [];
  for await (const event of loop.resume(runId)) {
    resumedEvents.push(event);
  }

  assert.deepEqual(resumedEvents.map((event) => event.type), [
    "tool.requested",
    "tool.completed",
    "context.built",
    "model.started",
    "model.completed",
    "verification.completed",
    "run.completed",
  ]);
  assert.equal((await restoreLoopRun({ runId, journal, checkpoints })).status, "completed");
});

test("an interrupted read-only tool is reconciled and completed with its original operation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-reconcile-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const journal = new JsonlLoopJournal(join(workspace, "journal.jsonl"));
  const checkpoints = new JsonFileLoopCheckpointStore(join(workspace, "checkpoints"));
  const turns: ModelTurn[] = [
    { kind: "tool_calls", calls: [{ id: "reconcile-read", name: "read_file", arguments: { path: "journal.jsonl" } }] },
    { kind: "final", text: "The reconciled read completed." },
  ];
  const createModel = (continuation?: ModelContinuation) => new ResumableScriptedModel(turns, continuation);
  const loop = new AgentLoop({
    model: createModel(),
    modelFactory: createModel,
    tools: new ToolRegistry(createWorkspaceTools(workspace)),
    journal,
    checkpoints,
  });
  const runId = "00000000-0000-0000-0000-000000000003";
  const iterator = loop.run("Reconcile a read.", runId);
  for (let index = 0; index < 5; index += 1) {
    await iterator.next();
  }
  await iterator.return(undefined);

  const before = await restoreLoopRun({ runId, journal, checkpoints });
  assert.equal(before.status, "running_tool");
  const originalOperationId = before.activeToolOperationId;

  const resumed = [];
  for await (const event of loop.resume(runId)) {
    resumed.push(event);
  }
  const completed = resumed.find((event) => event.type === "tool.completed");
  assert.equal((completed?.payload as { operationId?: string }).operationId, originalOperationId);
  assert.equal((await restoreLoopRun({ runId, journal, checkpoints })).status, "completed");
});

test("verification feedback retries a run once and then converges", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-retry-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const loop = new AgentLoop({
    model: new ScriptedModel([
      { kind: "final", text: "First answer." },
      { kind: "final", text: "Corrected answer." },
    ]),
    tools: new ToolRegistry(createWorkspaceTools(workspace)),
    journal: new JsonlLoopJournal(join(workspace, "journal.jsonl")),
    verifier: new SequenceVerifier([
      { kind: "retryable", summary: "Include the required evidence." },
      { kind: "passed", summary: "Evidence is present." },
    ]),
    budget: { maxVerificationRetries: 1 },
  });

  const events = [];
  for await (const event of loop.run("Produce an evidence-backed answer.")) {
    events.push(event);
  }

  assert.ok(events.some((event) => event.type === "run.retrying"));
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("the model-call budget stops a run before an unbounded second turn", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-budget-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const loop = new AgentLoop({
    model: new ScriptedModel([{ kind: "tool_calls", calls: [{ id: "budget-read", name: "read_file", arguments: { path: "journal.jsonl" } }] }]),
    tools: new ToolRegistry(createWorkspaceTools(workspace)),
    journal: new JsonlLoopJournal(join(workspace, "journal.jsonl")),
    budget: { maxModelCalls: 1 },
  });

  const events = [];
  for await (const event of loop.run("Read once, then stop.")) {
    events.push(event);
  }

  assert.equal(events.at(-1)?.type, "run.failed");
  assert.match(String((events.at(-1)?.payload as { reason?: string }).reason), /model-call budget/);
});

test("the owner can cancel a waiting run without leaving it resumable", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-cancel-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const journal = new JsonlLoopJournal(join(workspace, "journal.jsonl"));
  const checkpoints = new JsonFileLoopCheckpointStore(join(workspace, "checkpoints"));
  const loop = new AgentLoop({
    model: new ScriptedModel([{ kind: "tool_calls", calls: [{ id: "cancel-read", name: "read_file", arguments: { path: "journal.jsonl" } }] }]),
    tools: new ToolRegistry(createWorkspaceTools(workspace)),
    journal,
    checkpoints,
  });
  const runId = "00000000-0000-0000-0000-000000000005";
  const iterator = loop.run("Cancel before reading.", runId);
  for (let index = 0; index < 4; index += 1) {
    await iterator.next();
  }
  await iterator.return(undefined);

  await loop.cancel(runId, "No longer needed.");
  assert.equal((await restoreLoopRun({ runId, journal, checkpoints })).status, "cancelled");
});

test("an external tool waits for approval and keeps one operation ID through execution", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-approval-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  let executions = 0;
  const tools = new ToolRegistry([
    {
      schema: {
        type: "function",
        name: "send_note",
        description: "Send a note to an external service.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        strict: true,
      },
      risk: "external_side_effect",
      async execute() {
        executions += 1;
        return { ok: true, content: "External receipt: note-1" };
      },
    },
  ]);
  const journal = new JsonlLoopJournal(join(workspace, "journal.jsonl"));
  const checkpoints = new JsonFileLoopCheckpointStore(join(workspace, "checkpoints"));
  const turns: ModelTurn[] = [
    { kind: "tool_calls", calls: [{ id: "send-1", name: "send_note", arguments: {} }] },
    { kind: "final", text: "The note was sent after approval." },
  ];
  const createModel = (continuation?: ModelContinuation) => new ResumableScriptedModel(turns, continuation);
  const loop = new AgentLoop({ model: createModel(), modelFactory: createModel, tools, journal, checkpoints });
  const runId = "00000000-0000-0000-0000-000000000002";

  const firstEvents = [];
  for await (const event of loop.run("Send a note.", runId)) {
    firstEvents.push(event);
  }
  assert.equal(firstEvents.at(-1)?.type, "approval.requested");
  assert.equal(executions, 0);

  await loop.grantApproval(runId);
  const resumedEvents = [];
  for await (const event of loop.resume(runId)) {
    resumedEvents.push(event);
  }
  assert.equal(executions, 1);
  const requested = resumedEvents.find((event) => event.type === "tool.requested");
  const completed = resumedEvents.find((event) => event.type === "tool.completed");
  assert.equal(typeof (requested?.payload as { operationId?: unknown }).operationId, "string");
  assert.equal(
    (requested?.payload as { operationId?: string }).operationId,
    (completed?.payload as { operationId?: string }).operationId,
  );
  assert.equal(resumedEvents.at(-1)?.type, "run.completed");
});

test("write_file is deliberately a mock and cannot change the workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-tools-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const tools = new ToolRegistry(createWorkspaceTools(workspace));
  const result = await tools.execute({
    id: "call-write",
    name: "write_file",
    arguments: { path: "should-not-exist.txt", content: "proposed only" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { mocked: true, path: "should-not-exist.txt" });
  await assert.rejects(access(join(workspace, "should-not-exist.txt")));
});

test("workspace tools reject path traversal", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-path-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const tools = new ToolRegistry(createWorkspaceTools(workspace));
  const result = await tools.execute({ id: "call-escape", name: "read_file", arguments: { path: "../outside.txt" } });

  assert.equal(result.ok, false);
  assert.match(result.content, /must stay inside/);
});

test("the Responses adapter keeps a local function-call transcript with store disabled", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const replies = [
    {
      output: [{ type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
    },
    {
      output: [{ type: "message", content: [{ type: "output_text", text: "README inspected." }] }],
      output_text: "README inspected.",
    },
  ];
  const fetcher: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const model = new OpenAIResponsesModel({ apiKey: "test-key", model: "test-model", fetcher });
  const tools = [
    {
      type: "function" as const,
      name: "read_file",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      strict: true as const,
    },
  ];

  const first = await model.respond({ instructions: "Be concise.", messages: [{ role: "user", content: "Read README." }], tools });
  assert.deepEqual(first, { kind: "tool_calls", calls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }] });
  const continuation = model.snapshotContinuation();
  const resumedModel = new OpenAIResponsesModel({ apiKey: "test-key", model: "test-model", fetcher, continuation });
  const second = await resumedModel.respond({
    instructions: "Be concise.",
    messages: [
      { role: "user", content: "Read README." },
      { role: "tool", callId: "call-1", toolName: "read_file", result: { ok: true, content: "contents" } },
    ],
    tools,
  });

  assert.deepEqual(second, { kind: "final", text: "README inspected." });
  assert.equal(requests[0]?.store, false);
  assert.equal(requests[0]?.model, "test-model");
  assert.equal((requests[1]?.input as unknown[]).length, 3);
  assert.deepEqual((requests[1]?.input as Array<Record<string, unknown>>)[2], {
    type: "function_call_output",
    call_id: "call-1",
    output: JSON.stringify({ ok: true, content: "contents" }),
  });
});

class ScriptedModel implements LoopModel {
  readonly #turns: ModelTurn[];

  constructor(turns: ModelTurn[]) {
    this.#turns = [...turns];
  }

  async respond(): Promise<ModelTurn> {
    const turn = this.#turns.shift();
    if (turn === undefined) {
      throw new Error("Scripted model ran out of turns.");
    }
    return turn;
  }
}

class ResumableScriptedModel implements ContinuationCapableModel {
  readonly #turns: ModelTurn[];
  #position: number;

  constructor(turns: ModelTurn[], continuation?: ModelContinuation) {
    this.#turns = turns;
    this.#position = readScriptedPosition(continuation);
  }

  async respond(): Promise<ModelTurn> {
    const turn = this.#turns[this.#position++];
    if (turn === undefined) {
      throw new Error("Resumable scripted model ran out of turns.");
    }
    return turn;
  }

  snapshotContinuation(): ModelContinuation {
    return { provider: "test-scripted", state: { position: this.#position } };
  }
}

class SequenceVerifier implements ResponseVerifier {
  readonly #outcomes: VerificationOutcome[];

  constructor(outcomes: VerificationOutcome[]) {
    this.#outcomes = [...outcomes];
  }

  async verify(): Promise<VerificationOutcome> {
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) {
      throw new Error("Verifier ran out of outcomes.");
    }
    return outcome;
  }
}

function readScriptedPosition(continuation: ModelContinuation | undefined): number {
  if (continuation === undefined) {
    return 0;
  }
  if (continuation.provider !== "test-scripted" || typeof continuation.state !== "object" || continuation.state === null) {
    throw new Error("Unexpected scripted continuation.");
  }
  const position = (continuation.state as { position?: unknown }).position;
  if (typeof position !== "number") {
    throw new Error("Malformed scripted continuation.");
  }
  return position;
}
