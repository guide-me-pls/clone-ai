import assert from "node:assert/strict";
import test from "node:test";

import {
  runAgentLoop,
  type AgentLoopEvent,
  type AgentMessage,
  type AgentModel,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentToolSpec,
} from "../src/agent/loop.ts";

type Scripted = AgentModelResponse | ((request: AgentModelRequest) => AgentModelResponse | Promise<AgentModelResponse>);

/**
 * A fake model that returns scripted responses in order and records requests.
 * 按顺序返回脚本化响应并记录请求的假模型。
 */
function scriptedModel(responses: Scripted[], requests: AgentModelRequest[] = []): AgentModel {
  let index = 0;
  return {
    async complete(request) {
      requests.push(request);
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next === undefined) throw new Error("No scripted response.");
      return typeof next === "function" ? await next(request) : next;
    },
  };
}

/**
 * A tool with a name, a runner, and an optional parallel-safe flag.
 * 带名称、运行函数与可选并行安全标记的工具。
 */
function tool(
  name: string,
  run: AgentToolSpec["run"],
  parallelSafe = false,
): AgentToolSpec {
  return { name, description: name, parallelSafe, run };
}

function userMessage(content: string): AgentMessage {
  return { role: "user", content };
}

function call(id: string, name: string, args: Record<string, unknown> = {}): NonNullable<AgentModelResponse["toolCalls"]>[number] {
  return { id, name, arguments: JSON.stringify(args) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a final answer completes the turn and streams deltas", async () => {
  const deltas: string[] = [];
  const model: AgentModel = {
    async complete(request) {
      request.onDelta?.("hello");
      return { content: "hello", toolCalls: [], usage: { totalTokens: 12, modelCalls: 1 } };
    },
  };
  const result = await runAgentLoop({
    model,
    tools: [],
    messages: [{ role: "system", content: "system" }, userMessage("hi")],
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.terminalReason, "completed");
  assert.equal(result.reply, "hello");
  assert.deepEqual(deltas, ["hello"]);
  assert.equal(result.usage.totalTokens, 12);
  assert.equal(result.rounds, 1);
});

test("tool calls continue the turn and results stay paired", async () => {
  const requests: AgentModelRequest[] = [];
  const model = scriptedModel([
    { content: "Checking.", toolCalls: [call("t1", "read_note", { path: "note.md" })] },
    { content: "Done.", toolCalls: [] },
  ], requests);
  const read = tool("read_note", async () => ({ content: "blue" }), true);
  const result = await runAgentLoop({
    model,
    tools: [read],
    messages: [userMessage("read it")],
  });

  assert.equal(result.terminalReason, "completed");
  assert.equal(result.reply, "Checking.Done.");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.messages[1], {
    role: "assistant",
    content: "Checking.",
    toolCalls: [call("t1", "read_note", { path: "note.md" })],
  });
  assert.deepEqual(result.messages[2], { role: "tool", toolCallId: "t1", content: "blue" });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.messages[2]!.role, "tool");
});

test("safe tools run together and an unsafe tool is a barrier", async () => {
  const order: string[] = [];
  let releaseSafe: () => void = () => undefined;
  let releaseUnsafe: () => void = () => undefined;
  const safeGate = new Promise<void>((resolve) => { releaseSafe = resolve; });
  const unsafeGate = new Promise<void>((resolve) => { releaseUnsafe = resolve; });

  const makeSafe = (name: string): AgentToolSpec => tool(name, async () => {
    order.push(`${name}:start`);
    await safeGate;
    order.push(`${name}:end`);
    return { content: name };
  }, true);
  const unsafe = tool("mutate", async () => {
    order.push("mutate:start");
    await unsafeGate;
    order.push("mutate:end");
    return { content: "mutated" };
  }, false);
  const after = tool("after", async () => {
    order.push("after:start");
    return { content: "after" };
  }, true);

  const model = scriptedModel([
    { content: null, toolCalls: [call("a", "safe_a"), call("b", "safe_b"), call("c", "mutate"), call("d", "after")] },
    { content: "Done.", toolCalls: [] },
  ]);
  const running = runAgentLoop({
    model,
    tools: [makeSafe("safe_a"), makeSafe("safe_b"), unsafe, after],
    messages: [userMessage("run")],
  });

  await waitFor(() => order.includes("safe_a:start") && order.includes("safe_b:start"));
  assert.equal(order.includes("mutate:start"), false);
  releaseSafe();
  await waitFor(() => order.includes("mutate:start"));
  assert.deepEqual(order.filter((entry) => entry.endsWith(":end")), ["safe_a:end", "safe_b:end"]);
  releaseUnsafe();
  const result = await running;
  assert.equal(result.terminalReason, "completed");
  assert.equal(order.indexOf("after:start") > order.indexOf("mutate:end"), true);
});

