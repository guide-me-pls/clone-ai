import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createKernelRuntime } from "../src/main-agent/kernel-tools.ts";
import { createMainAgentSession } from "../src/main-agent/session.ts";

// Phase B acceptance, live: one natural-language request must travel
// Main Agent -> propose_work_plan -> Kernel validation -> journaled Run+Plan,
// with the Main Agent unable to self-certify anything. Real model, real cost —
// enable deliberately:
//   CLONE_AI_MAIN_LIVE=1 node --experimental-strip-types --test test/main-agent-live.test.ts
// 阶段 B 验收（真实版）：一句自然语言必须走完 Main Agent → propose_work_plan →
// Kernel 校验 → Run+Plan 落入 Journal，且 Main Agent 无法自证任何事。
// 真实模型、真实费用——需显式开启（见上面的命令）。
const enabled = process.env.CLONE_AI_MAIN_LIVE === "1";

test("live: a natural-language request becomes a Kernel-accepted plan", { skip: !enabled }, async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-main-live-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));

  const { session } = await createMainAgentSession({
    dataDirectory,
    sessionManager: SessionManager.inMemory(),
  });

  try {
    await session.prompt([
      "Propose a work plan for: review the repository README and summarize its risks.",
      "Use exactly one step: id 'review', risk read_only, agentId 'demo-researcher', requiredCapabilities ['research'],",
      "acceptance criteria ['A risk summary exists']. Then report the runId.",
    ].join(" "));
  } finally {
    session.dispose();
  }

  // The proof lives in the Kernel's journal, not in the agent's words.
  // 证据在 Kernel 的 Journal 里，而不在 Agent 的话语里。
  const runtime = await createKernelRuntime(dataDirectory);
  const runs = runtime.listRuns();
  const accepted = runs.filter((run) => run.planId !== undefined);
  assert.ok(accepted.length >= 1, `expected an accepted plan; runs: ${JSON.stringify(runs)}`);
  assert.equal(accepted[0]?.status, "queued");
});
