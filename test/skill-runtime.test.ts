/**
 * A skill is not "supported" unless a turn can see it, call it and receive its
 * body. This runs the native Main Agent against a fake provider and a real
 * SKILL.md, and checks both halves of the progressive disclosure.
 *
 * 只有当一个回合能看到、能调用技能并拿到正文，技能才算"支持"。本测试用假 Provider 与
 * 真实 SKILL.md 跑一遍原生 Main Agent，检查渐进披露的两半。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { toProviderToolName } from "../src/agent/loop.ts";
import { runNativeMainAgentTurn } from "../src/main-agent/native-runtime.ts";

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("a loaded skill is listed in the prompt, callable as a tool, and its body reaches the model", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-skill-runtime-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  const skillsRoot = join(dataDirectory, "skills");
  await mkdir(join(skillsRoot, "test-skill"), { recursive: true });
  await writeFile(join(skillsRoot, "test-skill", "SKILL.md"), `---
name: test-skill
description: A test procedure for the runtime.
allowed-tools: [read_file]
---

Read the evidence first, then report what is missing.
`);

  const bodies: Array<Record<string, unknown>> = [];
  const providerSkillName = toProviderToolName("Skill(test-skill)");
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    calls += 1;
    if (calls === 1) {
      return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "s1", type: "function", function: { name: providerSkillName, arguments: "{}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: "used the skill" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  }) as unknown as typeof fetch;

  const result = await runNativeMainAgentTurn({
    dataDirectory,
    text: "Run the test skill.",
    source: "cli",
    skillRoots: [skillsRoot],
    endpoint: { baseUrl: "http://gateway", model: "test-model" },
    fetchImpl,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.reply, "used the skill");
  assert.equal(bodies.length, 2);

  const first = bodies[0] as {
    messages: Array<{ role: string; content?: string }>;
    tools?: Array<{ function: { name: string } }>;
  };
  const system = first.messages.find((message) => message.role === "system");
  assert.match(system?.content ?? "", /Skills available/);
  assert.match(system?.content ?? "", /test-skill: A test procedure for the runtime\./);
  assert.ok(first.tools?.some((tool) => tool.function.name === providerSkillName), "the Skill tool must be offered");

  const second = bodies[1] as { messages: Array<{ role: string; content?: string }> };
  const toolMessage = second.messages.find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content ?? ""), /Skill: test-skill/);
  assert.match(String(toolMessage?.content ?? ""), /Read the evidence first, then report what is missing\./);
});
test("the Main Agent query passes the skill roots into the native runtime", async () => {
  // The runtime supports skills, but no caller passed the roots before this
  // change, so the listing and the Skill(...) tools never reached a turn.
  // 运行时支持技能，但此前没有调用方传入根目录，列表与 Skill(...) 工具因此从未进入回合。
  const source = await readFile(join(process.cwd(), "src", "application", "run-main-query.ts"), "utf8");
  assert.match(source, /skillRoots: skillRootsFor\(dataDirectory, options\.workspacePath \?\? process\.cwd\(\)\)/);
});