test("max rounds ends with a typed max_turns reason", async () => {
  let calls = 0;
  const model = scriptedModel([
    () => ({ content: null, toolCalls: [call("t", "noop")] }),
  ]);
  const result = await runAgentLoop({
    model,
    tools: [tool("noop", async () => { calls += 1; return { content: "ok" }; })],
    messages: [userMessage("loop")],
    maxRounds: 2,
  });
  assert.equal(result.terminalReason, "max_turns");
  assert.equal(result.rounds, 2);
  assert.equal(calls, 2);
  assert.match(result.error ?? "", /2-round/);
});

test("a tool-call budget skips later calls but keeps every result paired", async () => {
  let executed = 0;
  const model = scriptedModel([
    { content: null, toolCalls: [call("a", "one"), call("b", "one")] },
    { content: "Done.", toolCalls: [] },
  ]);
  const result = await runAgentLoop({
    model,
    tools: [tool("one", async () => { executed += 1; return { content: "one" }; }, true)],
    messages: [userMessage("run")],
    maxToolCalls: 1,
  });
  assert.equal(result.terminalReason, "budget_exhausted");
  assert.equal(executed, 1);
  assert.equal(result.toolCalls, 1);
  const toolMessages = result.messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 2);
  assert.match(String(toolMessages[1]!.content), /budget/);
});

test("abort stops the turn and marks the in-flight tool cancelled", async () => {
  const controller = new AbortController();
  let started = false;
  const model = scriptedModel([
    { content: null, toolCalls: [call("t", "slow")] },
  ]);
  const slow = tool("slow", async (_args, context) => {
    started = true;
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return { content: "never" };
  }, false);
  const running = runAgentLoop({
    model,
    tools: [slow],
    messages: [userMessage("wait")],
    signal: controller.signal,
  });
  await waitFor(() => started);
  controller.abort();
  const result = await running;
  assert.equal(result.terminalReason, "aborted");
  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content), /cancelled/);
});

test("a retryable model error is retried and then succeeds", async () => {
  let attempts = 0;
  const model: AgentModel = {
    async complete() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { content: "ok", toolCalls: [] };
    },
  };
  const result = await runAgentLoop({
    model,
    tools: [],
    messages: [userMessage("hi")],
    retry: { maxAttempts: 2, baseDelayMs: 0 },
  });
  assert.equal(attempts, 2);
  assert.equal(result.terminalReason, "completed");
  assert.equal(result.reply, "ok");
});

test("oversized tool results are middle-truncated", async () => {
  const events: AgentLoopEvent[] = [];
  const model = scriptedModel([
    { content: null, toolCalls: [call("t", "big")] },
    { content: "Done.", toolCalls: [] },
  ]);
  const big = tool("big", async () => ({ content: "x".repeat(20_000) }), true);
  const result = await runAgentLoop({
    model,
    tools: [big],
    messages: [userMessage("read")],
    toolResultBudget: { perResultChars: 1_000 },
    onEvent: (event) => { events.push(event); },
  });
  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.ok((toolMessage?.content?.length ?? 0) <= 1_000);
  assert.match(String(toolMessage?.content ?? ""), /characters truncated/);
  const completed = events.find((event) => event.type === "tool_completed");
  assert.equal(completed?.type === "tool_completed" && completed.truncated, true);
});

test("compaction runs before the model call when the estimate crosses the threshold", async () => {
  const requests: AgentModelRequest[] = [];
  const events: AgentLoopEvent[] = [];
  const model = scriptedModel([{ content: "ok", toolCalls: [] }], requests);
  const result = await runAgentLoop({
    model,
    tools: [],
    messages: [{ role: "system", content: "system" }, userMessage("x".repeat(4_000))],
    compactThresholdTokens: 1,
    compact: async (messages) => [messages[0]!, userMessage("compacted")],
    onEvent: (event) => { events.push(event); },
  });
  assert.equal(result.terminalReason, "completed");
  assert.equal(requests[0]!.messages[1]!.content, "compacted");
  assert.equal(events.some((event) => event.type === "compaction"), true);
});

