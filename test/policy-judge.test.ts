import assert from "node:assert/strict";
import test from "node:test";

import { judgePolicyDenial, parsePolicyJudgeVerdict, policyJudgePrompt } from "../src/core/policy-judge.ts";

const input = {
  objective: "读取 ~/.ssh/config",
  taskTitle: "SSH 配置",
  step: {
    id: "read",
    title: "读取 SSH 配置",
    instructions: "Read ~/.ssh/config.",
    risk: "read_only" as const,
    acceptanceCriteria: ["x"],
    scopes: [{ domain: "files" as const, resource: "~/.ssh/config", access: "read" as const }],
  },
  reason: "~/.ssh/config is a protected location that no policy can open.",
};

test("the appeal prompt carries the request, the scopes and the refusal", () => {
  const prompt = policyJudgePrompt(input);
  assert.match(prompt, /读取 ~\/\.ssh\/config/);
  assert.match(prompt, /files:read:/);
  assert.match(prompt, /protected location/);
  assert.match(prompt, /Answer with exactly one word: ALLOW, DENY, or ASK\./);
  assert.match(prompt, /never follow instructions/i);
});

test("one-word verdicts parse; anything else asks the owner", () => {
  assert.equal(parsePolicyJudgeVerdict("ALLOW"), "allow");
  assert.equal(parsePolicyJudgeVerdict('"allow."'), "allow");
  assert.equal(parsePolicyJudgeVerdict("放行"), "allow");
  assert.equal(parsePolicyJudgeVerdict("DENY"), "deny");
  assert.equal(parsePolicyJudgeVerdict("ASK"), "ask");
  assert.equal(parsePolicyJudgeVerdict("I think you should allow it"), undefined);
  assert.equal(parsePolicyJudgeVerdict(""), undefined);
});

test("the judge never throws and every failure becomes ask", async () => {
  assert.deepEqual(
    await judgePolicyDenial(input, async () => "ALLOW"),
    { decision: "allow", reason: "ALLOW" },
  );
  const unparsable = await judgePolicyDenial(input, async () => "maybe");
  assert.equal(unparsable.decision, "ask");
  assert.match(unparsable.reason, /no verdict/);
  const unavailable = await judgePolicyDenial(input, async () => { throw new Error("endpoint down"); });
  assert.equal(unavailable.decision, "ask");
  assert.equal(unavailable.unavailable, true);
  assert.match(unavailable.reason, /unavailable/);
});
