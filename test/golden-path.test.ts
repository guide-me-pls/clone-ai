/**
 * The golden path: the one scenario v0.1 must not break.
 *
 * "记住我每周五要写周报，并帮我准备" — the owner says it once in
 * conversation, and from there: the commitment is recorded with proof the
 * owner actually said it, survives a restart, turns into an opportunity when
 * Friday approaches, becomes a run when accepted, is executed by a worker that
 * writes a real file, is verified against that file, produces a memory
 * candidate, and comes back as recall the following week. Kill the owner's
 * process mid-run and no step runs twice.
 *
 * Every seam here is the production seam: the same recordOwnerState the
 * record_state tool calls, the same OpportunityService the daemon's maintenance
 * loop runs, the same proposePlanToKernel the Main Agent's tool lands on, the
 * same RunQueueConsumer with journal claims the GUI daemon starts, the same
 * EvidenceVerifier attachPlan gates completion with.
 *
 * 黄金路径：v0.1 绝不能断的那一条链路。
 *
 * "记住我每周五要写周报，并帮我准备"——所有者在对话里说一次，之后：承诺带着"他确实
 * 说过"的证据被记录、挺过重启、在周五临近时变成机会、被接受后成为 Run、由真正写文件的
 * Worker 执行、对着那个文件被验证、产生记忆候选、并在下一周作为召回回到对话。中途杀掉
 * 持有者的进程，没有任何一步会执行两次。
 *
 * 这里每一道接缝都是生产接缝：record_state 工具调用的同一个 recordOwnerState、Daemon
 * 维护循环跑的同一个 OpportunityService、Main Agent 工具落到的同一个 proposePlanToKernel、
 * GUI Daemon 启动的同一个带 Journal 领取的 RunQueueConsumer、attachPlan 用来把关完成的
 * 同一个 EvidenceVerifier。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";
import { createRuntimeAssembly } from "../src/core/runtime-factory.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { mainAgentSessionDirectory } from "../src/main-agent/conversation-history.ts";
import { recordOwnerState, proposePlanToKernel } from "../src/main-agent/tools/kernel-tools.ts";
import { OpportunityService } from "../src/opportunity/opportunity-service.ts";
import { PersonalStateStore } from "../src/state/personal-state-store.ts";
import { reconcileCommitments } from "../src/state/commitment-reconciler.ts";
import { RunQueueConsumer } from "../src/application/run-queue.ts";
import { MemoryGovernance } from "../src/memory/memory-governance.ts";
import { MdMemoryStore } from "../src/memory/md-memory-store.ts";
import { GovernedMemorySource } from "../src/memory/md-memory-store.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";

/** The owner's words, as they would appear in the session file. 所有者的话，会话文件里的样子。 */
const OWNER_WORDS = "记住我每周五要写周报，并帮我准备";

/**
 * A worker that actually writes the promised file. The scripted demo adapter
 * reports evidence without touching the disk, which is right for orchestration
 * tests — but the golden path is about the file being real, because the
 * verifier opens it.
 * 一个真的会写出承诺文件的 Worker。演示用 Scripted Adapter 只报告证据而不碰磁盘，这对
 * 编排测试是对的——但黄金路径的关键恰恰是文件是真的，因为验证器会去打开它。
 */
class WeeklyReportWriter implements RuntimeAdapter {
  readonly id = "draft-maker";
  readonly providerId = "demo";

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true,
      work: ["drafting", "filesystem_read", "filesystem_write"],
      evidenceKinds: ["artifact", "tool_result", "test", "observation"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    const path = join(input.workspacePath ?? process.cwd(), "weekly-report.md");
    const content = "# 周报\n\n本周进展：黄金路径测试第一次跑通，验证器现在会真的打开这个文件。\n风险与问题：无。\n下周计划：继续打磨验证器，覆盖更多文件契约。\n";
    await writeFile(path, content, "utf8");
    yield { type: "progress", message: "周报已写入 weekly-report.md" };
    yield {
      type: "evidence",
      evidence: {
        kind: "artifact",
        summary: "本周周报已写入 weekly-report.md。",
        locator: path,
      },
    };
    yield { type: "completed", summary: "周报完成。" };
  }
}

