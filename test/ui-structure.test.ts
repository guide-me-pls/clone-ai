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
import { runInNewContext } from "node:vm";

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

test("composer Enter respects IME composition and the 100 ms grace period", async () => {
  const app = await read("app.js");
  const start = app.indexOf("const IME_ENTER_GRACE_MS = 100;");
  const end = app.indexOf('document.addEventListener("keydown"', start);
  assert.ok(start >= 0 && end > start, "composer IME handlers must exist");
  const handlers: Record<string, (event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number; preventDefault: () => void }) => void> = {};
  let now = 1000;
  let submits = 0;
  runInNewContext(app.slice(start, end), {
    Date: { now: () => now },
    $: (id: string) => id === "query"
      ? { addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; } }
      : { requestSubmit: () => { submits += 1; } },
  });
  const enter = (options: Partial<{ key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }> = {}) => {
    let prevented = false;
    handlers.keydown!({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...options, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const compositionEvent = { key: "", shiftKey: false, isComposing: false, keyCode: 0, preventDefault: () => {} };
  handlers.compositionstart!(compositionEvent);
  assert.equal(enter(), true);
  handlers.compositionend!(compositionEvent);
  now += 99;
  assert.equal(enter(), true);
  assert.equal(submits, 0);
  now += 1;
  assert.equal(enter({ isComposing: true }), true);
  assert.equal(enter({ keyCode: 229 }), true);
  assert.equal(submits, 0);
  assert.equal(enter({ shiftKey: true }), false);
  assert.equal(enter({ key: "a" }), false);
  assert.equal(enter(), true);
  assert.equal(submits, 1);
});

test("populated conversations stay vertical and empty-state flex requires no messages", async () => {
  const app = await read("app.js");
  const start = app.indexOf("function renderSession(session)");
  const end = app.indexOf("async function selectSession", start);
  assert.ok(start >= 0 && end > start, "renderSession must exist");
  let empty = false;
  const content = { innerHTML: "" };
  const renderSession = runInNewContext(`${app.slice(start, end)}; renderSession`, {
    setTopbar: () => {},
    document: { body: { classList: { toggle: (_name: string, value: boolean) => { empty = value; } } } },
    state: { signatures: {} },
    $: (id: string) => id === "conversation-inner" ? content : { scrollTop: 0 },
    welcomeMarkup: () => "welcome",
    day: () => "today",
    messageMarkup: () => '<div class="message"></div>',
    recalledMemoryMarkup: () => "", planMarkup: () => "", agentsMarkup: () => "",
    evidenceMarkup: () => "", approvalMarkup: () => "", reviewMarkup: () => "", traceMarkup: () => "",
    restoreDisclosureScrolls: () => {}, requestAnimationFrame: () => {}, updateScrollBottom: () => {},
  });
  renderSession(null);
  assert.equal(empty, true);
  renderSession({ id: "test", updatedAt: "today", messages: [] });
  assert.equal(empty, true);
  renderSession({ id: "test", updatedAt: "today", messages: [{ text: "one" }, { text: "two" }] });
  assert.equal(empty, false);
  assert.equal((content.innerHTML.match(/class="message"/g) || []).length, 2);

  const css = (await read("style.css")) + (await read("audit.css")) + (await read("memory.css")) + (await read("components.css"));
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const flexContainers = rules.filter(([, selector, declarations]) => selector!.includes(".conversation-inner") && /display:\s*(?:inline-)?flex\b/.test(declarations!));
  assert.ok(flexContainers.length > 0, "empty conversation needs its flex layout");
  for (const [, selector] of flexContainers) assert.match(selector!, /\.conversation-inner:not\(:has\(\.message\)\)/);
  assert.match(css, /\.conversation-inner\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.message\s*\{[^}]*display:\s*block[^}]*width:\s*100%/);
  assert.match(css, /\.message\.person\s*\{[^}]*width:\s*100%/);
});
