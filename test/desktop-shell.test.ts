import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("the native desktop app is the only product entry", async () => {
  const [manifestSource, indexSource, appSource, auditSource, macShell, devDriver] = await Promise.all([
    readFile(join(process.cwd(), "package.json"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/ui/index.html"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/ui/app.js"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/ui/audit.js"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/macos/main.swift"), "utf8"),
    readFile(join(process.cwd(), "scripts/desktop-dev.mjs"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as { bin?: unknown; scripts?: Record<string, string> };

  // The product has one entry: the app bundle. The former CLI, headless server
  // and developer query entry must not come back as package metadata.
  // 产品只有一个入口：App 包。此前的 CLI、无界面服务器与开发查询入口不得以包元数据回归。
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.scripts?.gui, undefined);
  assert.equal(manifest.scripts?.cli, undefined);
  assert.equal(manifest.scripts?.main, undefined);
  assert.equal(manifest.scripts?.server, undefined);
  assert.equal(manifest.scripts?.["companion:debug"], undefined);
  assert.equal(manifest.scripts?.["desktop:dev"], "node scripts/desktop-dev.mjs");
  assert.equal(manifest.scripts?.traces, "node --experimental-strip-types scripts/traces.mjs");
  assert.equal(manifest.scripts?.selfcheck, "node --experimental-strip-types scripts/selfcheck.mjs");
  assert.equal(manifest.scripts?.repair, "node --experimental-strip-types scripts/repair.mjs");
  assert.equal(manifest.scripts?.["audit:export"], "node --experimental-strip-types scripts/audit-export.mjs");
  await assert.rejects(access(join(process.cwd(), "src/cli/clone-ai.ts")));
  await assert.rejects(access(join(process.cwd(), "src/server-main.ts")));
  await assert.rejects(access(join(process.cwd(), "src/main-agent/clone-main.ts")));

  // Owner actions that used to exist only in the CLI now have desktop surfaces.
  // 过去只在 CLI 中存在的所有者动作，现在有桌面界面。
  assert.match(indexSource, /id="authority-root"/);
  assert.match(indexSource, /id="data-export-choose"/);
  assert.match(appSource, /"\/api\/authority\/domains"/);
  assert.match(appSource, /"\/api\/export"/);
  // The agent page reads providers from state; a bare binding blocked the
  // first refresh after the merge that introduced it.
  // Agent 页面从 state 读取 providers；裸绑定曾在引入它的合并后阻塞首次刷新。
  assert.match(appSource, /const providerRows = state\.providers\.map/);
  assert.match(appSource, /const providerById = new Map\(state\.providers\.map/);
  assert.match(appSource, /const installed = state\.providers\.filter/);
  assert.match(appSource, /const missing = state\.providers\.filter/);
  assert.match(appSource, /const options = state\.providers\.map/);
  assert.match(auditSource, /"\/api\/reporting\/bad-cases"/);
  assert.match(auditSource, /\/api\/improvement\/suggestions\//);
  assert.match(auditSource, /\/cancel/);

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
