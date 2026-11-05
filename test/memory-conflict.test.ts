import assert from "node:assert/strict";
import test from "node:test";

import { dedupeContext, findConflicts, summarySimilarity } from "../src/memory/conflict.ts";

const at = (day: number): string => new Date(Date.UTC(2026, 0, day)).toISOString();

test("a reworded restatement scores high, an unrelated memory scores low", () => {
  const same = summarySimilarity("报告的模板用蓝色", "报告模板使用蓝色");
  const different = summarySimilarity("报告的模板用蓝色", "周报每周五提交");
  assert.ok(same > 0.45, `expected a high score, got ${same}`);
  assert.ok(different < 0.2, `expected a low score, got ${different}`);
});

test("a restated fact is proposed for retirement, keeping the newer one", () => {
  // A restatement is what this reliably catches; a changed value in Chinese
  // scores far lower and is recorded as a known limit, not tested as working.
  // 本模块可靠捕获的是复述；中文里取值改变得分低得多，记为已知局限，而不是测试它能工作。
  const pairs = findConflicts([
    { id: "old", summary: "报告的模板使用蓝色", type: "preference", createdAt: at(1) },
    { id: "new", summary: "报告模板用蓝色", type: "preference", createdAt: at(5) },
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.keep.id, "new");
  assert.equal(pairs[0]!.retire.id, "old");
});

test("different types are never reported as a conflict", () => {
  const pairs = findConflicts([
    { id: "a", summary: "报告模板使用蓝色", type: "preference", createdAt: at(1) },
    { id: "b", summary: "报告模板用蓝色", type: "procedure", createdAt: at(2) },
  ]);
  assert.deepEqual(pairs, []);
});

test("archived memories are not compared", () => {
  const pairs = findConflicts([
    { id: "a", summary: "报告模板使用蓝色", type: "preference", createdAt: at(1), status: "archived" },
    { id: "b", summary: "报告模板用蓝色", type: "preference", createdAt: at(2) },
  ]);
  assert.deepEqual(pairs, []);
});

test("dedupe keeps the higher-scoring restatement and drops the other", () => {
  const kept = dedupeContext([
    { id: "a", summary: "报告的模板使用蓝色", score: 0.9 },
    { id: "b", summary: "报告模板用蓝色", score: 0.5 },
  ]);
  assert.deepEqual(kept.map((item) => item.id), ["a"]);
});
