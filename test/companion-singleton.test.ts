import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { startCompanionServer } from "../src/companion-server.ts";
import { COMPANION_INSTANCE_LOCK } from "../src/companion-instance.ts";

/**
 * One clone home has one runtime. A second sidecar used to start silently,
 * overwrite the endpoint and the turn owner, and then delete the endpoint on
 * exit while the first process was still serving — the window then waited 60 s
 * for an endpoint nobody would publish. A live owner must make the second start
 * refuse before it writes anything.
 *
 * 一个 clone home 只有一个运行时。第二个 sidecar 过去会静默启动、覆盖端点与回合台账，
 * 退出时又在第一个进程仍在服务的情况下删除端点——窗口随后空等 60 秒。存活属主必须让第二次
 * 启动在写入任何东西之前被拒绝。
 */

const ROOT = process.cwd();

function pinMiningOff(t: TestContext): void {
  const previous = process.env.CLONE_AI_MEMORY_MINING;
  process.env.CLONE_AI_MEMORY_MINING = "off";
  t.after(() => {
    if (previous === undefined) delete process.env.CLONE_AI_MEMORY_MINING;
    else process.env.CLONE_AI_MEMORY_MINING = previous;
  });
}

async function temporaryHome(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-singleton-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function endpoint(directory: string): Promise<string | undefined> {
  return readFile(join(directory, "companion-endpoint.json"), "utf8").catch(() => undefined);
}

/** Runs the real sidecar entry in a separate process, bounded so a regression cannot hang the suite. 在独立进程中运行真实的 sidecar 入口；有界，回归不会挂住套件。 */
async function runSidecar(directory: string): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["CLONE_AI_HOME", "CLONE_AI_DATA_DIR", "CLONE_AI_WORKSPACE", "CLONE_AI_MEMORY_MINING", "CLONE_AI_PORT"]) {
    delete env[key];
  }
  Object.assign(env, {
    CLONE_HOME: directory,
    CLONE_AI_PORT: "0",
    CLONE_AI_MEMORY_MINING: "off",
    CLONE_AI_DESKTOP_CLIENT_PATH: join(ROOT, "apps/desktop/ui/index.html"),
  });
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "src/desktop-sidecar.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((resolveOutcome) => {
    const timer = setTimeout(() => resolveOutcome({ code: null, timedOut: true }), 8_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveOutcome({ code, timedOut: false });
    });
  });
  if (outcome.timedOut) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000)),
      ]);
    }
  }
  return { ...outcome, stderr };
}

test("a second sidecar on a live home refuses to start and leaves the endpoint alone", async (t) => {
  pinMiningOff(t);
  const directory = await temporaryHome(t);
  const first = await startCompanionServer({ port: 0, dataDirectory: directory });
  t.after(() => first.close());

  const published = await endpoint(directory);
  assert.ok(published, "the first runtime must publish its endpoint");

  const second = await runSidecar(directory);
  assert.equal(second.timedOut, false, "a second sidecar started alongside the first");
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /another Clone AI runtime/i);
  assert.match(second.stderr, new RegExp(`pid ${process.pid}`));
  assert.equal(await endpoint(directory), published);
});

test("a second runtime in the same process is refused before it publishes", async (t) => {
  pinMiningOff(t);
  const directory = await temporaryHome(t);
  const first = await startCompanionServer({ port: 0, dataDirectory: directory });
  t.after(() => first.close());

  const published = await endpoint(directory);
  await assert.rejects(
    startCompanionServer({ port: 0, dataDirectory: directory }),
    /already owns this home|Another Clone AI runtime/i,
  );
  assert.equal(await endpoint(directory), published);
});

test("a lock left by a dead process is reclaimed", async (t) => {
  pinMiningOff(t);
  const directory = await temporaryHome(t);
  const lockPath = join(directory, COMPANION_INSTANCE_LOCK);
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner"),
    `${JSON.stringify({ pid: 999_999, token: "dead-owner", startedAt: new Date().toISOString() })}\n`,
    "utf8",
  );

  const server = await startCompanionServer({ port: 0, dataDirectory: directory });
  await server.close();
  await assert.rejects(readFile(join(lockPath, "owner"), "utf8"), /ENOENT/);
});