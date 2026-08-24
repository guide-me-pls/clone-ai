#!/usr/bin/env node
/**
 * LongMemEval-style retrieval benchmark for the governed memory layer.
 *
 * LongMemEval (ICLR 2025, https://arxiv.org/abs/2410.10813) tests whether a
 * chat assistant remembers its owner across hundreds of sessions. Five
 * abilities — information extraction, multi-session reasoning, temporal
 * reasoning, knowledge updates, abstention — each question annotated with the
 * evidence sessions that contain its answer.
 *
 * This harness runs the deterministic half of that protocol against
 * MdMemoryStore.recall, the layer clone-ai owns:
 *
 *   ingest every haystack session as a governed memory (with its real date)
 *   → recall(question)
 *   → did the evidence sessions surface in the top-k?
 *
 * Metrics follow the paper's retrieval evaluation: recall_any@k /
 * recall_all@k over evidence sessions plus NDCG, aggregated per question
 * type. The 30 abstention instances are excluded from retrieval scoring, as
 * in the paper, and reported separately — they measure whether the twin
 * knows it does not know, which is a property of the answer layer, not of
 * retrieval. What this deliberately does NOT measure: answer quality. The
 * paper judges generated answers with an LLM (with per-type judge prompts,
 * e.g. tolerating off-by-one day errors in temporal questions); that belongs
 * to a live benchmark, not this offline one.
 *
 * LongMemEval fits clone-ai unusually well because both are single-user by
 * construction: every instance is one owner's private history, which is
 * exactly what a digital twin lives through.
 *
 * 用 LongMemEval（ICLR 2025）的确定性半套协议，考 clone-ai 的受治理记忆层：
 *
 *   把每个 haystack session 按其真实日期吃进记忆库 → recall(问题) → 证据 session
 *   是否进入 top-k？
 *
 * 指标照搬论文的检索评测：对证据 session 的 recall_any@k / recall_all@k 加 NDCG，
 * 按题型聚合；30 道 abstention 题按论文约定不参与检索计分，单独报告——它们测的是
 * “分身知不知道自己不知道”，那是答案层的属性，不是检索层的。刻意不测的：回答质量，
 * 论文用 LLM 裁判（且分题型定制判词，如时间题容忍差一天），那属于在线基准。
 *
 * LongMemEval 与 clone-ai 天然契合：每道题就是一个所有者的私人历史，而数字分身
 * 活过的正是这样一份历史。
 *
 * Usage / 用法:
 *   node --experimental-strip-types benchmark/long-memory-eval.ts --data FILE
 *     [--sample N] [--granularity session|turn] [--max-results K] [--min-ratio R]
 *
 * Data / 数据: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 *   longmemeval_oracle.json    只含证据 session（~15 MB，检索近乎送分，可当冒烟测试）
 *   longmemeval_s_cleaned.json 完整干草堆，~115k token/题（~277 MB，真正的考试）
 *   longmemeval_m_cleaned.json ~500 session/题（~2.7 GB）
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MdMemoryStore } from "../src/memory/md-memory-store.ts";

export interface LongMemEvalTurn {
  role: string;
  content: string;
  /** Present on the turns that contain the answer. 标记包含答案的回合。 */
  has_answer?: boolean;
}

export interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LongMemEvalTurn[][];
  answer_session_ids: string[];
}

export interface MemoryEvalOptions {
  dataPath: string;
  /** Run an evenly strided subset instead of all instances. 均匀抽样运行而非全量。 */
  sample?: number;
  granularity?: "session" | "turn";
  /** How many memories recall may return (top-k ceiling). recall 最多返回的记忆数（top-k 上限）。 */
  maxResults?: number;
  /** Match floor passed to recall; 0.2 is the product default. 传给 recall 的命中下限；0.2 是产品默认值。 */
  minRatio?: number;
}

export interface InstanceMetrics {
  questionId: string;
  questionType: string;
  abstention: boolean;
  matchedCount: number;
  topScore: number | undefined;
  recallAny: Record<string, number>;
  recallAll: Record<string, number>;
  ndcgAny: number;
  turnRecallAny: Record<string, number> | undefined;
}

export interface TypeAggregate {
  count: number;
  recallAny: Record<string, number>;
  recallAll: Record<string, number>;
  ndcgAny: number;
  /** Share of questions where recall returned nothing at all. recall 一条都没返回的问题占比。 */
  zeroMatchRate: number;
  turnRecallAny: Record<string, number> | undefined;
}

