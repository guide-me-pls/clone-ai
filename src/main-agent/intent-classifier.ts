import type { TaskIntent, TaskIntentKind } from "./dispatch-contracts.ts";

/**
 * Turns an owner request into a routable intent using deterministic rules.
 *
 * Routing must never depend on a model call: an explicit "use codex" has to
 * survive verbatim, and a classifier that hallucinated an agent id would let a
 * model silently redirect the owner's work. Everything here is inspectable and
 * reproducible.
 *
 * 用确定性规则把所有者的请求变成可路由的意图。
 *
 * 路由绝不能依赖模型调用：显式的"用 codex"必须原样存活，而会臆造 Agent ID 的分类器
 * 等于让模型悄悄改派所有者的工作。这里的一切都可检查、可复现。
 */

export interface IntentClassifierOptions {
  /** Known worker ids, used to recognise an explicit request. 已知 Worker ID，用于识别显式指定。 */
  knownAgentIds: readonly string[];
}

const KIND_PATTERNS: ReadonlyArray<{ kind: TaskIntentKind; pattern: RegExp }> = [
  { kind: "review", pattern: /\b(review|audit|inspect|critique)\b|审查|复核|评审|检查/i },
  { kind: "research", pattern: /\b(research|investigate|compare|explore|find out)\b|调研|研究|对比|查找/i },
  { kind: "planning", pattern: /\b(plan|design|roadmap|schedule|outline)\b|规划|计划|设计|排期/i },
  { kind: "operations", pattern: /\b(deploy|release|publish|send|migrate|rollback)\b|部署|发布|上线|发送|迁移/i },
  { kind: "coding", pattern: /\b(fix|implement|refactor|code|bug|test|compile|typescript)\b|修复|实现|重构|代码|编译|测试/i },
  // A question is answered, not built. Without this, "explain X" would be
  // routed to a worker that writes files and produce an artifact nobody asked
  // for.
  // 提问是要被回答的，不是要被建造的。没有这一条，"解释 X"会被路由给写文件的 Worker，
  // 产出一个没人要过的产物。
  { kind: "direct", pattern: /\b(explain|what is|why|how does|describe|summar)\w*\b|解释|说明|什么是|为什么|总结/i },
];

/**
 * Intent maps onto the capability vocabulary the dispatcher already uses
 * (see workers/capabilities.ts). Inventing a parallel set here would let an
 * intent match no worker at all — a request nobody can serve, for a reason
 * nobody can see.
 * 意图映射到 Dispatcher 已在使用的能力词汇表（见 workers/capabilities.ts）。在这里另造
 * 一套平行词汇，会让某个意图匹配不到任何 Worker——一个没人能服务、也没人看得出原因的请求。
 */
const CAPABILITY_BY_KIND: Readonly<Record<TaskIntentKind, readonly string[]>> = {
  coding: ["drafting"],
  review: ["review"],
  research: ["research"],
  planning: ["drafting"],
  operations: ["external_action"],
  direct: ["direct_response"],
};

/**
 * Matches "use X" / "用 X" / "让 X 来" against known ids only. An unknown name
 * is not treated as a selection, so a typo becomes a normal capability route
 * rather than a silent dispatch to whatever the text happened to contain.
 * 只在已知 ID 范围内匹配"use X"/"用 X"/"让 X 来"。未知名字不算指定，因此拼写错误会退回
 * 普通能力路由，而不是把文本里碰巧出现的词当成派发目标。
 */
export function classifyIntent(text: string, options: IntentClassifierOptions): TaskIntent {
  const summary = text.trim();
  const explicitAgentId = findExplicitAgent(summary, options.knownAgentIds);
  const excludedAgentIds = findExcludedAgents(summary, options.knownAgentIds, explicitAgentId);
  const kind = detectKind(summary);

  return {
    kind,
    summary,
    requiredCapabilities: CAPABILITY_BY_KIND[kind],
    ...(explicitAgentId === undefined ? {} : { explicitAgentId }),
    excludedAgentIds,
  };
}

function detectKind(text: string): TaskIntentKind {
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  // An unrecognised request is answered rather than built: guessing "write
  // code" would hand a plain question to a worker that edits the workspace.
  // 无法识别的请求按"回答"处理而不是"建造"：猜成写代码会把一个普通问题交给会改动
  // Workspace 的 Worker。
  return "direct";
}

function findExplicitAgent(text: string, knownAgentIds: readonly string[]): string | undefined {
  const lowered = text.toLocaleLowerCase();
  // Longest id first so "pi-agent" wins over a bare "pi" substring.
  // 先匹配最长 ID，使 "pi-agent" 优先于裸 "pi" 子串。
  const candidates = [...knownAgentIds].sort((left, right) => right.length - left.length);
  for (const id of candidates) {
    const needle = id.toLocaleLowerCase();
    const index = lowered.indexOf(needle);
    if (index < 0) continue;
    if (!hasWordBoundary(lowered, index, needle.length)) continue;
    // An id mentioned only inside an exclusion is not a selection.
    // 只出现在排除语境里的 ID 不算指定。
    if (isNegated(lowered, index)) continue;
    return id;
  }
  return undefined;
}

function findExcludedAgents(
  text: string,
  knownAgentIds: readonly string[],
  explicitAgentId: string | undefined,
): string[] {
  const lowered = text.toLocaleLowerCase();
  const excluded: string[] = [];
  for (const id of knownAgentIds) {
    if (id === explicitAgentId) continue;
    const needle = id.toLocaleLowerCase();
    const index = lowered.indexOf(needle);
    if (index < 0 || !hasWordBoundary(lowered, index, needle.length)) continue;
    if (isNegated(lowered, index)) excluded.push(id);
  }
  return excluded;
}

const NEGATION_PATTERN = /(don'?t|do not|never|avoid|without|except|not)\s+(use\s+)?$|不要(用|使用)?\s*$|别(用|使用)?\s*$|除了\s*$/i;

function isNegated(lowered: string, index: number): boolean {
  return NEGATION_PATTERN.test(lowered.slice(Math.max(0, index - 24), index));
}

function hasWordBoundary(text: string, index: number, length: number): boolean {
  const before = index === 0 ? "" : text[index - 1] ?? "";
  const after = text[index + length] ?? "";
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

function isIdentifierChar(character: string): boolean {
  return /[a-z0-9_]/i.test(character);
}
