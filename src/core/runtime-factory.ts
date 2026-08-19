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
import { LocalMemoryStore } from "../memory/memory-store.ts";

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
  const memory = new MemoryPipeline(journal);
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory,
    failureCatalog,
    memorySource: new LocalMemoryStore(paths.memoryFile),
    workspacePath: paths.workspacePath,
    workspaceCheckpointStore: new JsonWorkspaceCheckpointStore(paths.checkpointsDirectory),
    workspaceCheckpointDirectory: join(paths.dataDirectory, "checkpoints"),
  });
  await runtime.hydrate();
  return { paths, journal, runtime, memory, failureCatalog };
}
