/**
 * Which Main Agent handles a new request.
 *
 * The owner should not have to choose between "new conversation" and "new
 * task": both were ways to say "start something", and deciding which one
 * creates a Main Agent was the learning cost. Typing inside a conversation is
 * explicit and bypasses this module. A fresh request is routed:
 *
 * - an explicit continuation cue reuses the selected (or latest) conversation;
 * - an explicit new-goal cue, or no conversation at all, starts a new Main
 *   Agent;
 * - an ambiguous request with a selected conversation asks the model once, and
 *   fails open to a new Main Agent.
 *
 * The decision is journaled with its reason and source so the audit can explain
 * it. Keyword rules are deterministic and testable; the model is only the
 * tie-breaker for the ambiguous middle.
 *
 * 由哪个 Main Agent 处理一个新请求。
 *
 * 所有者不该在"新建对话"与"新建任务"之间做选择：两者都只是"开始一件事"的说法，而判断哪一个
 * 会创建 Main Agent 才是学习成本。在对话里输入是显式的，直接绕过本模块。新请求会被路由：
 * 明确的续接线索沿用所选（或最近）对话；明确的新目标线索或没有对话时新开 Main Agent；
 * 有选中对话但语义含糊时只问模型一次，模型不可用则失败即新开。
 *
 * 决定连同理由与来源写入 Journal，使审计能解释它。关键词规则是确定性、可测试的；模型只做
 * 含糊中间地带的裁决者。
 */
import { randomUUID } from "node:crypto";

import { CloneConfigStore } from "../config/clone-config.ts";
import { resolveClonePaths } from "../config/clone-home.ts";
import type { JournalEvent } from "../core/contracts.ts";
import type { JournalStore } from "../core/journal.ts";
import { createJournalStore } from "../core/sqlite-journal.ts";
import { logJson } from "../observability/json-log.ts";
import { conversationIdOf, MAIN_AGENT_DEFAULT_CONVERSATION_ID } from "./conversation.ts";
import { mainAgentRunConversations } from "./run-triggers.ts";
import { readMainAgentTurnRecords, type MainAgentTurnRecord } from "./turn-audit.ts";

export interface RouteContext {
  kind: "task" | "conversation";
  id: string;
}

export type RouteSource = "rule" | "model" | "fallback";

export interface ConversationRoute {
  turnId: string;
  conversationId: string;
  decision: "new" | "continue";
  source: RouteSource;
  reason: string;
  /** The conversation the route considered reusing. 路由曾考虑沿用的对话。 */
  candidateConversationId?: string;
  model?: string;
}

