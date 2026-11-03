/**
 * Optional live check: a model must not turn its interpretation of an owner's
 * words into confirmed personal state without an independent review path.
 * Real model, real cost: enable explicitly with CLONE_AI_MAIN_LIVE=1.
 * 可选的真实模型检查：在没有独立审核通道时，模型不能把对用户话语的解释写成已确认的
 * 个人状态。会产生真实费用，需显式设置 CLONE_AI_MAIN_LIVE=1。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { createMainAgentSession } from "../src/main-agent/session.ts";

const enabled = process.env.CLONE_AI_MAIN_LIVE === "1";

test("live: the twin does not save model-proposed commitments as owner-confirmed", { skip: !enabled, timeout: 240_000 }, async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-golden-live-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  const { session } = await createMainAgentSession({ dataDirectory });
  t.after(() => session.dispose());
  await session.prompt("记住我每周五要写周报，并帮我准备。");
  const journal = createJournalStore(dataDirectory);
  try {
    const events = await journal.list();
    assert.equal(events.some((event) => event.type === "state.commitment.recorded" || event.type === "state.self_model.recorded" || event.type === "state.goal.recorded"), false);
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});
