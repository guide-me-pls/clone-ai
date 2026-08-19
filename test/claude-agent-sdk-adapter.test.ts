import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeAgentSdkAdapter } from "../src/adapters/claude-agent-sdk-adapter.ts";
import type { ExecutionAssignment, ExecutionEvent } from "../src/core/contracts.ts";

// The typed SDK stream replaces parsed stdout, so these tests inject messages
// in the SDK's own shape instead of asserting on text heuristics.
// 有类型的 SDK 流取代了 stdout 解析，因此这些测试注入 SDK 自身形状的消息，
// 而不是对文本启发式做断言。
function assistantText(text: string): unknown {
  return { type: "assistant", session_id: "sdk-1", message: { content: [{ type: "text", text }] } };
}

function resultMessage(result: string, subtype = "success"): unknown {
  return { type: "result", subtype, session_id: "sdk-1", is_error: subtype !== "success", result };
}

function stubQuery(messages: unknown[]): never {
  return (async function* () {
    for (const message of messages) yield message;
  })() as never;
}

function assignment(workspacePath: string, overrides: Partial<ExecutionAssignment> = {}): ExecutionAssignment {
  return {
    run: { id: "run-1", taskId: "task-1", planId: "plan-1", status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    task: { id: "task-1", triggerId: "trigger-1", title: "Summarize", objective: "Summarize the README.", acceptanceCriteria: ["A five-point summary exists."], createdAt: "2026-01-01T00:00:00.000Z" },
    step: {
      id: "step-1",
      title: "Summarize",
      instructions: "Summarize the README.",
      acceptanceCriteria: ["A five-point summary exists."],
      risk: "read_only",
      agentId: "claude-sdk",
      requiredCapabilities: ["research"],
    },
    executor: { agentId: "claude-sdk", providerId: "claude-agent-sdk" },
    workspacePath,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ExecutionEvent>): Promise<ExecutionEvent[]> {
  const out: ExecutionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** The failure message of the last event, or "" when it did not fail. 最后一个事件的失败消息；未失败时为空串。 */
function failureText(events: ExecutionEvent[]): string {
  const last = events.at(-1);
  return last?.type === "failed" ? last.message : "";
}

/** The summary of the last event, or "" when it did not complete. 最后一个事件的完成摘要；未完成时为空串。 */
function completionSummary(events: ExecutionEvent[]): string {
  const last = events.at(-1);
  return last?.type === "completed" ? last.summary : "";
}

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clone-ai-sdk-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the typed result message is the settled signal and its text becomes the summary", async (t) => {
  const dir = await workspace(t);
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([assistantText("thinking"), resultMessage("Five points about the README.")]),
  });

  const events = await collect(adapter.execute(assignment(dir)));
  assert.deepEqual(events.map((event) => event.type), ["session_started", "evidence", "completed"]);
  assert.equal(completionSummary(events), "Five points about the README.");
});

test("a stream that ends without a result message is a failure, not a completion", async (t) => {
  const dir = await workspace(t);
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([assistantText("I finished the work.")]),
  });

  const events = await collect(adapter.execute(assignment(dir)));
  assert.equal(events.at(-1)?.type, "failed");
  assert.match(failureText(events), /without a result message/);
});

test("an error result is reported as a failure even though the stream ended cleanly", async (t) => {
  const dir = await workspace(t);
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([resultMessage("hit the turn limit", "error_max_turns")]),
  });

  const events = await collect(adapter.execute(assignment(dir)));
  assert.equal(events.at(-1)?.type, "failed");
  assert.match(failureText(events), /error result: hit the turn limit/);
});

test("tool use and tool results become typed events with redacted input", async (t) => {
  const dir = await workspace(t);
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([
      { type: "assistant", session_id: "sdk-1", message: { content: [{ type: "tool_use", id: "call-1", name: "Read", input: { file_path: "README.md", api_key: "sk-secret" } }] } },
      { type: "user", session_id: "sdk-1", message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false }] } },
      resultMessage("done"),
    ]),
  });

  const events = await collect(adapter.execute(assignment(dir)));
  const started = events.find((event) => event.type === "tool_started");
  assert.equal(started?.type === "tool_started" && started.tool, "Read");
  assert.match(started?.type === "tool_started" ? started.inputSummary ?? "" : "", /REDACTED/);
  assert.ok(!(started?.type === "tool_started" ? started.inputSummary ?? "" : "").includes("sk-secret"));
  const completed = events.find((event) => event.type === "tool_completed");
  assert.equal(completed?.type === "tool_completed" && completed.tool, "Read");
});

