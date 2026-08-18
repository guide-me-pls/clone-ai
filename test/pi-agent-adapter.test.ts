import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PiAgentAdapter,
  type PiProcessHost,
  type PiProcessStart,
  type PiRpcSession,
  type PiTransportEvent,
} from "../src/adapters/pi-agent-adapter.ts";
import type { ExecutionAssignment, ExecutionEvent, SubagentWorkOrder } from "../src/core/contracts.ts";

test("Pi RPC events become normalized runtime events without real credentials", async (t) => {
  process.env.CLONE_AI_SECRET = "must-not-pass-through";
  t.after(() => {
    delete process.env.CLONE_AI_SECRET;
  });
  const rpc = new FakePiSession([
    message({ type: "agent_start" }),
    message({ type: "turn_start" }),
    message({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Reviewed the evidence." },
    }),
    message({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md", apiKey: "must-not-leak" },
    }),
    message({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      isError: false,
    }),
    message({ type: "agent_settled" }),
  ]);
  const host = new FakePiHost(() => rpc);
  const adapter = new PiAgentAdapter({
    id: "evidence-reviewer",
    command: "fake-pi",
    processHost: host,
    tools: ["read", "grep"],
    workCapabilities: ["review", "filesystem_read"],
    environmentVariables: ["PATH"],
  });

  const events = [];
  for await (const event of adapter.execute(assignment())) events.push(event);

  assert.equal(host.starts.length, 1);
  assert.equal(host.starts[0]?.command, "fake-pi");
  assert.ok(host.starts[0]?.args.includes("rpc"));
  assert.ok(host.starts[0]?.args.includes("read,grep"));
  assert.equal("CLONE_AI_SECRET" in (host.starts[0]?.env ?? {}), false);
  assert.equal(rpc.commands[0]?.type, "prompt");
  assert.match(String(rpc.commands[0]?.message), /Expected artifacts:/);
  assert.deepEqual(events.map((event) => event.type), [
    "session_started",
    "progress",
    "message_delta",
    "tool_started",
    "tool_completed",
    "evidence",
    "completed",
  ]);
  const toolStarted = events.find((event) => event.type === "tool_started");
  assert.match(toolStarted?.inputSummary ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(toolStarted?.inputSummary ?? "", /must-not-leak/);
  assert.equal(rpc.terminated, true);
});

test("Pi redacts secret-like free text before surfacing deltas and evidence", async () => {
  const rpc = new FakePiSession([
    message({ type: "agent_start" }),
    message({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "token=abc1234567890 and sk-secretvalue12345" },
    }),
    message({ type: "agent_settled" }),
  ]);
  const host = new FakePiHost(() => rpc);
  const adapter = new PiAgentAdapter({ command: "fake-pi", processHost: host, environmentVariables: [] });

  const events = [];
  for await (const event of adapter.execute(assignment())) events.push(event);

  const delta = events.find((event) => event.type === "message_delta");
  const evidence = events.find((event) => event.type === "evidence");
  assert.doesNotMatch(delta?.type === "message_delta" ? delta.text : "", /abc1234567890|sk-secretvalue12345/);
  assert.match(delta?.type === "message_delta" ? delta.text : "", /\[REDACTED/);
  assert.doesNotMatch(evidence?.type === "evidence" ? evidence.evidence.summary : "", /abc1234567890|sk-secretvalue12345/);
});

test("Pi resume reopens the exact persisted session and changes the bounded prompt", async () => {
  const rpc = new FakePiSession([
    message({ type: "agent_start" }),
    message({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Continued." } }),
    message({ type: "agent_settled" }),
  ]);
  const host = new FakePiHost(() => rpc);
  const adapter = new PiAgentAdapter({ command: "fake-pi", processHost: host });

  const events = [];
  for await (const event of adapter.resume("saved-session-1", assignment())) events.push(event);

  const sessionFlag = host.starts[0]?.args.indexOf("--session-id") ?? -1;
  assert.equal(host.starts[0]?.args[sessionFlag + 1], "saved-session-1");
  assert.match(String(rpc.commands[0]?.message), /Resume this exact work order/);
  assert.equal(events[0]?.type, "session_started");
  assert.equal(events.at(-1)?.type, "completed");
});

test("Pi cancellation sends abort to the active RPC session", async () => {
  const rpc = new FakePiSession([]);
  const host = new FakePiHost(() => rpc);
  const adapter = new PiAgentAdapter({ command: "fake-pi", processHost: host });
  const iterator = adapter.execute(assignment())[Symbol.asyncIterator]();

  const started = await iterator.next();
  assert.equal(started.value?.type, "session_started");
  const sessionId = started.value?.type === "session_started" ? started.value.sessionId : "";
  await adapter.cancel(sessionId);
  await iterator.return?.();

  assert.equal(rpc.commands[0]?.type, "abort");
  assert.equal(rpc.terminated, true);
});

test("Pi receives a minimal environment and no tools by default", async () => {
  const hiddenName = "CLONE_AI_TEST_HIDDEN_SECRET";
  const allowedName = "CLONE_AI_TEST_ALLOWED_VALUE";
  const previousHidden = process.env[hiddenName];
  const previousAllowed = process.env[allowedName];
  process.env[hiddenName] = "do-not-forward";
  process.env[allowedName] = "forward-explicitly";
  try {
    const rpc = new FakePiSession([message({ type: "agent_settled" })]);
    const host = new FakePiHost(() => rpc);
    const adapter = new PiAgentAdapter({
      command: "fake-pi",
      processHost: host,
      environmentVariables: [allowedName],
    });

    for await (const _event of adapter.execute(assignment())) {
      // Consume the complete RPC lifecycle.
      // 消费完整的 RPC 生命周期。
    }

    assert.equal(host.starts[0]?.env[hiddenName], undefined);
    assert.equal(host.starts[0]?.env[allowedName], "forward-explicitly");
    assert.ok(host.starts[0]?.args.includes("--no-tools"));
  } finally {
    restoreEnvironment(hiddenName, previousHidden);
    restoreEnvironment(allowedName, previousAllowed);
  }
});

test("the default Pi process host speaks JSONL across a real subprocess boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-pi-rpc-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));
  const adapter = new PiAgentAdapter({
    command: process.execPath,
    commandArgs: [fixture],
    sessionDirectory: directory,
  });

  const events = [];
  for await (const event of adapter.execute(assignment())) events.push(event);

  assert.equal(events.find((event) => event.type === "message_delta")?.text, "Fixture Pi completed.");
  assert.equal(events.at(-1)?.type, "completed");
});

// --- Fault injection against a real subprocess boundary ---
// --- 面向真实子进程边界的故障注入 ---

test("a Pi that dies mid-record fails with a protocol error", async (t) => {
  const events = await runFixturePi(t, { mode: "die-mid-line" });

  assert.ok(events.some((event) => event.type === "failed" && /incomplete JSONL/.test(event.message)));
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("a Pi that exits without settling fails instead of completing", async (t) => {
  const events = await runFixturePi(t, { mode: "no-settle" });

  assert.ok(events.some((event) => event.type === "message_delta"));
  assert.ok(events.some((event) => event.type === "failed" && /before agent_settled/.test(event.message)));
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("garbage on the protocol stream fails the run", async (t) => {
  const events = await runFixturePi(t, { mode: "garbage" });

  assert.ok(events.some((event) => event.type === "failed" && /invalid JSONL/.test(event.message)));
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("a Pi that ignores abort is hard-terminated at the duration budget", async (t) => {
  const startedAt = Date.now();
  const events = await runFixturePi(t, { mode: "ignore-abort", maxDurationMs: 250, abortGraceMs: 400 });

  assert.ok(events.some((event) => event.type === "failed" && /duration budget/.test(event.message)));
  assert.ok(!events.some((event) => event.type === "completed"));
  // Before the hard deadline existed, this scenario hung the supervisor forever.
  // 在硬截止存在之前，这个场景会让 Supervisor 永远挂住。
  assert.ok(Date.now() - startedAt < 10_000);
});

test("a duplicated agent_settled yields exactly one completion", async (t) => {
  const events = await runFixturePi(t, { mode: "double-settle" });

  assert.equal(events.filter((event) => event.type === "completed").length, 1);
  assert.equal(events.filter((event) => event.type === "evidence").length, 1);
});

async function runFixturePi(
  t: TestContext,
  options: { mode: string; maxDurationMs?: number; abortGraceMs?: number },
): Promise<ExecutionEvent[]> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-pi-fault-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const previousMode = process.env.FAKE_PI_MODE;
  process.env.FAKE_PI_MODE = options.mode;
  try {
    const adapter = new PiAgentAdapter({
      command: process.execPath,
      commandArgs: [fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url))],
      sessionDirectory: directory,
      environmentVariables: ["FAKE_PI_MODE"],
      abortGraceMs: options.abortGraceMs ?? 400,
    });
    const events: ExecutionEvent[] = [];
    for await (const event of adapter.execute(assignment(options.maxDurationMs))) events.push(event);
    return events;
  } finally {
    restoreEnvironment("FAKE_PI_MODE", previousMode);
  }
}

class FakePiHost implements PiProcessHost {
  readonly starts: PiProcessStart[] = [];
  readonly #factory: () => PiRpcSession;

  constructor(factory: () => PiRpcSession) {
    this.#factory = factory;
  }

  async start(input: PiProcessStart): Promise<PiRpcSession> {
    this.starts.push(input);
    return this.#factory();
  }
}

class FakePiSession implements PiRpcSession {
  readonly commands: Record<string, unknown>[] = [];
  readonly events: AsyncIterable<PiTransportEvent>;
  terminated = false;

  constructor(events: PiTransportEvent[]) {
    this.events = (async function* () {
      for (const event of events) yield event;
    })();
  }

  send(command: Record<string, unknown>): void {
    this.commands.push(command);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

function assignment(maxDurationMs?: number): ExecutionAssignment {
  return {
    run: {
      id: "run-1",
      taskId: "task-1",
      status: "running",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    },
    task: {
      id: "task-1",
      triggerId: "trigger-1",
      title: "Review the implementation",
      objective: "Review the implementation",
      acceptanceCriteria: ["Review exists"],
      createdAt: "2026-07-30T00:00:00.000Z",
    },
    step: {
      id: "review-step",
      title: "Review",
      instructions: "Review existing evidence.",
      risk: "read_only",
      acceptanceCriteria: ["Review exists"],
      subagents: [],
    },
    executor: {
      agentId: "evidence-reviewer",
      providerId: "pi",
    },
    workOrder: workOrder(maxDurationMs),
    dependencyEvidence: [{
      id: "evidence-1",
      runId: "run-1",
      stepId: "review-step",
      workOrderId: "draft",
      kind: "artifact",
      summary: "Draft created.",
      locator: "file:///draft.md",
      createdAt: "2026-07-30T00:00:00.000Z",
    }],
  };
}

function workOrder(maxDurationMs = 60_000): SubagentWorkOrder {
  return {
    id: "review",
    agentId: "evidence-reviewer",
    role: "reviewer",
    title: "Review evidence",
    objective: "Check the dependency evidence.",
    inputs: [{
      name: "draft",
      description: "Verified draft evidence.",
      sourceWorkOrderId: "draft",
      required: true,
    }],
    requiredCapabilities: ["review"],
    expectedArtifacts: [{
      id: "review-note",
      kind: "artifact",
      description: "An independent review note.",
      required: true,
    }],
    acceptanceCriteria: ["Review note explains remaining uncertainty"],
    risk: "read_only",
    budget: {
      maxDurationMs,
      maxModelCalls: 5,
      maxToolCalls: 10,
      maxAttempts: 2,
    },
    dependsOn: ["draft"],
  };
}

function message(value: Record<string, unknown>): PiTransportEvent {
  return { type: "message", value };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
