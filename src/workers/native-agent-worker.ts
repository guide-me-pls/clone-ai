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

import type { ExecutionAssignment, ExecutionEvent, ModelUsage, RuntimeAdapter, RuntimeCapabilities } from "../core/contracts.ts";
import type { FailureReport } from "../core/failure-analysis.ts";
import { resolveGrants } from "../authority/path-gateway.ts";
import {
  runAgentLoop,
  type AgentMessage,
  type AgentModel,
  type AgentToolSpec,
} from "../agent/loop.ts";
import { systemPrompt } from "./native-worker-prompt.ts";

export type NativeToolRisk = "read" | "write" | "network" | "external";

export interface NativeToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface NativeToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input, sent to providers that use tool calling. 供使用 tool calling 的 Provider 使用的 JSON Schema。 */
  parameters?: Record<string, unknown>;
  risk: NativeToolRisk;
  /** Path of a file the call reads or writes; checked against the step's grants. 调用读写文件的路径，与步骤的授权核对。 */
  pathOf?: (input: Record<string, unknown>) => string | undefined;
  run: (call: NativeToolCall, context: { workspace: string }) => Promise<{ output: string; isError?: boolean }>;
}

/**
 * The worker's model adapter. The shared kernel owns the loop; this interface
 * is exactly one completion per call.
 * Worker 的模型适配器。共享内核拥有循环；这个接口每次只做一次 completion。
 */
export type NativeModelClient = AgentModel;

export interface NativeAgentWorkerConfig {
  id: string;
  label: string;
  /** Provider id recorded on executions; defaults to `id`. 执行记录中的 Provider id；缺省等于 `id`。 */
  providerId?: string;
  /** Routing vocabulary for the agent role. External actions are always removed. Agent 角色的路由词汇；外部动作始终被移除。 */
  workCapabilities?: readonly string[];
  /** Builds the provider client lazily so an unused provider never loads an SDK. 延迟构建 Provider 客户端，未使用的 Provider 不会加载 SDK。 */
  createClient: () => NativeModelClient;
  tools: readonly NativeToolSpec[];
  timeoutMs?: number;
}

