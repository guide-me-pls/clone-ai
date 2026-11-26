/**
 * The conversation outline is tested against the renderer it navigates.
 *
 * A long thread has no per-turn ids to link to, so the outline reads the
 * `data-jump-id` anchors the renderer writes on each request bubble (and on a
 * task record's person messages). These tests drive the real functions from
 * `apps/desktop/ui/app.js` with a small DOM stand-in: the list must match the
 * anchors, opening must mark the request at the reading line, and a jump must
 * scroll that anchor to the top.
 *
 * 对话目录针对它所导航的渲染器测试。
 *
 * 长线程没有可链接的逐回合 id，因此目录读取渲染器写在每个请求气泡（以及任务记录的
 * person 消息）上的 `data-jump-id` 锚点。这些用例用一个小的 DOM 替身驱动
 * `apps/desktop/ui/app.js` 的真实函数：列表必须与锚点一致，打开时必须标记阅读线所在的
 * 请求，跳转必须把该锚点滚到顶部。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const APP_PATH = join(process.cwd(), "apps", "desktop", "ui", "app.js");

/** Chrome's per-node state as a plain object. 每个节点的浏览器状态，用普通对象表示。 */
interface FakeNode {
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  dataset: Record<string, string>;
  scrollTop: number;
  classList: { added: string[]; removed: string[]; add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
  focus(): void;
  contains(node: unknown): boolean;
  getBoundingClientRect(): { top: number };
  scrollTo(options: unknown): void;
}

let active: FakeNode | null = null;

function fakeNode(overrides: Partial<FakeNode> = {}): FakeNode {
  const attributes = new Map<string, string>();
  const node: FakeNode = {
    hidden: false,
    textContent: "",
    innerHTML: "",
    dataset: {},
    scrollTop: 0,
    classList: {
      added: [],
      removed: [],
      add(name: string) { this.added.push(name); },
      remove(name: string) { this.removed.push(name); },
      contains() { return false; },
    },
    setAttribute(name: string, value: string) { attributes.set(name, String(value)); },
    getAttribute(name: string) { return attributes.get(name) ?? null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() { active = node; },
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo: () => {},
  };
  return Object.assign(node, overrides);
}

/** One request anchor as the renderer emits it. 渲染器写出的一个请求锚点。 */
function requestNode(text: string, options: { at?: string; status?: string; top?: number } = {}): FakeNode {
  const body = fakeNode({ textContent: text });
  return fakeNode({
    textContent: `你${text}`,
    dataset: { jumpAt: options.at ?? "", jumpStatus: options.status ?? "" },
    querySelector: (selector: string) => selector.includes(".turn-query-text") ? body : null,
    getBoundingClientRect: () => ({ top: options.top ?? 0 }),
  });
}

/**
 * Loads the real outline functions with a DOM that records what they do.
 * 加载真实的目录函数，配上一个会记录其行为的 DOM。
 */
function createOutline(source: string) {
  active = null;
  const viewport = fakeNode({ scrollTop: 300 });
  const toggle = fakeNode();
  const panel = fakeNode();
  const count = fakeNode();
  const list = fakeNode();
  const rows: FakeNode[] = [];
  const targets: FakeNode[] = [];
  const timers: Array<() => void> = [];
  const scrolled: unknown[] = [];
  // `setConversationOutline` reads the rows through the list node, not the
  // document; the fake list must return the same row fakes.
  // `setConversationOutline` 通过列表节点而不是 document 读取行；假列表必须返回同一批行。
  list.querySelectorAll = (selector: string) => selector === "[data-outline-index]" ? rows : [];

  const documentStub = {
    querySelectorAll(selector: string): FakeNode[] {
      if (selector === "#conversation-inner [data-jump-id]") return targets;
      if (selector === "#conversation-outline-list [data-outline-index]") return rows;
      return [];
    },
    activeElement: null as unknown,
  };
  const nodes: Record<string, FakeNode> = {
    conversation: viewport,
    "conversation-outline-toggle": toggle,
    "conversation-outline": panel,
    "conversation-outline-count": count,
    "conversation-outline-list": list,
  };
  const $ = (id: string): FakeNode | null => nodes[id] ?? null;
  const state = { outlineOpen: false, outlineTargets: [] as FakeNode[], outlineFrame: 0 };
  const t = (key: string): string => ({
    "outline-turn": "第 {index} 个回合",
    "outline-count": "{count} 个回合",
  }[key] ?? key);
  const escape = (value: unknown): string => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character] ?? character));
  const plainPreview = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
  const time = (): string => "08:00";
  const logStatus = (status: string): { tone: string } => ({
    completed: { tone: "ok" }, failed: { tone: "bad" }, interrupted: { tone: "warn" }, started: { tone: "info" },
  }[status] ?? { tone: "mute" });

  const factory = new Function(
    "state", "document", "window", "$", "t", "escape", "plainPreview", "time", "logStatus",
    `${source}
     return { conversationOutlineEntries, renderConversationOutline, markConversationOutlineCurrent, setConversationOutline, jumpToConversationTarget };`,
  ) as (...args: unknown[]) => {
    conversationOutlineEntries(targets: FakeNode[]): Array<{ index: number; label: string; at: string; status: string }>;
    renderConversationOutline(): void;
    markConversationOutlineCurrent(): void;
    setConversationOutline(open: boolean): void;
    jumpToConversationTarget(index: number): void;
  };
  const api = factory(
    state,
    Object.assign(documentStub, {
      // `$` reads getElementById, exactly like the app.
      // `$` 读取 getElementById，与 App 一致。
      getElementById: (id: string) => nodes[id] ?? null,
    }),
    { setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; } },
    $,
    t,
    escape,
    plainPreview,
    time,
    logStatus,
  );

  return {
    api,
    state,
    toggle,
    panel,
    count,
    list,
    rows,
    targets,
    viewport,
    scrolled,
    timers,
    /** Points the fake DOM at a new set of anchors. 让假 DOM 指向一组新锚点。 */
    setTargets(next: FakeNode[]): void {
      targets.length = 0;
      targets.push(...next);
    },
    /** One outline row fake per index, in reading order. 按阅读顺序为每个索引造一行。 */
    setRows(count: number): void {
      rows.length = 0;
      for (let index = 0; index < count; index += 1) {
        const row = fakeNode({ dataset: { outlineIndex: String(index) } });
        rows.push(row);
      }
    },
  };
}

