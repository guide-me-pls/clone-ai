import assert from "node:assert/strict";
import test from "node:test";

import {
  createOwnerDecisionNotifier,
  ownerNoticeBody,
  ownerNotificationArgs,
  ownerNoticeTitle,
} from "../src/application/owner-notifier.ts";

test("an owner notice is passed as argv, so a title cannot inject AppleScript", () => {
  const notice = {
    kind: "approval" as const,
    title: 'Say "done" — task',
    detail: 'Step "x" needs confirmation.\nReason: external side effect.',
  };
  const args = ownerNotificationArgs(notice);
  assert.deepEqual(args.slice(0, 6), [
    "-e", "on run argv",
    "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e", "end run",
  ]);
  assert.equal(args[6], ownerNoticeBody(notice));
  assert.equal(args[7], ownerNoticeTitle(notice));
  assert.match(args[6] ?? "", /Say "done" — task｜Step "x"/);
  assert.ok(!args.includes('say "done"'), "no text is turned into script source");
});

test("the notice body is one bounded line", () => {
  const long = { kind: "review" as const, title: "t", detail: "x".repeat(500) };
  const body = ownerNoticeBody(long);
  assert.ok(body.length <= 240);
  assert.ok(body.endsWith("…"));
  assert.ok(!body.includes("\n"));
});

test("non-macOS and failing executors never throw", () => {
  const calls: unknown[] = [];
  const linux = createOwnerDecisionNotifier({
    platform: "linux",
    exec: ((...args: unknown[]) => { calls.push(args); return undefined as never; }) as never,
  });
  linux({ kind: "approval", title: "t", detail: "d" });
  assert.equal(calls.length, 0);

  const failing = createOwnerDecisionNotifier({
    platform: "darwin",
    exec: (() => { throw new Error("no osascript"); }) as never,
  });
  assert.doesNotThrow(() => failing({ kind: "approval", title: "t", detail: "d" }));
});
