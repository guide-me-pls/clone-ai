import { join } from "node:path";

import { createDemoAgentRegistry } from "./adapters/demo-adapter.ts";
import type { TriggerKind } from "./core/contracts.ts";
import { JsonlJournalStore } from "./core/journal.ts";
import { DefaultPolicyEngine } from "./core/policy.ts";
import { CloneRuntime, type DispatchResult } from "./core/runtime.ts";
import { EvidenceVerifier } from "./core/verification.ts";
import { MemoryPipeline } from "./memory/memory-pipeline.ts";
import { LocalMemoryStore } from "./memory/memory-store.ts";
import { buildDemoPlan } from "./planning/demo-planner.ts";
import type { CloneSettings } from "./settings/agent-settings.ts";

export interface DemoRunResult {
  runId: string;
  status: DispatchResult["status"];
  activeStepId?: string;
  subagentsCompleted: number;
  memoryCandidatesProposed: number;
}

export async function startDemoWorkflow(
  dataDirectory: string,
  query: string,
  trigger: { kind?: TriggerKind; payload?: Record<string, unknown> } = {},
  settings?: CloneSettings,
): Promise<DemoRunResult> {
  const { runtime, memory } = await createRuntime(dataDirectory);
  const { run } = await runtime.acceptTrigger({
    kind: trigger.kind ?? "query",
    summary: query,
    payload: { source: "desktop-client", ...trigger.payload },
  });

  const memoryStore = new LocalMemoryStore(join(dataDirectory, "memory.json"));
  const recalled = await memoryStore.recall(query, run.id);
  await runtime.recordMemoryRecall(run.id, query, recalled.map((item) => ({
    id: item.memory.id,
    summary: item.memory.summary,
    score: item.score,
    matchedTerms: item.matchedTerms,
  })));

  const agents = settings?.agents;
  const enabledAgentIds = agents === undefined ? undefined : new Set(agents.filter((agent) => agent.enabled).map((agent) => agent.id));
  await runtime.attachPlan(run.id, buildDemoPlan(query, enabledAgentIds, recalled.map((item) => item.memory.summary)));

  const result = await runtime.execute(run.id, createDemoAgentRegistry(agents));
  const candidates = result.status === "completed" ? await memory.processNext() : [];
  return toDemoResult(runtime, result, candidates.length);
}

export async function approveDemoWorkflow(dataDirectory: string, runId: string, settings?: CloneSettings): Promise<DemoRunResult> {
  const { runtime, memory } = await createRuntime(dataDirectory);
  const run = runtime.getRun(runId);
  if (run.status !== "waiting_approval" || run.activeStepId === undefined) {
    throw new Error(`Run ${runId} is not waiting for an approval.`);
  }

  await runtime.grantApproval(run.id, run.activeStepId, "Approved from the local desktop companion.");
  const result = await runtime.execute(run.id, createDemoAgentRegistry(settings?.agents));
  const candidates = result.status === "completed" ? await memory.processNext() : [];
  return toDemoResult(runtime, result, candidates.length);
}

function toDemoResult(runtime: CloneRuntime, result: DispatchResult, memoryCandidatesProposed: number): DemoRunResult {
  return {
    runId: result.run.id,
    status: result.status,
    activeStepId: result.run.activeStepId,
    subagentsCompleted: runtime.getSubagentsForRun(result.run.id).filter((subagent) => subagent.status === "completed").length,
    memoryCandidatesProposed,
  };
}

async function createRuntime(dataDirectory: string): Promise<{ runtime: CloneRuntime; memory: MemoryPipeline }> {
  const journal = new JsonlJournalStore(join(dataDirectory, "journal.jsonl"));
  const memory = new MemoryPipeline(journal);
  const runtime = new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory });
  await runtime.hydrate();
  return { runtime, memory };
}
