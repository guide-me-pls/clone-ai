/**
 * Regression reproduction: ui-sidebar-hidden-restore
 *
 * The sidebar dropped its "hidden conversations" group exactly when the owner
 * needed it: `renderSessions()` returned early on an empty visible list, before
 * the `hiddenBlock` that carries the `data-restore-conversation` button was
 * rendered. With a single personal conversation hidden and no task sessions,
 * the restore entry point disappeared from the UI.
 *
 * This drives the real `renderSessions` from apps/desktop/ui/app.js in a small
 * sandbox (the technique test/ui-structure.test.ts uses for the same module),
 * so it fails for the recorded reason: no restore control reaches the sidebar.
 *
 * 回归复现：ui-sidebar-hidden-restore
 *
 * 侧栏恰好在所有者最需要的时候丢掉了“已隐藏”分组：`renderSessions()` 在可见列表为空时提前
 * 返回，尚未渲染携带 `data-restore-conversation` 按钮的 `hiddenBlock`。当唯一的个人对话被
 * 隐藏且没有任务会话时，恢复入口从界面上消失了。
 *
 * 本用例在一个小沙箱中驱动 apps/desktop/ui/app.js 的真实 `renderSessions`（与
 * test/ui-structure.test.ts 对同一模块使用的技术相同），因此它因记录的原因而失败：侧栏没有
 * 恢复控件。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import * as uiLocale from "../../src/desktop/ui-locale.ts";

const APP_PATH = join(process.cwd(), "apps", "desktop", "ui", "app.js");

/** Chrome strings, when the locale module exports its table. 界面文案（若模块导出）。 */
const strings = Object.values(uiLocale).find(
  (value) => value !== null && typeof value === "object" && "empty-sessions" in (value as Record<string, unknown>),
) as Record<string, string> | undefined;

/** Falls back to the key, exactly like the real `t()` before `/api/config` loads.
 * 回退到键名，与 `/api/config` 加载前的真实 `t()` 完全一致。 */
const t = (key: string): string => strings?.[key] ?? key;

/**
 * Cuts one top-level `function name(...) { ... }` declaration out of app.js.
 * Top-level functions end with a brace in column 0, so the first `\n}\n` after
 * the declaration closes it.
 *
 * 从 app.js 中切出一个顶层 `function name(...) { ... }` 声明。顶层函数以第 0 列的
 * 右花括号结束，因此声明之后的第一个 `\n}\n` 就是它的结尾。
 */
function sliceFunction(source: string, name: string): string {
  const declaration = source.indexOf(`function ${name}(`);
  assert.ok(declaration >= 0, `${name} must exist in apps/desktop/ui/app.js`);
  // Keep a leading `async` so the slice still parses if the body awaits.
  // 保留开头的 `async`，使函数体包含 await 时切片仍然可以解析。
  const start = source.slice(Math.max(0, declaration - 6), declaration) === "async "
    ? declaration - 6
    : declaration;
  const close = source.indexOf("\n}\n", declaration);
  assert.ok(close > declaration, `${name} must be a top-level function in apps/desktop/ui/app.js`);
  return source.slice(start, close + 3);
}

/** Stand-in for anything the render function reaches for that we did not model.
 * 渲染函数读取但桩未建模的任何东西的替身。 */
function unknown(): any {
  const proxy: any = new Proxy(function unknownStub() { return proxy; }, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[character] ?? character));
}

function element(): Record<string, any> {
  return {
    innerHTML: "",
    hidden: false,
    className: "",
    textContent: "",
    scrollTop: 0,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    requestSubmit() {},
  };
}

/**
 * Loads the real `renderSessions` and reports what it painted into the sidebar.
 * 加载真实的 `renderSessions`，并报告它画进侧栏的内容。
 */
