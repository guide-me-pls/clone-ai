import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveDesktopLaunchConfig } from "../src/desktop/launch-config.ts";

test("the macOS app no longer reads or defaults a working directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-desktop-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const clientPath = join(directory, "app", "index.html");
  const env = {
    HOME: directory,
    CLONE_HOME: join(directory, "data"),
    CLONE_AI_DESKTOP_DEFAULT_WORKSPACE: join(directory, "Documents", "Clone AI"),
    CLONE_AI_DESKTOP_CLIENT_PATH: clientPath,
  };
  // The branded default workspace is ignored: there is no configured folder.
  // 带品牌的默认工作区被忽略：没有配置的文件夹。
  assert.deepEqual(await resolveDesktopLaunchConfig(env), { clientPath });
  await mkdir(env.CLONE_HOME, { recursive: true });
  await writeFile(join(env.CLONE_HOME, "config.json"), JSON.stringify({ version: 1, workspacePath: join(directory, "chosen-workspace"), locale: "zh-CN" }));
  // A stored legacy workspacePath is not read back as a setting.
  // 已存的旧 workspacePath 不会被当作设置读回。
  assert.deepEqual(await resolveDesktopLaunchConfig(env), { clientPath });
  // CLONE_AI_WORKSPACE remains a developer override.
  // CLONE_AI_WORKSPACE 仍是开发者覆盖。
  assert.equal(
    (await resolveDesktopLaunchConfig({ ...env, CLONE_AI_WORKSPACE: join(directory, "explicit-workspace") })).workspacePath,
    join(directory, "explicit-workspace"),
  );
});

test("other desktop entry points retain their existing defaults", async () => {
  assert.deepEqual(await resolveDesktopLaunchConfig({}), {});
});
