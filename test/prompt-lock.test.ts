import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { MainAgentBusyError, mainAgentLockPath, withMainAgentLock } from "../src/main-agent/prompt-lock.ts";

test("a second Main Agent prompt is refused while the first still holds the lock", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-prompt-lock-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = withMainAgentLock(dataDirectory, async () => {
    await held;
    return "first";
  });
  first.catch(() => undefined);

  const lockPath = mainAgentLockPath(dataDirectory);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(lockPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  await assert.rejects(withMainAgentLock(dataDirectory, async () => "second"), MainAgentBusyError);
  release();
  assert.equal(await first, "first");
  assert.equal(await withMainAgentLock(dataDirectory, async () => "after"), "after");
});

test("a lock file whose owner is gone is stolen rather than wedging the session", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-stale-lock-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  const path = mainAgentLockPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "99999999\n", "utf8");

  assert.equal(await withMainAgentLock(dataDirectory, async () => "reclaimed"), "reclaimed");
});

test("a second prompt in the same conversation is refused, while another conversation proceeds", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-prompt-lock-conversations-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withMainAgentLock(dataDirectory, async () => {
    await held;
    return "first";
  }, "conversation-a");
  first.catch(() => undefined);

  const lockPath = mainAgentLockPath(dataDirectory, "conversation-a");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(lockPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  await assert.rejects(
    withMainAgentLock(dataDirectory, async () => "second", "conversation-a"),
    MainAgentBusyError,
  );
  // A different task has its own lock: one busy Main Agent does not block it.
  // 不同任务有各自的锁：一个忙碌的 Main Agent 不会阻塞另一个。
  assert.equal(await withMainAgentLock(dataDirectory, async () => "other", "conversation-b"), "other");
  release();
  assert.equal(await first, "first");
});

test("conversation lock files are distinct and never contain the raw id", () => {
  const dataDirectory = join(tmpdir(), "clone-ai-lock-paths");
  const main = mainAgentLockPath(dataDirectory);
  const other = mainAgentLockPath(dataDirectory, "conversation-a");
  assert.notEqual(main, other);
  assert.doesNotMatch(other, /conversation-a/);
  assert.match(other, /prompt-[0-9a-f]{16}\.lock$/);
});
