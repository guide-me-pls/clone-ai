import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodingCliAdapter } from "../src/adapters/coding-cli-adapter.ts";
import type { ExecutionAssignment, ExecutionEvent } from "../src/core/contracts.ts";

// NODE_OPTIONS treats backslashes inside quotes as escapes, so the preload
// path must use forward slashes to survive on Windows.
// NODE_OPTIONS 会把引号内的反斜杠当作转义符，preload 路径必须用正斜杠才能在 Windows 上存活。
const fakeCliPath = fileURLToPath(new URL("./fixtures/fake-coding-cli.cjs", import.meta.url)).replaceAll("\\", "/");

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

interface FakeCliOptions {
  evidence?: Record<string, unknown>;
  mode?: string;
  workspacePath?: string;
  maxDurationMs?: number;
}

async function runSupervisedCli(options: FakeCliOptions): Promise<ExecutionEvent[]> {
  const saved = new Map<string, string | undefined>([
    ["NODE_OPTIONS", process.env.NODE_OPTIONS],
    ["FAKE_CODING_CLI_MODE", process.env.FAKE_CODING_CLI_MODE],
    ["FAKE_CODING_CLI_EVIDENCE", process.env.FAKE_CODING_CLI_EVIDENCE],
  ]);
  process.env.NODE_OPTIONS = `--require "${fakeCliPath}"`;
  setOrDelete("FAKE_CODING_CLI_MODE", options.mode);
  setOrDelete("FAKE_CODING_CLI_EVIDENCE", options.evidence === undefined ? undefined : JSON.stringify(options.evidence));
  try {
    const adapter = new CodingCliAdapter({
      id: "external-operator",
      providerId: "codex-cli",
      command: process.execPath,
      workCapabilities: ["external_action"],
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
