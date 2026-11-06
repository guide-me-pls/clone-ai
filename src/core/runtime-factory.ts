import { join } from "node:path";

import { resolveClonePaths, prepareCloneHome, type ClonePathOptions, type ClonePaths } from "../config/clone-home.ts";
import { loadOutcomeCatalog, type OutcomeCatalog } from "./failure-analysis.ts";
import type { Evidence } from "./contracts.ts";
import type { JournalStore } from "./journal.ts";
import { createJournalStore } from "./sqlite-journal.ts";
import { AuthorityPolicyEngine } from "../authority/policy-engine.ts";
import { StandingPolicyStore } from "../authority/standing-policy-store.ts";
import { CloneRuntime } from "./runtime.ts";
import { JsonWorkspaceCheckpointStore } from "./workspace-evidence.ts";
import { createDefaultVerifier } from "./verification.ts";
import { DiffFileVerifier } from "./verifier-plugins.ts";
import { MemoryPipeline } from "../memory/memory-pipeline.ts";
import { AgentMemoryWorker } from "../memory/agent-memory-worker.ts";
import { ConversationMemoryPipeline } from "../memory/conversation-memory-pipeline.ts";
import { miningModeFromEnvironment as miningMode } from "../memory/mining-policy.ts";
import { GovernedMemorySource } from "../memory/md-memory-store.ts";
import { WorkerSettingsStore } from "../config/worker-settings.ts";

export interface RuntimeAssembly {
  paths: ClonePaths;
  journal: JournalStore;
  runtime: CloneRuntime;
  memory: MemoryPipeline;
  /** Present only when conversation mining is enabled. 仅在开启对话提炼时存在。 */
  conversationMemory?: ConversationMemoryPipeline;
  failureCatalog: OutcomeCatalog;
  /** Owner-authored autonomy levels and standing policies. 所有者撰写的自主档位与常设策略。 */
  authority: StandingPolicyStore;
  /** Re-reads which executors are enabled, for callers that change settings. 为修改设置的调用方重新读取已启用的执行者。 */
  refreshKnownAgents: () => Promise<void>;
  /**
   * Releases the journal handle. A SQLite journal holds the file open, so a
   * caller that owns a temporary or removable clone home must be able to let
   * go of it. 释放 Journal 句柄。SQLite Journal 会持续打开文件，因此拥有临时或可删除
   * clone home 的调用方必须能够放手。
   */
  close: () => void;
}

/**
 * Build the only Runtime assembly used by the daemon, Query workflow, and Main
 * Agent. One factory prevents those entry points from drifting in policy,
 * memory, journal, or recovery behavior. 为 Daemon、Query Workflow 和 Main Agent
 * 构建唯一的 Runtime 组装入口，避免不同入口在策略、记忆、Journal 或恢复行为上漂移。
 */
export interface RuntimeAssemblyOptions extends ClonePathOptions {
  /**
   * Evidence kinds that count as completion for this assembly's work. A
   * black-box CLI never reports `test` evidence, so the default verifier's
   * test plugin would fail a step whose acceptance says "tests". The repair
   * lane, which checks its tests itself, narrows this to the kinds its workers
   * really record.
   * 本次组装中算作完成的 Evidence 类型。黑盒 CLI 从不报告 `test` 证据，因此默认验证器的
   * 测试插件会让验收标准提到"测试"的步骤失败。自行检查测试的修复通道把它收窄到 Worker
   * 真正会记录的类型。
   */
  evidenceKinds?: readonly Evidence["kind"][];
  /**
   * Executors the Kernel will accept in a plan. Omitted means "read the
   * owner's settings"; an assembly built around an explicitly supplied
   * registry must say so, or every plan naming one of its agents is rejected.
   * Kernel 在计划中会接受的执行者。省略表示读取所有者设置；围绕显式提供的 Registry 构建的组装
   * 必须声明它，否则点名其 Agent 的每个计划都会被拒。
   */
  knownAgentIds?: () => Set<string>;
}

