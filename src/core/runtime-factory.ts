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
import { ConversationMemoryWorker } from "../memory/conversation-memory-worker.ts";
import { ConversationMemoryPipeline } from "../memory/conversation-memory-pipeline.ts";
import { miningModeFromEnvironment as miningMode } from "../memory/mining-policy.ts";
import { GovernedMemorySource } from "../memory/md-memory-store.ts";
import { WorkerSettingsStore } from "../config/worker-settings.ts";
import { CloneConfigStore } from "../config/clone-config.ts";
import { CapacityGate, sampleCapacity } from "./capacity.ts";

/**
 * One measured worker budget per clone home, shared by every assembly built
 * over that home. `runQuery` assembles one runtime per query, the Main Agent
 * assembles one per tool call and per turn, and the daemon holds one at boot;
 * a per-assembly gate let each of them dispatch up to the machine's full
 * budget, so two concurrent Main Agent turns doubled the real worker load.
 * 每个 clone home 一份实测 Worker 预算，由该 home 上的每个组装共享。`runQuery`
 * 每次查询组装一个 Runtime，主 Agent 每次工具调用与每个回合各组装一个，Daemon 启动时
 * 持有一个；逐组装的闸门让它们各自派发到机器的完整预算，因此两个并发 Main Agent 回合
 * 会把真实 Worker 负载翻倍。
 */
interface SharedCapacityEntry {
  readonly gate: CapacityGate;
  /** The owner's pin, shared so a refresh through any assembly reaches all. 所有者的固定值，共享后任一组装的刷新都能到达全部。 */
  readonly pin: { limit?: number };
  /** Serializes config reads so the last requested refresh wins. 串行化配置读取，使最后发起的刷新胜出。 */
  refreshChain: Promise<void>;
  references: number;
}

const sharedCapacityByHome = new Map<string, SharedCapacityEntry>();

/** Take a reference to the home's gate, creating it on first use. 取得本 home 闸门的引用，首次使用时创建。 */
function acquireSharedCapacity(dataDirectory: string): SharedCapacityEntry {
  const existing = sharedCapacityByHome.get(dataDirectory);
  if (existing !== undefined) {
    existing.references += 1;
    return existing;
  }
  const pin: { limit?: number } = {};
  const entry: SharedCapacityEntry = {
    gate: new CapacityGate(() => sampleCapacity(pin.limit === undefined ? {} : { pinnedLimit: pin.limit })),
    pin,
    refreshChain: Promise.resolve(),
    references: 1,
  };
  sharedCapacityByHome.set(dataDirectory, entry);
  return entry;
}

/**
 * Drop one reference; the last one removes the entry so a test suite's many
 * temporary homes do not accumulate. 释放一个引用；最后一个引用删除条目，使测试套件
 * 的大量临时 home 不会累积。
 */
