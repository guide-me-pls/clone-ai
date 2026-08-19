import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodingCliAdapter } from "../src/adapters/coding-cli-adapter.ts";
import type { ExecutionAssignment, ExecutionEvent } from "../src/core/contracts.ts";

// The fixture runs as the child's main module (via commandArgs), so provider
// arguments that look like node flags (claude's -p) are never parsed by node.
// fixture 作为子进程主模块运行（经 commandArgs），因此形如 node flag 的 Provider 参数
//（claude 的 -p）永远不会被 node 自己解析。
const fakeCliPath = fileURLToPath(new URL("./fixtures/fake-coding-cli.cjs", import.meta.url));

test("a worker-declared receipt is downgraded to an observation", async () => {
  const events = await runSupervisedCli({
    evidence: { kind: "receipt", summary: "The email was sent.", locator: "mail://forged" },
  });

  const evidence = evidenceEvents(events);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.evidence.kind, "observation");
  assert.match(evidence[0]?.evidence.summary ?? "", /rejected/);
  assert.equal(evidence[0]?.evidence.locator, undefined);
  assert.ok(events.some((event) => event.type === "completed"));
});

test("an artifact claim is accepted only for a real file inside the workspace", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "clone-ai-cli-"));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const workspace = join(parent, "workspace");
  await mkdir(join(workspace, "out"), { recursive: true });
  await writeFile(join(workspace, "out", "report.md"), "# report");
  await writeFile(join(parent, "escape.md"), "outside the workspace");

  const accepted = await runSupervisedCli({
    workspacePath: workspace,
    evidence: { kind: "artifact", summary: "The report is ready.", locator: "out/report.md" },
  });
  assert.equal(evidenceEvents(accepted)[0]?.evidence.kind, "artifact");
  assert.equal(evidenceEvents(accepted)[0]?.evidence.locator, "out/report.md");

  const rejections: Array<Record<string, unknown>> = [
    { kind: "artifact", summary: "Escapes the workspace.", locator: "../escape.md" },
    { kind: "artifact", summary: "Uses an absolute path.", locator: join(workspace, "out", "report.md") },
    { kind: "artifact", summary: "Points at nothing.", locator: "out/missing.md" },
  ];
  for (const claim of rejections) {
    const events = await runSupervisedCli({ workspacePath: workspace, evidence: claim });
    const evidence = evidenceEvents(events);
    assert.equal(evidence[0]?.evidence.kind, "observation", `expected rejection for locator ${String(claim.locator)}`);
    assert.match(evidence[0]?.evidence.summary ?? "", /rejected/);
  }
});

test("a stderr flood does not deadlock stdout consumption", async () => {
  const events = await runSupervisedCli({ mode: "big-stderr", maxDurationMs: 8_000 });

  assert.ok(events.some((event) => event.type === "completed"));
  assert.ok(!events.some((event) => event.type === "failed"));
});

test("the supervised CLI boundary never grants receipt authority", async () => {
  const adapter = new CodingCliAdapter({
    id: "external-operator",
    providerId: "codex-cli",
    command: process.execPath,
    workCapabilities: ["external_action"],
  });

  const capabilities = await adapter.capabilities();
  assert.deepEqual(capabilities.evidenceKinds, ["artifact", "observation"]);
});

test("only allowlisted environment variables reach the CLI child", async (t) => {
  process.env.CLONE_AI_TEST_SECRET = "super-secret";
  t.after(() => {
    delete process.env.CLONE_AI_TEST_SECRET;
  });

  const hidden = await runSupervisedCli({ mode: "env-probe" });
  assert.match(finalTextOf(hidden), /probe=absent/);

  const granted = await runSupervisedCli({
    mode: "env-probe",
    extraEnvironmentVariables: ["CLONE_AI_TEST_SECRET"],
  });
  assert.match(finalTextOf(granted), /probe=super-secret/);
});

test("a clean exit without protocol output fails instead of completing", async () => {
  for (const mode of ["silent", "garbage"]) {
    const events = await runSupervisedCli({ mode });
    assert.ok(
      events.some((event) => event.type === "failed" && /no parseable protocol output/.test(event.message)),
      `expected a protocol failure for mode ${mode}`,
    );
    assert.ok(!events.some((event) => event.type === "completed"), `unexpected completion for mode ${mode}`);
  }
});

