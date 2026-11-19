/**
 * The installed native window is the only UI entry.
 *
 * A browser preview is a second, real execution surface with the owner's
 * credentials; its home is isolated from `~/.clone`, so a task started there
 * can never appear in the app. These checks keep the product surface
 * single-entry: the app's supervised loopback server stays, the browser
 * preview entry does not.
 *
 * 已安装的原生窗口是唯一的界面入口。
 *
 * 浏览器预览是第二个真实执行面，带着所有者的凭据；它的 home 与 `~/.clone`
 * 隔离，在那里发起的任务永远不会出现在 App 里。这些检查让产品面保持单入口：
 * App 的受监督 loopback 服务保留，浏览器预览入口不存在。
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

async function exists(path: string): Promise<boolean> {
  return access(join(root, path)).then(() => true, () => false);
}

test("the repository exposes no browser preview entry", async () => {
  assert.equal(
    await exists(".claude/launch.json"),
    false,
    "a launch config lets a session start a browser UI on a fixed port",
  );
  assert.equal(
    await exists("scripts/companion-dev.mjs"),
    false,
    "the browser preview server must not ship",
  );
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.["companion:dev"], undefined, "companion:dev starts the browser preview");
  const previewScripts = Object.entries(pkg.scripts ?? {})
    .filter(([, command]) => command.includes("companion-dev"));
  assert.deepEqual(
    previewScripts,
    [],
    `no package script may start the browser preview: ${previewScripts.map(([name]) => name).join(", ")}`,
  );
});

test("the native window keeps its supervised loopback server", async () => {
  const sidecar = await readFile(join(root, "src", "desktop-sidecar.ts"), "utf8");
  assert.match(sidecar, /startCompanionServer\s*\(/);
  assert.match(sidecar, /port:\s*0/);
  const html = await readFile(join(root, "apps", "desktop", "ui", "index.html"), "utf8");
  assert.match(html, /<title>/);
});