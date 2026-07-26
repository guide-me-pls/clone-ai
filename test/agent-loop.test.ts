import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentLoop } from "../src/loop/agent-loop.ts";
import type { LoopModel, ModelTurn } from "../src/loop/contracts.ts";
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
  const second = await model.respond({
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