async function outlineSource(): Promise<string> {
  const app = await readFile(APP_PATH, "utf8");
  const start = app.indexOf("function conversationOutlineEntries");
  const end = app.indexOf("function renderSession(session)", start);
  assert.ok(start >= 0 && end > start, "the outline functions must sit together in app.js");
  return app.slice(start, end);
}

test("the outline lists one row per request anchor, in reading order", async () => {
  const outline = createOutline(await outlineSource());
  const entries = outline.api.conversationOutlineEntries([
    requestNode("现在先做红色方案还是蓝色方案？", { at: "2026-11-25T08:00:00.000Z", status: "completed" }),
    requestNode("   ", {}),
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.index, 0);
  assert.equal(entries[0]!.label, "现在先做红色方案还是蓝色方案？");
  assert.equal(entries[0]!.status, "completed");
  assert.equal(entries[0]!.at, "2026-11-25T08:00:00.000Z");
  // A request whose text is only whitespace still gets a readable row name.
  // 只有空白的请求仍然得到可读的行名。
  assert.equal(entries[1]!.label, "第 2 个回合");
});

test("the toggle appears only when two requests exist, and the list carries time and status", async () => {
  const outline = createOutline(await outlineSource());

  outline.setTargets([requestNode("唯一的请求")]);
  outline.api.renderConversationOutline();
  assert.equal(outline.toggle.hidden, true, "one request needs no jump list");
  assert.equal(outline.panel.hidden, true);

  outline.setTargets([
    requestNode("先做红色方案", { at: "2026-11-25T08:00:00.000Z", status: "completed" }),
    requestNode("再做蓝色方案", { at: "2026-11-25T09:30:00.000Z", status: "failed" }),
  ]);
  outline.api.renderConversationOutline();
  assert.equal(outline.toggle.hidden, false);
  assert.equal(outline.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(outline.count.textContent, "2 个回合");
  assert.match(outline.list.innerHTML, /data-outline-index="0"/);
  assert.match(outline.list.innerHTML, /data-outline-index="1"/);
  assert.match(outline.list.innerHTML, /先做红色方案/);
  assert.match(outline.list.innerHTML, /<time>08:00<\/time>/);
  assert.match(outline.list.innerHTML, /conversation-outline-dot ok/);
  assert.match(outline.list.innerHTML, /conversation-outline-dot bad/);
});

test("opening marks the request at the reading line and focuses it", async () => {
  const outline = createOutline(await outlineSource());
  outline.setTargets([
    requestNode("先做红色方案", { top: 10 }),
    requestNode("再做蓝色方案", { top: 500 }),
  ]);
  outline.setRows(2);
  outline.viewport.getBoundingClientRect = () => ({ top: 0 });
  outline.api.renderConversationOutline();
  outline.api.setConversationOutline(true);

  assert.equal(outline.panel.hidden, false);
  assert.equal(outline.toggle.getAttribute("aria-expanded"), "true");
  assert.equal(outline.rows[0]!.getAttribute("aria-current"), "true");
  assert.equal(outline.rows[1]!.getAttribute("aria-current"), "false");
  assert.equal(active, outline.rows[0], "opening moves focus to the current request");
});

test("a jump scrolls the request to the top, flashes it and closes the panel", async () => {
  const outline = createOutline(await outlineSource());
  const second = requestNode("再做蓝色方案", { top: 420 });
  outline.setTargets([requestNode("先做红色方案", { top: 10 }), second]);
  outline.setRows(2);
  outline.viewport.scrollTop = 300;
  outline.api.renderConversationOutline();
  outline.api.setConversationOutline(true);
  assert.equal(outline.panel.hidden, false);

  const viewport = outline.viewport as FakeNode & { scrolledTo?: unknown };
  outline.viewport.scrollTo = (options: unknown) => { viewport.scrolledTo = options; };
  outline.api.jumpToConversationTarget(1);

  // 300 px already scrolled + 420 px to the anchor − 12 px of breathing room.
  // 已滚动 300px + 距锚点 420px − 12px 留白。
  assert.deepEqual(viewport.scrolledTo, { top: 708, behavior: "smooth" });
  assert.deepEqual(second.classList.added, ["is-jump-target"]);
  assert.equal(outline.panel.hidden, true, "the panel closes so the target is readable");
  assert.equal(outline.timers.length, 1, "the flash is removed on a timer");
  outline.timers[0]!();
  assert.deepEqual(second.classList.removed, ["is-jump-target"]);
});