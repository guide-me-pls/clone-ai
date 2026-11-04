/**
 * Self-review: the system reads its own audit and proposes bounded changes.
 *
 * This is deliberately not "the model edits itself". The reviewer sees one
 * digest — pass rate, failure mix, gateway errors, the owner's labels — and may
 * answer with findings and a short list of **configuration** actions. Every
 * action is validated against what the machine actually supports, applied only
 * when the owner clicks, journaled with its before/after value, and reversible.
 * Code, prompts, policy and evidence rules are out of reach on purpose: an agent
 * that can widen its own authority is not an improvement loop, it is a risk.
 *
 * 自我评审：系统读自己的审计，提出有边界的改动。
 *
 * 这里刻意不是"模型改自己"。评审者只看到一份摘要——通过率、失败构成、网关错误、所有者的
 * 判定——并回答发现项与一小串**配置**动作。每个动作都会对照机器实际支持的能力校验，只在
 * 所有者点击时应用，记录前后值，且可撤销。代码、提示词、策略与证据规则故意不可及：能自己
 * 扩大权限的 Agent 不是改进回路，而是风险。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

import { loadAudits, summarizeAudits } from "./audit-service.ts";
import type { RunAuditRecord } from "./run-audit.ts";
import { listEffectiveProviderConfigs } from "../config/provider-config-store.ts";
import { CloneConfigStore } from "../config/clone-config.ts";
import { resolveClonePaths } from "../config/clone-home.ts";
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel } from "../workers/effort.ts";
import type { JournalStore } from "../core/journal.ts";

export type ReviewActionKind = "provider-effort" | "provider-model" | "main-agent-effort" | "main-agent-model";

export interface ReviewFinding {
  severity: "high" | "medium" | "low";
  area: string;
  evidence: string;
  recommendation: string;
}

export interface ReviewAction {
  id: string;
  kind: ReviewActionKind;
  providerId?: string;
  value: string;
  title: string;
  reason: string;
  /** Value before this action, filled when it is applied. 应用时填入的改动前值。 */
  from?: string;
  appliedAt?: string;
}

export interface SelfReview {
  generatedAt: string;
  summary: string;
  findings: ReviewFinding[];
  actions: ReviewAction[];
  model?: string;
  /** False when the model was unavailable; the review then carries only measured facts. 模型不可用时为 false，此时只有实测事实。 */
  ai: boolean;
  error?: string;
}

const REVIEW_FILE = "audit-review.json";
const MAX_DIGEST_CHARS = 12_000;

export interface SelfReviewOptions {
  /** Model call, injectable so the parsing and validation are testable without a network. 模型调用，可注入，使解析与校验无需网络即可测试。 */
  ask?: (system: string, prompt: string, dataDirectory: string) => Promise<string>;
  now?: Date;
}

export async function runSelfReview(
  dataDirectory: string,
  journal: JournalStore,
  options: SelfReviewOptions = {},
): Promise<SelfReview> {
  const records = await loadAudits(journal, { gateway: true });
  const summary = summarizeAudits(records);
  const providers = await listEffectiveProviderConfigs(dataDirectory);
  const config = await new CloneConfigStore(resolveClonePaths({ dataDirectory })).get();
  const digest = buildDigest(records, summary, providers, config);

  let reply: string | undefined;
  let error: string | undefined;
  try {
    reply = await (options.ask ?? askModel)(REVIEW_SYSTEM, digest, dataDirectory);
  } catch (caught: unknown) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const parsed = reply === undefined ? undefined : parseReview(reply);
  const model = config.mainAgentModel;
  const review: SelfReview = parsed === undefined
    ? {
        generatedAt: (options.now ?? new Date()).toISOString(),
        summary: error === undefined
          ? fallbackSummary(summary)
          : `AI 评审不可用（${error}）。下面是实测数据，未生成建议。`,
        findings: [],
        actions: [],
        ...(model === undefined ? {} : { model }),
        ai: false,
        ...(error === undefined ? {} : { error }),
      }
    : {
        generatedAt: (options.now ?? new Date()).toISOString(),
        summary: parsed.summary,
        findings: parsed.findings,
        actions: validateActions(parsed.actions, providers, model),
        ...(model === undefined ? {} : { model }),
        ai: true,
      };
  await saveReview(dataDirectory, review);
  return review;
}

