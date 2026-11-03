import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveGrants } from "../src/authority/path-gateway.ts";
import { buildSeatbeltProfile, sbString, wrapWithSandbox } from "../src/authority/seatbelt.ts";

test("the gateway drops protected, over-broad and unenforced scopes", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clone-gw-")));
  try {
    mkdirSync(join(home, "ws"));
    const grants = resolveGrants([
      { domain: "files", resource: join(home, ".ssh"), access: "read" },
      { domain: "files", resource: home, access: "write" },
      { domain: "files", resource: join(home, "out"), access: "write" },
      { domain: "mail", resource: "*", access: "write" },
      { domain: "network", resource: "example.com", access: "read" },
    ], { workspace: join(home, "ws"), home });
    assert.deepEqual(grants.writeRoots.sort(), [join(home, "out"), join(home, "ws")].sort());
    assert.equal(grants.network, true);
    assert.equal(grants.dropped.length, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("profile strings cannot be broken out of", () => {
  assert.equal(sbString('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => sbString("a\nb"));
});

test("seatbelt confines writes, protected reads and network (darwin only)", { skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec") }, () => {
  // Not under the system temp dir: temp locations are deliberately writable inside the sandbox.
  // 不放在系统临时目录下：临时位置在沙箱内被刻意设为可写。
  const home = realpathSync(mkdtempSync(join(process.cwd(), ".sandbox-test-")));
  try {
    mkdirSync(join(home, "ws")); mkdirSync(join(home, "other")); mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "key"), "secret");
    const grants = resolveGrants([], { workspace: join(home, "ws"), home });
    const profile = buildSeatbeltProfile({ grants, home });
    const run = (script: string) => {
      const w = wrapWithSandbox(profile, "/bin/sh", ["-c", script]);
      return spawnSync(w.command, w.args, { encoding: "utf8" });
    };
    assert.equal(run(`echo ok > "${join(home, "ws", "a.txt")}"`).status, 0);
    assert.equal(readFileSync(join(home, "ws", "a.txt"), "utf8").trim(), "ok");
    assert.notEqual(run(`echo no > "${join(home, "other", "b.txt")}"`).status, 0);
    assert.equal(existsSync(join(home, "other", "b.txt")), false);
    assert.notEqual(run(`cat "${join(home, ".ssh", "key")}"`).status, 0);
    assert.notEqual(run(`/usr/bin/curl -s -m 3 http://127.0.0.1:9 >/dev/null`).status, 0);
    assert.doesNotThrow(() => execFileSync("/usr/bin/true"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a sandboxed black-box worker cannot write outside its workspace (darwin only)", { skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec") }, async () => {
  const { BlackBoxCliWorker } = await import("../src/workers/black-box-cli-worker.ts");
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".sandbox-test-")));
  try {
    const workspace = join(root, "ws");
    mkdirSync(workspace); mkdirSync(join(root, "other"));
    const worker = new BlackBoxCliWorker({
      agentId: "w",
      config: {
        id: "sh",
        command: "/bin/sh",
        args: ["-c", `echo ok > "${workspace}/out.md"; echo no > "${join(root, "other", "x.txt")}"; exit 0`],
        sandbox: "seatbelt",
      },
      workCapabilities: ["drafting"],
    });
    const createdAt = "2026-11-03T00:00:00.000Z";
    const events = [];
    for await (const event of worker.execute({
      run: { id: "r", taskId: "t", status: "running", createdAt, updatedAt: createdAt },
      task: { id: "t", triggerId: "g", title: "t", objective: "o", acceptanceCriteria: ["a"], createdAt },
      step: { id: "s", title: "t", instructions: "i", risk: "reversible_write", acceptanceCriteria: ["a"], agentId: "w", requiredCapabilities: ["drafting"] },
      executor: { agentId: "w", providerId: "sh" },
      workspacePath: workspace,
    })) events.push(event);
    assert.equal(events.some((event) => event.type === "failed" && /sandbox|Unrestricted/i.test(event.message)), false, JSON.stringify(events));
    assert.equal(existsSync(join(workspace, "out.md")), true);
    assert.equal(existsSync(join(root, "other", "x.txt")), false);
    assert.ok(events.some((event) => event.type === "progress" && event.message.startsWith("Sandbox:")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("without a sandbox or host opt-in the worker still refuses", async () => {
  const { BlackBoxCliWorker } = await import("../src/workers/black-box-cli-worker.ts");
  const worker = new BlackBoxCliWorker({ agentId: "w", config: { id: "sh", command: "/bin/sh", args: ["-c", "exit 0"] }, workCapabilities: ["drafting"] });
  const createdAt = "2026-11-03T00:00:00.000Z";
  const events = [];
  for await (const event of worker.execute({
    run: { id: "r", taskId: "t", status: "running", createdAt, updatedAt: createdAt },
    task: { id: "t", triggerId: "g", title: "t", objective: "o", acceptanceCriteria: ["a"], createdAt },
    step: { id: "s", title: "t", instructions: "i", risk: "reversible_write", acceptanceCriteria: ["a"], agentId: "w", requiredCapabilities: ["drafting"] },
    executor: { agentId: "w", providerId: "sh" },
    workspacePath: tmpdir(),
  })) events.push(event);
  assert.equal(events[0]?.type, "failed");
});
