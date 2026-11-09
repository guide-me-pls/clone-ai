/**
 * Applying a review action: a small, reversible configuration change.
 *
 * The whitelist here is the whole safety boundary. An action may set the Main
 * Agent's model or effort — nothing else. Each application writes
 * `recommendation.applied` with the previous value first, so a revert is a
 * matter of putting one field back, and the journal can always answer who
 * changed what, on whose click, and from which review.
 *
 * 应用评审动作：一次小型、可撤销的配置改动。
 *
 * 这份白名单就是全部安全边界。动作只能设置 worker 或主 Agent 的模型与推理强度，别的都不行。
 * 每次应用先把改动前的值写入 `recommendation.applied`，因此撤销就是把一个字段放回去；
 * Journal 永远能回答：谁、在哪次评审下、因哪次点击、把什么改成了什么。
 */
import { join } from "node:path";

import type { JournalStore } from "../core/journal.ts";
import { CloneConfigStore } from "../config/clone-config.ts";
import { resolveClonePaths } from "../config/clone-home.ts";
import type { ReviewAction, SelfReview } from "./self-review.ts";
import { loadReview } from "./self-review.ts";
import { writeJsonAtomic } from "../config/json-file.ts";

export interface AppliedReviewAction {
  action: ReviewAction;
  from?: string;
  to: string;
  at: string;
}

export async function applyReviewAction(
  dataDirectory: string,
  journal: JournalStore,
  actionId: string,
): Promise<AppliedReviewAction> {
  const review = await requireReview(dataDirectory);
  const action = review.actions.find((candidate) => candidate.id === actionId);
  if (action === undefined) throw new Error("This action is not part of the current review.");

  const from = await currentValue(dataDirectory, action);
  await writeValue(dataDirectory, action, action.value);
  const at = new Date().toISOString();
  await journal.append({
    type: "recommendation.applied",
    payload: { actionId: action.id, kind: action.kind, ...(action.providerId === undefined ? {} : { target: action.providerId }), from: from ?? null, to: action.value, reviewGeneratedAt: review.generatedAt },
  });
  action.from = from;
  action.appliedAt = at;
  await writeJsonAtomic(join(dataDirectory, "audit-review.json"), review);
  return { action, ...(from === undefined ? {} : { from }), to: action.value, at };
}

export async function revertReviewAction(
  dataDirectory: string,
  journal: JournalStore,
  actionId: string,
): Promise<AppliedReviewAction> {
  const review = await requireReview(dataDirectory);
  const action = review.actions.find((candidate) => candidate.id === actionId);
  if (action === undefined) throw new Error("This action is not part of the current review.");
  if (action.appliedAt === undefined) throw new Error("This action has not been applied.");
  const from = action.from;
  // A revert restores the recorded previous value; when there was none, it clears
  // the field the action set. 撤销恢复记录下来的旧值；原本没有值时就清空该字段。
  await clearOrRestore(dataDirectory, action, from);
  const at = new Date().toISOString();
  await journal.append({
    type: "recommendation.applied",
    payload: { actionId: action.id, kind: action.kind, ...(action.providerId === undefined ? {} : { target: action.providerId }), from: action.value, to: from ?? null, reverted: true },
  });
  const applied: AppliedReviewAction = { action, ...(from === undefined ? {} : { from: action.value }), to: from ?? "", at };
  delete action.from;
  delete action.appliedAt;
  await writeJsonAtomic(join(dataDirectory, "audit-review.json"), review);
  return applied;
}

async function requireReview(dataDirectory: string): Promise<SelfReview> {
  const review = await loadReview(dataDirectory);
  if (review === undefined) throw new Error("There is no review yet. Generate one first.");
  return review;
}

async function currentValue(dataDirectory: string, action: ReviewAction): Promise<string | undefined> {
  if (action.kind === "main-agent-effort" || action.kind === "main-agent-model") {
    const config = await new CloneConfigStore(resolveClonePaths({ dataDirectory })).get();
    return action.kind === "main-agent-effort" ? config.mainAgentEffort : config.mainAgentModel;
  }
  throw new Error(`Unknown review action ${action.kind}.`);
}

async function writeValue(dataDirectory: string, action: ReviewAction, value: string): Promise<void> {
  if (action.kind === "main-agent-effort" || action.kind === "main-agent-model") {
    const store = new CloneConfigStore(resolveClonePaths({ dataDirectory }));
    if (action.kind === "main-agent-effort") await store.update({ mainAgentEffort: value as never });
    else await store.update({ mainAgentModel: value });
    return;
  }
  throw new Error(`Unknown review action ${action.kind}.`);
}

async function clearOrRestore(dataDirectory: string, action: ReviewAction, from: string | undefined): Promise<void> {
  if (from !== undefined) return writeValue(dataDirectory, action, from);
  if (action.kind === "main-agent-effort" || action.kind === "main-agent-model") {
    const store = new CloneConfigStore(resolveClonePaths({ dataDirectory }));
    if (action.kind === "main-agent-effort") await store.update({ mainAgentEffort: undefined });
    else await store.update({ mainAgentModel: "" });
    return;
  }
}