export async function loadReview(dataDirectory: string): Promise<SelfReview | undefined> {
  try {
    return JSON.parse(await readFile(join(dataDirectory, REVIEW_FILE), "utf8")) as SelfReview;
  } catch {
    return undefined;
  }
}

async function saveReview(dataDirectory: string, review: SelfReview): Promise<void> {
  const { writeJsonAtomic } = await import("../config/json-file.ts");
  await writeJsonAtomic(join(dataDirectory, REVIEW_FILE), review);
}

const REVIEW_SYSTEM = [
  "You are the operations reviewer for a local personal-agent runtime.",
  "You receive measured facts about recent runs: pass rate, failure stages and categories,",
  "model-gateway errors, durations, costs, and the owner's own pass/fail labels.",
  "Reply with ONE JSON object and nothing else:",
  '{"summary": string, "findings": [{"severity":"high|medium|low","area":string,"evidence":string,"recommendation":string}],',
  ' "actions": [{"kind":"provider-effort|provider-model|main-agent-effort|main-agent-model","providerId":string?,"value":string,"title":string,"reason":string}]}',
  "Rules:",
  "- Base every finding on the supplied facts, not on guesses. Quote the number or error you used.",
  "- Actions are configuration only and are applied by the owner with one click; propose at most 4.",
  "- provider-effort values must be in that provider's effortLevels; main-agent-effort likewise.",
  "- provider-model / main-agent-model only when a concrete model id appears in the facts.",
  "- Never propose code, prompt, policy, permission or evidence changes.",
  "- If the facts are too thin to justify a change, return an empty actions array and say so.",
].join("\n");

async function askModel(system: string, prompt: string, dataDirectory: string): Promise<string> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: dataDirectory,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => system,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    resourceLoader,
    noTools: "all",
    sessionManager: SessionManager.inMemory(dataDirectory),
  });
  let reply = "";
  let failure: string | undefined;
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const assistant = event.message as { stopReason?: string; errorMessage?: string };
      if (assistant.stopReason === "error") failure = assistant.errorMessage?.trim() || "The reviewer model ended with an error.";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      reply += event.assistantMessageEvent.delta;
    }
  });
  try {
    await session.prompt(prompt);
  } finally {
    session.dispose();
  }
  if (reply.trim().length === 0 && failure !== undefined) throw new Error(failure);
  return reply;
}

function buildDigest(
  records: readonly RunAuditRecord[],
  summary: ReturnType<typeof summarizeAudits>,
  providers: Awaited<ReturnType<typeof listEffectiveProviderConfigs>>,
  config: Awaited<ReturnType<CloneConfigStore["get"]>>,
): string {
  const failures = records
    .filter((record) => record.status === "failed")
    .slice(-10)
    .map((record) => ({
      runId: record.runId.slice(0, 8),
      title: record.taskTitle ?? record.objective ?? "",
      stage: record.outcome.failureStage,
      category: record.outcome.failureCategory,
      reason: (record.outcome.reason ?? "").slice(0, 300),
      providers: [...new Set(record.executions.map((execution) => execution.providerId).filter(Boolean))],
      gatewayErrors: record.executions.flatMap((execution) => execution.gatewayUsage?.errorSamples ?? []).slice(0, 2),
    }));
  const labelled = records
    .filter((record) => record.label !== undefined && (record.status === "completed" || record.status === "failed"))
    .slice(-10)
    .map((record) => ({ runId: record.runId.slice(0, 8), status: record.status, label: record.label!.verdict, note: record.label!.note ?? "" }));
  const digest = {
    generatedAt: new Date().toISOString(),
    totals: {
      runs: summary.runs,
      passRate: summary.passRate,
      averageDurationMs: summary.averageDurationMs,
      costUsd: summary.totals.costUsd,
      gatewayErrors: summary.totals.gatewayErrors,
    },
    byFailureStage: summary.byFailureStage,
    byFailureCategory: summary.byFailureCategory,
    byProvider: summary.byProvider,
    evaluation: summary.evaluation,
    providerConfig: providers.map((provider) => ({
      id: provider.id,
      model: provider.model ?? null,
      effort: provider.effort ?? null,
      effortLevels: provider.efforts ?? null,
      sandbox: provider.sandbox ?? null,
    })),
    mainAgent: { model: config.mainAgentModel ?? null, effort: config.mainAgentEffort ?? null },
    failures,
    labels: labelled,
  };
  const text = JSON.stringify(digest, null, 1);
  return text.length <= MAX_DIGEST_CHARS ? text : `${text.slice(0, MAX_DIGEST_CHARS)}\n…(cut)`;
}