test("an artifact claim is accepted only when the file really exists in the workspace", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, "summary.md"), "five points", "utf8");
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([
      resultMessage('done\nCLONE_AI_EVIDENCE: {"kind":"artifact","summary":"Wrote the summary","locator":"summary.md"}'),
    ]),
  });

  const events = await collect(adapter.execute(assignment(dir)));
  const evidence = events.find((event) => event.type === "evidence");
  assert.equal(evidence?.type === "evidence" && evidence.evidence.kind, "artifact");
  assert.equal(evidence?.type === "evidence" && evidence.evidence.locator, "summary.md");
});

test("a fabricated artifact claim is downgraded to an observation that records the rejection", async (t) => {
  const dir = await workspace(t);
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([
      resultMessage('done\nCLONE_AI_EVIDENCE: {"kind":"artifact","summary":"Wrote it","locator":"never-written.md"}'),
    ]),
  });

  const events = await collect(adapter.execute(assignment(dir)));
  const evidence = events.find((event) => event.type === "evidence");
  assert.equal(evidence?.type === "evidence" && evidence.evidence.kind, "observation");
  assert.match(evidence?.type === "evidence" ? evidence.evidence.summary : "", /does not exist/);
});

test("a receipt claim cannot be self-reported by the worker", async (t) => {
  const dir = await workspace(t);
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([
      resultMessage('done\nCLONE_AI_EVIDENCE: {"kind":"receipt","summary":"Sent the email","locator":"msg-1"}'),
    ]),
  });

  const events = await collect(adapter.execute(assignment(dir)));
  const evidence = events.find((event) => event.type === "evidence");
  assert.equal(evidence?.type === "evidence" && evidence.evidence.kind, "observation");
  assert.match(evidence?.type === "evidence" ? evidence.evidence.summary : "", /cannot be self-reported/);
});

test("a locator escaping the workspace is rejected", async (t) => {
  const dir = await workspace(t);
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([
      resultMessage('done\nCLONE_AI_EVIDENCE: {"kind":"artifact","summary":"Escaped","locator":"../outside.md"}'),
    ]),
  });

  const events = await collect(adapter.execute(assignment(dir)));
  const evidence = events.find((event) => event.type === "evidence");
  assert.match(evidence?.type === "evidence" ? evidence.evidence.summary : "", /escapes the workspace/);
});

test("read-only steps run in plan mode and reversible writes may accept edits", async (t) => {
  const dir = await workspace(t);
  const modes: Array<string | undefined> = [];
  const capture = (params: { options?: { permissionMode?: string } }) => {
    modes.push(params.options?.permissionMode);
    return stubQuery([resultMessage("done")]);
  };
  const adapter = new ClaudeAgentSdkAdapter({ id: "claude-sdk", workCapabilities: ["research"], queryFn: capture as never });

  await collect(adapter.execute(assignment(dir)));
  await collect(adapter.execute(assignment(dir, {
    step: { id: "step-2", instructions: "Edit", acceptanceCriteria: ["ok"], risk: "reversible_write", requiredCapabilities: ["research"] } as ExecutionAssignment["step"],
  })));
  assert.deepEqual(modes, ["plan", "acceptEdits"]);
});

test("exceeding the WorkOrder tool-call budget fails the assignment", async (t) => {
  const dir = await workspace(t);
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: () => stubQuery([
      { type: "assistant", session_id: "sdk-1", message: { content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] } },
      { type: "assistant", session_id: "sdk-1", message: { content: [{ type: "tool_use", id: "c2", name: "Read", input: {} }] } },
      resultMessage("done"),
    ]),
  });

  const events = await collect(adapter.execute(assignment(dir, {
    workOrder: {
      id: "wo-1",
      role: "researcher",
      title: "Read files",
      objective: "Read files",
      inputs: [],
      acceptanceCriteria: ["ok"],
      requiredCapabilities: ["research"],
      expectedArtifacts: [],
      risk: "read_only",
      dependsOn: [],
      budget: { maxToolCalls: 1, maxModelCalls: 10, maxDurationMs: 60_000, maxAttempts: 1 },
    },
  })));
  assert.equal(events.at(-1)?.type, "failed");
  assert.match(failureText(events), /tool-call budget/);
});

test("resume passes the prior session id to the SDK", async (t) => {
  const dir = await workspace(t);
  let resumed: string | undefined;
  const adapter = new ClaudeAgentSdkAdapter({
    id: "claude-sdk",
    workCapabilities: ["research"],
    queryFn: ((params: { options?: { resume?: string } }) => {
      resumed = params.options?.resume;
      return stubQuery([resultMessage("done")]);
    }) as never,
  });

  await collect(adapter.resume("sdk-earlier", assignment(dir)));
  assert.equal(resumed, "sdk-earlier");
});

test("the adapter never claims it can produce receipts", async () => {
  const adapter = new ClaudeAgentSdkAdapter({ id: "claude-sdk", workCapabilities: ["research"] });
  const capabilities = await adapter.capabilities();
  assert.ok(!(capabilities.evidenceKinds ?? []).includes("receipt"));
  assert.equal(capabilities.resume, true);
});