export async function createRuntimeAssembly(options: RuntimeAssemblyOptions = {}): Promise<RuntimeAssembly> {
  const { evidenceKinds } = options;
  const paths = resolveClonePaths(options);
  await prepareCloneHome(paths);
  const journal = createJournalStore(paths.dataDirectory);
  const failureCatalog = await loadOutcomeCatalog(paths.dataDirectory);
  const authority = new StandingPolicyStore(paths.dataDirectory, journal);
  await authority.load();

  // The executors the Kernel will accept in a plan. Read once here and cached
  // in a mutable set that a settings change can refresh, so validation stays
  // synchronous inside attachPlan while still tracking the owner's config.
  // Kernel 在计划中会接受的执行者。在此读一次并缓存在可变集合中，设置变更可刷新它，
  // 使 attachPlan 内的校验保持同步，同时仍能跟随所有者的配置。
  const workerSettings = new WorkerSettingsStore(paths.legacyAgentsFile);
  const knownAgents = new Set<string>(options.knownAgentIds?.() ?? []);
  const refreshKnownAgents = async (): Promise<void> => {
    // An explicitly supplied registry is the authority for what can run; the
    // settings file must not overwrite it with a different list.
    // 显式提供的 Registry 才是"能跑什么"的权威；设置文件不得用另一份清单覆盖它。
    if (options.knownAgentIds !== undefined) return;
    try {
      const settings = await workerSettings.get();
      knownAgents.clear();
      for (const agent of settings.agents) {
        if (agent.enabled) knownAgents.add(agent.id);
      }
    } catch {
      // An unreadable settings file must not turn every plan into a rejection;
      // an empty set disables the check rather than blocking all work.
      // 读不了设置文件不应让每个计划都被拒；空集合会禁用该检查，而不是阻断全部工作。
    }
  };
  await refreshKnownAgents();

  const memory = new MemoryPipeline(
    journal,
    // Task mining stays on the deterministic worker unless the owner asks for a
    // real miner: every completed task would otherwise cost a model call, and a
    // miner that is not installed must not turn a finished task into an error.
    // Conversation mining (below) is the one that defaults to a real miner,
    // because learning from what the owner says is the point of the feature.
    // 任务提炼默认仍用确定性 Worker，除非所有者明确要求真实提炼器：否则每个完成的任务都要多花一次
    // 模型调用，而且没装好的提炼器不该把已完成的任务变成错误。下面默认用真实提炼器的是对话提炼，
    // 因为"从所有者说的话里学习"正是这个功能的意义。
    miningMode() === "all"
      ? new AgentMemoryWorker({ allowUnrestrictedHost: process.env.CLONE_AI_MEMORY_MINING_UNRESTRICTED === "1" })
      : undefined,
    { lockPath: join(paths.dataDirectory, "memory-extraction-lock") },
  );
  // Conversation mining shares the pipeline's lock, so the two paths never
  // write candidates concurrently.
  // 对话提炼共用流水线锁，使两条路径不会并发写候选。
  const conversationMemory = miningMode() !== "off"
    ? new ConversationMemoryPipeline(journal, memory)
    : undefined;
  const runtime = new CloneRuntime({
    journal,
    policy: new AuthorityPolicyEngine({ config: () => authority.snapshot() }),
    verifier: evidenceKinds === undefined
      ? createDefaultVerifier({ workspacePath: paths.workspacePath })
      // Only the plugins a narrowed evidence set can satisfy: the test plugin
      // would otherwise demand evidence the worker is not allowed to record.
      // 只保留收窄后的证据集能满足的插件；否则测试插件会索要 Worker 不允许记录的证据。
      : new DiffFileVerifier({ workspacePath: paths.workspacePath }),
    memory,
    failureCatalog,
    // Recall comes from the governed store only: promoted memories, never raw
    // candidates. 召回只来自受治理的 Store：只有已提升的记忆，绝不包含原始候选。
    memorySource: new GovernedMemorySource(paths.dataDirectory, 4, journal),
    workspacePath: paths.workspacePath,
    workspaceCheckpointStore: new JsonWorkspaceCheckpointStore(paths.checkpointsDirectory),
    workspaceCheckpointDirectory: join(paths.dataDirectory, "checkpoints"),
    isolatedWorkspaceRoot: paths.isolatedWorkspacesDirectory,
    knownAgentIds: () => knownAgents,
  });
  await runtime.hydrate();
  const close = (): void => {
    (journal as { close?: () => void }).close?.();
  };
  return { paths, journal, runtime, memory, ...(conversationMemory === undefined ? {} : { conversationMemory }), failureCatalog, authority, refreshKnownAgents, close };
}
