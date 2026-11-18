import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("the native desktop app is the only product entry", async () => {
  const [manifestSource, indexSource, appSource, auditSource, macShell, devDriver, buildScript] = await Promise.all([
    readFile(join(process.cwd(), "package.json"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/ui/index.html"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/ui/app.js"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/ui/audit.js"), "utf8"),
    readFile(join(process.cwd(), "apps/desktop/macos/main.swift"), "utf8"),
    readFile(join(process.cwd(), "scripts/desktop-dev.mjs"), "utf8"),
    readFile(join(process.cwd(), "scripts/build-macos-app.mjs"), "utf8"),
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
  // Attachments carry text documents, PDF and .docx as well as images, and the
  // window accepts a dropped file instead of only a picker selection.
  // 附件除图片外也承载文本文档、PDF 与 .docx，窗口接受拖入文件，而不只是选择器选择。
  assert.match(indexSource, /id="attachments" type="file" accept="[^"]*text\/\*/);
  assert.match(indexSource, /accept="[^"]*\.pdf[^"]*\.docx[^"]*\.doc/);
  assert.match(appSource, /isTextDocumentFile/);
  assert.match(appSource, /binaryDocumentKind/);
  assert.match(appSource, /DOC_MIME/);
  assert.match(appSource, /attachmentReports/);
  assert.match(appSource, /addEventListener\("drop"/);
  assert.match(appSource, /dataTransfer\?\.types/);
  assert.match(macShell, /NSMenu\(title: "视图"\)/);
  assert.match(macShell, /navigationTitles = \["对话", "定时任务", "Agent", "记忆", "设置"\]/);
  assert.match(macShell, /WKUIDelegate/);
  assert.match(macShell, /webView\.uiDelegate = self/);
  assert.match(macShell, /runOpenPanelWith parameters: WKOpenPanelParameters/);
  assert.match(macShell, /panel\.allowedContentTypes = \[\.image, \.movie, \.text, \.json, \.commaSeparatedText, \.pdf\]/);
  assert.match(macShell, /\["docx", "doc"\]\.compactMap/);
  assert.match(macShell, /CLONE_AI_DOCUMENT_TOOL/);
  assert.match(buildScript, /document-tool\.swift/);
  assert.match(buildScript, /CloneAIDocumentTool/);
  assert.match(macShell, /CLONE_AI_DEV_ROOT/);
  assert.match(macShell, /SIGUSR1/);
  assert.match(devDriver, /CLONE_AI_DEV_ROOT: root/);
  assert.match(devDriver, /apps", "desktop", "ui"/);
  assert.match(devDriver, /--app-only/);
  // The window is not a dead end when the runtime it spawned stops: it
  // relaunches with exponential backoff, probes the health route the server
  // already exposes, follows a republished endpoint in resident mode, and
  // shows the captured stderr instead of telling the owner to reopen the app.
  // 窗口在它拉起的运行时停止后不是死路：按指数退避重启，探测服务端已有的健康路由，在
  // 常驻模式下跟随重新发布的端点，并显示捕获的 stderr，而不是让所有者重开应用。
  assert.match(macShell, /scheduleRuntimeRestart/);
  assert.match(macShell, /min\(30\.0, pow\(2\.0/);
  assert.match(macShell, /startHealthMonitor/);
  assert.match(macShell, /probeRuntimeHealth/);
  assert.match(macShell, /appendingPathComponent\("api\/health"\)/);
  assert.match(macShell, /retryResidentAttach/);
  assert.match(macShell, /didFailProvisionalNavigation/);
  assert.match(macShell, /sidecarStderrTail/);
  // A packaged launch from Finder has no environment: the window asks launchd
  // whether the job is loaded and attaches instead of spawning a second writer,
  // while a checkout without the job keeps its private runtime.
  // 从 Finder 打开的打包启动没有环境：窗口询问 launchd 任务是否已加载并选择附着，而不是
  // 再拉起一个写者；没有该任务的检出仍保留私有运行时。
  assert.match(macShell, /launchAgentIsLoaded/);
  assert.match(macShell, /"\/bin\/launchctl"/);
  assert.match(macShell, /gui\/\\\(getuid\(\)\)/);
  assert.match(macShell, /launchAgentLabel = "ai\.clone\.companion"/);
  assert.match(macShell, /private var residentRuntime = false/);
  assert.doesNotMatch(macShell, /private var residentRuntime: Bool/);
  assert.doesNotMatch(macShell, /请关闭应用后重新打开/);
  assert.doesNotMatch(macShell, /loadHTMLString/);
});
