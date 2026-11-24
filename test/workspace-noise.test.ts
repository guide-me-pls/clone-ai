/**
 * Noise is the owner's own definition where possible: generated directory
 * names, generated file patterns, and the repository's `.gitignore`. The
 * filter must keep real documents and dotfiles that are work.
 *
 * 噪声尽量采用所有者自己的定义：生成目录名、生成文件模式和仓库的 `.gitignore`。
 * 过滤器必须保留真正的文档与属于工作的点文件。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  cachedGitIgnoreIndex,
  isNoiseDirectoryName,
  isNoiseFile,
  isNoisePath,
  loadGitIgnoreIndex,
  resetNoiseCache,
} from "../src/main-agent/workspace-noise.ts";

const exec = promisify(execFile);

async function sandbox(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-noise-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("generated files are noise and real documents are not", () => {
  for (const path of [
    "a/.DS_Store",
    "a/Thumbs.db",
    "a/debug.log",
    "a/swap.swp",
    "a/state.tmp",
    "a/widget.tsbuildinfo",
    "a/app.min.js",
    "a/click.pyc",
    "a/backup~",
    "a/#notes#",
    "a/npm-debug.log",
  ]) {
    assert.equal(isNoiseFile(path), true, `${path} should be noise`);
  }
  for (const path of [
    "a/notes.md",
    "a/.gitignore",
    "a/.editorconfig",
    "a/package-lock.json",
    "a/main.ts",
    "a/README",
    "a/.env.example",
  ]) {
    assert.equal(isNoiseFile(path), false, `${path} should be work`);
  }
});

test("generated directory segments are noise, a normal source tree is not", () => {
  const root = "/Users/example/work";
  for (const path of [
    `${root}/node_modules/pkg/index.js`,
    `${root}/dist/app.js`,
    `${root}/.cache/blob`,
    `${root}/__pycache__/x.pyc`,
  ]) {
    assert.equal(isNoisePath(path, root), true, `${path} should be noise`);
  }
  assert.equal(isNoisePath(`${root}/src/main.ts`, root), false);
  assert.equal(isNoisePath(`${root}/notes/2026-11-24.md`, root), false);
  assert.equal(isNoiseDirectoryName(".git"), true);
  assert.equal(isNoiseDirectoryName("src"), false);
});

test("the repository's own .gitignore is part of the filter", async (t) => {
  const directory = await sandbox(t);
  const repo = join(directory, "project");
  await mkdir(repo, { recursive: true });
  try {
    await exec("git", ["init", "-q", repo]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", repo, "config", "user.name", "test"]);
  } catch {
    t.skip("git is not available");
    return;
  }
  await writeFile(join(repo, ".gitignore"), "draft.md\nbuild/\n", "utf8");
  await writeFile(join(repo, "notes.md"), "notes\n", "utf8");
  await writeFile(join(repo, "draft.md"), "draft\n", "utf8");
  await mkdir(join(repo, "build"), { recursive: true });
  await writeFile(join(repo, "build", "app.js"), "built\n", "utf8");
  await exec("git", ["-C", repo, "add", ".gitignore", "notes.md"]);
  await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

  const index = await loadGitIgnoreIndex([repo]);
  assert.equal(index.sources, 1);
  assert.equal(index.matches(resolve(repo, "draft.md")), true);
  assert.equal(index.matches(resolve(repo, "build", "app.js")), true, "an ignored directory covers its files");
  assert.equal(index.matches(resolve(repo, "notes.md")), false, "a tracked file is never ignored");

  resetNoiseCache();
  const first = cachedGitIgnoreIndex([repo], 1_000);
  const second = cachedGitIgnoreIndex([repo], 1_001);
  assert.equal(first, second, "the same repository set reuses one cached load");
});
