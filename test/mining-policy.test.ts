import assert from "node:assert/strict";
import test from "node:test";

import { miningModeFromEnvironment, shouldMine } from "../src/memory/mining-policy.ts";

test("the default mines turns that state something and skips the rest", () => {
  assert.equal(miningModeFromEnvironment({}), "filtered");
  assert.equal(shouldMine("我更喜欢用蓝色模板", "filtered"), true);
  assert.equal(shouldMine("以后每周五交周报", "filtered"), true);
  assert.equal(shouldMine("I prefer short answers", "filtered"), true);
  assert.equal(shouldMine("谢谢", "filtered"), false);
  assert.equal(shouldMine("现在几点了？", "filtered"), false);
  assert.equal(shouldMine("帮我把这个文件转成 PDF", "filtered"), false);
});

test("the mode is one switch: off silences both paths, all mines every turn", () => {
  assert.equal(miningModeFromEnvironment({ CLONE_AI_MEMORY_MINING: "0" }), "off");
  assert.equal(miningModeFromEnvironment({ CLONE_AI_MEMORY_MINING: "off" }), "off");
  assert.equal(shouldMine("我更喜欢用蓝色模板", "off"), false);
  assert.equal(miningModeFromEnvironment({ CLONE_AI_MEMORY_MINING: "1" }), "all");
  assert.equal(shouldMine("帮我把这个文件转成 PDF", "all"), true);
});
