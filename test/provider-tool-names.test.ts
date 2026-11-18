import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { toProviderToolName } from "../src/agent/loop.ts";
import { OpenAiCompatibleClient } from "../src/workers/openai-compatible-client.ts";

const PROVIDER_NAME = /^[a-zA-Z0-9_-]+$/;

function reply(name: string, args = "{}") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "call-1", function: { name, arguments: args } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }),
  } as unknown as Response;
}

describe("provider tool names", () => {
  test("a human-readable MCP name is sanitized in the tool table and the assistant echo", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return reply(toProviderToolName("playwright.browser_navigate"), "{\"url\":\"http://127.0.0.1:8136/\"}");
    }) as typeof fetch;
    const client = new OpenAiCompatibleClient({ baseUrl: "http://gateway", model: "m", fetchImpl });
    const tools = [{
      name: "playwright.browser_navigate",
      description: "open the local preview",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      run: async () => ({ content: "ok" }),
    }] as any;
    const signal = new AbortController().signal;

    const first = await client.complete({
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      tools,
      signal,
    });
    assert.equal(first.toolCalls[0]?.name, "playwright.browser_navigate", "the loop receives the real name");
    assert.match(bodies[0].tools[0].function.name, PROVIDER_NAME);
    assert.equal(bodies[0].tools[0].function.name, toProviderToolName("playwright.browser_navigate"));

    await client.complete({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: null, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "call-1", content: "done" },
      ],
      tools,
      signal,
    });
    const echoed = bodies[1].messages.find((message: any) => message.role === "assistant");
    assert.equal(echoed.tool_calls[0].function.name, toProviderToolName("playwright.browser_navigate"));
    assert.match(echoed.tool_calls[0].function.name, PROVIDER_NAME);
  });

  test("provider-safe names are untouched", () => {
    assert.equal(toProviderToolName("read_file"), "read_file");
    assert.equal(toProviderToolName("propose_work_plan"), "propose_work_plan");
  });

  test("a Skill(...) name is sanitized and stable", () => {
    const a = toProviderToolName("Skill(release-notes)");
    assert.match(a, PROVIDER_NAME);
    assert.equal(a, toProviderToolName("Skill(release-notes)"));
    assert.notEqual(a, toProviderToolName("Skill(other)"));
  });
});
