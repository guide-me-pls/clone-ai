#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const app = join(root, "dist", "Clone AI.app");
const executable = join(app, "Contents", "MacOS", "CloneAI");
const buildScript = join(root, "scripts", "build-macos-app.mjs");
const mainSwift = join(root, "apps", "desktop", "macos", "main.swift");

let appProcess = null;
let stopping = false;
let reloadTimer = null;
let rebuildTimer = null;
let rebuilding = false;
const expectedExits = new WeakSet();

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
  try {
    execFileSync("/usr/bin/pkill", ["-x", "CloneAI"], { stdio: "ignore" });
  } catch {
    // No running instance is the normal case.
    // 没有正在运行的实例才是正常情况。
  }
}

function launchApp() {
  if (stopping) return;
  stopOtherInstances();
  console.log("[desktop:dev] launching live source from", root);
  const child = spawn(executable, [], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CLONE_AI_DEV_ROOT: root,
      CLONE_AI_DEV_NODE: process.execPath,
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
    child.kill("SIGTERM");
  });
  if (appProcess === child) appProcess = null;
}

function scheduleRuntimeReload(name) {
  if (stopping) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (appProcess === null) {
      launchApp();
      return;
    }
    console.log(`[desktop:dev] ${name} changed; refreshing the running app`);
    appProcess.kill("SIGUSR1");
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
      launchApp();
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
}

async function main() {
  if (await appNeedsBuild()) buildApp();
  launchApp();

  watchTree(join(root, "src"), (name) => /\.(?:ts|js|json)$/.test(name), scheduleRuntimeReload);
  watchTree(join(root, "apps", "desktop", "ui"), (name) => /\.(?:html|css|js|svg|png)$/.test(name), scheduleRuntimeReload);
  watchTree(join(root, "apps", "desktop", "macos"), (name) => name === "main.swift", scheduleNativeRebuild);
  watch(join(root, "package.json"), () => scheduleRuntimeReload("package.json"));

  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

void main().catch((error) => {
  console.error(`[desktop:dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
