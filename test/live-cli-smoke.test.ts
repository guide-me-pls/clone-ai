import assert from "node:assert/strict";
import test from "node:test";

import { CodingCliAdapter } from "../src/adapters/coding-cli-adapter.ts";
import type { ExecutionAssignment, ExecutionEvent } from "../src/core/contracts.ts";

// Live smoke tests call the real installed CLI with real credentials and real
// cost, so they never run in the default suite. Enable them deliberately:
//   CLONE_AI_LIVE_SMOKE=1 node --experimental-strip-types --test test/live-cli-smoke.test.ts
// 真实冒烟测试会调用真实安装的 CLI、真实凭据并产生真实费用，因此永远不进默认套件。
// 需要时显式开启（见上面的命令）。
const enabled = process.env.CLONE_AI_LIVE_SMOKE === "1";

test("live: claude-code answers a read-only prompt through the supervised boundary", { skip: !enabled }, async () => {
  const adapter = new CodingCliAdapter({
    id: "live-claude",
    providerId: "claude-code",
    workCapabilities: ["implementation"],
  });

  const events: ExecutionEvent[] = [];
  for await (const event of adapter.execute(assignment())) events.push(event);

  const failed = events.filter((event) => event.type === "failed");
  const completed = events.find((event) => event.type === "completed");
  assert.ok(completed, `expected completion, got failures: ${JSON.stringify(failed)}`);
  assert.ok(completed.type === "completed" && completed.summary.trim().length > 0);
});

function assignment(): ExecutionAssignment {
  const createdAt = new Date().toISOString();
  return {
    run: { id: "live-run", taskId: "live-task", status: "running", createdAt, updatedAt: createdAt },
    task: {
      id: "live-task",
      triggerId: "live-trigger",
      title: "Live smoke",
      objective: "Confirm the live protocol boundary works.",
      acceptanceCriteria: ["A reply exists"],
      createdAt,
    },
    step: {
      id: "live-step",
      title: "Reply",
      instructions: "Reply with exactly: SMOKE_OK. Do not use any tools.",
      risk: "read_only",
      acceptanceCriteria: ["A reply exists"],
      agentId: "live-claude",
      requiredCapabilities: ["implementation"],
    },
    executor: { agentId: "live-claude", providerId: "claude-code" },
  };
}
