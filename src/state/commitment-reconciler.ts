/**
 * The reconcile loop: the twin's controller for stated obligations.
 *
 * A Kubernetes controller reads desired state, observes real state, computes
 * the difference, acts safely, and looks again. That is the shape a digital
 * twin needs for "I write a weekly report every Friday": the commitment is the
 * desired state, the workspace is the real state, and the loop is what makes
 * the second Friday happen after the first one is done.
 *
 * Concretely, one pass:
 *
 *   desired:   open commitments projected from the journal
 *   observed:  runs that were planned to serve them, their verification
 *              outcome, and — re-checked now, not at completion time — whether
 *              the artifact files still exist on disk
 *   diff:      a completed+verified run whose commitment is still open; or a
 *              recurring commitment whose occurrence has passed unsatisfied
 *   act:       settle — mark met, or advance to the next occurrence
 *   again:     the next call re-reads the journal and finds nothing to do
 *
 * Idempotency is the load-bearing property. Every entry point may call this —
 * after a run lands, on the maintenance timer, from the CLI — because a
 * settlement already recorded is never recorded twice: the settling event
 * carries the source run id, and a pass that finds it skips.
 *
 * 收敛环：分身对已声明义务的控制器。
 *
 * Kubernetes Controller 读取期望状态、观察真实状态、计算差异、安全执行、再看一眼。
 * 数字分身对“我每周五写周报”需要的正是这个形状：承诺是期望状态，工作区是真实状态，
 * 而这个环正是让第二个周五在第一个周五完成之后依然会到来的东西。
 *
 * 具体而言，一次扫描：
 *
 *   期望：从 Journal 投影出的未结承诺
 *   观察：为它们而规划的 Run、其验证结果，以及——现在重新检查而非沿用完成时刻的——
 *         产物文件是否仍在磁盘上
 *   差异：已完成且已验证、但承诺仍未结算的 Run；或某次周期已过而未满足的周期性承诺
 *   动作：结算——标记 met，或推进到下一次
 *   再看：下一次调用重读 Journal，发现无事可做
 *
 * 幂等是承重性质。任何入口都可以调用它——Run 落地之后、维护定时器、CLI——因为已记录
 * 的结算不会被记录第二次：结算事件携带来源 Run id，再次读到它的扫描会跳过。
 */
import { stat } from "node:fs/promises";

import type { JournalStore } from "../core/journal.ts";
import { PersonalStateStore } from "./personal-state-store.ts";
import { projectPersonalState } from "./state-projector.ts";
import type { Commitment } from "./personal-state.ts";

export interface CommitmentSettlement {
  commitmentId: string;
  /** How the occurrence was settled. 这次周期是如何被结算的。 */
  outcome: "met" | "missed" | "artifact-gone";
  /** The run whose completion settled it, when one did. 结算它的那个 Run（若有）。 */
  sourceRunId?: string;
  /** New due date for recurring commitments. 周期性承诺的新到期时间。 */
  dueAt?: string;
}

