import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionStore } from "../src/sessions/session-store.ts";

test("deleted sessions disappear from the companion list while their runtime journal can remain intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-sessions-"));
  try {
    const sessions = new SessionStore(join(directory, "sessions.json"));
    await sessions.delete("run-1");

    assert.equal(await sessions.isDeleted("run-1"), true);
    assert.equal(await sessions.isDeleted("run-2"), false);
    assert.deepEqual([...await sessions.deletedRunIds()], ["run-1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a deleted session can be restored without touching the journal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-restore-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const sessions = new SessionStore(join(directory, "sessions.json"));
  await sessions.delete("run-1");
  await sessions.delete("run-2");
  await sessions.restore("run-1");
  await sessions.restore("never-deleted");
  assert.deepEqual([...await sessions.deletedRunIds()], ["run-2"]);
});