export interface MemoryEvalReport {
  dataPath: string;
  granularity: "session" | "turn";
  maxResults: number;
  minRatio: number;
  instances: number;
  byType: Record<string, TypeAggregate>;
  overall: TypeAggregate;
  /** Per-instance metrics, so a bad aggregate can be drilled into. 逐题指标，供钻取糟糕的聚合值。 */
  instanceDetails: InstanceMetrics[];
  abstention: {
    count: number;
    averageMatches: number;
    noMatchRate: number;
    averageTopScore: number | undefined;
  };
  /** Average top score over non-abstention questions, for comparison. 非弃权题的平均最高分，供对照。 */
  nonAbstentionTopScore: number | undefined;
}

/**
 * "2023/04/10 (Mon) 23:07" → ISO. LongMemEval dates carry a weekday in
 * parentheses that Date.parse rejects; strip it and let V8 do the rest.
 * "2023/04/10 (Mon) 23:07" → ISO。LongMemEval 的日期带括号星期，Date.parse 不认；
 * 去掉它，其余交给 V8。
 */
function parseLongMemEvalDate(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const cleaned = raw.replace(/\s*\([^)]*\)/g, " ").trim();
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

async function loadInstances(dataPath: string): Promise<LongMemEvalInstance[]> {
  const source = (await readFile(dataPath, "utf8")).trim();
  if (source.startsWith("[")) return JSON.parse(source) as LongMemEvalInstance[];
  return source
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LongMemEvalInstance);
}

/** Even stride over the data so a sample keeps every question type present. 均匀抽样，使样本仍覆盖所有题型。 */
function strideSample<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined || limit >= items.length) return items;
  if (limit <= 0) return [];
  const step = items.length / limit;
  const selected: T[] = [];
  for (let i = 0; i < limit; i += 1) selected.push(items[Math.floor(i * step)]!);
  return selected;
}

function dcg(relevances: number[]): number {
  if (relevances.length === 0) return 0;
  let total = relevances[0]!;
  for (let i = 1; i < relevances.length; i += 1) total += relevances[i]! / Math.log2(i + 1);
  return total;
}

/** NDCG with binary relevance, mirroring the benchmark's own implementation. 二值相关度的 NDCG，与基准自身的实现对齐。 */
function ndcgAny(ranked: string[], correct: Set<string>, k: number): number {
  const relevances = ranked.slice(0, k).map((id) => (correct.has(id) ? 1 : 0));
  const idealDcg = dcg(Array.from({ length: Math.min(correct.size, k) }, () => 1));
  if (idealDcg === 0) return 0;
  return dcg(relevances) / idealDcg;
}

/**
 * Lives through one instance's history inside a throwaway store.
 *
 * Each session (or turn) becomes one governed memory committed with its real
 * date as occurredAt, so recency behaves as it would for an owner who actually
 * had those conversations on those days.
 *
 * 把一道题的整段历史在一次性 Store 里"活"一遍。每个 session（或回合）成为一条受治理
 * 记忆，并把真实日期作为 occurredAt 提交——这样新鲜度的表现，与真实在那些日子聊过天
 * 的所有者一致。
 */
async function ingestInstance(
  store: MdMemoryStore,
  instance: LongMemEvalInstance,
  granularity: "session" | "turn",
): Promise<Map<string, { sessionId: string; turnKey?: string; isAnswerTurn: boolean }>> {
  const locations = new Map<string, { sessionId: string; turnKey?: string; isAnswerTurn: boolean }>();
  for (let index = 0; index < instance.haystack_sessions.length; index += 1) {
    const sessionId = instance.haystack_session_ids[index] ?? `session-${index}`;
    const occurredAt = parseLongMemEvalDate(instance.haystack_dates[index], parseLongMemEvalDate(instance.question_date, new Date().toISOString()));
    const turns = instance.haystack_sessions[index] ?? [];

    if (granularity === "session") {
      const transcript = turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
      if (transcript.trim().length === 0) continue;
      const entry = await store.commit({
        summary: `Conversation on ${occurredAt.slice(0, 10)}: ${transcript.slice(0, 160).replace(/\s+/g, " ")}`,
        content: transcript,
        type: "fact",
        confidence: "medium",
        occurredAt,
      });
      locations.set(entry.id, { sessionId, isAnswerTurn: turns.some((turn) => turn.has_answer === true) });
      continue;
    }

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex]!;
      if (turn.content.trim().length === 0) continue;
      const entry = await store.commit({
        summary: `${turn.role} on ${occurredAt.slice(0, 10)}: ${turn.content.slice(0, 200).replace(/\s+/g, " ")}`,
        content: turn.content,
        type: "fact",
        confidence: "medium",
        occurredAt,
      });
      locations.set(entry.id, {
        sessionId,
        turnKey: `${sessionId}#${turnIndex}`,
        isAnswerTurn: turn.has_answer === true,
      });
    }
  }
  return locations;
}

