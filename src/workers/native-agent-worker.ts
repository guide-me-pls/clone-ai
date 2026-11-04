/**
 * A worker whose loop runs in this process on a vendor SDK, with every tool
 * call gated by the Kernel before it happens.
 *
 * The black-box CLI worker gets its boundary from the outside: an OS sandbox
 * around the whole process, and evidence inferred from a before/after workspace
 * diff. That is honest, but coarse — the Kernel never sees an individual tool
 * call, so it cannot refuse one and continue, and it cannot allow a network
 * host the step did not declare. A native worker moves the same boundary inside
 * the loop: the provider only receives the tools the step's scopes already
 * justify, and each call is checked against them at the moment it is made.
 *
 * What stays true regardless of the SDK: this module owns the execution loop
 * contract (events, budgets, cancellation, evidence). The model client is
 * injected, so the gating logic is testable without a network call and a new
 * provider is a small adapter, not a rewrite.
 *
 * 一个在当前进程内、基于厂商 SDK 运行循环的 Worker，并且每次工具调用都在发生之前由 Kernel 放行。
 *
 * 黑盒 CLI Worker 从外部获得边界：包住整个进程的操作系统沙箱，以及由工作区前后差异推断的证据。
 * 这很诚实，但很粗——Kernel 看不到单次工具调用，无法"拒绝一次并继续"，也无法只放行步骤声明的
 * 某个网络主机。原生 Worker 把同一条边界移到循环内部：Provider 只会拿到步骤 Scope 已经允许的工具，
 * 且每次调用都在发起的瞬间复核。
 *
 * 与 SDK 无关的部分：本模块拥有执行循环的契约（事件、预算、取消、证据）。模型客户端是注入的，
 * 因此放行逻辑无需网络即可测试，接入新 Provider 只是写一个小适配器，而不是重写。
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../core/contracts.ts";
import type { FailureReport } from "../core/failure-analysis.ts";
import { resolveGrants } from "../authority/path-gateway.ts";

export type NativeToolRisk = "read" | "write" | "network" | "external";

export interface NativeToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface NativeToolSpec {
  name: string;
  description: string;
  risk: NativeToolRisk;
  /** Path of a file the call reads or writes; checked against the step's grants. 调用读写文件的路径，与步骤的授权核对。 */
  pathOf?: (input: Record<string, unknown>) => string | undefined;
  run: (call: NativeToolCall, context: { workspace: string }) => Promise<{ output: string; isError?: boolean }>;
}

export interface NativeModelClient {
  /** Runs one turn; the loop lets the model call tools until this reports done. 运行一轮；循环让模型调用工具，直到这里报告完成。 */
  run(input: {
    instructions: string;
    tools: readonly NativeToolSpec[];
    workspace: string;
    onText?: (text: string) => void;
    execute: (call: NativeToolCall) => Promise<{ output: string; isError: boolean }>;
    signal: AbortSignal;
  }): Promise<{ summary: string }>;
}

export interface NativeAgentWorkerConfig {
  id: string;
  label: string;
  /** Builds the provider client lazily so an unused provider never loads an SDK. 延迟构建 Provider 客户端，未使用的 Provider 不会加载 SDK。 */
  createClient: () => NativeModelClient;
  tools: readonly NativeToolSpec[];
  timeoutMs?: number;
}

export type ToolDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * The gate. A tool is offered only when the step's granted scopes cover its
 * risk; a per-call path outside the grants is refused even for an allowed tool.
 * External effects stay refused because there is no action connector yet with
 * a receipt that proves the effect really happened.
 * 闸门。只有当步骤的授权 Scope 覆盖某工具的风险时，该工具才会被提供；即使工具本身被允许，
 * 单次调用中出现授权之外的路径也会被拒绝。外部副作用仍被拒绝，因为目前还没有能用 Receipt
 * 证明副作用确实发生的动作连接器。
 */