function releaseSharedCapacity(dataDirectory: string): void {
  const entry = sharedCapacityByHome.get(dataDirectory);
  if (entry === undefined) return;
  entry.references -= 1;
  if (entry.references <= 0) sharedCapacityByHome.delete(dataDirectory);
}

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
  /** The live capacity gate, for the Main Agent's read-only tool and the audit. 实时容量闸门，供主 Agent 的只读工具与审计使用。 */
  capacityGate: CapacityGate;
  /** Re-reads the owner's pinned concurrency limit. 重新读取所有者固定的并发上限。 */
  refreshCapacityPin: () => Promise<void>;
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
  /**
   * The workspace is a sandbox this assembly owns (the repair lane's worktree),
   * so writes there need no plan scope. Never set for the owner's live tree.
   * 工作区是本次组装拥有的沙箱（修复通道的 worktree），因此那里的写入无需计划 Scope。
   * 绝不用于所有者的活树。
   */
  workspaceWritable?: boolean;
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

  const extractionLockPath = join(paths.dataDirectory, "memory-extraction-lock");
  const memory = new MemoryPipeline(
    journal,
    // Task mining needs a model to say what is durable. Without one the default
    // worker proposes nothing: a completed task's objective is a work order, not
    // a memory. `=all` opts into the real miner explicitly.
    // 任务提炼需要模型说出什么值得长期记住。没有模型时默认 Worker 不提出候选：已完成任务的
    // 目标是工作单，不是记忆。`=all` 才会显式启用真实提炼器。
    miningMode() === "all"
      ? new AgentMemoryWorker({ dataDirectory: paths.dataDirectory })
      : undefined,
    { lockPath: extractionLockPath },
  );
  // Conversation mining gets its own pipeline and worker. Borrowing the task
  // pipeline's worker would make the no-op default silently turn it off; the
  // two share only the lock, so their journal writes never interleave.
  // 对话提炼拥有自己的流水线与 Worker。借用任务流水线的 Worker 会让空默认静默关掉它；
  // 两者只共用锁，因此 Journal 写入不会交错。
  const conversationMemory = miningMode() !== "off"
    ? new ConversationMemoryPipeline(journal, new MemoryPipeline(
        journal,
        new ConversationMemoryWorker({ dataDirectory: paths.dataDirectory }),
        { lockPath: extractionLockPath },
      ))
    : undefined;
  // One gate per clone home, not per assembly: the queue and every subagent
  // wave — in this assembly or a concurrently assembled one — draw from the
  // same measured budget. The pin is shared through the entry and re-read on
  // each acquire, so an owner setting change lands without a restart.
  // 每个 clone home 一份闸门，而不是每个组装一份：本组装或并发组装出的其他组装里的
  // 队列与每个子 Agent 波次，都从同一份实测预算取用。固定值通过条目共享，并在每次获取时
  // 重新读取，因此所有者改设置无需重启即可生效。
  const configStore = new CloneConfigStore(paths);
  const sharedCapacity = acquireSharedCapacity(paths.dataDirectory);
  const capacityGate = sharedCapacity.gate;
  async function readCapacityPin(): Promise<void> {
    try {
      sharedCapacity.pin.limit = (await configStore.get()).maxConcurrentWorkers;
    } catch {
      // An unreadable config must not stop dispatch; keep the last value.
      // 读不了配置不能让派发停摆；沿用上一次的值。
    }
  }
  // A construction that throws after taking the reference (hydrate over a
  // corrupt journal, say) must give it back, or the entry outlives this failed
  // attempt. 取得引用之后再抛错的构造（例如在损坏的 Journal 上 hydrate）必须归还
  // 引用，否则条目会活得比这次失败的尝试更久。
  let runtime: CloneRuntime;
  try {
    await readCapacityPin();
    runtime = new CloneRuntime({
      capacityGate,
      journal,
      policy: new AuthorityPolicyEngine({
        config: () => authority.snapshot(),
        // The repair lane's worktree is a sandbox, not the owner's machine.
        // 修复通道的 worktree 是沙箱，不是所有者的机器。
        ...(options.workspaceWritable === true ? { writableSandbox: true } : {}),
      }),
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
      ...(options.workspaceWritable === true ? { workspaceWritable: true } : {}),
      workspaceCheckpointStore: new JsonWorkspaceCheckpointStore(paths.checkpointsDirectory),
      workspaceCheckpointDirectory: join(paths.dataDirectory, "checkpoints"),
      isolatedWorkspaceRoot: paths.isolatedWorkspacesDirectory,
      knownAgentIds: () => knownAgents,
    });
    await runtime.hydrate();
  } catch (error: unknown) {
    releaseSharedCapacity(paths.dataDirectory);
    throw error;
  }
  async function refreshCapacityPin(): Promise<void> {
    const refresh = sharedCapacity.refreshChain.then(readCapacityPin);
    sharedCapacity.refreshChain = refresh.catch(() => undefined);
    await refresh;
  }
  let closed = false;
  const close = (): void => {
    // One release per assembly, even if a caller closes twice: a test's
    // cleanup and its `finally` both run, and a double release would delete a
    // gate another live assembly still holds.
    // 每个组装只释放一次，即使调用方关闭两次：测试的清理与 `finally` 都会执行，
    // 重复释放会删掉另一个存活组装仍在使用的闸门。
    if (closed) return;
    closed = true;
    (journal as { close?: () => void }).close?.();
    releaseSharedCapacity(paths.dataDirectory);
  };
  return {
    paths, journal, runtime, memory,
    ...(conversationMemory === undefined ? {} : { conversationMemory }),
    failureCatalog, authority, refreshKnownAgents, close,
    capacityGate,
    refreshCapacityPin,
  };
}