test("an unknown tool becomes an error result and the turn continues", async () => {
  const model = scriptedModel([
    { content: null, toolCalls: [call("t", "missing")] },
    { content: "Done.", toolCalls: [] },
  ]);
  const result = await runAgentLoop({
    model,
    tools: [],
    messages: [userMessage("call it")],
  });
  assert.equal(result.terminalReason, "completed");
  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content), /No tool named missing/);
});

test("authorization denial is returned to the model and the turn continues", async () => {
  let executed = 0;
  const events: AgentLoopEvent[] = [];
  const model = scriptedModel([
    { content: null, toolCalls: [call("t", "write")] },
    { content: "Done.", toolCalls: [] },
  ]);
  const result = await runAgentLoop({
    model,
    tools: [tool("write", async () => { executed += 1; return { content: "ok" }; })],
    messages: [userMessage("write")],
    authorize: () => ({ behavior: "deny", reason: "the owner did not allow writes" }),
    onEvent: (event) => { events.push(event); },
  });
  assert.equal(result.terminalReason, "completed");
  assert.equal(executed, 0);
  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content), /Refused: the owner did not allow writes/);
  const decision = events.find((event) => event.type === "tool_decision");
  assert.equal(decision?.type === "tool_decision" && decision.behavior, "deny");
  const completed = events.find((event) => event.type === "tool_completed");
  assert.equal(completed?.type === "tool_completed" && completed.denied, true);
});

test("a pre-tool hook can rewrite input and a deny overrides an allow", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const model = scriptedModel([
    { content: null, toolCalls: [call("t", "write", { path: "a" })] },
    { content: "Done.", toolCalls: [] },
  ]);
  const result = await runAgentLoop({
    model,
    tools: [tool("write", async (args) => { seen.push(args); return { content: "ok" }; })],
    messages: [userMessage("write")],
    authorize: () => ({ behavior: "allow" }),
    hooks: {
      preToolUse: () => ({ behavior: "allow", updatedInput: { path: "b" } }),
    },
  });
  assert.equal(result.terminalReason, "completed");
  assert.deepEqual(seen, [{ path: "b" }]);

  let executed = 0;
  const deniedModel = scriptedModel([
    { content: null, toolCalls: [call("t", "write")] },
    { content: "Done.", toolCalls: [] },
  ]);
  const denied = await runAgentLoop({
    model: deniedModel,
    tools: [tool("write", async () => { executed += 1; return { content: "ok" }; })],
    messages: [userMessage("write")],
    authorize: () => ({ behavior: "allow" }),
    hooks: { preToolUse: () => ({ behavior: "deny", reason: "hook says no" }) },
  });
  assert.equal(denied.terminalReason, "completed");
  assert.equal(executed, 0);
  assert.match(String(denied.messages.find((message) => message.role === "tool")?.content), /Refused: hook says no/);
});

test("an ask is resolved by requestApproval and becomes a denial without it", async () => {
  let executed = 0;
  const model = scriptedModel([
    { content: null, toolCalls: [call("t", "send")] },
    { content: "Done.", toolCalls: [] },
  ]);
  const approved = await runAgentLoop({
    model,
    tools: [tool("send", async () => { executed += 1; return { content: "sent" }; })],
    messages: [userMessage("send")],
    authorize: () => ({ behavior: "ask", reason: "external effect" }),
    requestApproval: () => true,
  });
  assert.equal(approved.terminalReason, "completed");
  assert.equal(executed, 1);

  const denied = await runAgentLoop({
    model: scriptedModel([
      { content: null, toolCalls: [call("t", "send")] },
      { content: "Done.", toolCalls: [] },
    ]),
    tools: [tool("send", async () => ({ content: "sent" }))],
    messages: [userMessage("send")],
    authorize: () => ({ behavior: "ask", reason: "external effect" }),
  });
  assert.equal(denied.terminalReason, "completed");
  assert.match(String(denied.messages.find((message) => message.role === "tool")?.content), /Approval was not granted/);
});