export async function reconcileCommitments(
  journal: JournalStore,
  options: { now?: Date } = {},
): Promise<CommitmentSettlement[]> {
  const now = options.now ?? new Date();
  const events = await journal.list();
  const state = projectPersonalState(events);

  // Which run was planned to serve which commitment — the linkage the plan
  // itself carries. A plan without it serves a request, not an obligation.
  // 哪个 Run 被规划来满足哪个承诺——联动关系由计划本身携带。没有它的计划服务的是
  // 一次请求，而不是一项义务。
  const servingPlanByRun = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "plan.created" || event.runId === undefined) continue;
    const serves = (event.payload as { servesCommitmentId?: unknown }).servesCommitmentId;
    if (typeof serves === "string") servingPlanByRun.set(event.runId, serves);
  }

  // Terminal runs and their verification verdicts. 终态 Run 与其验证结论。
  const completedRuns = new Set<string>();
  for (const event of events) {
    if (event.type !== "run.status_changed" || event.runId === undefined) continue;
    if ((event.payload as { status?: unknown }).status === "completed") completedRuns.add(event.runId);
  }
  const verifiedRuns = new Set<string>();
  for (const event of events) {
    if (event.type !== "verification.completed" || event.runId === undefined) continue;
    if ((event.payload as { passed?: unknown }).passed === true) verifiedRuns.add(event.runId);
  }

  // Settlements already applied, keyed by run: the dedup that makes repeated
  // calls free. 已应用的结算，按 Run 索引：正是这个去重让重复调用没有代价。
  const settledRuns = new Set<string>();
  for (const event of events) {
    if (event.type !== "state.commitment.updated") continue;
    const sourceRunId = (event.payload as { sourceRunId?: unknown }).sourceRunId;
    if (typeof sourceRunId === "string") settledRuns.add(sourceRunId);
  }

  // File locators recorded as evidence, for the re-observation. Note the
  // locators are per run, not per commitment: a run may serve only one
  // commitment, so its evidence is that commitment's observation.
  // 作为证据记录的文件定位符，供再观察使用。注意定位符按 Run 而不是按承诺归组：
  // 一个 Run 只服务一个承诺，因此它的证据就是那个承诺的观察结果。
  const locatorsByRun = new Map<string, string[]>();
  for (const event of events) {
    if (event.type !== "evidence.recorded" || event.runId === undefined) continue;
    const locator = (event.payload as { locator?: unknown }).locator;
    if (typeof locator !== "string" || locator.length === 0) continue;
    // Only absolute filesystem paths are re-checkable. A locator with a scheme
    // (demo://, https://) is a reference, not a file on this machine; a
    // relative path is ambiguous by the time another process reads it. For
    // those, the completion-time verification remains the observation of record.
    // 只有绝对文件系统路径可以复查。带协议的定位符（demo://、https://）是引用而非
    // 本机文件；相对路径在另一个进程读它时已有歧义。对它们，完成时刻的验证仍是
    // 记录在案的观察。
    if (!isAbsolutePath(locator) || locator.includes("://")) continue;
    const list = locatorsByRun.get(event.runId) ?? [];
    list.push(locator);
    locatorsByRun.set(event.runId, list);
  }

  const store = new PersonalStateStore(journal);
  const settlements: CommitmentSettlement[] = [];

  for (const commitment of Object.values(state.commitments)) {
    if (commitment.status !== "open") continue;

    // A completed, verified, not-yet-settled run serves this commitment?
    // 有没有已完成、已验证、且尚未结算的 Run 在服务这个承诺？
    const servingRun = [...servingPlanByRun.entries()]
      .filter(([runId, serves]) => serves === commitment.id && completedRuns.has(runId) && !settledRuns.has(runId))
      .map(([runId]) => runId)
      .at(0);

    if (servingRun !== undefined && verifiedRuns.has(servingRun)) {
      // Re-observe: the verifier checked the file when the run finished; the
      // controller checks it again now. A report that has been deleted since
      // did happen, but it is not the current state — the obligation stays
      // open, which is exactly the difference between "done once" and
      // "satisfied".
      // 再观察：验证器在 Run 结束时检查过文件；控制器现在再检查一次。之后被删掉的
      // 周报确实存在过，但它不是当前状态——义务保持未结，这恰好是“做过一次”与
      // “被满足”之间的差别。
      const locators = locatorsByRun.get(servingRun) ?? [];
      const gone = (await Promise.all(locators.map((path) => stat(path).then(() => false, () => true))))
        .some((missing) => missing);
      if (gone) {
        settlements.push({ commitmentId: commitment.id, outcome: "artifact-gone", sourceRunId: servingRun });
        continue;
      }

      const next = nextOccurrence(commitment, now);
      await store.settleCommitment({
        id: commitment.id,
        outcome: "met",
        reason: next === undefined ? "completed by a verified run" : "occurrence met; advanced to the next",
        sourceRunId: servingRun,
        ...(next === undefined ? {} : { dueAt: next }),
      });
      settlements.push({
        commitmentId: commitment.id,
        outcome: "met",
        sourceRunId: servingRun,
        ...(next === undefined ? {} : { dueAt: next }),
      });
      continue;
    }
    // A completed-but-unverified run falls through to the missed check: work
    // without proof does not satisfy an occurrence, and the recurrence must
    // still move — with the miss on record, so the journal says why.
    // 完成但未验证的 Run 落入 missed 检查：没有证明的工作不满足任何周期，而周期仍必须
    // 向前走——错过入账，让 Journal 写明原因。

    // No serving run. A recurring commitment whose occurrence has passed must
    // still move forward — otherwise one missed week silently cancels every
    // future one, and the twin stops asking forever. The miss is recorded, not
    // hidden: the settlement says the occurrence was missed. A satisfied
    // occurrence never reaches here — its settlement already advanced the date.
    // 没有服务的 Run。某次周期已过的周期性承诺仍必须向前走——否则错过一周就静默
    // 取消未来所有周，分身从此不再问。错过被记录而不是被藏起来：结算会写明该次未满足。
    // 已被满足的周期绝不会走到这里——它的结算已经推进了日期。
    if (commitment.everyDays !== undefined && commitment.dueAt !== undefined
      && Date.parse(commitment.dueAt) <= now.getTime()) {
      const next = nextOccurrence(commitment, now);
      if (next !== undefined) {
        await store.settleCommitment({
          id: commitment.id,
          outcome: "missed",
          reason: "occurrence passed without a completed serving run",
          dueAt: next,
        });
        settlements.push({ commitmentId: commitment.id, outcome: "missed", dueAt: next });
      }
    }
  }

  return settlements;
}

/**
 * The next occurrence: at least one step past the current due date, then
 * forward until strictly after `now`. The guaranteed step is what separates
 * the two settlements: work done early for this Friday discharges this
 * Friday and moves to the next one immediately — it does not leave the
 * satisfied occurrence sitting due until it "misses" a week later.
 *
 * 下一次出现：从当前到期日起至少推进一步，再前进到严格晚于 now。这一步保证正是两种
 * 结算的分界：为本周五提前完成的工作即刻免除本周五并移到下一周——它不会让已被满足的
 * 周期继续挂在那里，直到一周后"错过"。
 */
function nextOccurrence(commitment: Commitment, now: Date): string | undefined {
  if (commitment.everyDays === undefined || commitment.dueAt === undefined) return undefined;
  const step = commitment.everyDays * 24 * 3_600_000;
  const start = Date.parse(commitment.dueAt);
  if (Number.isNaN(start)) return undefined;
  let due = start;
  do {
    due += step;
  } while (due <= now.getTime());
  return new Date(due).toISOString();
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
