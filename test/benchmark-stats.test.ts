import assert from "node:assert/strict";
import test from "node:test";

import { median, percentile } from "../benchmark/stats.ts";

test("median handles odd, even and empty samples", () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("percentile uses the nearest observed rank", () => {
  assert.equal(percentile([], 90), null);
  assert.equal(percentile([5], 90), 5);
  const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(samples, 50), 5);
  assert.equal(percentile(samples, 90), 9);
  assert.equal(percentile(samples, 100), 10);
  assert.equal(percentile(samples, 0), 1);
});