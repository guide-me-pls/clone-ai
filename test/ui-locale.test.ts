import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { uiStringKeys, uiStrings } from "../src/desktop/ui-locale.ts";

test("English and Chinese chrome tables cover the same keys", () => {
  const keys = uiStringKeys();
  const zh = uiStrings("zh-CN");
  const en = uiStrings("en");
  assert.ok(keys.length > 40);
  for (const key of keys) {
    assert.equal(typeof zh[key], "string", `zh-CN missing ${key}`);
    assert.equal(typeof en[key], "string", `en missing ${key}`);
    assert.ok(zh[key].length > 0, `zh-CN empty ${key}`);
    assert.ok(en[key].length > 0, `en empty ${key}`);
  }
  assert.equal(zh["new-session"], "新建任务");
  assert.equal(en["new-session"], "New task");
});

test("the desktop HTML marks chrome so config.locale can replace it", async () => {
  const html = await readFile(join(process.cwd(), "apps/desktop/ui/index.html"), "utf8");
  assert.match(html, /data-i18n="new-session"/);
  assert.match(html, /id="config-locale"/);
  assert.match(html, /components\.css/);
  assert.match(html, /components\.js/);
  assert.match(html, /id="agent-page"/);
  assert.match(html, /id="mobile-open"/);
  assert.match(html, /data-settings-panel="mobile"/);
  assert.match(html, /id="whatsapp-binding-form"/);
  const js = await readFile(join(process.cwd(), "apps/desktop/ui/app.js"), "utf8");
  assert.match(js, /function applyChrome/);
  assert.match(js, /config\.ui\?\.strings/);
  assert.match(js, /cloneNavigation/);
  assert.match(js, /data-response-pending/);
  assert.match(js, /pending-connect-title/);
  assert.match(js, /empty-model-reply/);
  assert.match(js, /classList\.toggle\("empty-conversation"/);
  assert.match(js, /welcome-copy/);
  assert.match(js, /api\/main-agent\/interruptions/);
  assert.match(js, /api\/mobile\/whatsapp/);
  assert.match(js, /function saveWhatsAppBinding/);
  assert.match(js, /function plainPreview/);
  assert.doesNotMatch(js, /agent-auto-mode|data-agent-auto-mode/);
});

test("the shared component library exposes the primitives used by the UI", async () => {
  const source = await readFile(join(process.cwd(), "apps/desktop/ui/components.js"), "utf8");
  for (const primitive of ["button", "card", "emptyState", "field", "listRow", "sectionHeader", "segmented", "select", "switchControl"]) {
    assert.match(source, new RegExp(`${primitive}[,:]`), primitive);
  }
  assert.match(source, /window\.CloneUI/);
});
