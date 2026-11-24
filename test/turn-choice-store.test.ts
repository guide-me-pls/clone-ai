/**
 * The model/effort choice belongs to the conversation, not to the page origin.
 * 模型/强度选择属于对话，而不是页面 origin。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  readTurnChoice,
  readTurnChoices,
  turnChoicesFile,
  writeTurnChoice,
} from "../src/main-agent/turn-choice-store.ts";

async function sandbox(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-turn-choice-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a choice is stored with the conversation, and a partial update keeps the other field", async (t) => {
  const directory = await sandbox(t);
  const first = await writeTurnChoice(directory, "conversation-1", { model: "deepseek-v4.1-flash", effort: "max" });
  assert.equal(first?.model, "deepseek-v4.1-flash");
  assert.equal(first?.effort, "max");
  assert.deepEqual(
    { model: (await readTurnChoice(directory, "conversation-1"))?.model, effort: (await readTurnChoice(directory, "conversation-1"))?.effort },
    { model: "deepseek-v4.1-flash", effort: "max" },
  );

  await writeTurnChoice(directory, "conversation-1", { model: "another-model" });
  const partial = await readTurnChoice(directory, "conversation-1");
  assert.equal(partial?.model, "another-model");
  assert.equal(partial?.effort, "max", "an omitted field keeps its value");

  await writeTurnChoice(directory, "conversation-1", { model: "", effort: "" });
  assert.equal(await readTurnChoice(directory, "conversation-1"), undefined, "both empty removes the entry");
  assert.deepEqual(await readTurnChoices(directory), {});

  const mode = (await stat(turnChoicesFile(directory))).mode & 0o777;
  assert.equal(mode, 0o600, "the preference file is owner-only");
});

test("a malformed file reads as empty and a later write repairs it", async (t) => {
  const directory = await sandbox(t);
  await writeFile(turnChoicesFile(directory), "{ not json", "utf8");
  assert.deepEqual(await readTurnChoices(directory), {});
  await writeTurnChoice(directory, "conversation-2", { model: "m", effort: "high" });
  assert.equal((await readTurnChoice(directory, "conversation-2"))?.effort, "high");
});

test("an unsafe conversation id is refused instead of becoming a key", async (t) => {
  const directory = await sandbox(t);
  assert.equal(await writeTurnChoice(directory, "bad\u0000id", { model: "m" }), undefined);
  assert.equal(await readTurnChoice(directory, ""), undefined);
});
