import { join } from "node:path";

import { resolveClonePaths, prepareCloneHome, type ClonePathOptions, type ClonePaths } from "../config/clone-home.ts";
import { loadOutcomeCatalog, type OutcomeCatalog } from "./failure-analysis.ts";
import type { JournalStore } from "./journal.ts";
import { createJournalStore } from "./sqlite-journal.ts";
import { DefaultPolicyEngine } from "./policy.ts";
import { CloneRuntime } from "./runtime.ts";
import { JsonWorkspaceCheckpointStore } from "./workspace-evidence.ts";
import { EvidenceVerifier } from "./verification.ts";
import { MemoryPipeline } from "../memory/memory-pipeline.ts";
import { AgentMemoryWorker } from "../memory/agent-memory-worker.ts";
import { GovernedMemorySource } from "../memory/md-memory-store.ts";

export interface RuntimeAssembly {
  paths: ClonePaths;
  journal: JournalStore;
  runtime: CloneRuntime;
  memory: MemoryPipeline;
  failureCatalog: OutcomeCatalog;
}

/**
 * Build the only Runtime assembly used by the daemon, Query workflow, and Main
 * Agent. One factory prevents those entry points from drifting in policy,
 * memory, journal, or recovery behavior. 为 Daemon、Query Workflow 和 Main Agent
 * 构建唯一的 Runtime 组装入口，避免不同入口在策略、记忆、Journal 或恢复行为上漂移。
 */
export async function createRuntimeAssembly(options: ClonePathOptions = {}): Promise<RuntimeAssembly> {
  const paths = resolveClonePaths(options);
  await prepareCloneHome(paths);
  const journal = createJournalStore(paths.dataDirectory);
  const failureCatalog = await loadOutcomeCatalog(paths.dataDirectory);
  const memory = new MemoryPipeline(
    journal,
    // Memory mining by a background agent is opt-in: it costs one real model
    // call per completed task, so the deterministic worker stays the default.
    // 后台 Agent 提炼记忆是显式开启的：每完成一个任务会花一次真实模型调用，因此
    // 默认仍使用确定性 Worker。
    process.env.CLONE_AI_MEMORY_MINING === "1" ? new AgentMemoryWorker() : undefined,
  );
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory,
    failureCatalog,
    // Recall comes from the governed store only: promoted memories, never raw
    // candidates. 召回只来自受治理的 Store：只有已提升的记忆，绝不包含原始候选。
    memorySource: new GovernedMemorySource(paths.dataDirectory),
    workspacePath: paths.workspacePath,
    workspaceCheckpointStore: new JsonWorkspaceCheckpointStore(paths.checkpointsDirectory),
    workspaceCheckpointDirectory: join(paths.dataDirectory, "checkpoints"),
  });
  await runtime.hydrate();
  return { paths, journal, runtime, memory, failureCatalog };
}
