import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activeRequestFor,
  consumeApprovalCode,
  issueApprovalCode,
  normalizeApprovalCode,
} from "../src/mobile/approval-codes.ts";
import { approvalCommandFor, parseApprovalCommand } from "../src/mobile/whatsapp-bridge.ts";

async function directory(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clone-approval-"));
  t.after(async () => rm(path, { recursive: true, force: true }));
  return path;
}

test("a code approves exactly one run, once, then it is spent", async (t) => {
  const dir = await directory(t);
  const now = new Date("2026-11-05T10:00:00.000Z");
  const issued = await issueApprovalCode(dir, { runId: "run-1", stepId: "s1" }, now);
  assert.equal(issued.code.length, 8);
  assert.equal((await activeRequestFor(dir, "run-1", "s1", now))?.id, issued.request.id);

  const typed = normalizeApprovalCode(` ${issued.code.slice(0, 4)}-${issued.code.slice(4)} `);
  const first = await consumeApprovalCode(dir, typed, new Date(now.getTime() + 60_000));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.request.runId, "run-1");
  assert.equal(first.request.stepId, "s1");

  const replay = await consumeApprovalCode(dir, issued.code, new Date(now.getTime() + 61_000));
  assert.deepEqual(replay, { ok: false, reason: "used" });
});

test("codes expire, and re-issuing for the same step invalidates the older one", async (t) => {
  const dir = await directory(t);
  const now = new Date("2026-11-05T10:00:00.000Z");
  const first = await issueApprovalCode(dir, { runId: "run-1", stepId: "s1" }, now);
  const second = await issueApprovalCode(dir, { runId: "run-1", stepId: "s1" }, new Date(now.getTime() + 1_000));
  assert.notEqual(first.code, second.code);
  assert.deepEqual(await consumeApprovalCode(dir, first.code, new Date(now.getTime() + 2_000)), { ok: false, reason: "not_found" });
  assert.equal((await consumeApprovalCode(dir, second.code, new Date(now.getTime() + 3_000))).ok, true);

  const third = await issueApprovalCode(dir, { runId: "run-2", stepId: "s2" }, now);
  assert.deepEqual(
    await consumeApprovalCode(dir, third.code, new Date(now.getTime() + 11 * 60_000)),
    { ok: false, reason: "expired" },
  );
});

test("only APPROVE/REJECT plus a code are approval commands, and forwarding voids them", () => {
  assert.deepEqual(parseApprovalCommand("APPROVE 2345ABCD"), { action: "approve", code: "2345ABCD" });
  assert.deepEqual(parseApprovalCommand("接受"), undefined);
  assert.deepEqual(parseApprovalCommand("approve 2345-abcd"), { action: "approve", code: "2345-abcd" });
  assert.deepEqual(parseApprovalCommand("拒绝 2345ABCD"), { action: "reject", code: "2345ABCD" });
  assert.deepEqual(parseApprovalCommand("请帮我批准一下 2345ABCD"), undefined);
  assert.equal(approvalCommandFor({ text: "APPROVE 2345ABCD", forwarded: true })?.forwarded, true);
  assert.equal(approvalCommandFor({ text: "你好", forwarded: false }), undefined);
});