export interface RouteConversationOptions {
  dataDirectory: string;
  text: string;
  turnId?: string;
  context?: RouteContext;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Explicit continuation. Deliberately narrow: a generic "it" or "then" would
 * route unrelated requests into the previous task.
 * 明确的续接。刻意收窄：泛泛的"它"或"然后"会把无关请求路由进上一个任务。
 */
const CONTINUATION_CUE = /(继续|接着|刚才|上次|上一个|那个任务|这个任务|该任务|同一件事|把它|对它|继续做|接着做|continue|carry on|same task|that task|previous task|follow[- ]?up|pick up where)/i;

/** Explicit new goal: this must not be pulled into the selected context. 明确的新目标：不应被拉进所选上下文。 */
const NEW_INTENT_CUE = /(新建|新任务|新项目|新的任务|新目标|另一个任务|另一件事|换个话题|从头开始|重新开始|start over|new task|new project|another task|separate task|different topic)/i;

export async function routeConversation(options: RouteConversationOptions): Promise<ConversationRoute> {
  const turnId = options.turnId ?? randomUUID();
  const text = options.text.trim();
  const records = await readMainAgentTurnRecords(options.dataDirectory).catch(() => []);
  let candidate = await resolveCandidate(options.dataDirectory, options.context, records);
  const continuation = CONTINUATION_CUE.test(text);
  const newIntent = NEW_INTENT_CUE.test(text);
  // A continuation cue with nothing selected still means "that thing we were
  // doing": the most recent conversation is the only sensible referent.
  // 没有选中项但出现续接线索，仍表示"我们在做的那件事"：最近的对话是唯一合理的指代。
  if (candidate === undefined && continuation) candidate = latestConversation(records);

  let decision: "new" | "continue";
  let source: RouteSource;
  let reason: string;
  let model: string | undefined;
  if (candidate === undefined) {
    decision = "new";
    source = "rule";
    reason = "No conversation to continue, so a fresh request starts a new Main Agent.";
  } else if (continuation && !newIntent) {
    decision = "continue";
    source = "rule";
    reason = "The message explicitly continues the selected conversation.";
  } else if (newIntent && !continuation) {
    decision = "new";
    source = "rule";
    reason = "The message explicitly starts a new goal.";
  } else {
    const verdict = await askModel(options, candidate, text, records);
    decision = verdict.decision;
    source = verdict.source;
    reason = verdict.reason;
    model = verdict.model;
  }

  const newConversationId = `conversation-${randomUUID()}`;
  const conversationId = decision === "continue" && candidate !== undefined ? candidate : newConversationId;
  const route: ConversationRoute = {
    turnId,
    conversationId,
    decision,
    source,
    reason,
    ...(candidate === undefined ? {} : { candidateConversationId: candidate }),
    ...(model === undefined ? {} : { model }),
  };
  await recordRoute(options.dataDirectory, text, route);
  return route;
}

async function resolveCandidate(
  dataDirectory: string,
  context: RouteContext | undefined,
  records: readonly MainAgentTurnRecord[],
): Promise<string | undefined> {
  if (context === undefined) return undefined;
  if (context.kind === "conversation") {
    const id = context.id.trim();
    if (id === MAIN_AGENT_DEFAULT_CONVERSATION_ID) return id;
    return records.some((record) => conversationIdOf(record.conversationId) === id) ? id : undefined;
  }
  // A task's trigger names the conversation that asked for it. A task not
  // dispatched by a Main Agent has no candidate.
  // 任务的 Trigger 点名请求它的对话。不是由 Main Agent 派发的任务没有候选。
  const events = await readJournalEvents(dataDirectory);
  return mainAgentRunConversations(events).get(context.id.trim());
}

function latestConversation(records: readonly MainAgentTurnRecord[]): string | undefined {
  const latest = [...records]
    .filter((record) => record.status === "completed")
    .sort((left, right) => Date.parse(right.completedAt ?? right.startedAt) - Date.parse(left.completedAt ?? left.startedAt))
    .at(0);
  return latest === undefined ? undefined : conversationIdOf(latest.conversationId);
}

async function askModel(
  options: RouteConversationOptions,
  candidate: string,
  text: string,
  records: readonly MainAgentTurnRecord[],
): Promise<{ decision: "new" | "continue"; source: RouteSource; reason: string; model?: string }> {
  const endpoint = await resolveRouterEndpoint(options.dataDirectory, options.environment ?? process.env);
  if (endpoint === undefined) {
    return {
      decision: "new",
      source: "fallback",
      reason: "No model endpoint is configured for routing, so an ambiguous request starts a new Main Agent.",
    };
  }
  const history = records
    .filter((record) => conversationIdOf(record.conversationId) === candidate && record.status === "completed")
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    .slice(-3)
    .map((record) => `Owner: ${clip(record.text, 400)}\nMain Agent: ${clip(record.reply ?? "", 400)}`)
    .join("\n\n");
  if (history.length === 0) {
    return {
      decision: "new",
      source: "fallback",
      reason: "The selected conversation has no completed turns to continue.",
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` }),
      },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0,
        max_tokens: 120,
        stream: false,
        messages: [
          {
            role: "system",
            content: "You route one message for a personal agent. Decide whether the new message CONTINUES the selected conversation or starts an INDEPENDENT task with a fresh Main Agent. Continue means it refers to the same goal, deliverable, or an earlier answer. New means a different goal or an unrelated request. Reply only with JSON: {\"continue\": true or false, \"reason\": \"one short sentence\"}.",
          },
          {
            role: "user",
            content: `Selected conversation (latest turns):\n${history}\n\nNew message:\n${clip(text, 2_000)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`router HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = typeof body.choices?.[0]?.message?.content === "string" ? body.choices[0].message.content : "";
    const parsed = parseRouterAnswer(content);
    if (parsed === undefined) throw new Error("router returned no usable JSON");
    return {
      decision: parsed.continue ? "continue" : "new",
      source: "model",
      reason: clip(parsed.reason, 300),
      model: endpoint.model,
    };
  } catch (error: unknown) {
    logJson("warn", "conversation router fell back to a new Main Agent", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      decision: "new",
      source: "fallback",
      reason: "The routing model was unavailable, so an ambiguous request starts a new Main Agent.",
      model: endpoint.model,
    };
  }
}

function parseRouterAnswer(content: string): { continue: boolean; reason: string } | undefined {
  const match = content.match(/\{[\s\S]*\}/);
  if (match === null) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { continue?: unknown; reason?: unknown };
    if (typeof parsed.continue !== "boolean") return undefined;
    return { continue: parsed.continue, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return undefined;
  }
}

async function resolveRouterEndpoint(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ baseUrl: string; model: string; apiKey?: string } | undefined> {
  let persisted: { baseUrl?: string; model?: string; apiKey?: string } = {};
  try {
    const config = await new CloneConfigStore(resolveClonePaths({ dataDirectory })).get();
    persisted = {
      ...(config.mainAgentBaseUrl === undefined ? {} : { baseUrl: config.mainAgentBaseUrl }),
      ...(config.mainAgentModel === undefined ? {} : { model: config.mainAgentModel }),
      ...(config.mainAgentApiKey === undefined ? {} : { apiKey: config.mainAgentApiKey }),
    };
  } catch {
    // An unreadable config is "nothing persisted", not a routing failure.
    // 读不了配置等于"没有持久值"，不是路由失败。
  }
  const baseUrl = nonEmpty(environment.CLONE_AI_NATIVE_BASE_URL) ?? persisted.baseUrl;
  const model = nonEmpty(environment.CLONE_AI_NATIVE_MODEL) ?? persisted.model;
  const apiKey = nonEmpty(environment.CLONE_AI_NATIVE_API_KEY) ?? persisted.apiKey;
  if (baseUrl === undefined || model === undefined) return undefined;
  return {
    baseUrl,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

async function recordRoute(dataDirectory: string, text: string, route: ConversationRoute): Promise<void> {
  let journal: JournalStore | undefined;
  try {
    journal = createJournalStore(dataDirectory);
    await journal.append({
      type: "conversation.routed",
      payload: {
        schemaVersion: 1,
        turnId: route.turnId,
        input: clip(text, 2_000),
        decision: route.decision,
        conversationId: route.conversationId,
        ...(route.candidateConversationId === undefined ? {} : { candidateConversationId: route.candidateConversationId }),
        source: route.source,
        reason: route.reason,
        ...(route.model === undefined ? {} : { model: route.model }),
      },
    });
  } catch (error: unknown) {
    logJson("warn", "conversation route could not be journaled", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    (journal as { close?: () => void } | undefined)?.close?.();
  }
}

async function readJournalEvents(dataDirectory: string): Promise<JournalEvent[]> {
  const journal = createJournalStore(dataDirectory);
  try {
    return await journal.list();
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
