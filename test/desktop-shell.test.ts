import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("the native app is the only desktop UI entry", async () => {
  const [manifestSource, cliSource, macShell, devDriver] = await Promise.all([
    readFile(join(process.cwd(), "package.json"), "utf8"),
    readFile(join(process.cwd(), "src/cli/clone-ai.ts"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/macos/main.swift"), "utf8"),
    readFile(join(process.cwd(), "scripts/desktop-dev.mjs"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as { scripts?: Record<string, string> };

  assert.equal(manifest.scripts?.gui, undefined);
  assert.equal(manifest.scripts?.["companion:debug"], undefined);
  assert.equal(manifest.scripts?.["desktop:dev"], "node scripts/desktop-dev.mjs");
  assert.doesNotMatch(cliSource, /openAppWindow|openBrowser|app-window/);
  assert.match(cliSource, /spawn\("\/usr\/bin\/open", \[appBundle\]/);
  assert.match(macShell, /NSToolbar/);
  assert.match(macShell, /NSSegmentedControl/);
  assert.match(macShell, /NSMenu\(title: "视图"\)/);
  assert.match(macShell, /navigationTitles = \["对话", "定时任务", "Agent", "记忆", "设置"\]/);
  assert.match(macShell, /WKUIDelegate/);
  assert.match(macShell, /webView\.uiDelegate = self/);
  assert.match(macShell, /runOpenPanelWith parameters: WKOpenPanelParameters/);
  assert.match(macShell, /panel\.allowedContentTypes = \[\.image, \.movie\]/);
  assert.match(macShell, /CLONE_AI_DEV_ROOT/);
  assert.match(macShell, /SIGUSR1/);
  assert.match(devDriver, /CLONE_AI_DEV_ROOT: root/);
  assert.match(devDriver, /apps", "desktop", "ui"/);
  assert.match(devDriver, /--app-only/);
  assert.doesNotMatch(macShell, /loadHTMLString/);
});
