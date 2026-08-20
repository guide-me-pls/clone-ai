import assert from "node:assert/strict";
import test from "node:test";

import {
  DefaultToolPolicy,
  ToolAuthority,
  type AuthorizedTool,
  type ToolExecution,
} from "../src/core/tool-authority.ts";

function execution(name: string): ToolExecution {
  return { runId: "run-1", call: { id: "call-1", name, arguments: {} }, operationId: "op-1" };
}

test("a cooperative tool is cancelled by its stable operation id", async () => {
  let observedSignal: AbortSignal | undefined;
  const tool: AuthorizedTool = {
    name: "wait",
    async execute(_args, context) {
      observedSignal = context.signal;
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: false, content: "cancelled" };
    },
  };
  const authority = new ToolAuthority([tool]);

  const running = authority.execute({ ...execution("wait"), operationId: "op-cancel" });
  // Give the tool a turn to register its listener before cancelling.
  // 先让 Tool 有机会注册监听，再执行取消。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await authority.cancel("op-cancel"), true);

  const { result } = await running;
  assert.equal(result.ok, false);
  assert.equal(observedSignal?.aborted, true);
  // An unknown id is reported rather than silently succeeding.
  // 未知 ID 会被如实报告，而不是静默成功。
  assert.equal(await authority.cancel("op-missing"), false);
});

test("a tool that ignores its deadline is still stopped", async () => {
  const tool: AuthorizedTool = {
    name: "slow",
    async execute(_args, context) {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: false, content: "timed out" };
    },
  };
  const authority = new ToolAuthority([tool], { defaultTimeoutMs: 50 });

  const { result, receipt } = await authority.execute(execution("slow"));
  assert.equal(result.ok, false);
  assert.equal(receipt.status, "failed");
});

test("risk decides authorization, and an unknown tool is denied", () => {
  const tools: AuthorizedTool[] = [
    { name: "read", risk: "read_only", execute: async () => ({ ok: true, content: "" }) },
    { name: "write", risk: "reversible_write", execute: async () => ({ ok: true, content: "" }) },
    { name: "send", risk: "external_side_effect", execute: async () => ({ ok: true, content: "" }) },
    { name: "wipe", risk: "irreversible", execute: async () => ({ ok: true, content: "" }) },
  ];
  const authority = new ToolAuthority(tools, { policy: new DefaultToolPolicy() });

  assert.equal(authority.authorize(execution("read")).outcome, "allowed");
  assert.equal(authority.authorize(execution("write")).outcome, "allowed");
  assert.equal(authority.authorize(execution("send")).outcome, "approval_required");
  assert.equal(authority.authorize(execution("wipe")).outcome, "denied");
  assert.equal(authority.authorize(execution("ghost")).outcome, "denied");
});

test("recovery repeats a read but refuses to assume an external write did nothing", async () => {
  const tools: AuthorizedTool[] = [
    { name: "read", risk: "read_only", execute: async () => ({ ok: true, content: "" }) },
    { name: "send", risk: "external_side_effect", execute: async () => ({ ok: true, content: "" }) },
    {
      name: "send-with-receipt",
      risk: "external_side_effect",
      execute: async () => ({ ok: true, content: "" }),
      reconcile: async () => ({
        status: "completed",
        result: { ok: true, content: "already delivered" },
        receipt: { operationId: "op-1", status: "completed", evidence: [] },
      }),
    },
  ];
  const authority = new ToolAuthority(tools);

  // Replaying a read is safe.
  // 重放读取是安全的。
  assert.deepEqual(await authority.reconcile(execution("read")), { status: "not_started" });

  // An external write with no reconciliation handler must not be guessed at.
  // 没有对账处理器的外部写入不能靠猜。
  const unknown = await authority.reconcile(execution("send"));
  assert.equal(unknown.status, "unknown");

  const reconciled = await authority.reconcile(execution("send-with-receipt"));
  assert.equal(reconciled.status, "completed");
});

test("duplicate tool names are rejected at construction", () => {
  const duplicate: AuthorizedTool = { name: "same", execute: async () => ({ ok: true, content: "" }) };
  assert.throws(() => new ToolAuthority([duplicate, duplicate]), /Duplicate tool name/);
});
