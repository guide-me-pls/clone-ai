import { join, resolve } from "node:path";

import { PiAgentAdapter } from "./adapters/pi-agent-adapter.ts";
import { StaticAgentRegistry } from "./adapters/demo-adapter.ts";
import { JsonlJournalStore } from "./core/journal.ts";
import { DefaultPolicyEngine } from "./core/policy.ts";
import { CloneRuntime } from "./core/runtime.ts";
import { EvidenceVerifier } from "./core/verification.ts";
import { MemoryPipeline } from "./memory/memory-pipeline.ts";

const workspacePath = resolve(process.env.CLONE_AI_WORKSPACE ?? process.cwd());
const dataDirectory = resolve(
  process.env.CLONE_AI_DATA_DIR ?? join(workspacePath, ".clone-ai", "pi-smoke"),
);
const objective = process.argv.slice(2).join(" ").trim()
  || "Review the Clone AI WorkOrder contract and explain one remaining uncertainty.";

const journal = new JsonlJournalStore(join(dataDirectory, "journal.jsonl"));
const runtime = new CloneRuntime({
  journal,
  policy: new DefaultPolicyEngine(),
  verifier: new EvidenceVerifier(),
  memory: new MemoryPipeline(journal),
});
const { run } = await runtime.acceptTrigger({
  kind: "manual",
  summary: objective,
  payload: { source: "pi-smoke" },
});
await runtime.attachPlan(run.id, {
  summary: "Send one bounded, tool-free review WorkOrder to Pi.",
  steps: [{
    id: "pi-review-step",
    title: "Review through Pi",
    instructions: "Use Pi only for the bounded review contract below.",
    risk: "read_only",
    acceptanceCriteria: ["Pi returns a review artifact with a durable session locator"],
    subagents: [{
      id: "pi-review",
      agentId: "pi-reviewer",
      role: "reviewer",
      title: "Pi review",
      objective,
      inputs: [{
        name: "owner-request",
        description: "The exact review request supplied on the command line.",
        required: true,
      }],
      requiredCapabilities: ["review"],
      expectedArtifacts: [{
        id: "pi-review-note",
        kind: "artifact",
        description: "A concise review result returned by Pi.",
        required: true,
        locatorRequired: true,
      }],
      acceptanceCriteria: ["The result addresses the request and states remaining uncertainty"],
      risk: "read_only",
      budget: {
        maxDurationMs: 5 * 60_000,
        maxModelCalls: 10,
        maxToolCalls: 1,
        maxAttempts: 2,
      },
    }],
  }],
});

const adapter = new PiAgentAdapter({
  id: "pi-reviewer",
  cwd: workspacePath,
  sessionDirectory: join(dataDirectory, "sessions"),
  provider: process.env.CLONE_AI_PI_PROVIDER,
  model: process.env.CLONE_AI_PI_MODEL,
  tools: [],
  workCapabilities: ["review"],
});
const result = await runtime.execute(run.id, new StaticAgentRegistry([adapter]));
const evidence = (await journal.list())
  .filter((event) => event.runId === run.id && event.type === "evidence.recorded")
  .map((event) => event.payload as { summary: string; locator?: string });

console.log(`Run: ${run.id}`);
console.log(`Status: ${result.status}`);
for (const item of evidence) {
  console.log(`Evidence: ${item.summary}`);
  if (item.locator !== undefined) console.log(`Locator: ${item.locator}`);
}
console.log(`Journal: ${join(dataDirectory, "journal.jsonl")}`);
if (result.status !== "completed") process.exitCode = 1;
