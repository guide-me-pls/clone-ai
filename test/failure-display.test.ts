import assert from "node:assert/strict";
import test from "node:test";

import { describeFailureForOwner } from "../src/core/failure-display.ts";

test("a provider-blocked answer gets a Chinese summary and next step", () => {
  const display = describeFailureForOwner(
    "The model stopped without completing an answer (finish_reason: content_filter).",
  );
  assert.match(display.summary, /提供方拦截或中止/);
  assert.match(display.guidance, /重试|换一种说法/);
  assert.equal(display.permissionBlocked, false);
});

test("a plain stop notice without a known category stays generic", () => {
  const display = describeFailureForOwner("upstream returned an implausible token count");
  assert.equal(display.summary, "Worker 执行失败。");
});