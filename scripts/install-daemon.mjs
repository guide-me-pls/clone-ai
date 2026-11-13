#!/usr/bin/env node
/**
 * Install (or remove) the resident companion daemon as a per-user LaunchAgent.
 *
 * The desktop app is a window; this job is the runtime. `RunAtLoad` starts it at
 * login and `KeepAlive` restarts it after a crash, so quitting the window no
 * longer stops the twin. The app attaches to the endpoint the daemon publishes.
 *
 * 把常驻 companion Daemon 安装（或移除）为当前用户的 LaunchAgent。
 *
 * 桌面 App 是窗口，本任务才是运行时。`RunAtLoad` 在登录时启动它，`KeepAlive` 在崩溃后
 * 重启它，因此关闭窗口不再停掉分身。App 附着到 Daemon 发布的端点。
 *
 * Usage:
 *   node scripts/install-daemon.mjs            # install and load
 *   node scripts/install-daemon.mjs --uninstall
 *   node scripts/install-daemon.mjs --print    # print the plist, install nothing
 */
import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  DAEMON_LABEL,
  launchAgentPaths,
  renderLaunchAgentPlist,
  removeLaunchAgent,
  writeLaunchAgent,
} from "../src/desktop/daemon-supervisor.ts";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const home = homedir();
const launchAgents = join(home, "Library", "LaunchAgents");
const log = join(home, ".clone", "companion.log");
const entry = join(root, "src", "desktop-sidecar.ts");
const client = join(root, "apps", "desktop", "ui", "index.html");

const options = {
  label: DAEMON_LABEL,
  node: process.execPath,
  entry,
  workingDirectory: root,
  log,
  environment: {
    CLONE_AI_RESIDENT_DAEMON: "1",
    CLONE_AI_DESKTOP_CLIENT_PATH: client,
  },
  launchAgentsDirectory: launchAgents,
};

if (process.argv.includes("--print")) {
  process.stdout.write(renderLaunchAgentPlist(options));
  process.exit(0);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function launchctl(...args) {
  try {
    return await run("launchctl", args, { encoding: "utf8" });
  } catch (error) {
    return { stdout: "", stderr: String(error?.stderr ?? error?.message ?? error) };
  }
}

const domain = `gui/${process.getuid()}`;
const plist = launchAgentPaths(home, DAEMON_LABEL).plist;

if (process.argv.includes("--uninstall")) {
  await launchctl("bootout", domain, plist);
  await removeLaunchAgent(options);
  console.log(`Removed ${plist}`);
  console.log("The runtime will not start at login until you install it again.");
  process.exit(0);
}

if (!(await exists(entry))) {
  console.error(`Missing sidecar entry: ${entry}`);
  process.exit(1);
}
await mkdir(join(home, ".clone"), { recursive: true });
await chmod(join(home, ".clone"), 0o700).catch(() => undefined);
await writeLaunchAgent(options);

// Reload so the plist on disk is the one launchd is running.
await launchctl("bootout", domain, plist);
const bootstrapped = await launchctl("bootstrap", domain, plist);
if (bootstrapped.stderr.trim().length > 0) {
  console.error(bootstrapped.stderr.trim());
  console.error("The plist is written; load it with:");
  console.error(`  launchctl bootstrap ${domain} ${plist}`);
  process.exit(1);
}
await launchctl("kickstart", "-k", `${domain}/${DAEMON_LABEL}`);

console.log(`LaunchAgent: ${plist}`);
console.log(`Log:         ${log}`);
console.log(`Endpoint:    ${join(home, ".clone", "companion-endpoint.json")}`);
console.log("");
console.log("The runtime now starts at login and restarts after a crash.");
console.log("Closing the app window no longer stops it; quit means quit the window.");
console.log("Remove it with: node scripts/install-daemon.mjs --uninstall");

// A fresh install has no endpoint yet; say so instead of pretending.
const endpoint = await readFile(join(home, ".clone", "companion-endpoint.json"), "utf8").catch(() => undefined);
if (endpoint === undefined) {
  console.log("\nWaiting for the daemon to publish its endpoint (check the log if this takes long).");
}
