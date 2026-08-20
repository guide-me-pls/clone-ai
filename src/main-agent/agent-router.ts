import type {
  DispatchBlockedCode,
  DispatchResult,
  DispatchSource,
  MemoryContext,
  TaskIntent,
  WorkerDescriptor,
} from "./dispatch-contracts.ts";

/**
 * Chooses which worker runs a task, in a fixed priority order.
 *
 * The order is the product decision: an owner who names an agent gets that
 * agent or a refusal — never a silent substitute. Falling back to whatever is
 * installed would quietly answer a different question than the one asked, and
 * would make "use codex" meaningless the moment codex is unavailable.
 *
 * 按固定优先级决定由哪个 Worker 执行任务。
 *
 * 这个顺序就是产品决策：所有者点名了某个 Agent，就只能得到该 Agent 或一个拒绝——绝不
 * 静默替换。回退到"装了什么用什么"等于悄悄回答了另一个问题，也会让"用 codex"在 codex
 * 不可用的那一刻失去意义。
 */

export interface RouteInput {
  taskId: string;
  intent: TaskIntent;
  workers: readonly WorkerDescriptor[];
  memory?: MemoryContext;
  now?: string;
}

export function routeTask(input: RouteInput): DispatchResult {
  const createdAt = input.now ?? new Date().toISOString();
  const considered = input.workers.map((worker) => worker.id);
  const blocked = (code: DispatchBlockedCode, reason: string, requestedAgentId?: string): DispatchResult => ({
    status: "blocked",
    taskId: input.taskId,
    code,
    reason,
    ...(requestedAgentId === undefined ? {} : { requestedAgentId }),
    consideredAgentIds: considered,
  });

  const selected = (
    worker: WorkerDescriptor,
    source: DispatchSource,
    ruleIds: readonly string[],
    usedMemoryIds: readonly string[],
    reason: string,
  ): DispatchResult => ({
    status: "selected",
    decision: {
      taskId: input.taskId,
      intent: input.intent,
      selectedAgentId: worker.id,
      providerId: worker.providerId,
      source,
      matchedRuleIds: ruleIds,
      usedMemoryIds,
      alternatives: input.workers
        .filter((candidate) => candidate.id !== worker.id && candidate.enabled && candidate.installed)
        .map((candidate) => candidate.id),
      reason,
      sessionPolicy: "fresh",
      createdAt,
    },
  });

  // 1. An explicit request is honoured or refused with the precise reason.
  //    显式指定要么被满足，要么带着精确原因被拒绝。
  const requested = input.intent.explicitAgentId;
  if (requested !== undefined) {
    const worker = input.workers.find((candidate) => candidate.id === requested);
    if (worker === undefined) {
      return blocked("REQUESTED_AGENT_NOT_FOUND", `No worker is registered as "${requested}".`, requested);
    }
    if (!worker.enabled) {
      return blocked("REQUESTED_AGENT_DISABLED", `Worker "${requested}" is disabled in settings.`, requested);
    }
    if (!worker.installed) {
      return blocked("REQUESTED_AGENT_UNAVAILABLE", `Worker "${requested}" is not installed on this machine.`, requested);
    }
    const missing = missingCapabilities(worker, input.intent);
    if (missing.length > 0) {
      return blocked("CAPABILITY_MISMATCH", `Worker "${requested}" lacks: ${missing.join(", ")}.`, requested);
    }
    return selected(worker, "explicit", [], [], `The owner explicitly requested ${requested}.`);
  }

  // 2. Exclusions are removed before any scoring, so an excluded worker can
  //    never win on capability or history.
  //    排除在任何打分之前生效，被排除的 Worker 不可能靠能力或历史胜出。
  const excluded = new Set(input.intent.excludedAgentIds);
  const eligible = input.workers.filter((worker) => (
    worker.enabled
    && worker.installed
    && !excluded.has(worker.id)
    && missingCapabilities(worker, input.intent).length === 0
  ));
  if (eligible.length === 0) {
    return blocked(
      "NO_MATCHING_AGENT",
      `No enabled, installed worker satisfies: ${input.intent.requiredCapabilities.join(", ")}.`,
    );
  }

  // 3. Role rules narrow the field before memory is consulted.
  //    角色规则先收窄候选，再看记忆。
  const roleMatched = eligible.filter((worker) => worker.roles.includes(input.intent.kind));
  const pool = roleMatched.length > 0 ? roleMatched : eligible;
  const matchedRuleIds = roleMatched.length > 0 ? [`role:${input.intent.kind}`] : [];

  // 4. Past outcomes for this kind of work break the tie.
  //    同类任务的历史结果用于打破平局。
  const fromMemory = chooseByMemory(pool, input.memory);
  if (fromMemory !== undefined) {
    return selected(
      fromMemory.worker,
      "memory",
      matchedRuleIds,
      fromMemory.usedMemoryIds,
      `Past outcomes favour ${fromMemory.worker.id} for ${input.intent.kind} work.`,
    );
  }

  // 5. Description match, then declared priority, decide the remainder.
  //    最后由描述匹配与声明的优先级决定。
  const ranked = [...pool].sort((left, right) => (
    describeScore(right, input.intent) - describeScore(left, input.intent)
    || right.priority - left.priority
    || left.id.localeCompare(right.id)
  ));
  const winner = ranked[0]!;
  const source: DispatchSource = describeScore(winner, input.intent) > 0 ? "description" : "rule";
  return selected(
    winner,
    source,
    matchedRuleIds,
    [],
    source === "description"
      ? `${winner.id} describes itself as suited to ${input.intent.kind} work.`
      : `${winner.id} is the highest-priority worker with the required capabilities.`,
  );
}

