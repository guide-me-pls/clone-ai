import assert from "node:assert/strict";
import test from "node:test";

import { requiredBenchmarkModel } from "../benchmark/model-env.ts";

test("the benchmark model comes from the environment", () => {
  assert.equal(
    requiredBenchmarkModel({ CLONE_AI_BENCH_MAIN_MODEL: " vendor/model " }),
    "vendor/model",
  );
  assert.equal(
    requiredBenchmarkModel({ CLONE_AI_NATIVE_MODEL: "runtime/model" }),
    "runtime/model",
  );
  assert.equal(
    requiredBenchmarkModel({
      CLONE_AI_BENCH_MAIN_MODEL: "bench/model",
      CLONE_AI_NATIVE_MODEL: "runtime/model",
    }),
    "bench/model",
  );
  assert.throws(
    () => requiredBenchmarkModel({}),
    /CLONE_AI_BENCH_MAIN_MODEL/,
  );
  assert.throws(
    () => requiredBenchmarkModel({ CLONE_AI_BENCH_MAIN_MODEL: "   " }),
    /CLONE_AI_BENCH_MAIN_MODEL/,
  );
});