#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const app = join(root, "dist", "Clone AI.app");
const executable = join(app, "Contents", "MacOS", "CloneAI");
const buildScript = join(root, "scripts", "build-macos-app.mjs");
const mainSwift = join(root, "apps", "desktop", "macos", "main.swift");
const reloadMarker = join(
  tmpdir(),
  `clone-ai-dev-reload-${createHash("sha1").update(root).digest("hex").slice(0, 10)}`,
);

let appProcess = null;
let stopping = false;
let reloadTimer = null;
let rebuildTimer = null;
let rebuilding = false;
const expectedExits = new WeakSet();

const daemonLabel = "ai.clone.companion";
const daemonDomain = `gui/${process.getuid()}`;
const daemonPlist = join(homedir(), "Library", "LaunchAgents", `${daemonLabel}.plist`);
let residentDaemonPaused = false;

function launchctl(...args) {
  try {
    execFileSync("/bin/launchctl", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * launchd's KeepAlive restarts a killed job within milliseconds, so `pkill`
 * alone never makes room for the dev sidecar: the resident daemon returns and
 * both processes write one clone home. Boot the job out for the dev session
 * instead. Its plist stays on disk, so a login and the installer both restore
 * it; `resumeResidentDaemon` restores it when this driver exits.
 *
 * launchd 的 KeepAlive 会在毫秒级重启被杀的任务，因此单靠 `pkill` 永远无法给开发
 * sidecar 让位：常驻守护会回来，两个进程同写一个 clone home。开发会话改为把任务
 * bootout；plist 仍在磁盘上，登录与安装器都能恢复它，本驱动退出时由
 * `resumeResidentDaemon` 恢复。
 */
function pauseResidentDaemon() {
  if (residentDaemonPaused || !launchctl("print", `${daemonDomain}/${daemonLabel}`)) return;
  residentDaemonPaused = launchctl("bootout", `${daemonDomain}/${daemonLabel}`);
  if (residentDaemonPaused) {
    console.log("[desktop:dev] resident daemon paused for this dev session");
  } else {
    console.warn("[desktop:dev] could not pause the resident daemon; the sidecar lock will name the owner");
  }
}

function resumeResidentDaemon() {
  if (!residentDaemonPaused) return;
  residentDaemonPaused = false;
  if (launchctl("bootstrap", daemonDomain, daemonPlist)) {
    console.log("[desktop:dev] resident daemon restored");
  } else {
    console.warn(`[desktop:dev] could not restore the resident daemon; run: launchctl bootstrap ${daemonDomain} ${daemonPlist}`);
  }
}

// Registered before the first build: a build failure or a signal during startup
// must still give the twin back. Exit handlers may run only synchronous work,
// and `launchctl bootstrap` is synchronous.
// 在第一次构建之前注册：启动期间的构建失败或信号也必须把分身还回去。退出处理器只能运行
// 同步工作，而 `launchctl bootstrap` 是同步的。
process.once("exit", resumeResidentDaemon);
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

async function modifiedAt(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function appNeedsBuild() {
  const [sourceTime, executableTime] = await Promise.all([modifiedAt(mainSwift), modifiedAt(executable)]);
  return executableTime === 0 || sourceTime > executableTime + 1000;
}

function buildApp() {
  console.log("[desktop:dev] building the native shell");
  execFileSync(process.execPath, [buildScript, "--replace", "--app-only"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
}

function stopOtherInstances() {
  for (const pattern of [
    join(app, "Contents", "MacOS", "CloneAI"),
    join(app, "Contents", "Resources", "runtime", "src", "desktop-sidecar.ts"),
    join(root, "src", "desktop-sidecar.ts"),
  ]) {
    try {
      execFileSync("/usr/bin/pkill", ["-f", pattern], { stdio: "ignore" });
    } catch {
      // No matching process is the normal case.
      // 没有匹配进程才是正常情况。
    }
  }
}

async function launchApp() {
  if (stopping) return;
  stopOtherInstances();
  await writeFile(reloadMarker, `${Date.now()}\n`, "utf8");
  console.log("[desktop:dev] launching live source from", root);
  const child = spawn(executable, [], {
    cwd: root,
    detached: true,
    stdio: "inherit",
    env: {
      ...process.env,
      CLONE_AI_DEV_ROOT: root,
      CLONE_AI_DEV_NODE: process.execPath,
      CLONE_AI_DEV_RELOAD_FILE: reloadMarker,
    },
  });
  appProcess = child;
  child.on("exit", (code, signal) => {
    if (appProcess === child) appProcess = null;
    if (!stopping && !expectedExits.has(child)) {
      console.log(`[desktop:dev] app exited (${signal ?? code}); edit a watched file to relaunch`);
    }
  });
}

async function stopApp() {
  const child = appProcess;
  if (child === null) return;
  expectedExits.add(child);
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  });
  if (appProcess === child) appProcess = null;
}

function scheduleRuntimeReload(name) {
  if (stopping) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    if (appProcess === null) {
      await launchApp();
      return;
    }
    console.log(`[desktop:dev] ${name} changed; refreshing the running app`);
    await writeFile(reloadMarker, `${Date.now()}\n`, "utf8");
  }, 350);
}

function scheduleNativeRebuild(name) {
  if (stopping) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    if (rebuilding) return;
    rebuilding = true;
    try {
      console.log(`[desktop:dev] ${name} changed; rebuilding the native shell`);
      await stopApp();
      buildApp();
      await launchApp();
    } catch (error) {
      console.error(`[desktop:dev] native rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rebuilding = false;
    }
  }, 500);
}

function watchTree(directory, accepted, handler) {
  watch(directory, { recursive: true }, (_event, filename) => {
    if (filename === null) return;
    const name = filename.toString();
    if (accepted(name)) handler(name);
  }).on("error", (error) => {
    console.error(`[desktop:dev] watcher failed for ${directory}: ${error.message}`);
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(reloadTimer);
  clearTimeout(rebuildTimer);
  await stopApp();
  resumeResidentDaemon();
}

async function main() {
  pauseResidentDaemon();
  if (await appNeedsBuild()) buildApp();
  await launchApp();

  watchTree(join(root, "src"), (name) => /\.(?:ts|js|json)$/.test(name), scheduleRuntimeReload);
  watchTree(join(root, "apps", "desktop", "ui"), (name) => /\.(?:html|css|js|svg|png)$/.test(name), scheduleRuntimeReload);
  watchTree(join(root, "apps", "desktop", "macos"), (name) => name === "main.swift", scheduleNativeRebuild);
  watch(join(root, "package.json"), () => scheduleRuntimeReload("package.json"));
}

void main().catch((error) => {
  console.error(`[desktop:dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