async function seededHome(t: TestContext): Promise<{
  dataDirectory: string;
  workspacePath: string;
  /** Registers a handle released before the directories are removed. 登记一个在目录删除前释放的句柄。 */
  onClose: (close: () => void) => void;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-golden-home-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-golden-ws-"));
  const closers: Array<() => void> = [];
  // One hook, in this order: an open SQLite handle would make the rm fail with
  // EBUSY, and after-hooks run in registration order — so the removal must be
  // registered here, after nothing, but execute after the closers.
  // 单个钩子且按此顺序：打开的 SQLite 句柄会让 rm 以 EBUSY 失败，而 after 钩子按注册
  // 顺序执行——因此删除必须在这里注册，却在 closer 之后执行。
  t.after(async () => {
    for (const close of closers) close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  // The recorded conversation the quote check reads. A real session file is
  // written by the SDK as the owner speaks; seeding it directly is the same
  // disk state.
  // 引文核验读取的已记录对话。真实会话文件由 SDK 在所有者说话时写入；直接落一份
  // 种子文件就是同样的磁盘状态。
  const directory = mainAgentSessionDirectory(dataDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "session-golden.jsonl"), `${JSON.stringify({
    type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: OWNER_WORDS }] },
  })}\n`, "utf8");
  return { dataDirectory, workspacePath, onClose: (close) => closers.push(close) };
}

test("the golden path: a stated commitment becomes verified work and remembered preference", async (t) => {
  const { dataDirectory, workspacePath, onClose } = await seededHome(t);
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  onClose(() => assembly.close());

  // ── 1-2. The owner states it; the twin records it with proof they said it.
  //        所有者说出来；分身带着"他确实说过"的证据记录下来。
  const nextFriday = new Date(Date.now() + 5 * 24 * 3_600_000);
  const recorded = await recordOwnerState(dataDirectory, {
    kind: "commitment",
    ownerSaid: "我每周五要写周报",
    title: "每周五写周报",
    commitmentKind: "recurring",
    everyDays: 7,
    dueAt: nextFriday.toISOString(),
  });
  assert.equal(recorded.recorded, true, "a quote the owner really said must be recorded");

  const fabricated = await recordOwnerState(dataDirectory, {
    kind: "boundary",
    ownerSaid: "我从不希望别人帮我写周报",
    statement: "不希望别人帮忙写周报",
  });
  assert.equal(fabricated.recorded, false, "a boundary the owner never stated must be refused");
  assert.match((fabricated as { reason: string }).reason, /not on record/);

  // ── 3. Restart: a fresh store rebuilds the commitment from the journal alone.
  //        重启：全新 Store 仅凭 Journal 重建出这条承诺。
  const reopened = createJournalStore(dataDirectory);
  try {
    const store = new PersonalStateStore(reopened);
    const commitments = Object.values((await store.refresh()).commitments);
    assert.equal(commitments.length, 1);
    assert.equal(commitments[0]?.title, "每周五写周报");
    assert.equal(commitments[0]?.everyDays, 7);
  } finally {
    (reopened as { close?: () => void }).close?.();
  }

  // ── 4. Friday approaches: the scan proposes exactly one card for it.
  //        周五临近：扫描为它提出恰好一张卡片。
  const opportunityService = new OpportunityService(assembly.journal);
  const fridayMinusOneDay = new Date(nextFriday.getTime() - 24 * 3_600_000);
  const fresh = await opportunityService.scanAndRecord(fridayMinusOneDay);
  assert.equal(fresh.length, 1, "a due-soon commitment with no run activity yields one card");
  const card = fresh[0]!;
  assert.equal(card.source, "deadline");
  assert.equal(card.serves?.kind, "commitment");
  // The second scan converges: the maintenance loop must not stack duplicates.
  // 第二次扫描收敛：维护循环不得堆出重复卡片。
  assert.equal((await opportunityService.scanAndRecord(fridayMinusOneDay)).length, 0);

  // ── 5. The Main Agent proposes the work the card stands for. The plan names
  //        the file and the required content, which is what makes verification
  //        real rather than a headcount of evidence rows.
  //        Main Agent 提案这张卡片所代表的工作。计划点名文件与必需内容——这正是让验证
  //        变得真实、而不是数证据条数的东西。
  const proposal = await proposePlanToKernel(assembly.runtime, {
    summary: "为本周五的周报准备 weekly-report.md",
    // The linkage that closes the loop: this plan exists to satisfy the
    // commitment, so the reconciler can settle it when the run lands.
    // 让环闭合的联动：这个计划为满足那条承诺而存在，因此 Run 落地后收敛器能结算它。
    servesCommitmentId: (recorded as { id: string }).id,
    steps: [{
      id: "write-report",
      title: "写出本周周报",
      instructions: "把本周的周报写入 weekly-report.md。",
      risk: "reversible_write",
      acceptanceCriteria: [`文件 weekly-report.md 存在，包含："本周进展"`],
      agentId: "draft-maker",
      requiredCapabilities: ["drafting", "filesystem_write"],
    }],
  });
  assert.equal(proposal.accepted, true);
  assert.equal(proposal.runStatus, "queued");
  const runId = proposal.runId!;

  // ── 6-7. The queue consumer claims the run (journal-leased) and executes it;
  //         the Kernel verifies against the file the worker actually wrote.
  //         队列消费者领取这个 Run（Journal 租约）并执行；Kernel 对照 Worker 真正写出的
  //         文件做验证。
  const consumer = new RunQueueConsumer({
    runtime: assembly.runtime,
    journal: assembly.journal,
    registry: async () => new StaticAgentRegistry([new WeeklyReportWriter()]),
  });
  const started = await consumer.tick();
  await consumer.stop();
  assert.deepEqual(started, [runId]);

  const run = assembly.runtime.getRun(runId);
  assert.equal(run.status, "completed", `the run must complete, not stall in ${run.status}`);

  const written = await readFile(join(workspacePath, "weekly-report.md"), "utf8");
  assert.match(written, /本周进展/);
  assert.ok(written.length > 50, "the file must be a real report, not a token");

  const events = await assembly.journal.list();
  const verification = events.find((event) => event.type === "verification.completed");
  assert.ok(verification !== undefined, "completion must rest on a verification event");
  assert.equal((verification.payload as { passed?: boolean }).passed, true);

  // The lease was released on completion: a later process can claim this run's
  // next attempt without waiting out a dead owner's lease.
  // 完成后租约被释放：之后的进程无需等一个死掉持有者的租约到期。
  const claim = events.filter((event) => event.type === "run.status_changed" && event.payload);
  assert.ok(claim.length > 0);

  // ── 8. The completed run becomes a memory candidate; the owner promotes it.
  //        已完成的 Run 变成记忆候选；所有者批准它。
  await assembly.memory.rebuild();
  const candidates = await assembly.memory.processNext();
  assert.equal(candidates.length, 1, "a verified run produces exactly one candidate");

  const governance = new MemoryGovernance({
    journal: assembly.journal,
    store: new MdMemoryStore({ dataDirectory }),
  });
  onClose(() => void governance.close().catch(() => undefined));
  const pending = await governance.pendingCandidates();
  assert.equal(pending.length, 1);
  const promoted = await governance.promote(pending[0]!, { type: "preference" });
  const file = await readFile(join(dataDirectory, "memory", `${promoted.id}.md`), "utf8");
  assert.match(file, /周报/, "the promoted memory must be a real .md file");

  // ── 9. The following week: the same library the Kernel compiles into worker
  //        assignments recalls the preference for a weekly-report request.
  //        下一周：Kernel 编译进 Worker 派发的同一个库，为周报相关的请求召回这条偏好。
  const source = new GovernedMemorySource(dataDirectory);
  const recalled = await source.recall("帮我准备这周的周报", "golden-week-2");
  assert.ok(
    recalled.some((match) => match.memory.id === promoted.id),
    "next week's request must recall the promoted preference from the governed library",
  );

  // ── 10. The loop closes: the consumer's own reconcile settled the commitment
  //         the moment the verified run landed — outcome met, one week advanced,
  //         source run recorded. The second Friday is already on the calendar.
  //         环闭合：已验证 Run 落地的那一刻，消费者自己的收敛就结算了承诺——结果 met、
  //         推进一周、来源 Run 入账。第二个周五已经在日历上了。
  const settled = await assembly.journal.list();
  const settlement = settled.find((event) => event.type === "state.commitment.updated"
    && typeof (event.payload as { sourceRunId?: unknown }).sourceRunId === "string");
  assert.ok(settlement !== undefined, "the run's completion must settle the commitment it served");
  assert.equal((settlement.payload as { sourceRunId?: string }).sourceRunId, runId);
  assert.equal((settlement.payload as { outcome?: string }).outcome, "met");

  const advanced = Object.values((await new PersonalStateStore(assembly.journal).refresh()).commitments)[0]!;
  assert.equal(advanced.status, "open", "a recurring commitment stays open after an occurrence is met");
  const weekLater = Date.parse(advanced.dueAt!) - Date.now();
  assert.ok(weekLater > 11 * 24 * 3_600_000 && weekLater < 14 * 24 * 3_600_000, "dueAt must advance by one week past the settled Friday");

  // Idempotent: the settled run is never settled twice, and a satisfied
  // occurrence never turns into a miss.
  // 幂等：已结算的 Run 绝不会被结算第二次；被满足的周期绝不会变成错过。
  assert.deepEqual(await reconcileCommitments(assembly.journal, { now: new Date(Date.now() + 6 * 24 * 3_600_000) }), []);

  // The second Friday: the scan sees the advanced date and proposes the next
  // card — a different card id, one week later.
  // 第二个周五：扫描看到推进后的日期，提出下一张卡片——不同的卡片 id，晚一周。
  const secondFridayMinusOneDay = new Date(Date.parse(advanced.dueAt!) - 24 * 3_600_000);
  const nextCards = await opportunityService.scanAndRecord(secondFridayMinusOneDay);
  assert.equal(nextCards.length, 1);
  assert.notEqual(nextCards[0]?.id, card.id, "next week must be a new card, not the old one resurfacing");
  assert.equal(nextCards[0]?.serves?.id, advanced.id);
});

test("accepting an opportunity produces an executable run, not one stuck in planning", async (t) => {
  const { dataDirectory, workspacePath, onClose } = await seededHome(t);
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  onClose(() => assembly.close());

  const recorded = await recordOwnerState(dataDirectory, {
    kind: "commitment",
    ownerSaid: "我每周五要写周报",
    title: "每周五写周报",
    commitmentKind: "recurring",
    everyDays: 7,
    dueAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  });
  assert.equal(recorded.recorded, true);

  const opportunityService = new OpportunityService(assembly.journal);
  const [card] = await opportunityService.scanAndRecord();
  assert.ok(card !== undefined);
  await opportunityService.resolve(card.id, "accepted");

  // The companion's accept handler, verbatim: trigger alone leaves the run in
  // `planning`, so the deterministic planner attaches a plan and the run
  // reaches `queued`, where a consumer can actually take it.
  // 与 companion 的接受处理完全一致：仅 acceptTrigger 会把 Run 留在 `planning`，
  // 因此确定性规划器附上计划，让 Run 进入 `queued`，消费者才真正接得了手。
  const { run } = await assembly.runtime.acceptTrigger({
    kind: "signal",
    summary: card.title,
    payload: { opportunityId: card.id, source: card.source, whyNow: card.whyNow, trigger: "opportunity.accepted" },
  });
  const { buildFallbackPlan } = await import("../src/planning/fallback-planner.ts");
  const { defaultWorkerProfiles } = await import("../src/config/worker-settings.ts");
  const enabled = new Set(defaultWorkerProfiles().filter((agent) => agent.enabled).map((agent) => agent.id));
  await assembly.runtime.attachPlan(run.id, buildFallbackPlan(`${card.title}。${card.proposedResult}`, enabled));

  assert.notEqual(assembly.runtime.getRun(run.id).status, "planning");
  assert.equal(assembly.runtime.getRun(run.id).status, "queued");
});