export function decideTool(input: {
  risk: NativeToolRisk;
  grants: { readRoots: readonly string[]; writeRoots: readonly string[]; network: boolean };
  path?: string;
  workspace: string;
}): ToolDecision {
  if (input.risk === "external") return { allowed: false, reason: "External side effects require a governed action connector; this worker cannot perform them." };
  if (input.risk === "network" && !input.grants.network) return { allowed: false, reason: "The step was not granted a network scope." };
  if (input.path !== undefined) {
    // Lexical, not canonical: a path that escapes through `..` or a symlink
    // must be refused, not silently resolved back inside.
    // 按字面而非 canonical：通过 `..` 或符号链接逃逸的路径必须被拒绝，而不是被静默解析回内部。
    const target = canonical(resolve(input.workspace, input.path));
    const roots = (input.risk === "write" ? [...input.grants.writeRoots, ...input.grants.readRoots] : [...input.grants.readRoots, ...input.grants.writeRoots])
      .map(canonical);
    const inside = roots.some((root) => target === root || target.startsWith(`${root}/`));
    if (!inside) return { allowed: false, reason: `The path ${target} is outside the step's granted scopes.` };
  }
  return { allowed: true };
}

/** macOS resolves /var to /private/var, so a lexical compare would refuse the workspace itself. 本机 /var 会解析为 /private/var，纯字面比较会把工作区本身也拒掉。 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

export class NativeAgentWorker implements RuntimeAdapter {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly #capabilities: RuntimeCapabilities = {
    resume: false,
    cancellation: true,
    approvalCallback: false,
    parallelAssignments: false,
    work: ["research", "filesystem_read", "filesystem_write"],
  };
  readonly #config: NativeAgentWorkerConfig;

  constructor(config: NativeAgentWorkerConfig) {
    this.#config = config;
    this.id = config.id;
    this.label = config.label;
    this.providerId = config.id;
  }

  capabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve(this.#capabilities);
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    const workspace = resolve(input.workspacePath ?? process.cwd());
    const grants = resolveGrants(input.step.scopes, { workspace });
    const offered = this.#config.tools.filter((tool) => decideTool({ risk: tool.risk, grants, workspace }).allowed);
    const sessionId = randomUUID();
    let lastText = "";
    yield { type: "session_started", sessionId };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Native worker timed out.")), this.#config.timeoutMs ?? (input.workOrder?.budget.maxDurationMs ?? 20 * 60_000));
    try {
      const result = await this.#config.createClient().run({
        instructions: buildInstructions(input, grants.dropped.map((item) => `${item.scope.domain}:${item.scope.resource} (${item.reason})`)),
        tools: offered,
        workspace,
        signal: controller.signal,
        onText: (text) => { lastText = text; },
        execute: async (call) => {
          const tool = offered.find((item) => item.name === call.name);
          if (tool === undefined) {
            // A hallucinated or withdrawn tool is refused, and the loop continues:
            // the model gets the refusal as a tool result instead of a dead run.
            // 幻觉或已撤回的工具会被拒绝，循环继续：模型得到的是工具结果的拒绝，而不是一个死掉的 Run。
            return { output: `Refused: no tool named ${call.name} is available to this step.`, isError: true };
          }
          const decision = decideTool({ risk: tool.risk, grants, workspace, ...(tool.pathOf === undefined ? {} : { path: tool.pathOf(call.input) }) });
          if (!decision.allowed) return { output: `Refused: ${decision.reason}`, isError: true };
          const outcome = await tool.run(call, { workspace });
          return { output: outcome.output, isError: outcome.isError === true };
        },
      });
      if (lastText.length > 0) yield { type: "message_delta", text: lastText };
      yield { type: "completed", summary: result.summary };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const report: FailureReport = {
        providerId: this.id,
        agentId: this.id,
        category: controller.signal.aborted ? "timeout" : "unknown",
        signature: controller.signal.aborted ? "native-worker-timeout" : "native-worker-error",
        detail: message,
      };
      yield { type: "failed", message, report };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Instructions plus the boundary the model must work within. 指令，以及模型必须遵守的边界。 */
export function buildInstructions(input: ExecutionAssignment, dropped: readonly string[]): string {
  const lines = [
    input.workOrder?.objective ?? input.step.instructions,
    "",
    "You may call only the tools provided. Any path outside the workspace or the granted scopes is refused.",
  ];
  if (dropped.length > 0) lines.push(`Scopes the Kernel refused: ${dropped.join("; ")}.`);
  const criteria = input.step.acceptanceCriteria;
  if (criteria.length > 0) lines.push("", "Acceptance criteria:", ...criteria.map((item) => `- ${item}`));
  return lines.join("\n");
}