async function evaluateInstance(
  store: MdMemoryStore,
  instance: LongMemEvalInstance,
  locations: Map<string, { sessionId: string; turnKey?: string; isAnswerTurn: boolean }>,
  granularity: "session" | "turn",
  maxResults: number,
  minRatio: number,
): Promise<InstanceMetrics> {
  const matches = await store.recall(instance.question, { maxResults, minRatio });
  const abstention = instance.question_id.endsWith("_abs");

  // Turn-level hits collapse back to sessions in rank order, mirroring the
  // benchmark's turn-to-session conversion: several recalled turns of one
  // session count that session once.
  // 回合级命中按排名顺序折回 session，对齐基准的 turn→session 转换：同一 session 的
  // 多个被召回回合只计一次。
  const rankedSessions: string[] = [];
  const seenSessions = new Set<string>();
  for (const match of matches) {
    const location = locations.get(match.entry.id);
    if (location === undefined) continue;
    if (!seenSessions.has(location.sessionId)) {
      seenSessions.add(location.sessionId);
      rankedSessions.push(location.sessionId);
    }
  }

  const correct = new Set(instance.answer_session_ids);
  const ks = [1, 5, 10].filter((k) => k <= maxResults);
  const recallAny: Record<string, number> = {};
  const recallAll: Record<string, number> = {};
  for (const k of ks) {
    const top = rankedSessions.slice(0, k);
    recallAny[String(k)] = correct.size > 0 && [...correct].some((id) => top.includes(id)) ? 1 : 0;
    recallAll[String(k)] = correct.size > 0 && [...correct].every((id) => top.includes(id)) ? 1 : 0;
  }

  let turnRecallAny: Record<string, number> | undefined;
  if (granularity === "turn") {
    const rankedTurns = matches
      .map((match) => locations.get(match.entry.id)?.turnKey)
      .filter((key): key is string => key !== undefined);
    const correctTurns = new Set(
      [...locations.values()].filter((location) => location.isAnswerTurn && location.turnKey !== undefined).map((location) => location.turnKey!),
    );
    turnRecallAny = {};
    for (const k of ks) {
      const top = rankedTurns.slice(0, k);
      turnRecallAny[String(k)] = correctTurns.size > 0 && [...correctTurns].some((id) => top.includes(id)) ? 1 : 0;
    }
  }

  return {
    questionId: instance.question_id,
    questionType: instance.question_type,
    abstention,
    matchedCount: matches.length,
    topScore: matches[0]?.score,
    recallAny,
    recallAll,
    ndcgAny: ndcgAny(rankedSessions, correct, Math.min(10, maxResults)),
    turnRecallAny,
  };
}

function aggregate(results: InstanceMetrics[]): TypeAggregate {
  const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
  const ks = Object.keys(results[0]?.recallAny ?? {});
  const recallAny: Record<string, number> = {};
  const recallAll: Record<string, number> = {};
  const turnRecallAny: Record<string, number> = {};
  const hasTurn = results.some((result) => result.turnRecallAny !== undefined);
  for (const k of ks) {
    recallAny[k] = mean(results.map((result) => result.recallAny[k] ?? 0));
    recallAll[k] = mean(results.map((result) => result.recallAll[k] ?? 0));
    if (hasTurn) turnRecallAny[k] = mean(results.map((result) => result.turnRecallAny?.[k] ?? 0));
  }
  return {
    count: results.length,
    recallAny,
    recallAll,
    ndcgAny: mean(results.map((result) => result.ndcgAny)),
    zeroMatchRate: mean(results.map((result) => (result.matchedCount === 0 ? 1 : 0))),
    turnRecallAny: hasTurn ? turnRecallAny : undefined,
  };
}

