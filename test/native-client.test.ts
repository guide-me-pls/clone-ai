import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeAgentWorker, type NativeToolSpec } from "../src/workers/native-agent-worker.ts";
import { createConfiguredNativeWorker, fileTools, readNativeWorkerEnvironment } from "../src/workers/native-worker-factory.ts";
import { OpenAiCompatibleClient, parseArguments, parseUsage, systemPrompt } from "../src/workers/openai-compatible-client.ts";
import { createBuiltInProviderRegistry } from "../src/workers/provider-catalog.ts";
import type { ExecutionEvent } from "../src/core/contracts.ts";

test("configuration is explicit and never guessed", () => {
  assert.deepEqual(readNativeWorkerEnvironment({}, "/tmp"), { workspace: "/tmp" });
  assert.equal(createConfiguredNativeWorker({}, "/tmp"), undefined);
  const configured = readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MODEL: "m", CLONE_AI_NATIVE_BASE_URL: "http://x" }, "/tmp");
  assert.equal(configured.model, "m");
  assert.equal(configured.baseUrl, "http://x");
});

test("the client sends neutral messages and returns tool calls and usage", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const reply = {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 2 } },
  };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const client = new OpenAiCompatibleClient({ baseUrl: "http://gateway", model: "m", fetchImpl });
  const result = await client.complete({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "read a.txt" },
    ],
    tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } }, run: async () => ({ content: "" }) }],
    signal: new AbortController().signal,
  });
  assert.deepEqual(result.toolCalls, [{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }]);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2 });
  assert.equal(bodies.length, 1);
  const body = bodies[0] as { messages: Array<{ role: string }>; tools: Array<{ function: { name: string } }> };
  assert.equal(body.messages[0]!.role, "system");
  assert.equal(body.tools[0]!.function.name, "read_file");
});

test("an aborted request never reaches fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  const client = new OpenAiCompatibleClient({
    baseUrl: "http://gateway",
    model: "m",
    fetchImpl: (async () => { fetched = true; return new Response("", { status: 200 }); }) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => client.complete({ messages: [], tools: [], signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(fetched, false);
});

test("argument parsing tolerates a provider that sends prose or nothing", () => {
  assert.deepEqual(parseArguments(""), {});
  assert.deepEqual(parseArguments("not json"), {});
  assert.deepEqual(parseArguments("[1,2]"), {});
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 });
});

test("usage parsing accepts both provider shapes and never invents numbers", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }), { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  assert.deepEqual(parseUsage({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 }), { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 });
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage(null), undefined);
});

test("a provider without a usage block stays unpriced", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const client = new OpenAiCompatibleClient({ baseUrl: "http://gateway", model: "m", fetchImpl });
  const result = await client.complete({
    messages: [{ role: "user", content: "x" }],
    tools: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.content, "ok");
  assert.equal(result.usage, undefined);
});

test("the native provider is registered, identity follows the agent, and external roles are refused", async () => {
  const registry = createBuiltInProviderRegistry();
  const definition = registry.get("native");
  assert.ok(definition);
  assert.equal(registry.supportsRole("native", "draft"), true);
  assert.equal(registry.supportsRole("native", "external"), false);

  const saved = { model: process.env.CLONE_AI_NATIVE_MODEL, baseUrl: process.env.CLONE_AI_NATIVE_BASE_URL };
  try {
    delete process.env.CLONE_AI_NATIVE_MODEL;
    delete process.env.CLONE_AI_NATIVE_BASE_URL;
    assert.throws(() => definition!.createAdapter({
      agentId: "agent-1",
      role: "draft",
      workCapabilities: ["drafting", "filesystem_write"],
      dataDirectory: "/tmp",
    }), /CLONE_AI_NATIVE_MODEL/);

    process.env.CLONE_AI_NATIVE_MODEL = "test-model";
    process.env.CLONE_AI_NATIVE_BASE_URL = "http://127.0.0.1:1";
    const adapter = definition!.createAdapter({
      agentId: "agent-1",
      role: "draft",
      workCapabilities: ["drafting", "filesystem_write"],
      dataDirectory: "/tmp",
    });
    assert.equal(adapter.id, "agent-1");
    assert.equal(adapter.providerId, "native");
    const capabilities = await adapter.capabilities();
    assert.deepEqual(capabilities.work, ["drafting", "filesystem_write"]);
  } finally {
    if (saved.model === undefined) delete process.env.CLONE_AI_NATIVE_MODEL;
    else process.env.CLONE_AI_NATIVE_MODEL = saved.model;
    if (saved.baseUrl === undefined) delete process.env.CLONE_AI_NATIVE_BASE_URL;
    else process.env.CLONE_AI_NATIVE_BASE_URL = saved.baseUrl;
  }
});

test("the system prompt names the offered tools and the boundary", () => {
  const tools: NativeToolSpec[] = fileTools();
  const prompt = systemPrompt("do it", tools);
  assert.match(prompt, /read_file, list_directory, write_file/);
  assert.match(prompt, /will be refused/);
});

test("the worker reports exact usage through the shared kernel", async () => {
  const worker = new NativeAgentWorker({
    id: "n",
    label: "N",
    createClient: () => ({
      async complete() {
        return { content: "done", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      },
    }),
    tools: [],
  });
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-native-count-"));
  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute({
    run: { id: "r", taskId: "t", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "t", triggerId: "x", title: "t", objective: "x", acceptanceCriteria: [], createdAt: "" },
    step: { id: "s", title: "s", instructions: "x", risk: "read_only", acceptanceCriteria: [], scopes: [] },
    executor: { agentId: "n", providerId: "n" },
    workspacePath: workspace,
  })) {
    events.push(event);
  }
  await rm(workspace, { recursive: true, force: true });
  const completed = events.find((event) => event.type === "completed");
  assert.ok(completed?.type === "completed");
  assert.equal(completed.usage?.totalTokens, 15);
  assert.equal(completed.usage?.modelCalls, 1);
  assert.ok(events.some((event) => event.type === "session_started"));
});