function createSidebar(source: string) {
  const sessionList = element();

  // Every node the render reaches for is recorded, so the check does not depend
  // on which id the session list happens to use.
  // 渲染读取的每个节点都会被记录，因此检查不依赖会话列表恰好使用哪个 id。
  const painted: Record<string, any>[] = [sessionList];
  const nodes = new Map<string, Record<string, any>>([["session-list", sessionList]]);
  const $ = (id: string): Record<string, any> => {
    if (!nodes.has(id)) {
      const node = element();
      nodes.set(id, node);
      painted.push(node);
    }
    return nodes.get(id)!;
  };

  const state = {
    dashboard: { sessions: [] as any[], deletedConversations: [] as any[], selectedId: null },
    selectedId: null,
    strings: strings ?? {},
    locale: "zh-CN",
    signatures: {},
    drafts: new Map(),
    scrollPositions: new Map(),
    openDisclosures: new Map(),
    disclosureScrollPositions: new Map(),
    // The sidebar renders a child-group disclosure from this set; a stub
    // without it fails before the restore control is reached.
    // 侧栏从这个集合渲染子任务分组折叠状态；缺少它会在到达恢复控件之前失败。
    openChildGroups: new Set(),
    composingNew: false,
    streaming: false,
  };

  // `ui.*` helpers: keep the data attributes so a control built that way stays visible.
  // `ui.*` 辅助函数：保留 data 属性，使这样构建的控件仍然可见。
  const ui = new Proxy(function uiStub() { return ""; }, {
    get: (_target, key) => {
      if (key === "then") return undefined;
      return (options: any) => {
        if (!options || typeof options !== "object") return "";
        return Object.entries(options.attributes ?? {})
          .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
          .join(" ");
      };
    },
  });

  const documentStub = {
    getElementById: $,
    querySelector: () => element(),
    querySelectorAll: () => [],
    createElement: () => element(),
    addEventListener() {},
    activeElement: null,
    title: "",
    body: { classList: { toggle() {}, add() {}, remove() {} } },
    documentElement: { lang: "", title: "", style: { setProperty() {} } },
  };

  const scopeTarget: Record<string | symbol, unknown> = {
    state,
    document: documentStub,
    window: { CloneUI: ui, innerWidth: 1280, CLONE_AI_TOKEN: "", addEventListener() {} },
    ui,
    $,
    t,
    escape: escapeHtml,
    plainPreview: (value: unknown) => String(value ?? ""),
    shortName: (value: unknown) => String(value ?? ""),
    day: () => "day",
    time: () => "time",
    statusMeta: (status: unknown) => ({ label: String(status ?? ""), className: "running", dot: "running" }),
    icon: () => "",
    // The grouping logic is what this sandbox tests; the row markup and the
    // small labels are stubs so the slice stays one function. `main` is kept as
    // an attribute because the pinned row is the merge this suite guards.
    // 本沙箱验证分组逻辑；行标记与小标签用桩，切片仍只包含一个函数。`main` 保留为属性，
    // 因为固定行正是本套件所守护的合并。
    sessionMarkup: (session: any, options: any = {}) => `<div class="session-item" data-test-session="${session.id}"${options.main ? ' data-main="true"' : ""}>${session.title ?? ""}</div>`,
    sessionTime: (session: any) => Date.parse(session.updatedAt) || 0,
    MAIN_CONVERSATION_ID: "main-agent-conversation",
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback?: (time: number) => void) => callback?.(0),
    announce: () => {},
  };

  const scope = new Proxy(scopeTarget, {
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return (target as Record<string | symbol, unknown>)[key];
      if (key in globalThis) return (globalThis as any)[key];
      return unknown();
    },
    set: (target, key, value) => {
      (target as Record<string | symbol, unknown>)[key] = value;
      return true;
    },
  });

  const factory = new Function("__scope", `with (__scope) {\n${source}\n; return renderSessions;\n}`) as
    (scope: unknown) => (sessions?: unknown) => unknown;

  return {
    /** Awaited so a sync or an async `renderSessions` both settle before we look.
 * 等待它完成，使同步或异步的 `renderSessions` 在检查前都已落定。 */
    renderSessions: async (sessions?: unknown): Promise<void> => {
      await factory(scope)(sessions);
    },
    state,
    /** The visible top-level row count the render wrote into 最近. 渲染写入“最近”的顶层行数。 */
    count: (): string => String(nodes.get("session-count")?.textContent ?? ""),
    /** Everything renderSessions painted into the sidebar this run.
 * 本次运行中 renderSessions 画进侧栏的全部内容。 */
    markup: () => painted.map((node) => String(node.innerHTML ?? "")).join(""),
  };
}

const appSource = await readFile(APP_PATH, "utf8");
const renderSessionsSource = sliceFunction(appSource, "renderSessions");

/** The owner's only conversation, hidden and therefore waiting to be restored.
 * 所有者唯一的对话，被隐藏，等待恢复。 */
const HIDDEN_CONVERSATION = {
  id: "main-agent-conversation",
  title: "个人对话",
  updatedAt: "2026-11-06T06:00:00.000Z",
  deletedAt: "2026-11-06T06:30:00.000Z",
};

test("the sidebar keeps the hidden-conversation restore control when no session is visible", async () => {
  const sidebar = createSidebar(renderSessionsSource);
  sidebar.state.dashboard.sessions = [];
  sidebar.state.dashboard.deletedConversations = [HIDDEN_CONVERSATION];

  // The owner hid their only conversation, so nothing visible is left.
  // 所有者隐藏了唯一的对话，因此没有可见内容剩下。
  await sidebar.renderSessions([]);

  assert.ok(sidebar.markup().length > 0, "renderSessions must paint the sidebar");
  assert.match(
    sidebar.markup(),
    /data-restore-conversation/,
    "the sidebar must still render data-restore-conversation when the visible session list is empty; " +
      "otherwise a hidden conversation can never be restored from the UI",
  );
});