export async function runLongMemoryEval(options: MemoryEvalOptions): Promise<MemoryEvalReport> {
  const granularity = options.granularity ?? "session";
  const maxResults = options.maxResults ?? 10;
  const minRatio = options.minRatio ?? 0.2;
  const instances = strideSample(await loadInstances(options.dataPath), options.sample);

  const results: InstanceMetrics[] = [];
  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index]!;
    const directory = await mkdtemp(join(tmpdir(), `clone-memory-eval-${granularity}-`));
    let store: MdMemoryStore | undefined;
    try {
      store = new MdMemoryStore({ dataDirectory: directory });
      const locations = await ingestInstance(store, instance, granularity);
      results.push(await evaluateInstance(store, instance, locations, granularity, maxResults, minRatio));
    } finally {
      // Close before removing: on Windows an open SQLite handle keeps the
      // directory locked. 先关再删：在 Windows 上打开的 SQLite 句柄会锁住目录。
      try {
        await store?.close();
      } catch {
        // A store that already failed to open must not fail the run.
      }
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if ((index + 1) % 50 === 0) console.error(`  … ${index + 1}/${instances.length} instances`);
  }

  const scored = results.filter((result) => !result.abstention);
  const abstentions = results.filter((result) => result.abstention);
  const byType: Record<string, TypeAggregate> = {};
  for (const type of new Set(scored.map((result) => result.questionType))) {
    byType[type] = aggregate(scored.filter((result) => result.questionType === type));
  }

  const withMatches = abstentions.filter((result) => result.matchedCount > 0);
  const scoredWithMatches = scored.filter((result) => result.matchedCount > 0);
  return {
    dataPath: options.dataPath,
    granularity,
    maxResults,
    minRatio,
    instances: results.length,
    byType,
    overall: aggregate(scored),
    instanceDetails: results,
    abstention: {
      count: abstentions.length,
      averageMatches: abstentions.length === 0 ? 0 : abstentions.reduce((total, result) => total + result.matchedCount, 0) / abstentions.length,
      noMatchRate: abstentions.length === 0 ? 0 : abstentions.filter((result) => result.matchedCount === 0).length / abstentions.length,
      averageTopScore: withMatches.length === 0 ? undefined : withMatches.reduce((total, result) => total + (result.topScore ?? 0), 0) / withMatches.length,
    },
    nonAbstentionTopScore: scoredWithMatches.length === 0
      ? undefined
      : scoredWithMatches.reduce((total, result) => total + (result.topScore ?? 0), 0) / scoredWithMatches.length,
  };
}

function pct(value: number | undefined): string {
  if (value === undefined) return "    -";
  return `${(value * 100).toFixed(1).padStart(5)}%`;
}

export function printReport(report: MemoryEvalReport): void {
  console.log(`LongMemEval retrieval — clone-ai governed memory`);
  console.log(`data: ${report.dataPath}`);
  console.log(`granularity=${report.granularity} maxResults=${report.maxResults} minRatio=${report.minRatio} instances=${report.instances}`);
  console.log();
  console.log(["question type".padEnd(26), "  n ", " any@1", " any@5", " any@10", " all@5", " all@10", " ndcg@10", "  zero"].join(""));
  const row = (name: string, agg: TypeAggregate): string => [
    name.padEnd(26),
    String(agg.count).padStart(4),
    pct(agg.recallAny["1"]),
    pct(agg.recallAny["5"]),
    pct(agg.recallAny["10"]),
    pct(agg.recallAll["5"]),
    pct(agg.recallAll["10"]),
    pct(agg.ndcgAny),
    pct(agg.zeroMatchRate),
  ].join("");
  for (const [type, agg] of Object.entries(report.byType)) console.log(row(type, agg));
  if (Object.keys(report.byType).length > 0) console.log("-".repeat(86));
  console.log(row("overall", report.overall));
  if (report.overall.turnRecallAny !== undefined) {
    console.log(`turn-level recall_any: @1 ${pct(report.overall.turnRecallAny["1"])}  @5 ${pct(report.overall.turnRecallAny["5"])}  @10 ${pct(report.overall.turnRecallAny["10"])}`);
  }
  console.log();
  console.log("abstention (excluded from retrieval scoring, as in the paper):");
  console.log(`  ${report.abstention.count} questions | avg recalled memories: ${report.abstention.averageMatches.toFixed(2)} | no-match rate: ${pct(report.abstention.noMatchRate)} | avg top score: ${report.abstention.averageTopScore?.toFixed(2) ?? "-"}`);
  console.log(`  non-abstention avg top score: ${report.nonAbstentionTopScore?.toFixed(2) ?? "-"} — the gap between the two is the calibration room for "I don't know"`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dataPath = value("--data");
  if (dataPath === undefined) {
    console.error("Usage: long-memory-eval --data FILE [--sample N] [--granularity session|turn] [--max-results K] [--min-ratio R]");
    console.error("Data: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned");
    process.exit(2);
  }
  const sample = value("--sample") === undefined ? undefined : Number(value("--sample"));
  const report = await runLongMemoryEval({
    dataPath,
    ...(sample === undefined ? {} : { sample }),
    granularity: value("--granularity") === "turn" ? "turn" : "session",
    maxResults: value("--max-results") === undefined ? 10 : Number(value("--max-results")),
    minRatio: value("--min-ratio") === undefined ? 0.2 : Number(value("--min-ratio")),
  });
  printReport(report);

  const here = fileURLToPath(new URL(".", import.meta.url));
  const resultsDirectory = join(here, "results");
  await mkdir(resultsDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const name = basename(dataPath).replace(/\.jsonl?$/, "");
  const reportPath = join(resultsDirectory, `longmemeval-${name}-${report.granularity}-r${report.maxResults}-m${report.minRatio}-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nReport: ${reportPath}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
