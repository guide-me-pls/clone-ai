import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  launchAgentPaths,
  readLaunchAgentState,
  removeLaunchAgent,
  renderLaunchAgentPlist,
  resolveDaemonCommand,
  writeLaunchAgent,
  type LaunchAgentOptions,
} from "../src/desktop/daemon-supervisor.ts";

async function tempDir(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-daemon-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function options(directory: string, overrides: Partial<LaunchAgentOptions> = {}): LaunchAgentOptions {
  return {
    label: "ai.clone.companion",
    node: "/usr/bin/node",
    entry: "/opt/clone/src/desktop-sidecar.ts",
    workingDirectory: "/opt/clone",
    log: join(directory, "companion.log"),
    environment: {},
    launchAgentsDirectory: join(directory, "LaunchAgents"),
    ...overrides,
  };
}

test("the plist keeps the runtime alive across crashes and logins", () => {
  const plist = renderLaunchAgentPlist(options("/tmp/owner"));

  // Run at login and restart on exit: this is what "resident" means.
  // 登录即启动、退出即重启：这就是"常驻"的含义。
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>Label<\/key><string>ai\.clone\.companion<\/string>/);
  // A crash loop must not spin: the throttle is the backstop.
  // 崩溃循环不能空转：节流是兜底。
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  // The ready line is how the shell learns the port; it must reach the log.
  // ready 行是外壳得知端口的方式；它必须进入日志。
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/tmp\/owner\/companion\.log<\/string>/);
  assert.match(plist, /--experimental-strip-types/);
});

test("the plist escapes XML metacharacters in paths", () => {
  const plist = renderLaunchAgentPlist(options("/tmp/owner", {
    entry: "/tmp/a&b/src/desktop-sidecar.ts",
    workingDirectory: "/tmp/a<b>",
    log: "/tmp/q\"uote.log",
  }));
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /a&lt;b&gt;/);
  assert.match(plist, /q&quot;uote\.log/);
  // No raw metacharacter survives.
  // 没有未转义的元字符残留。
  assert.equal(plist.includes("a&b"), false);
});

test("writing the agent makes it private and idempotent", async (t) => {
  const directory = await tempDir(t);
  const input = options(directory);
  const plist = await writeLaunchAgent(input);
  assert.equal(plist, join(directory, "LaunchAgents", "ai.clone.companion.plist"));
  // A plist names executables and log paths; it is not world-readable.
  // plist 点名可执行文件与日志路径，不应全局可读。
  assert.equal((await stat(plist)).mode & 0o077, 0);

  await writeLaunchAgent(input);
  const written = await readFile(plist, "utf8");
  assert.equal(written.split("<plist").length - 1, 1, "rewriting must replace, not append");
});

test("removing an agent that is not installed is not an error", async (t) => {
  const directory = await tempDir(t);
  await removeLaunchAgent(options(directory));
  assert.equal(await readLaunchAgentState(join(directory, "LaunchAgents"), "ai.clone.companion"), "absent");
});

test("the daemon command is the same entry the shell would have spawned", () => {
  const command = resolveDaemonCommand({
    node: "/usr/local/bin/node",
    entry: "/opt/clone/src/desktop-sidecar.ts",
    workingDirectory: "/opt/clone",
  });
  // Same entry, same flag: the plist changes *who* supervises, not what runs.
  // 同一个入口、同一个参数：plist 改变的是"谁托管"，不是"跑什么"。
  assert.deepEqual(command, ["/usr/local/bin/node", "--experimental-strip-types", "/opt/clone/src/desktop-sidecar.ts"]);
});

test("an installed plist is reported as installed", async (t) => {
  const directory = await tempDir(t);
  const launchAgents = join(directory, "LaunchAgents");
  await mkdir(launchAgents, { recursive: true });
  await writeFile(join(launchAgents, "ai.clone.companion.plist"), "<plist/>", "utf8");
  assert.equal(await readLaunchAgentState(launchAgents, "ai.clone.companion"), "installed");
});

test("the default install location is the owner's LaunchAgents folder", () => {
  const paths = launchAgentPaths("/Users/owner", "ai.clone.companion");
  assert.equal(paths.directory, "/Users/owner/Library/LaunchAgents");
  assert.equal(paths.plist, "/Users/owner/Library/LaunchAgents/ai.clone.companion.plist");
});
