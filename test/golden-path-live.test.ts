/**
 * The golden path with the real model in the loop.
 *
 * The deterministic golden-path test proves the machinery, but the machinery
 * is only half the twin: the other half is the model choosing to call
 * record_state when the owner states an obligation — quoting their words
 * exactly, because the quote check will refuse a paraphrase. That choice is
 * what this test measures. Nothing here is mocked or scripted; a regression
 * in the charter, the tool description, or the quote-check tolerance shows up
 * as a red test, not as a silently less attentive twin.
 *
 * Real model, real cost — enable deliberately:
 *   CLONE_AI_MAIN_LIVE=1 node --experimental-strip-types --test test/golden-path-live.test.ts
 *
 * 带真实模型的黄金路径。
 *
 * 确定性的黄金路径测试证明了机器，但机器只是分身的一半：另一半是模型在所有者声明
 * 一项义务时选择调用 record_state——逐字引用他的话，因为引文核验会拒绝改写。这个
 * 测试测量的正是那个选择。这里没有任何 mock 或脚本；charter、工具描述或引文容差的
 * 退化都会表现为一个红色测试，而不是一个悄悄变得不那么专注的分身。
 *
 * 真实模型、真实费用——需显式开启（见上面的命令）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { createMainAgentSession } from "../src/main-agent/session.ts";
import { mainAgentSessionDirectory } from "../src/main-agent/conversation-history.ts";
import { projectPersonalState } from "../src/state/state-projector.ts";

const enabled = process.env.CLONE_AI_MAIN_LIVE === "1";

test("live: the twin records a stated commitment and remembers it after a restart", { skip: !enabled, timeout: 240_000 }, async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-golden-live-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));

  const { session } = await createMainAgentSession({ dataDirectory });
  t.after(() => session.dispose());
  await session.prompt("记住我每周五要写周报，并帮我准备。");

  // The commitment must exist in the journal — recorded through record_state
  // with a quote that survived verification, or not at all.
  // 承诺必须存在于 Journal——经由 record_state 记录、引文通过了核验，或者根本不存在。
  const journal = createJournalStore(dataDirectory);
  try {
    const events = await journal.list();
    const recorded = events.find((event) => event.type === "state.commitment.recorded");
    assert.ok(recorded !== undefined, "the model must record a commitment the owner stated in plain words");

    const state = projectPersonalState(events);
    const commitment = Object.values(state.commitments)[0]!;
    assert.match(commitment.title, /周报/);
    assert.equal(commitment.provenance.authoredBy, "owner", "the entry is the owner's, with the agent as scribe");

    // A fabricated boundary must NOT be there: the owner said nothing about
    // email, and the quote check is the enforcement.
    // 编造的边界绝不能出现：所有者没提过邮件，而引文核验就是执行者。
    assert.equal(
      events.filter((event) => event.type === "state.self_model.recorded").length,
      0,
      "the model must not record boundaries the owner never stated",
    );
  } finally {
    (journal as { close?: () => void }).close?.();
  }

  // Restart: the next session's briefing is compiled fresh from the journal —
  // the twin that wakes up knows what the twin that slept learned.
  // 重启：下一个会话的简报从 Journal 全新编译——醒来的分身知道睡下的分身学到的东西。
  const restartJournal = createJournalStore(dataDirectory);
  try {
    const briefing = await (await import("../src/main-agent/situation-briefing.ts")).compileBriefing({
      journal: restartJournal,
      dataDirectory,
      workspacePath: process.cwd(),
    });
    assert.match(briefing.text, /周报/, "the situation briefing must carry the commitment into the next session");
  } finally {
    (restartJournal as { close?: () => void }).close?.();
  }
});
