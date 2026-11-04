/**
 * Structural checks for the desktop UI that do not need a browser.
 *
 * Every "weird" UI bug so far had the same shape: the script addressed an id
 * that did not exist, or a stylesheet referenced a file the server did not
 * serve, and the failure was silent. These checks make that shape fail loudly.
 *
 * 不需要浏览器的桌面界面结构检查。
 *
 * 到目前为止每个"莫名其妙"的界面问题都是同一形状：脚本引用了不存在的 id，或样式表引用了
 * 服务器没提供的文件，而失败是静默的。这些检查让这种形状直接报错。
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const ui = join(process.cwd(), "apps", "desktop", "ui");
const read = (name: string): Promise<string> => readFile(join(ui, name), "utf8");

/** Ids created at runtime by the view modules themselves. 由视图模块在运行时自行创建的 id。 */
const RUNTIME_IDS = new Set(["memory-root", "probe-panel", "probe"]);

test("the shell is internally consistent: ids, assets, and strings", async () => {
  const html = await read("index.html");
  const app = await read("app.js");
  const audit = await read("audit.js");
  const memory = await read("memory.js");

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `duplicate ids in index.html: ${duplicates.join(", ")}`);
  const known = new Set(ids);

  // Views also render elements with ids from their own templates; those count as defined.
  // 视图也会在自己的模板里渲染带 id 的元素；这些同样算已定义。
  for (const source of [app, audit, memory]) {
    for (const match of source.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)) known.add(match[1]!);
    for (const match of source.matchAll(/id:\s*"([A-Za-z0-9_-]+)"/g)) known.add(match[1]!);
  }

  const referenced = new Set<string>();
  for (const source of [app, audit, memory]) {
    for (const match of source.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) referenced.add(match[1]!);
    for (const match of source.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)) referenced.add(match[1]!);
  }
  const missing = [...referenced].filter((id) => !known.has(id) && !RUNTIME_IDS.has(id));
  assert.deepEqual(missing, [], `scripts read ids that index.html does not define: ${missing.join(", ")}`);

  const assets = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]!);
  for (const asset of assets) {
    await access(join(ui, asset));
  }
  assert.ok(assets.includes("audit.css") && assets.includes("audit.js"), "the audit view must ship with the shell");
  assert.ok(assets.includes("memory.css") && assets.includes("memory.js"), "the memory view must ship with the shell");

  const locale = await readFile(join(process.cwd(), "src", "desktop", "ui-locale.ts"), "utf8");
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]!);
  const escapes = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const untranslated = [...new Set(keys)].filter((key) => {
    const pattern = new RegExp(`(?:["']${escapes(key)}["']|\\b${escapes(key)})\\s*:`);
    return !pattern.test(locale);
  });
  assert.deepEqual(untranslated, [], `markup points at missing strings: ${untranslated.join(", ")}`);
});

test("interactive views style their own truncation, so long text cannot stretch a row", async () => {
  const css = (await read("style.css")) + (await read("components.css")) + (await read("audit.css")) + (await read("memory.css"));
  // One-line previews: the session list must ellipsize rather than wrap. 单行预览：会话列表必须省略号截断而不是换行。
  assert.match(css, /\.session \.session-title[^{]*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.session \.session-title[^{]*\{[^}]*text-overflow:\s*ellipsis/);
  // Long ids, payloads and memory text must break inside their column. 长 id、载荷与记忆正文必须在列内断行。
  assert.match(css, /\.au-trace-item span[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  // A hidden panel must actually hide even when its layout sets display. 布局设了 display 的隐藏面板也必须真的隐藏。
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});