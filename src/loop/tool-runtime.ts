import { randomUUID } from "node:crypto";

import type {
  ToolDefinition,
  ToolExecution,
  ToolReceipt,
  ToolReconcileResult,
  ToolResult,
  ToolAuthorization,
  ToolPolicy,
} from "./contracts.ts";
import { ToolRegistry } from "./tools.ts";

export interface ToolRuntimeOptions {
  defaultTimeoutMs?: number;
  policy?: ToolPolicy;
}

/**
 * The only layer allowed to execute a Tool. It attaches a stable operation ID,
 * constrains execution time, exposes cancellation, and provides a conservative
 * recovery answer for an interrupted operation.
 *
 * 唯一允许执行 Tool 的层。它附加稳定 Operation ID、限制执行时间、支持取消，并为中断操作提供
 * 保守的恢复结论。
 */
export class ToolRuntime {
  readonly #tools: ToolRegistry;
  readonly #defaultTimeoutMs: number;
  readonly #active = new Map<string, AbortController>();
  readonly #policy: ToolPolicy;

  constructor(tools: ToolRegistry, options: ToolRuntimeOptions = {}) {
    this.#tools = tools;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#policy = options.policy ?? new LocalToolPolicy();
  }

  createOperationId(): string {
    return randomUUID();
  }

  authorize(execution: ToolExecution): ToolAuthorization {
    const definition = this.#tools.get(execution.call.name);
    if (definition === undefined) {
      return { outcome: "denied", reason: `Unknown tool: ${execution.call.name}` };
    }
    return this.#policy.authorize({ execution, definition });
  }

  async execute(execution: ToolExecution, timeoutMs = this.#defaultTimeoutMs): Promise<{ result: ToolResult; receipt: ToolReceipt }> {
    const tool = this.#tools.get(execution.call.name);
    if (tool === undefined) {
      const result = { ok: false, content: `Unknown tool: ${execution.call.name}` };
      return { result, receipt: receiptFor(execution.operationId, result) };
    }

    const controller = new AbortController();
    this.#active.set(execution.operationId, controller);
    const timeout = setTimeout(() => controller.abort(new Error(`Tool timed out after ${timeoutMs}ms.`)), timeoutMs);
    try {
      const result = await tool.execute(execution.call.arguments, {
        operationId: execution.operationId,
        signal: controller.signal,
      });
      return { result, receipt: receiptFor(execution.operationId, result) };
    } catch (error: unknown) {
      const result = { ok: false, content: error instanceof Error ? error.message : String(error) };
      return { result, receipt: receiptFor(execution.operationId, result) };
    } finally {
      clearTimeout(timeout);
      this.#active.delete(execution.operationId);
    }
  }

  async cancel(operationId: string): Promise<boolean> {
    const controller = this.#active.get(operationId);
    if (controller === undefined) {
      return false;
    }
    controller.abort(new Error("Tool cancelled by runtime."));
    return true;
  }

  async reconcile(execution: ToolExecution): Promise<ToolReconcileResult> {
    const tool = this.#tools.get(execution.call.name);
    if (tool === undefined) {
      return { status: "unknown", reason: `Unknown tool: ${execution.call.name}` };
    }
    if (tool.risk === undefined || tool.risk === "read_only") {
      // Repeating a read is safe. The resume runner may execute it again.
      // 重复读取是安全的；恢复 Runner 可以再次执行它。
      return { status: "not_started" };
    }
    if (tool.reconcile === undefined) {
      return { status: "unknown", reason: `Tool ${execution.call.name} has no recovery reconciliation handler.` };
    }
    return tool.reconcile(execution);
  }
}

/**
 * Safe default while no user-configured standing policy exists.
 * 用户尚未配置长期 Policy 时使用的安全默认值。
 */
export class LocalToolPolicy implements ToolPolicy {
  authorize(input: { execution: ToolExecution; definition: ToolDefinition }): ToolAuthorization {
    switch (input.definition.risk ?? "read_only") {
      case "read_only":
      case "reversible_write":
        return { outcome: "allowed" };
      case "external_side_effect":
        return { outcome: "approval_required", reason: `${input.execution.call.name} affects an external system.` };
      case "irreversible":
        return { outcome: "denied", reason: `${input.execution.call.name} is irreversible and needs an explicit policy implementation.` };
    }
  }
}

function receiptFor(operationId: string, result: ToolResult): ToolReceipt {
  return {
    operationId,
    status: result.ok ? "completed" : "failed",
    evidence: [{ kind: "observation", summary: result.content }],
  };
}