function missingCapabilities(worker: WorkerDescriptor, intent: TaskIntent): string[] {
  return intent.requiredCapabilities.filter((capability) => !worker.capabilities.includes(capability));
}

/**
 * Memory may only prefer a worker that already passed every earlier gate, and
 * only through recorded outcomes. It cannot introduce a worker, revive an
 * excluded one, or override an explicit request — memory is evidence about the
 * past, never authority over the present.
 * 记忆只能在已通过前面所有关卡的 Worker 中做偏好选择，且只能依据已记录的结果。它无法引入
 * 新 Worker、复活被排除的 Worker，也无法覆盖显式指定——记忆是关于过去的证据，而不是对
 * 当下的权威。
 */
function chooseByMemory(
  pool: readonly WorkerDescriptor[],
  memory: MemoryContext | undefined,
): { worker: WorkerDescriptor; usedMemoryIds: string[] } | undefined {
  if (memory === undefined) return undefined;
  const outcomes = memory.evidence.filter((item) => item.kind === "agent_outcome" || item.kind === "task_outcome");
  if (outcomes.length === 0) return undefined;

  let best: { worker: WorkerDescriptor; score: number; usedMemoryIds: string[] } | undefined;
  for (const worker of pool) {
    const mentions = outcomes.filter((item) => mentionsWorker(item.summary, worker.id));
    if (mentions.length === 0) continue;
    const score = mentions.reduce((total, item) => total + outcomeWeight(item.summary), 0);
    if (score <= 0) continue;
    if (best === undefined || score > best.score) {
      best = { worker, score, usedMemoryIds: mentions.map((item) => item.id) };
    }
  }
  return best === undefined ? undefined : { worker: best.worker, usedMemoryIds: best.usedMemoryIds };
}

function mentionsWorker(summary: string, workerId: string): boolean {
  return summary.toLocaleLowerCase().includes(workerId.toLocaleLowerCase());
}

/**
 * Scores a recorded outcome as success, failure, or ambiguous.
 *
 * "error" and 错误 are deliberately absent from the failure markers: in coding
 * work they almost always name the *subject* ("fix the TypeScript error"), not
 * the result. Treating them as failure made a successful repair read as a
 * failed attempt, which is exactly backwards.
 *
 * 把已记录的结果判为成功、失败或不确定。
 *
 * 失败标记里刻意不含 "error" 与 "错误"：在编码工作中它们几乎总是指任务的*对象*
 * （"修复 TypeScript 错误"），而不是结果。把它们当作失败，会让一次成功的修复被读成
 * 失败的尝试，恰好颠倒。
 */
function outcomeWeight(summary: string): number {
  const lowered = summary.toLocaleLowerCase();
  const failed = /\b(fail|failed|failure|unable|timeout|timed out|gave up)\b|失败|超时|未能|没能|放弃/.test(lowered);
  const succeeded = /\b(succeed|succeeded|success|passed|completed|fixed|resolved)\b|成功|通过|完成|修复|解决/.test(lowered);
  if (failed && !succeeded) return -1;
  if (succeeded && !failed) return 1;
  return 0;
}

function describeScore(worker: WorkerDescriptor, intent: TaskIntent): number {
  const description = worker.description.toLocaleLowerCase();
  const words = intent.summary
    .toLocaleLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((word) => word.length > 2);
  if (words.length === 0) return 0;
  return words.filter((word) => description.includes(word)).length;
}
