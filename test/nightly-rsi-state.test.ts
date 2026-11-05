import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fingerprint, isConsumed, loadState, markConsumed, recordOutcome, saveState, stateFilePath } from "../scripts/nightly-rsi-state.mjs";

const empty = () => ({ version: 1, traces: {} });
const now = new Date("2026-11-05T03:00:00.000Z");

async function tempDirectory(t: import("node:test").TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nightly-rsi-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("missing state loads empty", async (t) => {
  const directory = await tempDirectory(t);
  assert.deepEqual(await loadState(directory), empty());
  assert.equal(stateFilePath(directory), join(directory, "consumed-traces.json"));
});

test("only the same run and file bytes are consumed; marking is pure", () => {
  const state = empty();
  assert.equal(fingerprint("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const sha256 = fingerprint(Buffer.from(' { "runId": "run-1" }'));
  const changed = fingerprint('{"runId":"run-1"}');
  const next = markConsumed(state, { runId: "run-1", sha256, branch: "rsi/fix", prUrl: "https://example.invalid/pr/1" }, now);
  assert.deepEqual(state, empty());
  assert.equal(isConsumed(next, "run-1", sha256), true);
  assert.equal(isConsumed(next, "run-1", changed), false);
  assert.equal(isConsumed(next, "run-2", sha256), false);
  assert.deepEqual(next.traces["run-1"], { runId: "run-1", sha256, consumedAt: now.toISOString(), branch: "rsi/fix", prUrl: "https://example.invalid/pr/1" });
  const changedTrace = [{ runId: "run-1", sha256: changed }];
  const failed = recordOutcome(next, changedTrace, { status: "failed", branch: "rsi/retry" }, now);
  assert.equal(isConsumed(failed, "run-1", changed), false);
  assert.equal(isConsumed(failed, "run-1", sha256), true);
  const repaired = recordOutcome(next, changedTrace, { status: "fixed", branch: "rsi/retry" }, now);
  assert.equal(isConsumed(repaired, "run-1", changed), true);
  assert.equal(isConsumed(repaired, "run-1", sha256), false);
});

test("the actual outcome decision consumes successful batches only", () => {
  const traces = [{ runId: "run-1", sha256: fingerprint("trace") }];
  const state = empty();
  for (const status of ["failed", "aborted", "unknown"]) {
    const next = recordOutcome(state, traces, { status, branch: "rsi/fix" }, now);
    assert.equal(isConsumed(next, "run-1", traces[0]!.sha256), false, status);
    assert.deepEqual(next, state);
  }
  for (const status of ["fixed", "pr-created", "patch-only"]) {
    const next = recordOutcome(state, traces, { status, branch: "rsi/fix", ...(status === "pr-created" ? { prUrl: "https://example.invalid/pr/1" } : {}) }, now);
    assert.equal(isConsumed(next, "run-1", traces[0]!.sha256), true, status);
    assert.equal(next.traces["run-1"].branch, "rsi/fix");
    assert.equal(next.traces["run-1"].prUrl, status === "pr-created" ? "https://example.invalid/pr/1" : undefined);
  }
});

test("state round-trips through atomic replacement without leftover temp files", async (t) => {
  const directory = await tempDirectory(t);
  const nested = join(directory, "reports");
  const sha256 = fingerprint("first trace");
  const first = markConsumed(empty(), { runId: "run-1", sha256, branch: "rsi/fix" }, now);
  await saveState(nested, first);
  assert.deepEqual(await loadState(nested), first);
  const second = markConsumed(first, { runId: "run-2", sha256: fingerprint("second"), branch: "rsi/next" }, now);
  await saveState(nested, second);
  assert.deepEqual(await loadState(nested), second);
  assert.deepEqual(JSON.parse(await readFile(stateFilePath(nested), "utf8")), second);
  assert.deepEqual(await readdir(nested), ["consumed-traces.json"]);
});

test("corrupt or invalid state falls back to empty", async (t) => {
  const directory = await tempDirectory(t);
  const target = stateFilePath(directory);
  for (const content of ["{broken", "null", "[]", '{"version":2,"traces":{}}', '{"version":1,"traces":[]}', '{"version":1,"traces":{"run-1":{"runId":"run-1"}}}', '{"version":1,"traces":{"wrong":{"runId":"run-1","sha256":"' + "a".repeat(64) + '","branch":"rsi/fix","consumedAt":"now"}}}']) {
    await writeFile(target, content);
    assert.deepEqual(await loadState(directory), empty(), content);
  }
});

test("failed replacement cleans up the same-directory temporary file", async (t) => {
  const directory = await tempDirectory(t);
  await mkdir(stateFilePath(directory));
  await assert.rejects(saveState(directory, empty()));
  assert.deepEqual(await readdir(directory), ["consumed-traces.json"]);
});
