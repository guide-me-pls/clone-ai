import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeAgentWorker, type NativeToolSpec } from "../src/workers/native-agent-worker.ts";
import { createConfiguredNativeWorker, fileTools, readNativeWorkerEnvironment } from "../src/workers/native-worker-factory.ts";
import { OpenAiCompatibleClient, parseArguments, systemPrompt } from "../src/workers/openai-compatible-client.ts";

test("configuration is explicit and never guessed", () => {
  assert.deepEqual(readNativeWorkerEnvironment({}, "/tmp"), { workspace: "/tmp" });
  assert.equal(createConfiguredNativeWorker({}, "/tmp"), undefined);
  const configured = readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MODEL: "m", CLONE_AI_NATIVE_BASE_URL: "http://x" }, "/tmp");
  assert.equal(configured.model, "m");
  assert.equal(configured.baseUrl, "http://x");
});

test("the client relays tool calls and ends on a plain answer", async () => {
  const seen: Array<{ name: string; input: Record<string, unknown> }> = [];
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] } }] },
    { choices: [{ message: { content: "Done: the note says hi.", tool_calls: [] } }] },
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    // The tool result from round one must reach round two.
    // 第一轮的工具结果必须到达第二轮。
    if (replies.length === 1) assert.ok(body.messages.some((message) => message.role === "tool" && message.content.includes("hi")));
    return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const client = new OpenAiCompatibleClient({ baseUrl: "http://gateway", model: "m", fetchImpl });
  const result = await client.run({
    instructions: "read a.txt",
    tools: [],
    workspace: "/tmp",
    signal: new AbortController().signal,
    execute: async (call) => { seen.push(call); return { output: "hi", isError: false }; },
  });
  assert.match(result.summary, /hi/);
  assert.deepEqual(seen, [{ name: "read_file", input: { path: "a.txt" } }]);
});

test("an abort stops the loop instead of hanging", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new OpenAiCompatibleClient({ baseUrl: "http://gateway", model: "m", fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(() => client.run({ instructions: "x", tools: [], workspace: "/tmp", signal: controller.signal, execute: async () => ({ output: "", isError: false }) }), /cancelled/);
});

test("argument parsing tolerates a provider that sends prose or nothing", () => {
  assert.deepEqual(parseArguments(""), {});
  assert.deepEqual(parseArguments("not json"), {});
  assert.deepEqual(parseArguments("[1,2]"), {});
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 });
});

test("the system prompt names the offered tools and the boundary", () => {
  const tools: NativeToolSpec[] = fileTools();
  const prompt = systemPrompt("do it", tools);
  assert.match(prompt, /read_file, list_directory, write_file/);
  assert.match(prompt, /will be refused/);
});

test("the worker reports model and tool activity so the Kernel can count it", async () => {
  const counts: { modelCalls: number; toolCalls: number; done?: number } = { modelCalls: 0, toolCalls: 0 };
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    createClient: () => ({
      async run(input) {
        input.onModelCall?.();
        await input.execute({ name: "absent", input: {} });
        input.onToolCall?.({ name: "absent", input: {} }, { isError: true });
        input.onModelCall?.();
        return { summary: "done" };
      },
    }),
    tools: [],
  });
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-native-count-"));
  const events: string[] = [];
  for await (const event of worker.execute({
    run: { id: "r", taskId: "t", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "t", triggerId: "x", title: "t", objective: "x", acceptanceCriteria: [], createdAt: "" },
    step: { id: "s", title: "s", instructions: "x", risk: "read_only", acceptanceCriteria: [], scopes: [] },
    executor: { agentId: "n", providerId: "n" },
    workspacePath: workspace,
  })) {
    events.push(event.type);
    if (event.type === "completed") counts.done = 1;
  }
  await rm(workspace, { recursive: true, force: true });
  assert.equal(counts.done, 1);
  assert.ok(events.includes("session_started"));
});