function fallbackSummary(summary: ReturnType<typeof summarizeAudits>): string {
  const rate = summary.passRate === null ? "未知" : `${Math.round(summary.passRate * 100)}%`;
  return `共 ${summary.runs} 次运行，通过率 ${rate}；失败阶段 ${JSON.stringify(summary.byFailureStage)}。AI 评审未生成建议。`;
}

interface ParsedReview {
  summary: string;
  findings: ReviewFinding[];
  actions: Array<{ kind: ReviewActionKind; providerId?: string; value: string; title: string; reason: string }>;
}

function parseReview(reply: string): ParsedReview | undefined {
  const first = reply.indexOf("{");
  const last = reply.lastIndexOf("}");
  if (first === -1 || last <= first) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(reply.slice(first, last + 1));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) return undefined;
  const findings: ReviewFinding[] = Array.isArray(record.findings)
    ? record.findings.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const item = entry as Record<string, unknown>;
        const raw = item.severity;
        const severity: ReviewFinding["severity"] = raw === "high" || raw === "medium" ? raw : "low";
        const area = typeof item.area === "string" ? item.area : "";
        const evidence = typeof item.evidence === "string" ? item.evidence : "";
        const recommendation = typeof item.recommendation === "string" ? item.recommendation : "";
        if (recommendation.length === 0) return [];
        return [{ severity, area: area.slice(0, 80), evidence: evidence.slice(0, 300), recommendation: recommendation.slice(0, 300) }];
      }).slice(0, 8)
    : [];
  const actions: ParsedReview["actions"] = Array.isArray(record.actions)
    ? record.actions.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const item = entry as Record<string, unknown>;
        const kind: ReviewActionKind | undefined = item.kind === "provider-effort" || item.kind === "provider-model" || item.kind === "main-agent-effort" || item.kind === "main-agent-model"
          ? item.kind
          : undefined;
        if (kind === undefined) return [];
        if (typeof item.value !== "string" || item.value.trim().length === 0 || item.value.length > 120) return [];
        if (/[\r\n]/.test(item.value)) return [];
        return [{
          kind,
          ...(typeof item.providerId === "string" ? { providerId: item.providerId } : {}),
          value: item.value.trim(),
          title: (typeof item.title === "string" ? item.title : item.value).slice(0, 120),
          reason: (typeof item.reason === "string" ? item.reason : "").slice(0, 300),
        }];
      })
    : [];
  return { summary: record.summary.trim().slice(0, 1_200), findings, actions };
}

/** Drops anything the machine cannot actually do, then de-duplicates. 丢弃机器实际做不到的项，然后去重。 */
function validateActions(
  actions: ParsedReview["actions"],
  providers: Awaited<ReturnType<typeof listEffectiveProviderConfigs>>,
  mainAgentModel?: string,
): ReviewAction[] {
  const seen = new Set<string>();
  const valid: ReviewAction[] = [];
  for (const action of actions) {
    if (valid.length >= 4) break;
    const key = `${action.kind}:${action.providerId ?? "main"}`;
    if (seen.has(key)) continue;
    if (action.kind === "provider-effort" || action.kind === "provider-model") {
      const provider = providers.find((candidate) => candidate.id === action.providerId);
      if (provider === undefined) continue;
      if (action.kind === "provider-effort" && !(provider.efforts ?? EFFORT_LEVELS).includes(action.value as EffortLevel)) continue;
    }
    if (action.kind === "main-agent-effort" && !isEffortLevel(action.value)) continue;
    if (action.kind === "main-agent-model" && mainAgentModel === undefined && !action.value.includes("/")) continue;
    seen.add(key);
    valid.push({ id: `${action.kind}:${action.providerId ?? "main"}:${action.value}`, ...action });
  }
  return valid;
}

/** Whether the review file exists, for a cheap UI probe without reading it. 评审文件是否存在，供界面轻量探测。 */
export function reviewExists(dataDirectory: string): boolean {
  return existsSync(join(dataDirectory, REVIEW_FILE));
}