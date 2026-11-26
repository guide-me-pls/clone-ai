/**
 * A model question must block the turn, reach the owner as buttons, and resume
 * the same turn with the chosen label. This runs the native Main Agent against
 * a fake provider and answers through the broker, the way the chat does.
 *
 * 模型提问必须阻塞回合、以按钮到达所有者，并用所选标签恢复同一回合。本测试用假 Provider
 * 跑原生 Main Agent，并像聊天那样通过经纪人作答。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runNativeMainAgentTurn } from "../src/main-agent/native-runtime.ts";
import { OwnerQuestionBroker } from "../src/main-agent/owner-questions.ts";

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the owner question.");
}

test("ask_owner blocks the turn until the owner clicks, then continues with the choice", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-owner-question-"));
  const broker = new OwnerQuestionBroker();
  t.after(async () => {
    broker.closeAll();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    calls += 1;
    if (calls === 1) {
      return sseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "q1",
                type: "function",
                function: {
                  name: "ask_owner",
                  arguments: JSON.stringify({
                    question: "要我派这个任务吗？",
                    choices: [{ label: "独立进程" }, { label: "塞进 lifespan" }],
                  }),
                },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: "好，按独立进程派任务。" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  }) as unknown as typeof fetch;

  const turn = runNativeMainAgentTurn({
    dataDirectory,
    text: "看一下这个方案，然后派任务。",
    source: "cli",
    endpoint: { baseUrl: "http://gateway", model: "test-model" },
    fetchImpl,
    questions: broker,
  });

  const question = await waitFor(() => broker.list()[0]);
  assert.equal(question.question, "要我派这个任务吗？");
  assert.deepEqual(question.choices.map((choice) => choice.label), ["独立进程", "塞进 lifespan"]);
  const first = bodies[0] as { tools?: Array<{ function: { name: string } }> };
  assert.ok(first.tools?.some((tool) => tool.function.name === "ask_owner"), "the ask_owner tool must be offered");

  const answered = broker.answer(question.id, { choiceId: "choice-1" });
  assert.equal(answered?.id, question.id);
  const result = await turn;
  assert.equal(result.error, undefined);
  assert.equal(result.reply, "好，按独立进程派任务。");
  assert.equal(broker.list().length, 0);
  const second = bodies[1] as { messages: Array<{ role: string; content?: string }> };
  const toolMessage = second.messages.find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content ?? ""), /owner chose: 独立进程/);
});