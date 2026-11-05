/**
 * What deserves the owner's attention right now, in one ordered list.
 *
 * The pieces already existed but never met: commitments come from the personal
 * state projection, observations from connectors, pending memory candidates and
 * improvement suggestions from their own services. Each lived behind its own
 * API, so the owner had to remember four places to look. A personal agent that
 * never surfaces anything on its own is a search box; this is the surface it
 * uses to speak first.
 *
 * It is a read model, not a new source of truth: every item points at the
 * service and id that owns it, so acting on one goes through that service and
 * its usual rules. Nothing here can approve, promote or execute.
 *
 * 现在值得所有者注意的事情，合成一个有顺序的列表。
 *
 * 零件本来都有，却从不汇合：承诺来自个人状态投影，观察来自 Connector，待审记忆候选与改进建议来自各自的
 * 服务。每一项都藏在自己的 API 后面，所有者得记住四个地方去看。一个从不主动呈现任何东西的个人 Agent
 * 只是搜索框；这里就是它用来先开口的界面。
 *
 * 它是只读模型，不是新的事实来源：每一项都指向拥有它的服务与 id，因此对它采取行动仍走那个服务与其既有
 * 规则。这里没有任何东西能批准、提升或执行。
 */
import type { Commitment, Goal } from "../state/personal-state.ts";
import type { Observation } from "../connectors/connector.ts";
import type { OpportunityCard } from "./opportunity.ts";
import type { PendingSuggestion } from "../improvement/improvement-service.ts";
import type { MemoryCandidate } from "../core/contracts.ts";

export type AttentionKind = "overdue_commitment" | "due_soon_commitment" | "observation" | "memory_candidate" | "improvement_suggestion" | "opportunity";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  /** Why it is here, in one line the owner can act on. 为什么它在这里，一行可供所有者行动的理由。 */
  detail: string;
  /** Where acting on it happens. 采取行动的位置。 */
  action: { service: "promises" | "memory" | "improvement" | "opportunities"; id: string };
  urgency: number;
  /** Whether the item came from outside the twin (mail, calendar) and is untrusted text. 是否来自分身之外（邮件、日历），属于不可信文本。 */
  untrusted?: boolean;
}

export interface AttentionInput {
  commitments?: readonly Commitment[];
  goals?: readonly Goal[];
  observations?: ReadonlyArray<Observation & { connectorId?: string }>;
  candidates?: readonly MemoryCandidate[];
  suggestions?: readonly PendingSuggestion[];
  opportunities?: readonly OpportunityCard[];
  now?: Date;
}

const DAY_MS = 86_400_000;

/**
 * Ordered by urgency, then by kind. Overdue commitments outrank everything:
 * they are promises the owner already made, and the twin exists to keep them.
 * 按紧迫度排序，其次按类型。逾期承诺排在一切之前：它们是所有者已经许下的承诺，而分身存在的意义就是守住它们。
 */
export function buildAttention(input: AttentionInput): AttentionItem[] {
  const now = (input.now ?? new Date()).getTime();
  const items: AttentionItem[] = [];
  const goalTitles = new Map((input.goals ?? []).map((goal) => [goal.id, goal.title]));

  for (const commitment of input.commitments ?? []) {
    if (commitment.status !== "open" || commitment.dueAt === undefined) continue;
    const due = Date.parse(commitment.dueAt);
    if (Number.isNaN(due)) continue;
    const overdue = due < now;
    const soon = !overdue && due - now <= 2 * DAY_MS;
    if (!overdue && !soon) continue;
    items.push({
      id: `commitment:${commitment.id}`,
      kind: overdue ? "overdue_commitment" : "due_soon_commitment",
      title: commitment.title,
      detail: overdue
        ? `Was due ${new Date(due).toISOString().slice(0, 10)}.`
        : `Due ${new Date(due).toISOString().slice(0, 10)}${goalTitles.has(commitment.goalId ?? "") ? ` for ${goalTitles.get(commitment.goalId!)}` : ""}.`,
      action: { service: "promises", id: commitment.id },
      urgency: overdue ? 100 - Math.min(50, Math.floor((now - due) / DAY_MS)) : 60 - Math.floor((due - now) / DAY_MS),
    });
  }

  for (const candidate of input.candidates ?? []) {
    if (candidate.status !== "proposed") continue;
    items.push({
      id: `candidate:${candidate.id}`,
      kind: "memory_candidate",
      title: "A memory needs your review",
      detail: candidate.summary,
      action: { service: "memory", id: candidate.id },
      urgency: 40,
    });
  }

  for (const suggestion of input.suggestions ?? []) {
    items.push({
      id: `suggestion:${suggestion.id}`,
      kind: "improvement_suggestion",
      title: suggestion.title,
      detail: suggestion.rationale,
      action: { service: "improvement", id: suggestion.id },
      urgency: 30,
    });
  }

  for (const opportunity of input.opportunities ?? []) {
    if (opportunity.status !== "proposed") continue;
    items.push({
      id: `opportunity:${opportunity.id}`,
      kind: "opportunity",
      title: opportunity.title,
      detail: opportunity.whyNow,
      action: { service: "opportunities", id: opportunity.id },
      urgency: opportunity.expectedValue === "high" ? 25 : 20,
    });
  }

  for (const observation of input.observations ?? []) {
    items.push({
      id: `observation:${observation.connectorId ?? "unknown"}:${observation.externalId}`,
      kind: "observation",
      title: observation.title,
      detail: observation.body ?? "Observed by a connector.",
      // An observation has no service of its own and no action to take: it
      // exists to be noticed. Pointing it at a service would invent an action
      // the owner never asked for.
      // 观察没有自己的服务，也没有可采取的动作：它的意义就是被注意到。给它指向某个服务，等于凭空
      // 造出一个所有者从未要求的动作。
      action: { service: "opportunities", id: `observation:${observation.externalId}` },
      urgency: 10,
      untrusted: true,
    });
  }

  return items.sort((left, right) => right.urgency - left.urgency || left.title.localeCompare(right.title));
}
