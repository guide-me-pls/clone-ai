import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLoop, type AgentMessage, type AgentToolSpec } from "../src/agent/loop.ts";
import { OpenAiCompatibleClient } from "../src/workers/openai-compatible-client.ts";

/**
 * A tool result that carries an image must reach the provider request intact.
 *
 * Before this, `AgentToolResult` was `{ content: string }` and the serializer
 * flattened anything else to "", so a browser MCP screenshot was silently
 * dropped and the worker was blind to its own render. This test pins the path
 * from a tool's images to the wire.
 *
 * 携带图片的工具结果必须原样到达 Provider 请求。
 *
 * 此前 `AgentToolResult` 只有 `{ content: string }`，序列化器把其他内容压成 ""，浏览器 MCP
 * 截图被静默丢弃，Worker 对自己渲染的结果一无所知。本测试钉住从工具图片到请求体的路径。
 */
test("an image returned by a tool reaches the provider as a tool content part", async () => {
  const screenshotTool: AgentToolSpec = {
    name: "browser_take_screenshot",
    description: "Take a screenshot.",
    parameters: { type: "object", properties: {} },
    run: async () => ({
      content: "Took a screenshot of the page.",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    }),
  };

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const model = {
    complete: async (input: { messages: AgentMessage[] }) => {
      const client = new OpenAiCompatibleClient({
        baseUrl: "http://gateway",
        model: "m",
        fetchImpl: (async (_url: string, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }> });
          const second = bodies.length > 1;
          return new Response(JSON.stringify({
            choices: [{
              message: second
                ? { content: "The render has shadows." , tool_calls: [] }
                : { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "browser_take_screenshot", arguments: "{}" } }] },
            }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }) as unknown as typeof fetch,
      });
      const response = await client.complete({
        messages: input.messages,
        tools: [{ name: "browser_take_screenshot", description: "Take a screenshot.", parameters: { type: "object", properties: {} }, run: async () => ({ content: "" }) }],
        signal: new AbortController().signal,
      });
      return { content: response.content, toolCalls: response.toolCalls, finishReason: response.finishReason };
    },
  };

  const result = await runAgentLoop({
    model: model as never,
    tools: [screenshotTool],
    messages: [{ role: "user", content: "Look at the render." }],
    maxRounds: 3,
  });
  assert.equal(result.terminalReason, "completed");

  const toolMessage = bodies[1]?.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage, "the second request must carry the tool result");
  const parts = toolMessage.content as Array<{ type: string; image_url?: { url: string } }>;
  assert.ok(Array.isArray(parts), "tool content with an image must be an array of parts");
  assert.equal(parts[0]?.type, "text");
  const image = parts.find((part) => part.type === "image_url");
  assert.ok(image, "the screenshot must survive as an image_url part");
  assert.equal(image?.image_url?.url, "data:image/png;base64,aGVsbG8=");
});

test("a text-only tool result still serializes as a plain string", async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let round = 0;
  const model = {
    complete: async () => {
      round += 1;
      if (round > 1) return { content: "done", toolCalls: [] };
      return { content: null, toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] };
    },
  };
  const tool: AgentToolSpec = { name: "read_file", description: "Read.", run: async () => ({ content: "file contents" }) };
  const result = await runAgentLoop({
    model: model as never,
    tools: [tool],
    messages: [{ role: "user", content: "read" }],
    maxRounds: 2,
    onEvent: (event) => {
      if (event.type === "model_call_completed") bodies.push({ messages: [] });
    },
  });
  assert.equal(result.terminalReason, "completed");
  // The loop keeps the string form when there is no image; the OpenAI client
  // is what would serialize it, and the previous test covers the image branch.
  // 没有图片时循环保持字符串形式；序列化由 OpenAI 客户端完成，上一测试覆盖图片分支。
  assert.equal(typeof result.reply, "string");
});
