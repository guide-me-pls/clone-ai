/**
 * The blocking owner-question broker: choices, free text, cancellation and a
 * timeout that never leaves a turn waiting forever.
 *
 * 阻塞式所有者提问经纪人：选项、自由文本、取消，以及不会让回合永远等待的超时。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatOwnerAnswer, OwnerQuestionBroker } from "../src/main-agent/owner-questions.ts";

test("a question lists its choices and resolves with the clicked one", async () => {
  const broker = new OwnerQuestionBroker();
  const pending = broker.ask({
    conversationId: "main-agent-conversation",
    turnId: "turn-1",
    question: "要我派这个任务吗？",
    choices: [{ label: "独立进程", description: "新进程执行" }, { label: "塞进 lifespan" }],
  });
  const listed = broker.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.choices.map((choice) => choice.label), ["独立进程", "塞进 lifespan"]);
  assert.equal(listed[0]?.allowOther, true);
  assert.equal(listed[0]?.turnId, "turn-1");
  const answered = broker.answer(listed[0]!.id, { choiceId: "choice-2" });
  assert.equal(answered?.id, listed[0]!.id);
  const answer = await pending;
  assert.equal(answer.label, "塞进 lifespan");
  assert.match(formatOwnerAnswer(answer), /owner chose: 塞进 lifespan/);
  assert.equal(broker.list().length, 0);
  assert.equal(broker.answer(listed[0]!.id, { choiceId: "choice-1" }), undefined);
});

test("free text is accepted, and invalid asks or choices are refused", async () => {
  const broker = new OwnerQuestionBroker();
  const pending = broker.ask({
    conversationId: "main-agent-conversation",
    question: "选哪个方案？",
    choices: [{ label: "A" }, { label: "B" }],
  });
  const id = broker.list()[0]!.id;
  assert.throws(() => broker.answer(id, { choiceId: "choice-9" }), /not a choice/);
  assert.throws(() => broker.answer(id, { text: "   " }), /choiceId or text/);
  broker.answer(id, { text: "两个都试一下" });
  assert.match(formatOwnerAnswer(await pending), /两个都试一下/);

  assert.throws(() => broker.ask({ conversationId: "c", question: "", choices: [{ label: "A" }, { label: "B" }] }), /question is required/);
  assert.throws(() => broker.ask({ conversationId: "c", question: "q", choices: [{ label: "A" }] }), /between 2 and 4/);
  assert.throws(() => broker.ask({ conversationId: "c", question: "q", choices: [{ label: "A" }, { label: "A" }] }), /repeats/);
  assert.throws(() => broker.ask({ conversationId: "c", question: "q", choices: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }] }), /between 2 and 4/);
});

test("an aborted turn or a shutdown resolves the wait and clears the list", async () => {
  const broker = new OwnerQuestionBroker();
  const controller = new AbortController();
  const pending = broker.ask({
    conversationId: "c",
    question: "q?",
    choices: [{ label: "A" }, { label: "B" }],
    signal: controller.signal,
  });
  controller.abort();
  assert.equal((await pending).cancelled, true);
  assert.equal(broker.list().length, 0);

  const another = broker.ask({ conversationId: "c", question: "q2?", choices: [{ label: "A" }, { label: "B" }] });
  broker.closeAll();
  assert.equal((await another).cancelled, true);
  assert.equal(broker.list().length, 0);
});

test("a timeout resolves instead of hanging the turn", async () => {
  const broker = new OwnerQuestionBroker();
  const answer = await broker.ask({
    conversationId: "c",
    question: "q?",
    choices: [{ label: "A" }, { label: "B" }],
    timeoutMs: 10,
  });
  assert.equal(answer.timedOut, true);
  assert.match(formatOwnerAnswer(answer), /did not answer/);
});