test("a missing CLI binary fails the step instead of crashing the supervisor", async () => {
  const events = await runSupervisedCli({ command: join(tmpdir(), "clone-ai-missing-cli.exe") });

  assert.ok(events.some((event) => event.type === "failed" && /failed to start/.test(event.message)));
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("a hanging CLI is killed at the duration budget", async () => {
  const events = await runSupervisedCli({ mode: "hang", maxDurationMs: 500 });

  assert.ok(events.some((event) => event.type === "failed" && /duration budget/.test(event.message)));
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("a provider-issued session id is journaled once, not per event", async () => {
  const events = await runSupervisedCli({ mode: "own-session" });

  const sessions = events.filter(
    (event): event is Extract<ExecutionEvent, { type: "session_started" }> => event.type === "session_started",
  );
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1]?.sessionId, "cli-own-session");
  assert.ok(events.some((event) => event.type === "completed"));
});

test("a recorded headless auth failure surfaces the provider result, not stderr noise", async () => {
  const events = await runSupervisedCli({
    providerId: "claude-code",
    mode: "replay",
    replayFile: "recorded-claude-headless-error.jsonl",
    replayExit: 1,
  });

  assert.ok(events.some((event) => event.type === "failed" && /Not logged in/.test(event.message)));
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("a recorded claude-code success stream replays into deltas, tools, and one completion", async () => {
  const events = await runSupervisedCli({
    providerId: "claude-code",
    mode: "replay",
    replayFile: "recorded-claude-success.jsonl",
  });

  // The result text must not be appended on top of the streamed deltas.
  // result 文本不能叠加在流式增量之上重复计一遍。
  assert.equal(finalTextOf(events), "SMOKE_OK");
  const completed = events.filter((event) => event.type === "completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.type === "completed" ? completed[0].summary : "", "SMOKE_OK");
  assert.ok(events.some((event) => event.type === "tool_started" && event.tool === "Read"));
  assert.ok(events.some((event) => event.type === "tool_completed" && event.tool === "Read" && event.isError === false));
  const sessions = events.filter((event) => event.type === "session_started");
  assert.equal(sessions.length, 2);
});

interface FakeCliOptions {
  evidence?: Record<string, unknown>;
  mode?: string;
  workspacePath?: string;
  maxDurationMs?: number;
  command?: string;
  providerId?: "codex-cli" | "claude-code";
  replayFile?: string;
  replayExit?: number;
  extraEnvironmentVariables?: string[];
}

async function runSupervisedCli(options: FakeCliOptions): Promise<ExecutionEvent[]> {
  const saved = new Map<string, string | undefined>([
    ["FAKE_CODING_CLI_MODE", process.env.FAKE_CODING_CLI_MODE],
    ["FAKE_CODING_CLI_EVIDENCE", process.env.FAKE_CODING_CLI_EVIDENCE],
    ["FAKE_CODING_CLI_REPLAY", process.env.FAKE_CODING_CLI_REPLAY],
    ["FAKE_CODING_CLI_EXIT", process.env.FAKE_CODING_CLI_EXIT],
  ]);
  setOrDelete("FAKE_CODING_CLI_MODE", options.mode);
  setOrDelete("FAKE_CODING_CLI_EVIDENCE", options.evidence === undefined ? undefined : JSON.stringify(options.evidence));
  setOrDelete(
    "FAKE_CODING_CLI_REPLAY",
    options.replayFile === undefined
      ? undefined
      : fileURLToPath(new URL(`./fixtures/${options.replayFile}`, import.meta.url)),
  );
  setOrDelete("FAKE_CODING_CLI_EXIT", options.replayExit === undefined ? undefined : String(options.replayExit));
  try {
    const adapter = new CodingCliAdapter({
      id: "external-operator",
      providerId: options.providerId ?? "codex-cli",
      command: options.command ?? process.execPath,
      commandArgs: options.command === undefined ? [fakeCliPath] : [],
      workCapabilities: ["external_action"],
      // The child environment is default-deny; the fixture's own control
      // variables must be granted explicitly, exactly like any other secret.
      // 子进程环境默认拒绝；fixture 自己的控制变量也必须显式授予，与任何机密一视同仁。
      environmentVariables: [
        "FAKE_CODING_CLI_MODE",
        "FAKE_CODING_CLI_EVIDENCE",
        "FAKE_CODING_CLI_REPLAY",
        "FAKE_CODING_CLI_EXIT",
        ...(options.extraEnvironmentVariables ?? []),
      ],
    });
    const events: ExecutionEvent[] = [];
    for await (const event of adapter.execute(assignment(options))) events.push(event);
    return events;
  } finally {
    for (const [key, value] of saved) setOrDelete(key, value);
  }
}

function setOrDelete(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function assignment(options: FakeCliOptions): ExecutionAssignment {
  const createdAt = new Date().toISOString();
  return {
    run: { id: "run-1", taskId: "task-1", status: "running", createdAt, updatedAt: createdAt },
    task: {
      id: "task-1",
      triggerId: "trigger-1",
      title: "Produce a report",
      objective: "Produce a report",
      acceptanceCriteria: ["The report exists"],
      createdAt,
    },
    step: {
      id: "step-1",
      title: "Produce the report",
      instructions: "Write the report in the workspace.",
      risk: "read_only",
      acceptanceCriteria: ["The report exists"],
      agentId: "external-operator",
      requiredCapabilities: ["external_action"],
    },
    executor: { agentId: "external-operator", providerId: "codex-cli" },
    workOrder: {
      id: "order-1",
      role: "maker",
      title: "Produce the report",
      objective: "Write the report in the workspace.",
      inputs: [],
      requiredCapabilities: ["external_action"],
      expectedArtifacts: [{ id: "report", kind: "artifact", description: "The report file.", required: true, locatorRequired: true }],
      acceptanceCriteria: ["The report exists"],
      risk: "read_only",
      budget: { maxDurationMs: options.maxDurationMs ?? 30_000, maxModelCalls: 4, maxToolCalls: 4, maxAttempts: 1 },
    },
    workspacePath: options.workspacePath,
  };
}

function evidenceEvents(events: ExecutionEvent[]): Array<Extract<ExecutionEvent, { type: "evidence" }>> {
  return events.filter((event): event is Extract<ExecutionEvent, { type: "evidence" }> => event.type === "evidence");
}

function finalTextOf(events: ExecutionEvent[]): string {
  return events
    .filter((event): event is Extract<ExecutionEvent, { type: "message_delta" }> => event.type === "message_delta")
    .map((event) => event.text)
    .join("");
}
