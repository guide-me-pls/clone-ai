import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildInstructions, NativeAgentWorker } from "../../src/workers/native-agent-worker.ts";
import { fileTools } from "../../src/workers/native-worker-factory.ts";

// Run 560e7a43: vendor/three.module.js occurred only in the step's prose, but
// its ENOENT was promoted to native-missing-input and aborted the whole step.
test("only a declared required work-order input makes an ENOENT fatal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-native-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missingPath = "vendor/three.module.js";

  const assignment = {
    run: { id: "run-1", taskId: "task-1", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "task-1", triggerId: "trigger-1", title: "Build", objective: "Build the model", acceptanceCriteria: [], createdAt: "" },
    step: {
      id: "step-1",
      title: "Build the model",
      instructions: `Build the interactive model with ${missingPath}.`,
      risk: "read_only",
      acceptanceCriteria: [],
      scopes: [],
    },
    executor: { agentId: "native", providerId: "native" },
    workspacePath: directory,
  };

  async function execute(withRequiredInput) {
    let calls = 0;
    let modelSawEnoent = false;
    const worker = new NativeAgentWorker({
      id: "native",
      label: "Native",
      tools: fileTools(),
      timeoutMs: 5_000,
      createClient: () => ({
        async complete(request) {
          calls += 1;
          if (calls === 1) {
            return {
              content: null,
              toolCalls: [{ id: "read-missing", name: "read_file", arguments: JSON.stringify({ path: missingPath }) }],
            };
          }
          modelSawEnoent = JSON.stringify(request).includes("ENOENT");
          return { content: "The optional module is absent; the step is complete.", toolCalls: [] };
        },
      }),
    });
    const input = withRequiredInput ? {
      ...assignment,
      workOrder: {
        id: "work-order-1",
        role: "maker",
        title: "Build the model",
        objective: assignment.step.instructions,
        inputs: [{ name: missingPath, description: "The required Three.js module", required: true }],
        requiredCapabilities: ["filesystem_read"],
        expectedArtifacts: [],
        acceptanceCriteria: [],
        risk: "read_only",
        budget: { maxDurationMs: 5_000, maxAttempts: 1 },
      },
    } : assignment;
    const events = [];
    for await (const event of worker.execute(input)) events.push(event);
    return { events, modelSawEnoent: () => modelSawEnoent };
  }

  // No work order means no declared inputs: prose alone must not fail the step.
  const prose = await execute(false);
  assert.equal(prose.modelSawEnoent(), true, "the real read_file tool must return ENOENT");
  assert.equal(prose.events.some((event) => event.type === "failed"), false);
  assert.equal(prose.events.some((event) => event.type === "completed"), true);

  // Declaring that same path with required: true retains the original guard.
  const declared = await execute(true);
  const failure = declared.events.find((event) => event.type === "failed");
  assert.equal(declared.modelSawEnoent(), true);
  assert.ok(failure !== undefined && failure.type === "failed");
  assert.equal(failure.report?.signature, "native-missing-input");
  assert.equal(failure.report?.category, "no_artifact");
  assert.equal(failure.message, `Required input missing: ${missingPath}`);
  assert.equal(declared.events.some((event) => event.type === "completed"), false);

  // The prompt must enforce declared inputs, not turn every prose path into one.
  assert.equal(buildInstructions(assignment, []).includes(
    "If a file named in these instructions is missing or unreadable, stop and report it.",
  ), false);
});
