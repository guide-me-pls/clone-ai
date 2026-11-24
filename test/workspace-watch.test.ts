/**
 * The watcher records that an operation happened, skips generated paths, and
 * coalesces the burst a single save produces. It never reads content.
 * 监听器记录"发生过操作"，跳过生成路径，并合并一次保存产生的爆发。它绝不读取内容。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { resetNoiseCache } from "../src/main-agent/workspace-noise.ts";
import { WorkspaceWatcher } from "../src/main-agent/workspace-watch.ts";
import { localDayWindow, readWorkspaceEvents, type WorkspaceOperationEvent } from "../src/main-agent/workspace-ledger.ts";

const exec = promisify(execFile);

async function sandbox(t: TestContext): Promise<{ home: string; dataDirectory: string; work: string }> {
  const home = await mkdtemp(join(tmpdir(), "clone-watch-home-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-watch-data-"));
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { home, dataDirectory, work };
}

async function waitForEvents(
  dataDirectory: string,
  folder: string,
  predicate: (events: WorkspaceOperationEvent[]) => boolean,
  timeoutMs = 3_000,
): Promise<WorkspaceOperationEvent[]> {
  const key = localDayWindow("today", new Date()).dayKey;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const day = await readWorkspaceEvents(dataDirectory, folder, key);
    if (predicate(day.events)) return day.events;
    if (Date.now() > deadline) return day.events;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a created file becomes one operation record, and a save burst stays one", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  const watcher = new WorkspaceWatcher({
    dataDirectory,
    home,
    folders: [canonical],
    dedupeMs: 1_000,
  });
  t.after(() => watcher.close());
  await watcher.start();
  assert.deepEqual(watcher.watchedFolders(), [canonical]);

  await writeFile(join(canonical, "notes.md"), "one\n", "utf8");
  const events = await waitForEvents(dataDirectory, canonical, (list) => list.some((event) => event.path === "notes.md"));
  assert.equal(events.filter((event) => event.path === "notes.md").length, 1);
  assert.equal(events.find((event) => event.path === "notes.md")?.kind, "created");

  // A second write inside the dedupe window is the same operation. 去重窗口内的第二次写入是同一操作。
  await writeFile(join(canonical, "notes.md"), "two\n", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await readWorkspaceEvents(dataDirectory, canonical, localDayWindow("today", new Date()).dayKey);
  assert.equal(after.events.filter((event) => event.path === "notes.md").length, 1);
});

test("generated files and directories never reach the operation log", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  const watcher = new WorkspaceWatcher({ dataDirectory, home, folders: [canonical] });
  t.after(() => watcher.close());
  await watcher.start();

  await writeFile(join(canonical, "notes.md"), "work\n", "utf8");
  await waitForEvents(dataDirectory, canonical, (list) => list.some((event) => event.path === "notes.md"));

  await writeFile(join(canonical, ".DS_Store"), "junk", "utf8");
  await writeFile(join(canonical, "debug.log"), "junk\n", "utf8");
  await writeFile(join(canonical, "state.tmp"), "junk\n", "utf8");
  await mkdir(join(canonical, "node_modules"), { recursive: true });
  await writeFile(join(canonical, "node_modules", "pkg.md"), "junk\n", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 500));

  const day = await readWorkspaceEvents(dataDirectory, canonical, localDayWindow("today", new Date()).dayKey);
  const paths = day.events.map((event) => event.path);
  assert.equal(paths.some((path) => path === ".DS_Store"), false);
  assert.equal(paths.some((path) => path === "debug.log"), false);
  assert.equal(paths.some((path) => path === "state.tmp"), false);
  assert.equal(paths.some((path) => path.startsWith("node_modules/")), false);
});

test("a repository's gitignored path is not recorded", async (t) => {
  const { home, dataDirectory, work } = await sandbox(t);
  const canonical = await realpath(work);
  try {
    await exec("git", ["init", "-q", canonical]);
    await exec("git", ["-C", canonical, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", canonical, "config", "user.name", "test"]);
  } catch {
    t.skip("git is not available");
    return;
  }
  await writeFile(join(canonical, ".gitignore"), "draft.md\n", "utf8");
  await writeFile(join(canonical, "notes.md"), "notes\n", "utf8");
  resetNoiseCache();
  const watcher = new WorkspaceWatcher({ dataDirectory, home, folders: [canonical], dedupeMs: 1_000 });
  t.after(() => watcher.close());
  await watcher.start();

  await writeFile(join(canonical, "draft.md"), "draft\n", "utf8");
  await writeFile(join(canonical, "notes.md"), "notes changed\n", "utf8");
  const events = await waitForEvents(dataDirectory, canonical, (list) => list.some((event) => event.path === "notes.md"));
  assert.equal(events.some((event) => event.path === "draft.md"), false);
  assert.equal(events.some((event) => event.path === "notes.md"), true);
});
