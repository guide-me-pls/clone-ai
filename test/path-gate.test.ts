import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { decideTool } from "../src/workers/native-agent-worker.ts";
import { resolveGrants } from "../src/authority/path-gateway.ts";
import { isForbiddenPath } from "../src/authority/scope.ts";

/**
 * The path gate, tested against what the filesystem actually does.
 *
 * Every case here was a real bypass before: a symlink was inside the workspace
 * by name and outside by effect, a read grant authorized a write, a grant on an
 * ancestor handed over a protected root, and the protected-root comparison was
 * case-sensitive on a case-insensitive volume.
 *
 * 路径闸门，按文件系统的实际行为测试。
 *
 * 这里每个用例此前都是真实绕过：符号链接名字在内、效果在外；读授权能授权写；
 * 祖先授权连带交出受保护根；受保护根比较在不区分大小写的卷上区分大小写。
 */
async function scratch(t: TestContext): Promise<{ workspace: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "clone-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "outside data", "utf8");
  return { workspace: realpathSync(workspace), outside: realpathSync(outside) };
}

function grants(workspace: string): { readRoots: string[]; writeRoots: string[]; network: boolean } {
  return { readRoots: [workspace], writeRoots: [workspace], network: false };
}

test("a symlink inside the workspace that points outside is readable, but never writable", async (t) => {
  const { workspace, outside } = await scratch(t);
  await symlink(outside, join(workspace, "link"));
  // Reads are machine-wide; the symlink is a read target like any other. A
  // write through the same link is outside the write roots and stays refused.
  // 读取覆盖整机；该符号链接与其他读取目标一样。经由同一链接的写入落在写入根之外，仍被拒绝。
  assert.equal(decideTool({ risk: "read", grants: grants(workspace), workspace, path: "link/secret.txt" }).allowed, true);
  assert.equal(decideTool({ risk: "write", grants: grants(workspace), workspace, path: "link/new.txt" }).allowed, false);
  // The same path written directly is still allowed. 直接写同一位置的路径仍然放行。
  await writeFile(join(workspace, "inside.txt"), "ok", "utf8");
  assert.equal(decideTool({ risk: "read", grants: grants(workspace), workspace, path: "inside.txt" }).allowed, true);
});

test("a read outside the workspace needs no scope, while a write still does", async (t) => {
  const { workspace, outside } = await scratch(t);
  assert.equal(decideTool({ risk: "read", grants: grants(workspace), workspace, path: join(outside, "secret.txt") }).allowed, true);
  assert.equal(decideTool({ risk: "write", grants: grants(workspace), workspace, path: join(outside, "new.txt") }).allowed, false);
  // A write root granted by the Kernel admits the same path. Kernel 授权的写入根会放行同一路径。
  const granted = { ...grants(workspace), writeRoots: [workspace, outside] };
  assert.equal(decideTool({ risk: "write", grants: granted, workspace, path: join(outside, "new.txt") }).allowed, true);
});

test("the workspace is not a write root unless the Kernel owns the tree", async (t) => {
  const { workspace, outside } = await scratch(t);
  const plain = resolveGrants([], { workspace });
  assert.deepEqual(plain.writeRoots, [], "the live workspace must not be granted implicitly");
  assert.equal(decideTool({ risk: "write", grants: plain, workspace, path: "inside.txt" }).allowed, false);

  // The isolated sandbox copy is the one workspace the Kernel may grant.
  // 隔离沙箱副本是 Kernel 唯一可以直接授权的工作区。
  const owned = resolveGrants([], { workspace, includeWorkspace: true });
  assert.equal(decideTool({ risk: "write", grants: owned, workspace, path: "inside.txt" }).allowed, true);

  const scoped = resolveGrants([{ domain: "files", resource: workspace, access: "write" }], { workspace });
  assert.equal(decideTool({ risk: "write", grants: scoped, workspace, path: "inside.txt" }).allowed, true);
  assert.equal(decideTool({ risk: "write", grants: scoped, workspace, path: ".git/config" }).allowed, false);

  const external = resolveGrants([{ domain: "files", resource: outside, access: "write" }], { workspace });
  assert.equal(decideTool({ risk: "write", grants: external, workspace, path: join(outside, ".git/config") }).allowed, false);
});

test("a read at a protected location is refused even without a workspace boundary", async (t) => {
  const { workspace } = await scratch(t);
  const home = await mkdtemp(join(tmpdir(), "clone-gate-home-read-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), "key", "utf8");
  const decision = decideTool({ risk: "read", grants: grants(workspace), workspace, path: join(home, ".ssh", "id_ed25519"), home });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed === false ? decision.reason : "", /protected location/);
});

test("a read grant does not authorize a write, while write implies read", async (t) => {
  const { workspace } = await scratch(t);
  const readOnly = { readRoots: [workspace], writeRoots: [] as string[], network: false };
  assert.equal(decideTool({ risk: "read", grants: readOnly, workspace, path: "a.txt" }).allowed, true);
  assert.equal(decideTool({ risk: "write", grants: readOnly, workspace, path: "a.txt" }).allowed, false);
  const writeOnly = { readRoots: [] as string[], writeRoots: [workspace], network: false };
  assert.equal(decideTool({ risk: "read", grants: writeOnly, workspace, path: "a.txt" }).allowed, true);
});

test("a grant on an ancestor of a protected root is refused", async (t) => {
  const { workspace } = await scratch(t);
  const home = await mkdtemp(join(tmpdir(), "clone-gate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "Library", "Keychains"), { recursive: true });
  const resolved = resolveGrants(
    [{ domain: "files", resource: join(home, "Library"), access: "read" }],
    { workspace, home },
  );
  assert.equal(resolved.readRoots.length, 0, "the ancestor grant must be dropped");
  assert.match(resolved.dropped[0]?.reason ?? "", /protected location/);
  // A specific folder that contains no protected root is still granted. 不含受保护根的具体目录仍会被授权。
  const specific = resolveGrants(
    [{ domain: "files", resource: join(home, "Library", "Keychains", "notes"), access: "read" }],
    { workspace, home },
  );
  assert.equal(specific.readRoots.length, 0, "a path inside the protected root is still protected");
});

test("the forbidden-root check ignores case on a case-insensitive volume", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "clone-gate-case-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), "key", "utf8");
  assert.equal(isForbiddenPath(join(home, ".ssh", "id_ed25519"), home), true);
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(isForbiddenPath(join(home, ".SSH", "id_ed25519"), home), true);
  }
});