test("the same sandbox reaches the hidden group when a session is visible", async () => {
  const sidebar = createSidebar(renderSessionsSource);
  sidebar.state.dashboard.deletedConversations = [HIDDEN_CONVERSATION];

  await sidebar.renderSessions([
    { id: "task-1", title: "整理今天", status: "completed", updatedAt: "2026-11-06T06:00:00.000Z" },
  ]);

  assert.match(
    sidebar.markup(),
    /data-restore-conversation/,
    "the hidden group renders alongside visible sessions, so the sandbox itself is sound",
  );
});

test("the main conversation is the pinned first row and dispatched runs are not rows", async () => {
  const sidebar = createSidebar(renderSessionsSource);
  const at = new Date().toISOString();
  const main = {
    id: "main-agent-conversation", kind: "conversation", title: "Main Agent 对话",
    status: "completed", preview: "完成", updatedAt: at, childCount: 1,
  };
  const mainTask = {
    id: "run-main", parentId: "main-agent-conversation", conversationId: "main-agent-conversation",
    title: "主对话的任务", status: "completed", preview: "完成", updatedAt: at,
  };
  const conversation = {
    id: "conversation-x", kind: "conversation", title: "整理资料",
    status: "completed", preview: "完成", updatedAt: at,
  };
  const sessions = [conversation, main, mainTask];
  sidebar.state.dashboard.sessions = sessions;

  await sidebar.renderSessions(sessions);
  const markup = sidebar.markup();

  // The main conversation is one pinned row; the run it dispatched is read in
  // the audit and is not a row here, nested or otherwise.
  // 主对话是一行固定行；它派发的 Run 在审计里读，这里不是行——无论嵌套与否。
  assert.match(markup, /data-test-session="main-agent-conversation" data-main="true"/);
  assert.doesNotMatch(markup, /data-child-group=/);
  assert.doesNotMatch(markup, /session-children/);
  const occurrences = (id: string) => (markup.match(new RegExp(`data-test-session="${id}"`, "g")) ?? []).length;
  assert.equal(occurrences("main-agent-conversation"), 1, "the main conversation is one row");
  assert.equal(occurrences("run-main"), 0, "a dispatched run is not a sidebar row");
  assert.equal(occurrences("conversation-x"), 1, "another conversation is unaffected");
  // The count is the two conversations, not the run.
  // 计数是两个对话，不含 Run。
  assert.equal(sidebar.count(), "2", "the count is the two conversations");
});

test("the sidebar promotes a waiting task and drops every other run", async () => {
  const sidebar = createSidebar(renderSessionsSource);
  const at = new Date().toISOString();
  const conversation = {
    id: "conversation-x", kind: "conversation", title: "整理资料",
    status: "waiting_approval", preview: "1 个任务等待你的确认", updatedAt: at, childCount: 2,
  };
  const running = {
    id: "run-running", parentId: "conversation-x", conversationId: "conversation-x",
    title: "派发一", status: "running", preview: "正在执行", updatedAt: at,
  };
  const waiting = {
    id: "run-waiting", parentId: "conversation-x", conversationId: "conversation-x",
    title: "派发二", status: "waiting_approval", preview: "等待确认", updatedAt: at,
  };
  const mainTask = {
    id: "run-main", parentId: "main-agent-conversation", conversationId: "main-agent-conversation",
    title: "主对话的任务", status: "completed", preview: "完成", updatedAt: at,
  };
  const scheduled = { id: "run-scheduled", title: "定时跑", status: "completed", preview: "完成", updatedAt: at };
  const sessions = [conversation, running, waiting, mainTask, scheduled];
  sidebar.state.dashboard.sessions = sessions;

  await sidebar.renderSessions(sessions);
  const markup = sidebar.markup();

  // The one row a task earns is a decision: the waiting task is promoted into
  // 需要你处理. Running, completed and conversation-less runs have no row at all.
  // 任务唯一能挣到的行是"决定"：等待中的任务被提升到 需要你处理。运行中、已完成与没有
  // 对话的 Run 都没有行。
  assert.match(markup, /class="session-group session-group-needs"/);
  assert.doesNotMatch(markup, /session-group-auto/);
  assert.doesNotMatch(markup, /data-child-group=/);
  const occurrences = (id: string) => (markup.match(new RegExp(`data-test-session="${id}"`, "g")) ?? []).length;
  assert.equal(occurrences("conversation-x"), 1, "the conversation is one row");
  assert.equal(occurrences("run-running"), 0, "a running run is not a row");
  assert.equal(occurrences("run-waiting"), 1, "the waiting task is promoted once");
  assert.equal(occurrences("run-main"), 0, "the main conversation's run is not a row");
  assert.equal(occurrences("run-scheduled"), 0, "a conversation-less run is not a row");
  // One conversation plus the one decision; the runs contribute nothing.
  // 一个对话加上那一个决定；Run 不计入。
  assert.equal(sidebar.count(), "2");
});