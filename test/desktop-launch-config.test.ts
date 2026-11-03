import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveDesktopLaunchConfig } from "../src/desktop/launch-config.ts";

test("the macOS app uses its own safe workspace and bundled UI by default", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-desktop-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "Documents", "Clone AI");
  const clientPath = join(directory, "app", "index.html");
  const env = {
    HOME: directory,
    CLONE_HOME: join(directory, "data"),
    CLONE_AI_DESKTOP_DEFAULT_WORKSPACE: workspace,
    CLONE_AI_DESKTOP_CLIENT_PATH: clientPath,
  };
  assert.deepEqual(await resolveDesktopLaunchConfig(env), { workspacePath: workspace, clientPath });
  await mkdir(env.CLONE_HOME, { recursive: true });
  await writeFile(join(env.CLONE_HOME, "config.json"), JSON.stringify({ version: 1, workspacePath: join(directory, "chosen-workspace"), locale: "zh-CN" }));
  assert.equal((await resolveDesktopLaunchConfig(env)).workspacePath, join(directory, "chosen-workspace"));
  assert.equal((await resolveDesktopLaunchConfig({ ...env, CLONE_AI_WORKSPACE: join(directory, "explicit-workspace") })).workspacePath, join(directory, "explicit-workspace"));
});

test("other desktop entry points retain their existing defaults", async () => {
  assert.deepEqual(await resolveDesktopLaunchConfig({}), {});
});
