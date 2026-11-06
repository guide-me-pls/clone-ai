import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The 3 s background poll hands the same library back to `renderLibrary`, and the
 * wrapper at the end of apps/desktop/ui/memory.js calls `render()` on every call,
 * which assigns `#memory-root`'s innerHTML again. The browser detaches the input
 * the owner is typing into, so focus falls back to `body`; a textarea holding an
 * unsaved edit is replaced by the stored content.
 *
 * 每 3 秒的后台轮询把同一份 library 再交给 `renderLibrary`，而 memory.js 末尾的包装
 * 每次都会调用 `render()` 重写 `#memory-root` 的 innerHTML；浏览器随即摘下所有者正在
 * 输入的输入框，焦点退回 `body`，含未保存编辑的 textarea 被已保存内容替换。
 */

const memoryScript = readFileSync(join(process.cwd(), "apps", "desktop", "ui", "memory.js"), "utf8");

/** The same escape map the UI components ship; the panel calls it bare. 与界面组件相同的转义表；面板直接调用它。 */
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
}[character] as string));

/** Absorbs any DOM or global helper the view reaches for that the stub does not model. 吸收桩未建模的任意 DOM 或全局辅助物。 */
function anyStub(): any {
  const stub: any = new Proxy(function stub() { return stub; }, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* empty() { /* 空序列 */ };
      if (key === "then") return undefined;
      if (key === "length") return 0;
      if (key === "toString") return () => "";
      return stub;
    },
    set: () => true,
    apply: () => stub,
    has: () => true,
  });
  return stub;
}

/** A library where any extra field the view reads is an empty list. 一个长得像记忆库的对象：视图多读的字段都当作空列表。 */
function makeLibrary(memories: unknown[]): any {
  const stats = { active: memories.length, archived: 0, contentDirectory: "/tmp/memory" };
  return new Proxy({ memories, stats } as any, {
    get: (target, key) => {
      if (typeof key === "symbol" || key in target) return (target as any)[key];
      if (key === "then") return undefined;
      return [];
    },
  });
}

/**
 * Loads apps/desktop/ui/memory.js against a minimal page: one `#memory-root` that
 * records every innerHTML assignment, because a real assignment replaces its
 * whole subtree and detaches whatever the owner was typing in.
 *
 * 在最小页面上加载 apps/desktop/ui/memory.js：只有一个 `#memory-root`，记录每次
 * innerHTML 赋值，因为真实赋值会替换整棵子树并摘下所有者正在输入的东西。
 */
function openMemoryPanel(library?: any) {
  const paints: string[] = [];
  const attached: { isConnected: boolean }[] = [];
  const failures: unknown[] = [];
  let markup = "";

  const body: any = { isConnected: true, tagName: "BODY", closest: () => null, contains: () => true };

  const base: any = {
    id: "memory-root",
    dataset: {},
    get innerHTML() { return markup; },
    set innerHTML(next: string) {
      paints.push(String(next ?? ""));
      // A real innerHTML assignment detaches every node it replaces, and the focused
      // element inside it falls back to body. 真实的 innerHTML 赋值会摘下被替换的所有节点，
      // 位于其中的焦点元素随之退回 body。
      for (const node of attached.splice(0)) node.isConnected = false;
      const active: any = documentStub.activeElement;
      if (active !== undefined && active !== null && active !== body && active.isConnected === false) {
        documentStub.activeElement = body;
      }
      markup = String(next ?? "");
    },
    appendChild(node: any) { node.isConnected = true; attached.push(node); return node; },
    insertBefore(node: any) { node.isConnected = true; attached.push(node); return node; },
    append() {},
    replaceChildren() {},
    contains: (node: any) => node !== undefined && node !== null && node !== body,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  const root: any = new Proxy(base, {
    get: (target, key) => (key in target ? (target as any)[key] : anyStub()),
    set: (target, key, value) => { (target as any)[key] = value; return true; },
  });

  const documentStub: any = {
    activeElement: body,
    body,
    documentElement: body,
    hasFocus: () => true,
    createElement: () => anyStub(),
    getElementById: (id: string) => (id === "memory-root" ? root : anyStub()),
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  const env: any = {
    document: documentStub,
    escape,
    // Every endpoint answers with a well-formed empty payload so a background
    // detail fetch cannot throw for a reason unrelated to the poll.
    // 每个端点都返回结构完整的空载荷，使后台取详情不会因与轮询无关的原因抛错。
    api: async () => library,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    localStorage: { getItem: () => null, setItem() {} },
    // app.js owns the earlier library renderer; memory.js wraps it at load time.
    // app.js 拥有更早的库渲染函数；memory.js 在加载时把它包起来。
    renderLibrary: () => {},
  };
  env.window = env;
  env.globalThis = env;

  const scope: any = new Proxy(env, {
    has: () => true,
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key === "undefined") return undefined;
      if (key in target) return (target as any)[key];
      if (key in globalThis) return (globalThis as any)[key];
      return anyStub();
    },
    set: (target, key, value) => { (target as any)[key] = value; return true; },
  });
  new Function("scope", `with (scope) {\n${memoryScript}\n}`)(scope);

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };

  /** One poll tick, as app.js's setInterval fires it. 一次轮询，正如 app.js 的 setInterval 触发的那样。 */
  const poll = async (next: unknown): Promise<void> => {
    try {
      await (env.renderLibrary as (library: unknown) => unknown)(next);
    } catch (error) {
      failures.push(error);
    }
    await settle();
  };

  return { root, body, documentStub, paints, failures, poll };
}