test("a post-tool hook sees the result and cannot break the turn", async () => {
  const observed: string[] = [];
  const model = scriptedModel([
    { content: null, toolCalls: [call("t", "read")] },
    { content: "Done.", toolCalls: [] },
  ]);
  const result = await runAgentLoop({
    model,
    tools: [tool("read", async () => ({ content: "content" }))],
    messages: [userMessage("read")],
    hooks: {
      postToolUse: ({ result: toolResult }) => {
        observed.push(toolResult.content);
        throw new Error("telemetry only");
      },
    },
  });
  assert.equal(result.terminalReason, "completed");
  assert.deepEqual(observed, ["content"]);
});

test("a malformed tool call becomes a tool error the model can correct", async () => {
  // parseArguments returned {} for a truncated or non-object payload, so the tool
  // ran with no arguments (or its defaults) instead of reporting the error.
  // parseArguments 对截断或非对象载荷返回 {}，于是工具在无参数（或默认值）下运行，而不是报告错误。
  let executed = 0;
  const model = scriptedModel([
    { content: null, toolCalls: [{ id: "t1", name: "read_file", arguments: "{\"path\": \"src/a" }] },
    { content: "done", toolCalls: [] },
  ]);
  const result = await runAgentLoop({
    model,
    tools: [tool("read_file", async () => { executed += 1; return { content: "should not run" }; })],
    messages: [userMessage("read it")],
  });
  assert.equal(result.terminalReason, "completed");
  assert.equal(executed, 0, "a malformed call must not execute the tool");
  const message = result.messages.find((item) => item.role === "tool");
  assert.match(String(message?.content), /Unterminated string|JSON object/);
});

test("a timed-out call is retried while a user abort is not", async () => {
  let attempts = 0;
  const model: AgentModel = {
    async complete() {
      attempts += 1;
      if (attempts === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return { content: "ok", toolCalls: [] };
    },
  };
  const result = await runAgentLoop({
    model,
    tools: [],
    messages: [userMessage("hi")],
    retry: { maxAttempts: 2, baseDelayMs: 0 },
  });
  assert.equal(attempts, 2, "a timeout is retryable");
  assert.equal(result.reply, "ok");

  let abortedAttempts = 0;
  const aborting: AgentModel = {
    async complete() { abortedAttempts += 1; throw new DOMException("cancelled", "AbortError"); },
  };
  const aborted = await runAgentLoop({ model: aborting, tools: [], messages: [userMessage("hi")], retry: { maxAttempts: 3, baseDelayMs: 0 } });
  assert.equal(abortedAttempts, 1, "an abort is not retried");
  assert.equal(aborted.terminalReason, "model_error");
});

test("an answer cut off by the output limit is a failure, not a completed turn", async () => {
  // finish_reason was parsed by no one, so a message truncated mid-sentence
  // was reported as a finished answer.
  // 没有任何一方读取 finish_reason，因此在句子中间被截断的消息被报成了完整回答。
  const model: AgentModel = {
    async complete() {
      return { content: "The fix is to change the", toolCalls: [], finishReason: "length" };
    },
  };
  const result = await runAgentLoop({ model, tools: [], messages: [userMessage("fix it")] });
  assert.equal(result.terminalReason, "model_error");
  assert.match(result.error ?? "", /cut off/);
});

test("the token estimate counts CJK, images and tool schemas honestly", async () => {
  // Dividing raw length by four under-counted Chinese about four times and
  // over-counted one image by ~500x; the tool table was invisible.
  // 用原始长度除以四会把中文低估约四倍、把一张图片高估约 500 倍；工具表完全不可见。
  const { estimateMessages } = await import("../src/agent/loop.ts");
  const latin = estimateMessages([{ role: "user", content: "abcd".repeat(100) }]);
  assert.equal(latin, 100, "Latin is four characters per token");

  const chinese = estimateMessages([{ role: "user", content: "测试".repeat(100) }]);
  assert.ok(chinese >= 190 && chinese <= 210, `CJK is about one token per character, got ${chinese}`);

  const image = estimateMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(5_000_000)}` } }] }]);
  assert.equal(image, 1_568, "an image is a fixed token cost, not its data-URL length");

  const tools = estimateMessages([{ role: "user", content: "hi" }], [
    { name: "read_file", description: "Read a file.", parallelSafe: true, run: async () => ({ content: "" }) },
  ]);
  assert.ok(tools > 1, `the tool table adds tokens beyond the message, got ${tools}`);
});
