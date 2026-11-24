/**
 * The daily ledger records what changed, keeps only what it can afford, and
 * tells the truth about what it missed.
 *
 * 每日台账记录改了什么、只保存负担得起的内容，并如实说明漏了什么。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { isForbiddenPath } from "../src/authority/scope.ts";
import {
  captureWorkspaceFolder,
  ledgerFolderKey,
  ledgerStateFile,
  localDayWindow,
  pruneWorkspaceLedger,
  readLedgerCoverage,
  readWorkspaceBlob,
  readWorkspaceDay,
  renderUnifiedDiff,
  type LedgerFolderState,
} from "../src/main-agent/workspace-ledger.ts";

const exec = promisify(execFile);

async function sandbox(t: TestContext): Promise<{ home: string; dataDirectory: string; work: string }> {
  const home = await mkdtemp(join(tmpdir(), "clone-ledger-home-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ledger-data-"));
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { home, dataDirectory, work };
}

async function stateOf(dataDirectory: string, folder: string): Promise<LedgerFolderState> {
  return JSON.parse(await readFile(ledgerStateFile(dataDirectory, folder), "utf8")) as LedgerFolderState;
}

test("a baseline capture, then a second capture, yields content-level changes", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "notes.md"), "alpha\nbeta\ngamma\n", "utf8");
  await writeFile(join(canonical, "old.txt"), "old file\n", "utf8");
  const first = await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  assert.equal(first.captured, true);
  assert.equal(first.baseline, true);
  assert.equal(first.changes, 0, "a baseline is not a day of added files");

  await writeFile(join(canonical, "notes.md"), "alpha\nBETA\ngamma\ndelta\n", "utf8");
  await writeFile(join(canonical, "new.md"), "new file\n", "utf8");
  await rm(join(canonical, "old.txt"));
  const second = await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  assert.equal(second.baseline, false);
  assert.equal(second.changes, 3);

  const window = localDayWindow("today", new Date());
  const day = await readWorkspaceDay(dataDirectory, canonical, window.dayKey);
  const changes = new Map(day.changes.map((change) => [change.path, change]));
  assert.equal(changes.get("notes.md")?.change, "modified");
  assert.equal(changes.get("new.md")?.change, "added");
  assert.equal(changes.get("old.txt")?.change, "deleted");

  const before = changes.get("notes.md")?.before;
  const after = changes.get("notes.md")?.after;
  assert.ok(before?.text === true && after?.text === true);
  const beforeText = await readWorkspaceBlob(dataDirectory, before.hash);
  const afterText = await readWorkspaceBlob(dataDirectory, after.hash);
  assert.equal(beforeText, "alpha\nbeta\ngamma\n");
  assert.equal(afterText, "alpha\nBETA\ngamma\ndelta\n");
  assert.equal(await readWorkspaceBlob(dataDirectory, changes.get("old.txt")?.before?.hash ?? ""), "old file\n");
});

test("rewriting the same bytes does not record a change", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "same.md"), "same\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  await writeFile(join(canonical, "same.md"), "same\n", "utf8");
  const now = new Date();
  await utimes(join(canonical, "same.md"), now, now);
  const second = await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  assert.equal(second.changes, 0);
});

test("binaries and large text files are identified without a content blob", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  await writeFile(join(canonical, "huge.md"), `${"x".repeat(600 * 1024)}\n`, "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  const state = await stateOf(dataDirectory, canonical);
  assert.equal(state.files["image.bin"]?.text, false);
  assert.match(state.files["image.bin"]?.hash ?? "", /^meta:/);
  assert.equal(state.files["huge.md"]?.text, false);
  assert.match(state.files["huge.md"]?.hash ?? "", /^meta:/);
});

test("a protected folder is refused before anything is written", async (t) => {
  const { home, dataDirectory } = await sandbox(t);
  const secret = join(home, ".ssh");
  await mkdir(secret, { recursive: true });
  await writeFile(join(secret, "config"), "Host *", "utf8");
  const result = await captureWorkspaceFolder({ dataDirectory, folder: secret, home, force: true });
  assert.equal(result.captured, false);
  assert.match(result.error ?? "", /protected location/);
  await assert.rejects(readFile(ledgerStateFile(dataDirectory, secret), "utf8"));
  assert.equal((await readLedgerCoverage(dataDirectory, secret)).trackedFiles, 0);
});

test("the capture interval skips a folder captured recently, and force bypasses it", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "a.md"), "one\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  await writeFile(join(canonical, "a.md"), "two\n", "utf8");
  const skipped = await captureWorkspaceFolder({ dataDirectory, folder: canonical, home });
  assert.equal(skipped.captured, false);
  assert.equal(skipped.changes, 0);
  const forced = await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  assert.equal(forced.changes, 1);
});

test("a day with more changes than the cap is marked truncated", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "one.md"), "1\n", "utf8");
  await writeFile(join(canonical, "two.md"), "2\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  await writeFile(join(canonical, "one.md"), "1 changed\n", "utf8");
  await writeFile(join(canonical, "two.md"), "2 changed\n", "utf8");
  const result = await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true, maxDayChanges: 1 });
  assert.equal(result.changes, 1);
  const window = localDayWindow("today", new Date());
  const day = await readWorkspaceDay(dataDirectory, canonical, window.dayKey);
  assert.equal(day.truncated, true);
});

test("a file created and deleted inside the day nets to nothing", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "here.md"), "here\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  await writeFile(join(canonical, "ephemeral.md"), "gone soon\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  await rm(join(canonical, "ephemeral.md"));
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  const window = localDayWindow("today", new Date());
  const day = await readWorkspaceDay(dataDirectory, canonical, window.dayKey);
  assert.equal(day.changes.some((change) => change.path === "ephemeral.md"), false);
  assert.equal(day.changes.some((change) => change.path === "here.md"), false);
});

test("a change made while the app was closed is filed under its own day", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(10, 0, 0, 0);
  const baselineAt = new Date(yesterday);
  baselineAt.setHours(9, 0, 0, 0);
  await writeFile(join(canonical, "gap.md"), "before\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, now: baselineAt, force: true });
  await writeFile(join(canonical, "gap.md"), "after\n", "utf8");
  await utimes(join(canonical, "gap.md"), yesterday, yesterday);

  const captured = await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, now: new Date(), force: true });
  assert.equal(captured.changes, 1);
  const yesterdayKey = localDayWindow("yesterday", new Date()).dayKey;
  const todayKey = localDayWindow("today", new Date()).dayKey;
  const yesterdayDay = await readWorkspaceDay(dataDirectory, canonical, yesterdayKey);
  const todayDay = await readWorkspaceDay(dataDirectory, canonical, todayKey);
  assert.equal(yesterdayDay.changes.find((change) => change.path === "gap.md")?.change, "modified");
  assert.equal(todayDay.changes.some((change) => change.path === "gap.md"), false, "the capture day is not the change day");
});

test("a protected root inside a learned folder is never read or stored", async (t) => {
  const { home, dataDirectory } = await sandbox(t);
  const canonical = await realpath(home);
  await writeFile(join(canonical, "note.md"), "note\n", "utf8");
  const keychains = join(canonical, "Library", "Keychains");
  await mkdir(keychains, { recursive: true });
  await writeFile(join(keychains, "secret.md"), "secret credential\n", "utf8");

  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  const state = await stateOf(dataDirectory, canonical);
  assert.ok(state.files["note.md"] !== undefined);
  assert.equal(state.files["Library/Keychains/secret.md"], undefined, "a protected root inside the folder is skipped");
});

test("an aborted capture writes no state", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "x.md"), "x\n", "utf8");
  const controller = new AbortController();
  controller.abort();
  const result = await captureWorkspaceFolder({
    dataDirectory,
    folder: canonical,
    home,
    force: true,
    signal: controller.signal,
  });
  assert.equal(result.captured, false);
  assert.match(result.error ?? "", /aborted/i);
  await assert.rejects(readFile(ledgerStateFile(dataDirectory, canonical), "utf8"));
});

test("credential-shaped files are tracked by identity but never read into a blob", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, ".env"), "API_KEY=sk-secret\n", "utf8");
  await writeFile(join(canonical, "id_ed25519"), "PRIVATE KEY\n", "utf8");
  await writeFile(join(canonical, "secrets.json"), "{\"token\":\"secret\"}\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  const state = await stateOf(dataDirectory, canonical);
  for (const name of [".env", "id_ed25519", "secrets.json"]) {
    assert.equal(state.files[name]?.text, false, `${name} must not be stored as text`);
    assert.match(state.files[name]?.hash ?? "", /^meta:/);
  }
});

test("the ledger directory is a protected location", async (t) => {
  const { home } = await sandbox(t);
  assert.equal(isForbiddenPath(join(home, ".clone", "workspace-history", "blobs", "aa", "x"), home), true);
});

test("generated and gitignored files never enter the ledger", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "notes.md"), "notes\n", "utf8");
  await writeFile(join(canonical, ".DS_Store"), "junk", "utf8");
  await writeFile(join(canonical, "debug.log"), "junk\n", "utf8");
  await writeFile(join(canonical, "state.tmp"), "junk\n", "utf8");
  await mkdir(join(canonical, "node_modules"), { recursive: true });
  await writeFile(join(canonical, "node_modules", "pkg.md"), "junk\n", "utf8");

  let gitAvailable = true;
  try {
    await exec("git", ["init", "-q", canonical]);
    await exec("git", ["-C", canonical, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", canonical, "config", "user.name", "test"]);
    await writeFile(join(canonical, ".gitignore"), "draft.md\n", "utf8");
    await writeFile(join(canonical, "draft.md"), "draft\n", "utf8");
    await exec("git", ["-C", canonical, "add", ".gitignore", "notes.md"]);
  } catch {
    gitAvailable = false;
  }

  const result = await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  assert.equal(result.captured, true);
  assert.ok(result.filtered >= (gitAvailable ? 4 : 3), `filtered ${result.filtered} should cover patterns and gitignore`);

  const state = await stateOf(dataDirectory, canonical);
  assert.ok(state.files["notes.md"] !== undefined, "a real document is tracked");
  assert.equal(state.files[".DS_Store"], undefined);
  assert.equal(state.files["debug.log"], undefined);
  assert.equal(state.files["state.tmp"], undefined);
  assert.equal(state.files["node_modules/pkg.md"], undefined);
  if (gitAvailable) assert.equal(state.files["draft.md"], undefined, "the repository's gitignore is respected");
});

test("day windows follow the local calendar, not UTC", () => {
  const now = new Date(2026, 10, 23, 13, 5, 0);
  const today = localDayWindow("today", now);
  assert.equal(today.dayKey, "2026-11-23");
  assert.equal(today.start.getHours(), 0);
  assert.equal(today.end.getDate(), 24, "the day includes everything written before the next midnight");

  const yesterday = localDayWindow("yesterday", now);
  assert.equal(yesterday.dayKey, "2026-11-22");
  assert.equal(yesterday.end.getTime(), today.start.getTime());

  const past = localDayWindow("2026-11-20", now);
  assert.equal(past.dayKey, "2026-11-20");
  assert.equal(past.start.getHours(), 0);
  assert.equal(past.end.getDate(), 21);

  assert.throws(() => localDayWindow("not-a-day", now), /Unrecognized day/);
});

test("pruning drops old day files and the blobs nothing references", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  await writeFile(join(canonical, "live.md"), "live\n", "utf8");
  await captureWorkspaceFolder({ dataDirectory, folder: canonical, home, force: true });
  const state = await stateOf(dataDirectory, canonical);
  const liveHash = state.files["live.md"]?.hash;
  assert.ok(liveHash !== undefined);

  const key = ledgerFolderKey(canonical);
  const oldDay = join(dataDirectory, "workspace-history", "days", key, "2020-01-01.jsonl");
  await mkdir(join(dataDirectory, "workspace-history", "days", key), { recursive: true });
  const orphanHash = "a".repeat(64);
  await writeFile(oldDay, `${JSON.stringify({
    at: "2020-01-01T10:00:00.000Z",
    path: "gone.md",
    change: "modified",
    before: { hash: orphanHash, size: 3, mtimeMs: 0, text: true },
    after: { hash: liveHash, size: 4, mtimeMs: 0, text: true },
  })}\n`, "utf8");
  await mkdir(join(dataDirectory, "workspace-history", "blobs", orphanHash.slice(0, 2)), { recursive: true });
  await writeFile(join(dataDirectory, "workspace-history", "blobs", orphanHash.slice(0, 2), orphanHash), "old", "utf8");

  const result = await pruneWorkspaceLedger(dataDirectory, { retentionDays: 1, force: true });
  assert.equal(result.removedDays, 1);
  assert.equal(result.removedBlobs, 1, "the orphan blob is collected, the live baseline blob is kept");
  await assert.rejects(readFile(oldDay, "utf8"));
  assert.ok(await readWorkspaceBlob(dataDirectory, liveHash));
});

test("a diff trims the unchanged edges and keeps the change readable", () => {
  const diff = renderUnifiedDiff("notes.md", "10:00", "11:00", "a\nb\nc\n", "a\nB\nc\n");
  assert.match(diff, /--- a\/notes\.md \(10:00\)/);
  assert.match(diff, /^\+B$/m);
  assert.match(diff, /^-b$/m);
  assert.match(diff, / a/m);
  assert.match(diff, / c/m);
});
