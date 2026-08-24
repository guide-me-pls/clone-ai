import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLongMemoryEval, type LongMemEvalInstance } from "../benchmark/long-memory-eval.ts";

/**
 * A tiny LongMemEval-format fixture with known answers, exercising the three
 * behaviours that matter: a plain extraction question, a knowledge update
 * where the fresh mention must outrank the stale one, and an abstention
 * question whose answer exists nowhere in the haystack.
 *
 * 一个已知答案的迷你 LongMemEval 格式夹具，覆盖三种关键行为：普通信息抽取题、
 * “新提及必须压过旧提及”的知识更新题，以及干草堆里根本不存在答案的弃权题。
 */
function fixture(): LongMemEvalInstance[] {
  const daysAgo = (days: number): string => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return [
    {
      question_id: "q1",
      question_type: "single-session-user",
      question: "What was the first issue I had with my new car?",
      answer: "GPS system not functioning",
      question_date: daysAgo(1),
      haystack_session_ids: ["s1", "s2"],
      haystack_dates: [daysAgo(30), daysAgo(20)],
      haystack_sessions: [
        [
          { role: "user", content: "My new car has a problem after its first service: the GPS system is not functioning.", has_answer: true },
          { role: "assistant", content: "Sorry to hear about the GPS issue. Did the dealership check the antenna?" },
        ],
        [
          { role: "user", content: "I also asked about the tire warranty." },
          { role: "assistant", content: "The tire warranty covers two years." },
        ],
      ],
      answer_session_ids: ["s1"],
    },
    {
      question_id: "q2",
      question_type: "knowledge-update",
      question: "Where do I live now?",
      answer: "Shanghai",
      question_date: daysAgo(1),
      haystack_session_ids: ["s1", "s2", "s3"],
      haystack_dates: [daysAgo(60), daysAgo(40), daysAgo(5)],
      haystack_sessions: [
        [{ role: "user", content: "I live in Beijing now, near the park." }],
        [{ role: "user", content: "The weather was lovely today." }],
        [{ role: "user", content: "I moved last week: I live in Shanghai now.", has_answer: true }],
      ],
      answer_session_ids: ["s3"],
    },
    {
      question_id: "q3_abs",
      question_type: "single-session-user",
      question: "What is my sister's dog's name?",
      answer: "This question is unanswerable from the history.",
      question_date: daysAgo(1),
      haystack_session_ids: ["s1"],
      haystack_dates: [daysAgo(10)],
      haystack_sessions: [
        [
          { role: "user", content: "I cooked pasta with tomato sauce and basil tonight." },
          { role: "assistant", content: "That sounds delicious. Pasta with basil is a classic combination." },
        ],
      ],
      answer_session_ids: [],
    },
  ];
}

test("session-granularity eval scores a known fixture exactly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-memory-eval-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const dataPath = join(directory, "fixture.json");
  await writeFile(dataPath, JSON.stringify(fixture()), "utf8");

  const report = await runLongMemoryEval({ dataPath, granularity: "session", maxResults: 10 });

  // q1: the evidence session is the only match — the tire-warranty session
  // stays below the match floor.
  // q1：证据 session 是唯一命中——轮胎保修那条低于命中下限。
  assert.equal(report.byType["single-session-user"]?.count, 1);
  assert.equal(report.byType["single-session-user"]?.recallAny["5"], 1);
  const q1 = report.instanceDetails.find((detail) => detail.questionId === "q1")!;
  assert.equal(q1.matchedCount, 1);

  // q2: knowledge update — both mentions surface, and the fresh one (5 days
  // ago) outranks the stale one (60 days ago) through the recency signal, so
  // the evidence session is the top-ranked result.
  // q2：知识更新——两条提及都被召回，且新的（5 天前）凭借新鲜度信号压过旧的
  // （60 天前），因此证据 session 排在第一。
  assert.equal(report.byType["knowledge-update"]?.recallAny["1"], 1);
  assert.equal(report.byType["knowledge-update"]?.recallAll["5"], 1);
  const q2 = report.instanceDetails.find((detail) => detail.questionId === "q2")!;
  assert.equal(q2.matchedCount, 2);
  assert.equal(q2.recallAny["1"], 1);

  // q3: abstention — nothing in the cooking haystack matches the question, so
  // recall stays empty. That emptiness is the raw material for "I don't know".
  // q3：弃权——做饭的干草堆里没有任何内容命中问题，召回为空。这份“空”正是
  // “我不知道”的原料。
  assert.equal(report.abstention.count, 1);
  assert.equal(report.abstention.averageMatches, 0);
  assert.equal(report.abstention.noMatchRate, 1);
  // And a real question does produce a score, so the two are separable.
  // 而真实问题能产生分数，两者因此可区分。
  assert.notEqual(report.nonAbstentionTopScore, undefined);
});

test("turn-granularity eval finds the evidence turn itself", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-memory-eval-turn-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const dataPath = join(directory, "fixture.json");
  await writeFile(dataPath, JSON.stringify(fixture()), "utf8");

  const report = await runLongMemoryEval({ dataPath, granularity: "turn", maxResults: 10 });

  // The user turn that contains the answer is the only turn above the floor
  // for q1, so turn-level recall_any@1 is a perfect hit.
  // q1 中包含答案的用户回合是唯一高于下限的回合，因此 turn 级 recall_any@1 命中。
  assert.equal(report.overall.turnRecallAny?.["1"] !== undefined ? 1 : 0, 1);
  const q1 = report.instanceDetails.find((detail) => detail.questionId === "q1")!;
  assert.equal(q1.turnRecallAny?.["1"], 1);
  // Collapsed back to sessions, the evidence session is still found.
  // 折回 session 后，证据 session 仍被找到。
  assert.equal(q1.recallAny["1"], 1);
});