const DEFAULT_NATIVE_WORK = ["research", "filesystem_read", "filesystem_write"] as const;

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
    // Root first, then resolve: the workspace may itself sit behind a symlink
    // (/tmp -> /private/tmp on macOS), and canonicalising the target but not the
    // workspace would refuse every path inside it.
    // 先规范化根再解析：工作区本身可能位于符号链接之后（macOS 上 /tmp -> /private/tmp），
    // 只规范化目标而不规范化工作区，会把其中每条路径都拒掉。
    const root = canonical(input.workspace);
    const target = resolve(root, input.path);
    const roots = (input.risk === "write" ? [...input.grants.writeRoots, ...input.grants.readRoots] : [...input.grants.readRoots, ...input.grants.writeRoots])
      .map((grantRoot) => canonical(resolve(canonical(input.workspace), grantRoot)));
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
  readonly #capabilities: Omit<RuntimeCapabilities, "work"> = {
    resume: false,
    cancellation: true,
    approvalCallback: false,
    parallelAssignments: false,
  };
  readonly #config: NativeAgentWorkerConfig;

  constructor(config: NativeAgentWorkerConfig) {
    this.#config = config;
    this.id = config.id;
    this.label = config.label;
    this.providerId = config.providerId ?? config.id;
  }

  capabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve({
      ...this.#capabilities,
      work: [...(this.#config.workCapabilities ?? DEFAULT_NATIVE_WORK)].filter((capability) => capability !== "external_action"),
    });
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    const workspace = resolve(input.workspacePath ?? process.cwd());
    const grants = resolveGrants(input.step.scopes, { workspace });
    const offered = this.#config.tools.filter((tool) => decideTool({ risk: tool.risk, grants, workspace }).allowed);
    const sessionId = randomUUID();
    yield { type: "session_started", sessionId };

    const controller = new AbortController();
    const timeoutMs = this.#config.timeoutMs ?? (input.workOrder?.budget.maxDurationMs ?? 20 * 60_000);
    const timeout = setTimeout(() => controller.abort(new Error("Native worker timed out.")), timeoutMs);
    const budget = input.workOrder?.budget;
    const startedAt = Date.now();
    // Artifacts the worker actually touched, reported as evidence. Without this
    // the verifier sees a run that "did nothing", even when files landed.
    // Worker 实际触碰的产物，作为证据上报。没有它，即使文件已落盘，验证器也会认为
    // 这次运行"什么都没做"。
    const produced = new Map<string, { kind: "artifact" | "observation"; summary: string; locator: string }>();
    // Paths the task explicitly names. A failed read of one is a missing input,
    // not a guess the model should work around.
    // 任务明确点名的路径。读取它们失败意味着输入缺失，而不是模型应当绕过的猜测。
    const requiredText = [input.workOrder?.objective ?? "", input.step.instructions, ...input.step.acceptanceCriteria].join("\n");
    const missingInputs = new Set<string>();
    try {
      const instructions = buildInstructions(input, grants.dropped.map((item) => `${item.scope.domain}:${item.scope.resource} (${item.reason})`));
      const messages: AgentMessage[] = [
        { role: "system", content: systemPrompt(instructions, offered) },
        { role: "user", content: instructions },
      ];
      const result = await runAgentLoop({
        model: this.#config.createClient(),
        tools: offered.map((tool) => agentTool(tool, workspace, produced, missingInputs, requiredText)),
        messages,
        maxRounds: budget?.maxModelCalls ?? 12,
        ...(budget?.maxToolCalls === undefined ? {} : { maxToolCalls: budget.maxToolCalls }),
        maxDurationMs: timeoutMs,
        signal: controller.signal,
        authorize: (request) => {
          const tool = offered.find((item) => item.name === request.call.name);
          if (tool === undefined) {
            return { behavior: "deny" as const, reason: `No tool named ${request.call.name} is available to this step.` };
          }
          const decision = decideTool({
            risk: tool.risk,
            grants,
            workspace,
            ...(tool.pathOf === undefined ? {} : { path: tool.pathOf(request.input) }),
          });
          return decision.allowed
            ? { behavior: "allow" as const }
            : { behavior: "deny" as const, reason: decision.reason };
        },
        toolResultBudget: { perResultChars: 8_000, totalChars: 32_000 },
      });
      const usage: ModelUsage = { ...result.usage, durationMs: Math.max(0, Date.now() - startedAt) };

      if (missingInputs.size > 0) {
        const detail = `Required input missing: ${[...missingInputs].join(", ")}`;
        yield {
          type: "failed",
          message: detail,
          report: {
            providerId: this.providerId,
            agentId: this.id,
            category: "no_artifact",
            signature: "native-missing-input",
            detail,
          },
          usage,
        };
        return;
      }
      if (result.terminalReason === "budget_exhausted") {
        const message = result.error ?? "The native worker reached a budget limit.";
        yield {
          type: "failed",
          message,
          report: {
            providerId: this.providerId,
            agentId: this.id,
            category: "budget_exceeded",
            signature: budgetSignature(message),
            detail: message,
          },
          usage,
        };
        return;
      }
      if (result.terminalReason === "model_error") {
        const message = result.error ?? "The native worker's model call failed.";
        yield {
          type: "failed",
          message,
          report: {
            providerId: this.providerId,
            agentId: this.id,
            category: "unknown",
            signature: "native-worker-error",
            detail: message,
          },
          usage,
        };
        return;
      }
      if (result.terminalReason === "aborted") {
        const message = result.error ?? "The native worker was cancelled.";
        yield {
          type: "failed",
          message,
          report: {
            providerId: this.providerId,
            agentId: this.id,
            category: "timeout",
            signature: "native-worker-timeout",
            detail: message,
          },
          usage,
        };
        return;
      }
      if (result.terminalReason === "max_turns" && budget?.maxModelCalls !== undefined) {
        const message = result.error ?? `The worker reached its ${budget.maxModelCalls}-model-call budget.`;
        yield {
          type: "failed",
          message,
          report: {
            providerId: this.providerId,
            agentId: this.id,
            category: "budget_exceeded",
            signature: "budget-model-calls",
            detail: message,
          },
          usage,
        };
        return;
      }

      if (result.reply.length > 0) yield { type: "message_delta", text: result.reply };
      for (const item of [...produced.values()].slice(0, 20)) {
        yield { type: "evidence", evidence: item };
      }
      yield {
        type: "completed",
        summary: result.reply.trim().length > 0 ? result.reply : "The native worker finished without a final message.",
        usage,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = controller.signal.aborted;
      const report: FailureReport = {
        providerId: this.providerId,
        agentId: this.id,
        category: timedOut ? "timeout" : "unknown",
        signature: timedOut ? "native-worker-timeout" : "native-worker-error",
        detail: message,
      };
      yield { type: "failed", message, report };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Adapt one worker tool to the shared loop. Tool gating is the loop's
 * `authorize` callback; this wrapper only runs the tool and tracks evidence.
 * 把一个 Worker 工具适配到共享循环。工具闸门是循环的 `authorize` 回调；这个包装只执行
 * 工具并追踪证据。
 */
function agentTool(
  tool: NativeToolSpec,
  workspace: string,
  produced: Map<string, { kind: "artifact" | "observation"; summary: string; locator: string }>,
  missingInputs: Set<string>,
  requiredText: string,
): AgentToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    parallelSafe: tool.risk === "read",
    run: async (input) => {
      const outcome = await tool.run({ name: tool.name, input }, { workspace });
      if (outcome.isError !== true && tool.pathOf !== undefined) {
        const path = tool.pathOf(input);
        if (path !== undefined && !produced.has(path)) {
          produced.set(path, {
            kind: tool.risk === "write" ? "artifact" : "observation",
            summary: tool.risk === "write" ? `${tool.name} wrote ${path}` : `${tool.name} read ${path}`,
            locator: path,
          });
        }
      }
      if (outcome.isError === true && tool.risk === "read" && tool.pathOf !== undefined) {
        const failedPath = tool.pathOf(input);
        if (failedPath !== undefined && requiredText.includes(failedPath)) missingInputs.add(failedPath);
      }
      return { content: outcome.output, isError: outcome.isError === true };
    },
  };
}

/** Classify a budget failure for the Kernel's comparable failure report. 为 Kernel 的可比较失败报告归类预算失败。 */
function budgetSignature(message: string): string {
  if (/tool[- ]call/i.test(message)) return "budget-tool-calls";
  if (/token/i.test(message)) return "budget-tokens";
  if (/duration|ms budget|timed? out/i.test(message)) return "budget-duration";
  if (/round|model[- ]call/i.test(message)) return "budget-model-calls";
  return "budget-exceeded";
}

/** Instructions plus the boundary the model must work within. 指令，以及模型必须遵守的边界。 */
export function buildInstructions(input: ExecutionAssignment, dropped: readonly string[]): string {
  const lines = [
    input.workOrder?.objective ?? input.step.instructions,
    "",
    "You may call only the tools provided. Any path outside the workspace or the granted scopes is refused.",
    "If a file named in these instructions is missing or unreadable, stop and report it. Do not invent its contents.",
  ];
  if (dropped.length > 0) lines.push(`Scopes the Kernel refused: ${dropped.join("; ")}.`);
  const criteria = input.step.acceptanceCriteria;
  if (criteria.length > 0) lines.push("", "Acceptance criteria:", ...criteria.map((item) => `- ${item}`));
  return lines.join("\n");
}
