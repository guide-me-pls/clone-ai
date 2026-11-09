import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeAgentWorker, type NativeToolSpec } from "../src/workers/native-agent-worker.ts";
import { createConfiguredNativeWorker, fileTools, readNativeWorkerEnvironment } from "../src/workers/native-worker-factory.ts";
import { OpenAiCompatibleClient, parseArguments, parseUsage, systemPrompt } from "../src/workers/openai-compatible-client.ts";
import { createBuiltInProviderRegistry } from "../src/workers/provider-catalog.ts";

test("configuration is explicit and never guessed", () => {
  assert.deepEqual(readNativeWorkerEnvironment({}, "/tmp"), { workspace: "/tmp" });
  assert.equal(createConfiguredNativeWorker({}, "/tmp"), undefined);
  const configured = readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MODEL: "m", CLONE_AI_NATIVE_BASE_URL: "http://x" }, "/tmp");
  assert.equal(configured.model, "m");
  assert.equal(configured.baseUrl, "http://x");
  // The repair budget is owner-controlled and a malformed value is ignored.
  // 修复预算由所有者控制，非法值会被忽略。
  assert.equal(readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MAX_ROUNDS: "24" }, "/tmp").maxRounds, 24);
  assert.equal(readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MAX_ROUNDS: "0" }, "/tmp").maxRounds, undefined);
  assert.equal(readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MAX_ROUNDS: "1.5" }, "/tmp").maxRounds, undefined);
  assert.equal(readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MAX_ROUNDS: "many" }, "/tmp").maxRounds, undefined);
  // A completion cap is likewise owner-controlled and malformed values are ignored.
  // 单次补全上限同样由所有者控制，非法值被忽略。
  assert.equal(readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MAX_TOKENS: "16000" }, "/tmp").maxTokens, 16000);
  assert.equal(readNativeWorkerEnvironment({ CLONE_AI_NATIVE_MAX_TOKENS: "-1" }, "/tmp").maxTokens, undefined);
});

test("a configured completion cap reaches the provider request", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new OpenAiCompatibleClient({ baseUrl: "http://gateway", model: "m", fetchImpl, maxTokens: 16000 });
  await client.run({
    instructions: "x",
    tools: [],
    workspace: "/tmp",
    signal: new AbortController().signal,
    execute: async () => ({ output: "", isError: false }),
  });
  assert.equal(body?.max_tokens, 16000);
});

test("a configured round budget is what stops a model that keeps calling tools", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: `c${calls}`, type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new OpenAiCompatibleClient({ baseUrl: "http://gateway", model: "m", fetchImpl, maxRounds: 3 });
  const result = await client.run({
    instructions: "keep reading",
    tools: [],
    workspace: "/tmp",
    signal: new AbortController().signal,
    execute: async () => ({ output: "again", isError: false }),
  });
  assert.equal(calls, 3);
  assert.match(result.summary, /round limit/);
});

test("the client relays tool calls and ends on a plain answer", async () => {
  const seen: Array<{ name: string; input: Record<string, unknown> }> = [];
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 2 } } },
    { choices: [{ message: { content: "Done: the note says hi.", tool_calls: [] } }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
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
  assert.deepEqual(result.usage, {
    modelCalls: 2,
    inputTokens: 30,
    outputTokens: 12,
    totalTokens: 42,
    cachedInputTokens: 2,
  });
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

test("usage parsing accepts both provider shapes and never invents numbers", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }), { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  assert.deepEqual(parseUsage({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 }), { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 });
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage(null), undefined);
});

test("a provider without a usage block is counted but not priced", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const client = new OpenAiCompatibleClient({ baseUrl: "http://gateway", model: "m", fetchImpl });
  const result = await client.run({
    instructions: "x",
    tools: [],
    workspace: "/tmp",
    signal: new AbortController().signal,
    execute: async () => ({ output: "", isError: false }),
  });
  assert.deepEqual(result.usage, { modelCalls: 1 });
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

test("edit_file replaces one exact excerpt and refuses ambiguity or a fragment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-edit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "app.js");
  await writeFile(file, "const a = 1;\nconst target = 2;\nconst c = 3;\n");
  const edit = fileTools().find((tool) => tool.name === "edit_file");
  assert.ok(edit, "the native worker must offer edit_file");

  const ok = await edit.run(
    { name: "edit_file", input: { path: "app.js", old_text: "const target = 2;", new_text: "const target = 42;" } },
    { workspace: directory },
  );
  assert.equal(ok.isError, undefined);
  assert.match(await readFile(file, "utf8"), /const target = 42;/);

  const missing = await edit.run(
    { name: "edit_file", input: { path: "app.js", old_text: "not in the file", new_text: "x" } },
    { workspace: directory },
  );
  assert.equal(missing.isError, true);
  assert.match(missing.output, /not present/);

  const ambiguous = await edit.run(
    { name: "edit_file", input: { path: "app.js", old_text: "const", new_text: "let" } },
    { workspace: directory },
  );
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.output, /more than once/);

  // A fragment smuggled through edit_file must not be able to replace the file.
  // 通过 edit_file 偷运的片段不得替换整个文件。
  const whole = await readFile(file, "utf8");
  const fragment = await edit.run(
    { name: "edit_file", input: { path: "app.js", old_text: whole, new_text: "x" } },
    { workspace: directory },
  );
  assert.equal(fragment.isError, true);
  assert.match(fragment.output, /looks like a fragment/);
  assert.equal(await readFile(file, "utf8"), whole);
});

test("write_file creates a file but refuses to replace an existing one", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = fileTools({ writeFileMode: "refuse-existing" }).find((tool) => tool.name === "write_file");
  assert.ok(write);

  const created = await write.run(
    { name: "write_file", input: { path: "new.js", content: "const a = 1;\n" } },
    { workspace: directory },
  );
  assert.equal(created.isError, undefined);
  assert.equal(await readFile(join(directory, "new.js"), "utf8"), "const a = 1;\n");

  // An existing file must be changed through edit_file, so a one-line fix cannot
  // become a whole-file fragment.
  // 已有文件必须通过 edit_file 修改，使一行修复不会变成整文件片段。
  const replaced = await write.run(
    { name: "write_file", input: { path: "new.js", content: "x" } },
    { workspace: directory },
  );
  assert.equal(replaced.isError, true);
  assert.match(replaced.output, /use edit_file/);
  assert.equal(await readFile(join(directory, "new.js"), "utf8"), "const a = 1;\n");
});

test("write_file replaces an existing file by default, because ordinary tasks regenerate files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-write-overwrite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = fileTools().find((tool) => tool.name === "write_file");
  assert.ok(write);
  await write.run({ name: "write_file", input: { path: "report.md", content: "first" } }, { workspace: directory });
  const replaced = await write.run({ name: "write_file", input: { path: "report.md", content: "second" } }, { workspace: directory });
  assert.equal(replaced.isError, undefined);
  assert.equal(await readFile(join(directory, "report.md"), "utf8"), "second");
});

test("the system prompt names the offered tools and the boundary", () => {
  const tools: NativeToolSpec[] = fileTools();
  const prompt = systemPrompt("do it", tools);
  assert.match(prompt, /read_file, list_directory, write_file/);
  assert.match(prompt, /will be refused/);
  // A summary without a successful write is a failure, so the loop cannot end
  // on a claim of work that never reached the workspace.
  // 没有成功写入的总结就是失败，因此循环不能以“声称做了但其实没落盘”结束。
  assert.match(prompt, /Never answer with a summary that claims work you did not perform/);
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