const library = makeLibrary([
  {
    id: "mem-1", summary: "提前一天确认发布窗口", content: "发布前一天与负责人确认窗口。",
    type: "procedure", status: "active", sensitivity: "private", confidence: "high", accessCount: 2,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", sourceRunId: "owner",
  },
  {
    id: "mem-2", summary: "不接受未经确认的对外邮件", content: "对外邮件必须先给我看。",
    type: "commitment", status: "active", sensitivity: "private", confidence: "high", accessCount: 0,
    createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", sourceRunId: "owner",
  },
]);

test("an unchanged background poll keeps the focused search box inside #memory-root", async () => {
  const { root, documentStub, paints, failures, poll } = openMemoryPanel();
  await poll(library);
  const painted = paints.length;
  assert.ok(painted >= 1, `the memory panel must paint at least once; errors: ${String(failures[0])}`);

  // The owner typed into the search box [data-mem-query] inside #memory-root.
  // 所有者在 #memory-root 的搜索框 [data-mem-query] 里输入了文字。
  const search: any = { isConnected: true, tagName: "INPUT", dataset: { memQuery: "" }, value: "发布" };
  root.appendChild(search);
  documentStub.activeElement = search;

  // The 3 s poll delivers the very same library again. 3 秒轮询再次送来同一份 library。
  await poll(library);

  assert.equal(documentStub.activeElement, search, "the background poll replaced the focused memory search box");
  assert.equal(paints.length, painted, "the background poll rebuilt #memory-root although the data did not change");
});

test("an unsaved editor textarea inside #memory-root survives the background poll", async () => {
  const { root, documentStub, paints, failures, poll } = openMemoryPanel();
  await poll(library);
  const painted = paints.length;
  assert.ok(painted >= 1, `the memory panel must paint at least once; errors: ${String(failures[0])}`);

  // The owner opened 「编辑」 and typed a body that is not saved yet; that textarea
  // lives inside #memory-root. 所有者点了「编辑」并输入了尚未保存的正文，那个 textarea 在 #memory-root 内。
  const textarea: any = { isConnected: true, tagName: "TEXTAREA", dataset: { libraryContent: "mem-1" }, value: "未保存的正文改动" };
  root.appendChild(textarea);
  documentStub.activeElement = textarea;

  await poll(library);

  assert.equal(textarea.isConnected, true, "the poll replaced the editor textarea the owner was typing in");
  assert.equal(textarea.value, "未保存的正文改动", "the poll overwrote the unsaved edit with the stored content");
  assert.equal(paints.length, painted, "the background poll rebuilt #memory-root although the data did not change");
});