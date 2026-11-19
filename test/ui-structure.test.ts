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

test("the main conversation is a pinned row with a fixed name and no hide control", async () => {
  const app = await read("app.js");
  const start = app.indexOf("function sessionMarkup");
  const end = app.indexOf("function renderSessions", start);
  assert.ok(start >= 0 && end > start, "sessionMarkup must exist");
  const sessionMarkup = runInNewContext(
    `const state = { selectedId: null };
     ${app.slice(start, end)};
     sessionMarkup`,
    {
      escape: (value: unknown) => String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      plainPreview: (value: unknown) => String(value ?? ""),
      t: (key: string) => (({
        "session-group-main": "主对话",
        "main-conversation-legacy": "此前的对话记录",
        "session-flag-approval": "需你确认",
        "session-flag-review": "需你复核",
      } as Record<string, string>)[key] ?? key),
      statusMeta: () => ({ label: "已完成", className: "completed", dot: "completed" }),
    },
  ) as (session: unknown, options?: unknown) => string;

  // The pinned row names the owner's original thread with the chrome string,
  // not the thread's churning content title, and it has no hide control.
  // 固定行用框架文案命名所有者最初的线程，而不是会变化的线程内容标题；它没有隐藏控件。
  const main = sessionMarkup(
    { id: "main-agent-conversation", kind: "conversation", title: "旧的标题", preview: "", status: "completed" },
    { main: true },
  );
  assert.match(main, /data-session="main-agent-conversation"/);
  assert.match(main, />主对话</);
  assert.match(main, /此前的对话记录/);
  assert.doesNotMatch(main, /data-delete-session/);

  // Every other conversation keeps its first-request title and its hide control.
  // 其他对话保留其首个请求标题与隐藏控件。
  const other = sessionMarkup({ id: "conversation-a", kind: "conversation", title: "整理资料", preview: "完成", status: "completed" });
  assert.match(other, />整理资料</);
  assert.match(other, /data-delete-session="conversation-a"/);
});

test("the invocation audit exposes server search and reversible delete controls", async () => {
  const audit = await read("audit.js");
  // The list is searched on the server, not only in the loaded page.
  // 列表在服务端搜索，而不是只搜索已加载的一页。
  assert.match(audit, /\/api\/invocations\?\$\{params\}/);
  assert.match(audit, /data-au-inv-query/);
  assert.match(audit, /data-au-inv-deleted/);
  // Deletion is a reversible tombstone the detail pane can undo.
  // 删除是可逆墓碑，详情面板可以撤销。
  assert.match(audit, /data-au-inv-delete=/);
  assert.match(audit, /data-au-inv-delete-shown/);
  assert.match(audit, /data-au-inv-restore=/);
  assert.match(audit, /api\/invocations\/\$\{deleted \? "delete" : "restore"\}/);
  // Turns are searched on the server too, so the count is not just the loaded page.
  // 回合也在服务端搜索，因此计数不只代表已加载的一页。
  assert.match(audit, /\/api\/audit\/turns\?\$\{params\}/);
  assert.match(audit, /data-au-turn-query/);
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

test("screenshots pasted from the macOS clipboard become visible attachments", async () => {
  const app = await read("app.js");
  const start = app.indexOf("function clipboardAttachmentFiles");
  const end = app.indexOf("const icon", start);
  assert.ok(start >= 0 && end > start, "clipboard attachment extraction must exist");
  assert.match(app, /\$\("query"\)\.addEventListener\("paste"/, "the composer must handle paste events");

  const extract = new Function("File", `${app.slice(start, end)}\nreturn clipboardAttachmentFiles;`)(File) as (data: unknown) => File[];
  const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  const jpeg = new File([new Uint8Array([255, 216, 255])], "photo.jpg", { type: "image/jpeg" });

  const items = extract({
    items: [
      { kind: "file", type: "image/png", getAsFile: () => png },
      { kind: "string", type: "text/plain", getAsFile: () => null },
    ],
    files: [],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.name, "剪贴板截图-1.png");
  assert.equal(items[0]!.type, "image/png");

  const fallback = extract({ items: [], files: [jpeg] });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]!.name, "剪贴板截图-1.jpg");
  assert.deepEqual(extract({ items: [], files: [{ type: "image/tiff" }] }), []);
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
    turnLogMarkup: (session: { turns?: unknown[] }) => (session.turns || []).length > 0 ? '<div class="turn-log"></div>' : "",
    // A conversation's content is its turns; a task record's is its messages.
    // 对话的内容是回合；任务记录的内容是消息。
    sessionHasContent: (session: { kind?: string; turns?: unknown[]; messages: unknown[] } | null) => session !== null
      && (session.kind === "conversation" ? (session.turns || []).length > 0 : session.messages.length > 0),
    recalledMemoryMarkup: () => "", planMarkup: () => "", agentsMarkup: () => "",
    decisionDock: () => "", dispatchSourceMarkup: () => "", evidenceMarkup: () => "", approvalMarkup: () => "", reviewMarkup: () => "", traceMarkup: () => "",
    verificationMarkup: () => "",
    restoreDisclosureScrolls: () => {}, requestAnimationFrame: () => {}, updateScrollBottom: () => {},
    revealAgentFocus: () => {},
  });
  renderSession(null);
  assert.equal(empty, true);
  renderSession({ id: "test", updatedAt: "today", messages: [] });
  assert.equal(empty, true);
  renderSession({ id: "test", updatedAt: "today", messages: [{ text: "one" }, { text: "two" }] });
  assert.equal(empty, false);
  assert.equal((content.innerHTML.match(/class="message"/g) || []).length, 2);
  // A conversation with turns is populated by its log, not by chat messages.
  // 有回合的对话由日志支撑内容，而不是聊天消息。
  renderSession({ id: "chat", kind: "conversation", updatedAt: "today", messages: [], turns: [{ id: "t1" }] });
  assert.equal(empty, false);
  assert.match(content.innerHTML, /turn-log/);
  assert.doesNotMatch(content.innerHTML, /class="message"/);
  // An empty conversation shows the welcome alone: the day divider beside it
  // was laid out as a second flex column.
  // 空对话只显示欢迎语：旁边的日期分隔线会被排成第二个 flex 列。
  renderSession({ id: "chat", kind: "conversation", updatedAt: "today", messages: [], turns: [] });
  assert.equal(empty, true);
  assert.match(content.innerHTML, /welcome/);
  assert.doesNotMatch(content.innerHTML, /day-divider/);

  const css = (await read("style.css")) + (await read("audit.css")) + (await read("memory.css")) + (await read("components.css"));
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const flexContainers = rules.filter(([, selector, declarations]) => selector!.includes(".conversation-inner") && /display:\s*(?:inline-)?flex\b/.test(declarations!));
  assert.ok(flexContainers.length > 0, "empty conversation needs its flex layout");
  for (const [, selector] of flexContainers) assert.match(selector!, /\.conversation-inner:not\(:has\(\.message\)\)/);
  assert.match(css, /\.conversation-inner\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.message\s*\{[^}]*display:\s*block[^}]*width:\s*100%/);
  assert.match(css, /\.message\.person\s*\{[^}]*width:\s*100%/);
});

test("a conversation renders each turn as a right-hand request and a left-hand answer", async () => {
  const app = await read("app.js");
  const start = app.indexOf("const LOG_STATUS = {");
  const end = app.indexOf("function displayAgentTitle", start);
  assert.ok(start >= 0 && end > start, "turnLogMarkup must exist");
  const markup = runInNewContext(`${app.slice(start, end)}; turnLogMarkup`, {
    escape: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]!)),
    richText: (value: unknown) => String(value ?? ""),
    plainPreview: (value: unknown) => String(value ?? ""),
    time: () => "17:13",
    welcomeMarkup: () => "welcome",
  }) as (session: unknown) => string;
  assert.equal(markup({ id: "chat", kind: "conversation", messages: [], turns: [] }), "");

  const html = markup({
    id: "chat",
    kind: "conversation",
    messages: [{ id: "work-1", role: "clone", text: "任务「整理资料」已完成。", occurredAt: "2026-11-18T09:00:00.000Z", tone: "success" }],
    turns: [{
      id: "turn-1", kind: "turn", input: "整理资料", status: "completed",
      startedAt: "2026-11-18T08:59:00.000Z", durationMs: 4200,
      modelId: "claude-sonnet-5-5", provider: "native", effort: "high", journaled: true,
      snapshot: {
        schemaVersion: 1, charterVersion: 3, charterHash: "charter", briefingHash: "briefing",
        promptHash: "prompt", toolsHash: "tools", materialHash: "0123456789abcdef",
        toolNames: ["dispatch_task", "read_file"], locator: "prompt-snapshots/0123456789abcdef.json",
        capturedAt: "2026-11-18T08:59:00.000Z",
      },
      compactions: [{ at: "2026-11-18T08:59:30.000Z", estimatedTokens: 90_000, compactAt: 80_000, droppedMessages: 12, keptMessages: 3, summary: "前面的对话压成一段摘要。" }],
      toolCalls: [{ toolCallId: "call-1", name: "dispatch_task", inputSummary: '{"objective":"整理资料"}', isError: false, durationMs: 3000 }],
      spawnedRuns: [{ id: "run-12345678", title: "整理资料", status: "completed" }],
      priorTurns: 2, priorTurnsOmitted: 0,
      reply: "已整理。",
    }],
  });
  // A turn shows its result and the grounds it stands on; the process — the
  // model, the prompt snapshot's tool table, and every call's input — lives in
  // the audit and must not come back into the reading column.
  // 回合显示结果与它所依据的东西；过程——模型、提示词快照的工具表与每次调用的输入——在
  // 审计页，不得回到阅读栏。
  assert.match(html, /结果/);
  assert.match(html, /依据/);
  assert.match(html, /工具调用 1 次/);
  assert.match(html, /派生任务 1 个/);
  // The spawned runs are not rows in the reading column any more: the sidebar
  // lists no runs and the conversation lists none either. The one-line 依据
  // names how many were dispatched and opens the audit.
  // 派发的 Run 不再作为阅读栏里的行：侧栏不列 Run，对话也不列。一行"依据"说明派发了
  // 几个，并打开审计。
  assert.doesNotMatch(html, /产物/);
  assert.doesNotMatch(html, /data-log-run=/);
  assert.match(html, /data-open-turn-audit="turn-1"/);
  assert.match(html, /data-open-turn-conversation="chat"/);
  assert.match(html, /aria-label="查看审计：整理资料 · 17:13"/);
  assert.doesNotMatch(html, /log-step-label">上下文/);
  assert.doesNotMatch(html, /log-step-label">派发/);
  assert.doesNotMatch(html, /工具表/);
  assert.doesNotMatch(html, /native\/claude-sonnet-5-5/);
  assert.doesNotMatch(html, /charter v3/);
  assert.doesNotMatch(html, /此前 2 轮已完成对话/);
  assert.doesNotMatch(html, /丢弃 12 条/);
  assert.doesNotMatch(html, /dispatch_task/);
  assert.match(html, /已整理。/);
  // The owner's request is a right-hand bubble and the answer is the left-hand
  // section; the two voices no longer share one clamped title line.
  // 所有者的请求是靠右的气泡，回答是左侧章节；两个声音不再共用一条被截断的标题行。
  assert.match(html, /class="turn-query"/);
  assert.match(html, /class="turn-query-bubble"/);
  assert.match(html, /class="log-entry-kicker">clone-ai/);
  assert.doesNotMatch(html, /<b class="log-query">整理资料/);
  // Work updates join the same log and keep their own label.
  // 工作更新进入同一份日志，并保留自己的标签。
  assert.match(html, /任务更新/);
  assert.match(html, /任务「整理资料」已完成。/);
  assert.doesNotMatch(html, /class="message/);
  assert.match(html, /class="turn-log"/);
  // The evidence line is the way back to the process: the conversation names no
  // tools, so the audit must land on exactly this turn. The locator is the turn
  // id plus the conversation, not the request text: a long request overflows the
  // GET header limit and the journal stores the request redacted.
  // 依据行是回到过程的路径：对话不点名工具，因此审计必须精确落在本回合。定位键是
  // 回合 id 加对话，而不是请求文本：长请求会撑爆 GET 头部上限，Journal 存储的请求已脱敏。
  assert.match(app, /data-open-turn-audit/);
  assert.match(app, /data-open-turn-conversation/);
  assert.match(app, /turnAudit\.dataset\.openTurnConversation/);
  assert.match(app, /CloneAudit\?\.showTurns/);
  const audit = await read("audit.js");
  assert.match(audit, /async function showTurns\(turnId, conversationId\)/);
  assert.match(audit, /state\.view = "turns"/);
  assert.match(audit, /turnId: id/);
  assert.match(audit, /filter\.turnId/);
  assert.match(audit, /refreshTurns\(true\)/);
  assert.match(audit, /data-au-turn-clear/);
  assert.match(audit, /window\.CloneAudit = Object\.freeze\(\{ load, showTurns \}\)/);

  // A turn the journal never recorded says so instead of inventing a clean run.
  // Journal 没有记录的回合如实说明，而不是编造一次干净的运行。
  const bare = markup({
    id: "chat", kind: "conversation", messages: [],
    turns: [{ id: "t", kind: "turn", input: "q", status: "completed", startedAt: "2026-11-18T08:00:00.000Z", journaled: false, compactions: [], toolCalls: [], spawnedRuns: [], priorTurns: 0, priorTurnsOmitted: 0, reply: "好。" }],
  });
  assert.match(bare, /没有 Journal 记录/);
  assert.match(bare, /好。/);
  // The audit is a journal projection: without a journal record the control
  // would be a dead end, so it is absent.
  // 审计是 Journal 的投影：没有 Journal 记录时控件会是死角，因此不出现。
  assert.doesNotMatch(bare, /data-open-turn-audit/);

  // A cancelled update is not a success: the badge follows the run's status.
  // 已取消的更新不是成功：标签跟随 Run 的状态。
  const cancelled = markup({
    id: "chat", kind: "conversation", turns: [],
    messages: [{ id: "work-2", role: "clone", text: "任务「整理」已取消。", occurredAt: "2026-11-18T09:10:00.000Z", workStatus: "cancelled" }],
  });
  assert.match(cancelled, /log-badge--mute/);
  assert.match(cancelled, /已取消/);
  assert.doesNotMatch(cancelled, /log-badge--ok/);

  // A hidden run is not a row either: the conversation no longer lists runs,
  // so there is no dead button and no "hidden" placeholder to invent.
  // 隐藏的 Run 也不再是行：对话不再列 Run，因此没有失效按钮，也不需要编造"已隐藏"占位。
  const hidden = markup({
    id: "chat", kind: "conversation", messages: [],
    turns: [{ id: "t2", kind: "turn", input: "派发", status: "completed", startedAt: "2026-11-18T10:00:00.000Z", journaled: true, compactions: [], toolCalls: [], spawnedRuns: [{ id: "run-hidden", hidden: true }], priorTurns: 0, priorTurnsOmitted: 0, reply: "已派发。" }],
  });
  assert.doesNotMatch(hidden, /data-log-run=/);
  assert.doesNotMatch(hidden, /任务已隐藏/);

  // A failed turn says why and what to do, and does not claim a direct answer.
  // 失败的回合说明原因与下一步，不会声称自己直接回答。
  const failed = markup({
    id: "chat", kind: "conversation", messages: [],
    turns: [{
      id: "t3", kind: "turn", input: "查一下", status: "failed", startedAt: "2026-11-18T10:01:00.000Z",
      journaled: true, compactions: [], toolCalls: [], spawnedRuns: [], priorTurns: 0, priorTurnsOmitted: 0,
      error: "model_error", errorSummary: "模型没有返回结果。", errorGuidance: "检查 Provider 与网络后重试。",
    }],
  });
  assert.match(failed, /模型没有返回结果。/);
  assert.match(failed, /下一步：检查 Provider 与网络后重试。/);
  assert.match(failed, /原始错误/);
  assert.match(failed, /本轮在调用工具前就结束了。/);
  assert.match(failed, /data-open-turn-audit="t3"/);
  assert.doesNotMatch(failed, /本轮直接回答/);

  // A running turn with no calls yet still has a basis and a way to its record.
  // 尚未调用工具的运行中回合仍有依据与通往记录的路。
  const running = markup({
    id: "chat", kind: "conversation", messages: [],
    turns: [{ id: "t5", kind: "turn", input: "慢慢来", status: "started", startedAt: "2026-11-18T10:03:00.000Z", journaled: true, compactions: [], toolCalls: [], spawnedRuns: [], priorTurns: 0, priorTurnsOmitted: 0 }],
  });
  assert.match(running, /仍在运行；还没有工具调用记录。/);
  assert.match(running, /data-open-turn-audit="t5"/);

  // Legacy history never entered the journal: it keeps the 结果 shape and says
  // so instead of offering an audit page that cannot exist.
  // 旧历史从未进入 Journal：它沿用"结果"结构并如实说明，而不是提供一个不可能存在的审计页。
  const history = markup({
    id: "chat", kind: "conversation", messages: [],
    turns: [{ id: "h1", kind: "history", input: "旧请求", status: "info", startedAt: "2026-11-18T10:04:00.000Z", reply: "旧回答。" }],
  });
  assert.match(history, /log-step-label">结果/);
  assert.match(history, /旧回答。/);
  assert.match(history, /旧记录没有保存过程。/);
  assert.doesNotMatch(history, /data-open-turn-audit/);

  // Older turns are counted, not silently dropped.
  // 更早的回合会被计数，而不是悄悄丢掉。
  const omitted = markup({
    id: "chat", kind: "conversation", messages: [], turnsOmitted: 12,
    turns: [{ id: "t4", kind: "turn", input: "最近一轮", status: "completed", startedAt: "2026-11-18T10:02:00.000Z", journaled: true, compactions: [], toolCalls: [], spawnedRuns: [], priorTurns: 0, priorTurnsOmitted: 0, reply: "好。" }],
  });
  assert.match(omitted, /更早的 12 个回合/);
});

test("the first-send failure card uses the server's owner-facing summary", async () => {
  // A first send has no streamed reply, so this transient card is the only
  // failure text the owner sees. It must use the summary and next step the
  // server sends, not only the raw loop error.
  // 首次发送没有流式正文，因此这张临时卡是所有者在失败时唯一看到的文字。它必须使用服务端
  // 发来的摘要与下一步，而不只是原始循环错误。
  const app = await read("app.js");
  assert.match(app, /failureSummary = payload\.errorSummary \|\| ""/);
  assert.match(app, /failureGuidance = payload\.errorGuidance \|\| ""/);
  assert.match(app, /data-response-error><b>错误<\/b>/);
  assert.match(app, /log-error-guidance">下一步：/);
});

test("the transcript separates a turn, a task update, a child run and a record by level", async () => {
  const app = await read("app.js");
  const css = await read("components.css");
  // The screenshot that prompted this had four look-alike white cards: a turn
  // tail, a 任务更新, the next turn and an Agent 协作 disclosure, with child-run
  // buttons that looked like sibling tasks. The levels are now carried by
  // structure: a ruled section with a named overline, a margin note, a row on a
  // rail and a disclosure line.
  // 触发这次改版的截图里有四只相似的白卡片：回合尾部、任务更新、下一个回合与 Agent 协作
  // 记录，子 Run 按钮还像同级任务。现在层级由结构承担：带层级眉线的分隔章节、页边注、
  // 竖线上的行与披露行。
  const start = app.indexOf("const LOG_STATUS = {");
  const end = app.indexOf("function displayAgentTitle", start);
  assert.ok(start >= 0 && end > start, "the log markup must exist");
  const markup = runInNewContext(`${app.slice(start, end)}; turnLogMarkup`, {
    escape: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]!)),
    richText: (value: unknown) => String(value ?? ""),
    plainPreview: (value: unknown) => String(value ?? ""),
    time: () => "17:13",
    welcomeMarkup: () => "welcome",
  }) as (session: unknown) => string;
  const html = markup({
    id: "chat",
    kind: "conversation",
    messages: [{ id: "work-1", role: "clone", text: "任务「整理资料」等待你复核。", occurredAt: "2026-11-18T09:00:00.000Z", workStatus: "waiting_review", tone: "warning" }],
    turns: [{
      id: "turn-1", kind: "turn", input: "整理资料", status: "completed", startedAt: "2026-11-18T08:59:00.000Z",
      journaled: true, compactions: [], priorTurns: 0, priorTurnsOmitted: 0,
      toolCalls: [], spawnedRuns: [{ id: "run-12345678", title: "整理资料", status: "completed" }],
      reply: "已整理。",
    }],
  });
  // A turn names its author and keeps its steps in a body the CSS can rule.
  // 回合点明作者，并把步骤放进 CSS 可以画分隔的正文容器。
  assert.match(html, /class="log-entry-kicker">clone-ai/);
  assert.match(html, /class="log-entry-body"/);
  // A work update carries its own run status but no turn overline, so a failed
  // or waiting update cannot look like a turn with a different badge.
  // 任务更新携带自己的 Run 状态，但没有回合眉线：失败或等待中的更新不会看起来只是换了个标签的回合。
  assert.match(html, /data-log-kind="work" data-log-status="waiting_review"/);
  assert.equal((html.match(/class="log-entry-kicker"/g) || []).length, 1);
  // A dispatched run is not a row in the turn log: runs are read in the audit,
  // and the turn keeps one 依据 line naming them.
  // 派发的 Run 不再作为回合日志里的行：Run 在审计里读，回合只保留一行点名它们的"依据"。
  assert.doesNotMatch(html, /data-run-status="completed"/);
  assert.match(html, /派生任务 1 个/);
  // The level grammar must live in the final CSS layer: ruled turns, a ruled
  // note and top-rule records. The turn's identity strip pins only within its
  // own section, and records flatten only after the turn log — a task record
  // keeps its card grouping.
  // 层级语法必须落在最终 CSS 层：分隔的回合、带竖线的页边注与顶线记录。回合的身份条只在
  // 自身章节内吸附；记录只在回合日志之后变平——任务记录保留卡片分组。
  assert.match(css, /\.log-entry\s*\{[^}]*border-top:\s*1px solid var\(--line\)/);
  assert.match(css, /\.log-entry--work\s*\{[^}]*border-left:\s*2px solid/);
  assert.match(css, /\.turn-log\s*~\s*\.activity-card\s*\{[^}]*border-top:\s*1px solid/);
  assert.match(css, /\.log-entry-head\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /\.log-entry:not\(\.log-entry--work\):has\(\+ \.log-entry--work\)/);
  // The answer is the section: with only 结果 left, the 52 px label gutter would
  // indent every reply and name the obvious. The final layer collapses it to one
  // column, hides the label, sets the reply at reading size and closes the
  // section with the 依据 footer and a right-end audit control.
  // 回答就是章节：只剩"结果"时，52px 标签栏只会缩进每段回复并给显而易见的东西贴标签。
  // 最终层把它收成一列、隐藏标签、用阅读字号排回复，并以"依据"页脚与行尾审计入口收束章节。
  assert.match(css, /\.log-step\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*gap:\s*0/);
  assert.match(css, /\.log-step-label\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.log-reply\s*\{[^}]*font-size:\s*14\.5px[^}]*line-height:\s*1\.75/);
  assert.match(css, /\.log-basis\s*\{[^}]*padding-top:\s*10px[^}]*border-top:\s*1px solid var\(--line\)/);
  assert.match(css, /\.log-basis-open\s*\{[^}]*margin-left:\s*auto/);
});

test("a finished task record keeps its verification, evidence and artifacts", async () => {
  const app = await read("app.js");
  const blocks = [
    ["verificationMarkup", app.indexOf("function verificationMarkup(session)"), app.indexOf("function recalledMemoryMarkup", app.indexOf("function verificationMarkup(session)"))],
    ["traceMarkup", app.indexOf("function traceMarkup(session)"), app.indexOf("const SCROLL_BOTTOM_THRESHOLD", app.indexOf("function traceMarkup(session)"))],
  ] as const;
  for (const [name, start, end] of blocks) assert.ok(start >= 0 && end > start, `${name} must exist`);
  const context = {
    escape: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]!)),
    icon: () => "",
    time: () => "15:49",
    disclosureOpen: (_session: unknown, _name: string, fallback = false) => fallback,
    EVIDENCE_KIND: { artifact: "产物", observation: "观察" },
  };
  const markup = runInNewContext(`${blocks.map(([, start, end]) => app.slice(start, end)).join("\n")}; ({ verificationMarkup, evidenceMarkup, traceMarkup })`, context);
  const session = {
    id: "run-1",
    status: "completed",
    evidenceCount: 2,
    evidence: [
      { id: "e1", kind: "artifact", locator: "src/main.js", summary: "write_file wrote src/main.js", createdAt: "2026-11-18T07:49:23.174Z" },
      { id: "e2", kind: "observation", locator: "README.md", summary: "read_file read README.md", createdAt: "2026-11-18T07:49:23.174Z" },
    ],
    verification: {
      runId: "run-1", passed: true, needsReview: false, reviewedBy: "owner",
      summary: "Owner accepted the unverified criteria.",
      unverifiedCriteria: ["审查 RAG 项目代码"],
      checkedEvidenceIds: ["e1", "e2"],
      createdAt: "2026-11-18T07:49:23.174Z",
    },
    trace: [{ sequence: 1, type: "run.created", label: "创建任务运行", detail: "1 个步骤", occurredAt: "2026-11-18T07:49:23.174Z" }],
  };
  const verification = markup.verificationMarkup(session);
  assert.match(verification, /核验结果/);
  // The owner's decision is the pill; the old "你的决定：接受结果" line said the
  // same thing twice next to it.
  // 所有者的决定就是标签；旧的"你的决定：接受结果"一行在旁边又重复了一遍。
  assert.match(verification, /已接受结果/);
  assert.doesNotMatch(verification, /你的决定：/);
  assert.match(verification, /审查 RAG 项目代码/);
  assert.match(verification, /检查了 2 条证据/);
  // A criterion carrying "title: text" renders the title on its own line.
  // 带"标题: 文本"的标准会把标题单独显示一行。
  assert.match(verification, /<ol class="verification-criteria">/);
  const titled = markup.verificationMarkup({
    ...session,
    verification: { ...session.verification, unverifiedCriteria: ["完善模型: 首帧可见"] },
  });
  assert.match(titled, /<b>完善模型<\/b><span>首帧可见<\/span>/);
  // A record written before the summary changed still repeats the criteria in
  // its stored summary; the record shows the count, not the wall of text.
  // 在摘要改动之前写下的记录仍会在摘要里重复标准；记录显示计数，而不是一堵文字墙。
  const legacy = markup.verificationMarkup({
    ...session,
    verification: { ...session.verification, summary: "Checks passed, but these criteria need owner review: A; B." },
  });
  assert.match(legacy, /自动检查通过；1 项标准需人工判断/);
  assert.doesNotMatch(legacy, /Checks passed, but these criteria need owner review/);
  const evidence = markup.evidenceMarkup(session);
  assert.match(evidence, /1 个产物 · 1 条观察/);
  assert.match(evidence, /src\/main\.js/);
  assert.match(evidence, /README\.md/);
  assert.match(evidence, /data-disclosure="evidence" open/);
  // The record opens its trace in both states; the owner's own collapse still wins.
  // 两种状态下记录都展开轨迹；所有者自己做过的折叠仍然有效。
  assert.match(markup.traceMarkup({ ...session, status: "waiting_review" }), /data-disclosure="trace" open/);
  assert.match(markup.traceMarkup(session), /data-disclosure="trace" open/);
});

test("a plan step names its risk instead of promising a confirmation", async () => {
  const app = await read("app.js");
  const start = app.indexOf("function planMarkup(session)");
  const end = app.indexOf("function agentsMarkup", start);
  assert.ok(start >= 0 && end > start, "planMarkup must exist");
  const planMarkup = runInNewContext(`${app.slice(start, end)}; planMarkup`, {
    escape: (value: unknown) => String(value ?? ""),
    icon: () => "",
    disclosureOpen: () => false,
  });
  const session = {
    id: "run-1",
    status: "failed",
    plan: {
      summary: "review",
      steps: [
        { id: "s1", title: "read", risk: "read_only", delegated: false },
        { id: "s2", title: "write", risk: "reversible_write", delegated: false },
        { id: "s3", title: "deploy", risk: "external_side_effect", delegated: false },
      ],
    },
  };
  const markup = planMarkup(session);
  // "需确认" read as a pending approval, but a reversible write is allowed by
  // policy without one; the label now names the risk class.
  // “需确认”会被读成待审批，但可回滚写入由策略直接放行；标签现在只说明风险类别。
  assert.match(markup, /直接处理/);
  assert.match(markup, /本地写入/);
  assert.match(markup, /外部动作/);
  assert.doesNotMatch(markup, /需确认/);
});

test("a subagent row outside its record opens the task record that owns it", async () => {
  const app = await read("app.js");
  const css = (await read("style.css")) + (await read("components.css"));
  const start = app.indexOf("function agentsMarkup(session)");
  const end = app.indexOf("function approvalMarkup", start);
  assert.ok(start >= 0 && end > start, "agentsMarkup must exist");
  const markupFor = (session: unknown, agentFocus: { runId: string; agentId: string } | null = null) => runInNewContext(
    `${app.slice(start, end)}; agentsMarkup(sessionParam)`,
    {
      escape: (value: unknown) => String(value ?? ""),
      icon: () => "",
      disclosureOpen: () => false,
      statusMeta: (status: string) => ({ label: status, dot: status }),
      displayAgentTitle: (agent: { title: string }) => agent.title,
      displayAgentDetail: (agent: { summary?: string }) => agent.summary ?? "",
      state: { agentFocus },
      sessionParam: session,
    },
  );
  const agent = {
    id: "agent-1",
    runId: "run-1",
    title: "准备本地交付物",
    status: "failed",
    providerId: "native",
    summary: "Subagent draft did not satisfy its artifact contract.",
  };
  // In the conversation the subagent belongs to another record: the row is the
  // button that opens it, and the title is the hover affordance.
  // 对话中的子 Agent 属于另一条记录：整行是打开它的按钮，标题是悬停提示。
  const conversation = markupFor({ id: "main-agent-conversation", status: "running", subagents: [agent] });
  assert.match(conversation, /<button class="agent-row agent-row--open" type="button" data-open-agent-run="run-1" data-agent-id="agent-1"/);
  assert.match(conversation, /<strong>准备本地交付物<\/strong>/);
  assert.match(conversation, /title="打开这个子 Agent 所属的任务记录"/);
  // Inside the record the row is already where the click would land: it keeps
  // the same information without an affordance.
  // 记录内的行已经在目的地：保留同样信息，但不做成可点击。
  const record = markupFor({ id: "run-1", status: "failed", subagents: [agent] });
  assert.match(record, /<div class="agent-row" data-agent-id="agent-1">/);
  assert.doesNotMatch(record, /data-open-agent-run/);
  // A click asks for one row; the target record opens its card and marks that
  // row so the reveal can scroll to it.
  // 点击要求查看某一行；目标记录展开卡片并标出该行，供 reveal 滚动到它。
  const focused = markupFor({ id: "run-1", status: "completed", subagents: [agent] }, { runId: "run-1", agentId: "agent-1" });
  assert.match(focused, /data-disclosure="agents" open/);
  assert.match(focused, /data-agent-focus="true"/);
  // The click handler and the one-shot reveal are wired, and the row's title
  // underlines on hover.
  // 点击处理器与一次性 reveal 已接线，行的标题在悬停时显示下划线。
  assert.match(app, /event\.target\.closest\("\[data-open-agent-run\]"\)/);
  assert.match(app, /state\.agentFocus = \{ runId: agentRun\.dataset\.openAgentRun, agentId: agentRun\.dataset\.agentId \}/);
  assert.match(app, /void selectSession\(agentRun\.dataset\.openAgentRun\)/);
  assert.match(app, /function revealAgentFocus\(id\)/);
  assert.match(app, /revealAgentFocus\(session\.id\)/);
  assert.match(css, /button\.agent-row:hover strong\s*\{[^}]*text-decoration:\s*underline/);
  assert.match(css, /button\.agent-row:focus-visible\s*\{[^}]*outline:/);
});

test("invocation rows keep selection and deletion as sibling controls", async () => {
  const audit = await read("audit.js");
  // A button cannot contain another button, so a per-row delete control forces
  // the row from a single button into a container with two siblings: the pick
  // button (data-au-invocation) and the action (delete/restore). The bulk action
  // still counts pick buttons, so it keeps working.
  // 按钮里不能再放按钮，因此行级删除控件把整行从单个按钮变成带两个兄弟的容器：选择按钮
  // （data-au-invocation）与动作（删除/恢复）。批量动作仍按选择按钮计数，因此继续有效。
  const row = audit.match(/<div class="au-row">[\s\S]*?<\/div>`\)\.join\(""\)/);
  assert.ok(row !== null, "the invocation row must be a container, not one button");
  assert.match(row![0], /data-au-invocation=/);
  assert.match(row![0], /data-au-inv-delete=/);
  assert.match(row![0], /data-au-inv-restore=/);
  // The pick button closes before the delete action opens: no nested buttons.
  // 选择按钮在删除动作打开之前关闭：没有嵌套按钮。
  assert.match(row![0], /<\/button>\s*\$\{record\.deleted/);
  // The bulk action still reads the pick buttons, not the row actions.
  // 批量动作仍读取选择按钮，而不是行动作。
  assert.match(audit, /querySelectorAll\("\[data-au-invocation\]"\)/);
});

test("decisions are confirmed on the task record that owns the run", async () => {
  const app = await read("app.js");
  const css = await read("style.css");
  const index = await read("index.html");
  // The conversation is not a decision inbox: the task record owns its approval
  // and its review. The main conversation is a sidebar row now, so the old
  // "never filtered as a row" assertion is intentionally gone.
  // 对话不是决定收件箱：任务记录拥有自己的确认与复核。主对话现在是侧栏行，
  // 原先"绝不作为行过滤"的断言已移除。
  assert.doesNotMatch(app, /data-open-main-conversation/);
  assert.match(app, /data-approve="\$\{escape\(approval\.runId\)\}"/);
  assert.match(app, /data-review="\$\{escape\(review\.runId\)\}"/);
  assert.match(app, /session\.reviews/);
  // A pending decision is docked at the top of the pane, not left after the log.
  // 等待中的决定固定在面板顶部，而不是留在日志末尾。
  assert.match(app, /function decisionDock\(session\)/);
  assert.match(app, /\$\{decisionDock\(session\)\}/);
  // The sidebar is conversations only: no nested run rows, no child-group
  // disclosures, no 定时/自动 task section. A task waiting for the owner is the
  // one promoted row; dispatched runs are read in the audit, whose record list
  // stays tasks-only because a conversation is not a Run.
  // 侧栏只列对话：没有嵌套的 Run 行、没有子行折叠区、没有"定时/自动"任务分区。唯一被提升的
  // 行是等待所有者决定的任务；派发的 Run 在审计里读，而审计的记录列表仍只列任务，
  // 因为对话不是 Run。
  assert.match(app, /const conversations = rawSessions\.filter\(\(session\) => session\.kind === "conversation"\)/);
  assert.match(app, /const tasks = rawSessions\.filter\(\(session\) => session\.kind !== "conversation"\)/);
  assert.doesNotMatch(app, /data-child-group=/);
  assert.doesNotMatch(app, /class="session-children"/);
  assert.doesNotMatch(app, /autoBlock/);
  assert.match(app, /session-group-needs/);
  assert.match(app, /session-group-main/);
  assert.match(app, /session-flag-approval/);
  assert.match(app, /session-flag-review/);
  assert.match(app, /needs-you/);
  // A conversation row carries no species badge and no task count; the row is
  // the whole story.
  // 对话行不再携带种类徽章，也不带任务计数；这一行就是全部。
  assert.doesNotMatch(app, /class="session-kind"/);
  assert.doesNotMatch(app, /taskCountLabel/);
  assert.match(app, /const records = sessions\.filter\(\(session\) => session\.kind !== "conversation"\)/);
  assert.doesNotMatch(index, /id="open-conversation"/);
  // The sidebar has one talk entry: 新请求 starts a routed request, and the
  // main conversation is the pinned first row of the same list. There is no
  // second navigation button for it.
  // 侧栏只有一个对话入口：新请求 发起经过路由的请求，主对话是同一列表中固定的第一行。
  // 它没有第二个导航按钮。
  assert.doesNotMatch(app, /\$\("open-conversation"\)/);
  assert.match(app, /const mainConversation = conversations\.find\(\(session\) => session\.id === MAIN_CONVERSATION_ID\)/);
  assert.match(app, /const otherConversations = conversations\.filter\(\(session\) => session\.id !== MAIN_CONVERSATION_ID\)/);
  // There is no working-directory setting: the page and its script no longer
  // carry the picker, the reveal action or the restart notice.
  // 没有工作目录设置：页面与脚本都不再带有选择器、定位动作或重启提示。
  assert.doesNotMatch(index, /config-workspace|data-i18n="working-directory"/);
  assert.doesNotMatch(app, /chooseWorkspace|revealWorkspace|workspace-saved/);
  assert.match(css, /\.session-flag/);
  assert.match(css, /\.session-item\.is-attention/);
  const auditCss = await read("audit.css");
  assert.doesNotMatch(auditCss, /\.session-item\.is-child/);
  assert.doesNotMatch(auditCss, /\.session-children/);

  const approvalStart = app.indexOf("function approvalMarkup(session)");
  const approvalEnd = app.indexOf("function reviewMarkup", approvalStart);
  assert.ok(approvalStart >= 0 && approvalEnd > approvalStart, "approvalMarkup must exist");
  const approvalMarkup = runInNewContext(
    `${app.slice(approvalStart, approvalEnd)}; approvalMarkup`,
    { escape: (value: unknown) => String(value ?? "") },
  ) as (session: unknown) => string;
  const approval = approvalMarkup({
    id: "run-approval",
    status: "waiting_approval",
    title: "Publish the report",
    approvals: [{ runId: "run-approval", stepId: "send", title: "发送", description: "这一步会影响外部系统；确认后才会继续。" }],
  });
  assert.match(approval, /data-approve="run-approval"/);
  assert.match(approval, /需要你确认后才能继续/);
  assert.match(approval, /步骤：发送/);
  assert.match(approval, /确认后才会继续/);

  const reviewStart = app.indexOf("function reviewMarkup(session)");
  const reviewEnd = app.indexOf("function verificationMarkup", reviewStart);
  assert.ok(reviewStart >= 0 && reviewEnd > reviewStart, "reviewMarkup must render the review list");
  const reviewMarkup = runInNewContext(
    `${app.slice(reviewStart, reviewEnd)}; reviewMarkup`,
    { escape: (value: unknown) => String(value ?? ""), richText: (value: unknown) => String(value ?? "") },
  ) as (session: unknown) => string;
  const markup = reviewMarkup({
    id: "run-review",
    status: "waiting_review",
    title: "Review the report",
    reviews: [{ runId: "run-review", title: "Review the report", result: "The review found three gaps.", verification: { summary: "A browser check is pending.", unverifiedCriteria: ["The page shows the detail."] } }],
  });
  assert.match(markup, /data-review="run-review"/);
  assert.match(markup, /The page shows the detail\./);
  // The card must show the worker's answer, not only the criteria the Kernel
  // could not verify. 卡片必须显示 Worker 的回答，而不只是 Kernel 无法验证的标准。
  assert.match(markup, /The review found three gaps\./);
  assert.match(markup, /review-result/);
  // A waiting review without a stored verification still offers the decision.
  // 等待复核但没有存储的核验记录时，仍提供决定按钮。
  const fallback = reviewMarkup({ id: "run-review-2", status: "waiting_review", title: "No verification", reviews: [] });
  assert.match(fallback, /data-review="run-review-2"/);
  assert.match(fallback, /等待你的复核/);
});

test("a finished run keeps its verification, evidence and trace on the task", async () => {
  const app = await read("app.js");
  const css = await read("style.css");
  // The verdict used to disappear with `waiting_review`, evidence was a bare
  // count, and the trace only opened when its disclosure was toggled by hand.
  // The record now survives the owner's decision, lists what the run produced,
  // and opens the trace while a decision is still pending.
  // 结论过去随 `waiting_review` 一起消失，证据只有计数，轨迹只能手动展开。现在记录在
  // 所有者决定后仍然保留、列出 Run 产出了什么，并在仍待决定时展开轨迹。
  assert.match(app, /function verificationMarkup\(session\)/);
  assert.match(app, /verification\.reviewedBy === "owner"/);
  assert.match(app, /data-verification/);
  assert.match(app, /\$\{verificationMarkup\(session\)\}/);
  assert.match(app, /function evidenceMarkup\(session\)/);
  assert.match(app, /session\.evidence/);
  assert.match(app, /EVIDENCE_KIND\[item\.kind\]/);
  assert.match(app, /\$\{evidenceMarkup\(session\)\}/);
  assert.match(app, /disclosureOpen\(session, "trace", true\)/);
  assert.match(css, /\.verification-card\s*\{/);
  assert.match(css, /\.evidence-list\s*\{/);
});

test("the owner's message renders markdown like the agent's", async () => {
  const app = await read("app.js");
  const css = await read("components.css");
  // The owner's request is a right-hand bubble and the live turn uses the same
  // escaping renderer. A pasted task brief therefore never shows raw markdown,
  // and the agent's reply keeps the same treatment on the left.
  // 所有者的请求是靠右的气泡，实时回合使用同一套先转义的渲染器。粘贴的任务说明因此不会显示
  // 字面 Markdown，Agent 的回复在左侧保持同样的处理。
  assert.match(app, /const body = richText\(text\);/);
  assert.match(app, /class="turn-query-bubble"/);
  assert.match(app, /richText\(query \|\| "（已发送附件）"\)/);
  assert.match(css, /\.message-copy \.md-heading/);
  assert.match(css, /\.message-copy \.md-list-line/);
  assert.match(css, /\.turn-query-text \.md-heading/);
  assert.match(css, /\.turn-query-text \.md-list-line/);
  assert.match(css, /\.log-reply \.md-heading/);
});

test("a Markdown table renders as a table and carries its CSV", async () => {
  const app = await read("app.js");
  const css = await read("components.css");
  const start = app.indexOf("function mdInline(");
  const end = app.indexOf("function messageMarkup(", start);
  assert.ok(start >= 0 && end > start, "the table renderer must sit before messageMarkup");
  const escapeLine = app.match(/^const escape = .*$/m)?.[0];
  assert.ok(escapeLine, "richText escapes through the shared helper");
  const richText = runInNewContext(`${escapeLine}\n${app.slice(start, end)}; richText`) as (value: string) => string;

  const html = richText("今天的情况：\n\n| 位置 | 状态 |\n| :--- | ---: |\n| `src/a.js` | **已修改** |\n| b | c |\n\n结束。");
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th class="md-table-cell md-table-cell--left">位置<\/th>/);
  assert.match(html, /<th class="md-table-cell md-table-cell--right">状态<\/th>/);
  assert.match(html, /<td class="md-table-cell md-table-cell--left"><code class="md-inline">src\/a\.js<\/code><\/td>/);
  assert.match(html, /<td class="md-table-cell md-table-cell--right"><b>已修改<\/b><\/td>/);
  assert.match(html, /data-export-csv="位置,状态&#10;src\/a\.js,已修改&#10;b,c"/);
  assert.match(html, />导出 CSV</);
  assert.doesNotMatch(html, /\| 位置 \|/);

  // A pipe escaped in a cell is content, not a column separator.
  // 单元格里转义的竖线是内容，不是列分隔符。
  const escaped = richText("| a \\| b | c |\n| --- | --- |\n| d | e |");
  assert.match(escaped, /<th class="md-table-cell">a \| b<\/th>/);
  assert.match(escaped, /data-export-csv="a \| b,c&#10;d,e"/);

  // A line with pipes and no delimiter row is prose, not a table.
  // 有竖线但没有分隔行的只是普通文本，不是表格。
  const prose = richText("| a | b |\n不是分隔行");
  assert.doesNotMatch(prose, /<table/);
  assert.match(prose, /\| a \| b \|/);

  // A table inside a fenced block stays code.
  // 围栏代码块里的表格保持为代码。
  const fenced = richText("```\n| a | b |\n| --- | --- |\n```");
  assert.doesNotMatch(fenced, /<table/);
  assert.match(fenced, /<pre class="md-code">/);
  assert.match(fenced, /\| a \| b \|/);

  // Cell content is escaped before any inline markup is added.
  // 单元格内容在任何行内标记之前先被转义。
  const unsafe = richText("| a |\n| --- |\n| <img src=x onerror=alert(1)> |");
  assert.doesNotMatch(unsafe, /<img/);
  assert.match(unsafe, /&lt;img src=x onerror=alert\(1\)&gt;/);

  assert.match(css, /\.md-table-wrap\s*\{/);
  assert.match(css, /\.md-table-export\s*\{/);
  assert.match(css, /\.md-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  // The button is wired into the conversation's one delegated click handler.
  // 按钮接入对话唯一的委托点击处理器。
  assert.match(app, /event\.target\.closest\("\[data-export-table\]"\)/);
  assert.match(app, /exportMarkdownTable\(tableExport\.dataset\.exportCsv/);
});

test("a table's export control writes CSV through the owner-picked folder", async () => {
  const app = await read("app.js");
  const start = app.indexOf("function exportMarkdownTable(");
  const end = app.indexOf("async function addConnector(", start);
  assert.ok(start >= 0 && end > start, "exportMarkdownTable must be standalone");
  const source = app.slice(start, end);

  const announced: Array<[string, boolean]> = [];
  let downloaded: { href?: string; download?: string } | undefined;
  let downloadedBlob: { parts?: string[] } | undefined;
  let chosen: { purpose: string; callback: (destination: string) => Promise<void> } | undefined;
  let posted: { path: string; body: { destination: string; csv: string } } | undefined;
  const revealed: string[] = [];
  const run = (window: unknown) => runInNewContext(`${source}; exportMarkdownTable`, {
    window,
    announce: (message: string, error: boolean) => announced.push([message, error === true]),
    chooseNativeDirectory: (purpose: string, callback: (destination: string) => Promise<void>) => { chosen = { purpose, callback }; },
    api: async (path: string, options: { body: string }) => {
      posted = { path, body: JSON.parse(options.body) };
      return { path: "/tmp/out/clone-ai-table.csv", name: "clone-ai-table.csv" };
    },
    Blob: class { parts: string[]; constructor(parts: string[]) { this.parts = parts; } },
    URL: { createObjectURL: (blob: { parts?: string[] }) => { downloadedBlob = blob; return "blob:table"; }, revokeObjectURL: () => {} },
    document: { createElement: () => { const anchor = { href: "", download: "", click() { downloaded = anchor; } }; return anchor; } },
    setTimeout: () => {},
  }) as (csv: string) => void;

  // A browser preview has no native picker: the table becomes a real download.
  // 浏览器预览没有原生选择器：表格变成一次真实下载。
  run({})("a,b\n1,2");
  assert.equal(downloaded?.href, "blob:table");
  assert.match(downloaded?.download ?? "", /^clone-ai-table-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(downloadedBlob?.parts?.[0]?.charCodeAt(0), 0xFEFF);
  assert.deepEqual(announced.at(-1), ["表格已下载为 CSV。", false]);

  // The desktop hands the CSV to the daemon only after the owner picks a folder.
  // 桌面端只在所有者挑中文件夹之后，才把 CSV 交给 daemon。
  run({ CloneNative: { chooseDirectory: () => {}, revealInFinder: (path: string) => revealed.push(path) } })("a,b\n1,2");
  assert.equal(chosen?.purpose, "table-export");
  await chosen?.callback("/tmp/out");
  assert.equal(posted?.path, "/api/tables/export");
  assert.equal(posted?.body.destination, "/tmp/out");
  assert.equal(posted?.body.csv.charCodeAt(0), 0xFEFF);
  assert.deepEqual(revealed, ["/tmp/out/clone-ai-table.csv"]);
  assert.deepEqual(announced.at(-1), ["表格已导出：clone-ai-table.csv", false]);
});

test("every function the UI calls is defined", async () => {
  // The daemon serves app.js from a snapshot read at startup. A source edit
  // that reorders or drops a function therefore reaches an already-running
  // window as a runtime break — "Can't find variable" on the first click — and
  // no static check noticed. This is the cheap version of that check: every
  // identifier the UI calls with no other definition in the file must exist.
  // Daemon 提供的是启动时读取的 app.js 快照。源码改动若重排或丢弃函数，会以运行时错误的
  // 形式到达已在运行的窗口——第一次点击就 "Can't find variable"——而此前没有任何静态检查。
  // 这是该检查的廉价版本：UI 调用、且文件里没有其他定义的标识符必须存在。
  const app = await read("app.js");
  const defined = new Set<string>();
  for (const match of app.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(match[1]);
  for (const match of app.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(match[1]);
  for (const match of app.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(match[1]);
  const called = new Set<string>();
  for (const match of app.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)) called.add(match[1]);
  // Keywords and globals that are not declarations in this file, plus words the
  // regex picks up from strings and property positions.
  // 关键词与本文件里并非声明的全局，以及正则从字符串和属性位置误抓的词。
  const ignored = new Set([
    "if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "new",
    "async", "parseInt", "parseFloat", "isNaN", "encodeURIComponent", "decodeURIComponent",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch", "alert", "confirm",
    "prompt", "requestAnimationFrame", "structuredClone", "queueMicrotask", "import", "require",
    "resolve", "reject", "onChoose", "run", "first", "u0000BLOCK", "u0000TABLE", "characters",
  ]);
  const missing = [...called].filter((name) => !defined.has(name) && !ignored.has(name));
  assert.deepEqual(missing, [], `app.js calls functions it never defines: ${missing.join(", ")}`);
});


test("the audit explains how each Main Agent turn was assembled", async () => {
  const audit = await read("audit.js");
  const auditCss = await read("audit.css");
  // The audit answers "how was this task assembled": conversation, history
  // window, prompt materials, tool table and dispatched runs in one block.
  // 审计回答"这个任务怎么组装的"：对话、历史窗口、提示词材料、工具表与派发的 Run 放在
  // 同一个块里。
  assert.match(audit, /function assemblyBlock\(turn\)/);
  assert.match(audit, /\$\{assemblyBlock\(turn\)\}/);
  assert.match(audit, /任务组装/);
  assert.match(audit, /historyMessages/);
  assert.match(audit, /instructionSources/);
  assert.match(audit, /turn\.runs/);
  assert.match(audit, /au-assembly-runs/);
  // The conversation no longer renders compaction summaries; the audit is their
  // only home, so it must show the text and the counts.
  // 对话不再渲染压缩摘要；审计是它们唯一的家，因此必须显示正文与计数。
  assert.match(audit, /turn\.compactions/);
  assert.match(audit, /au-assembly-compactions/);
  // The executed calls, with their inputs and durations, are the other half of
  // what the conversation dropped; the audit turn card must keep rendering them.
  // 执行过的调用及其输入与耗时是对话丢掉的另一半；审计回合卡必须继续渲染它们。
  assert.match(audit, /turn\.toolCalls/);
  assert.match(audit, /au-turn-tools/);
  assert.match(auditCss, /\.au-assembly/);
  assert.match(auditCss, /\.au-assembly-compactions/);
  assert.match(auditCss, /\.au-turn-tools/);
});

test("the audit keeps the compaction summary the conversation no longer shows", async () => {
  const audit = await read("audit.js");
  const start = audit.indexOf("function assemblyBlock(turn)");
  const end = audit.indexOf("function turnsView", start);
  assert.ok(start >= 0 && end > start, "assemblyBlock must exist");
  const assemblyBlock = runInNewContext(`${audit.slice(start, end)}; assemblyBlock`, {
    esc: (value: unknown) => String(value ?? ""),
    num: (value: number) => String(value ?? 0),
    stamp: () => "11:35:00",
    statusBadge: (status: string) => `<span>${status}</span>`,
  }) as (turn: unknown) => string;
  const html = assemblyBlock({
    conversationId: "conversation-a", modelId: "m", provider: "p", effort: "high",
    historyMessages: 3, historyTurns: 1,
    compactions: [{ at: "2026-11-19T03:30:00.000Z", estimatedTokens: 90_000, compactAt: 80_000, droppedMessages: 12, keptMessages: 3, summary: "前面的对话压成一段摘要。" }],
    snapshot: { charterVersion: 5, hasBriefing: true, instructionSources: [], toolNames: ["dispatch_task"], materialHash: "abcdef" },
    runs: [], historySearches: [],
  });
  // The process the conversation dropped must still be readable in its new home.
  // 对话丢掉的过程，仍必须能在它的新家读到。
  assert.match(html, /上下文压缩/);
  assert.match(html, /丢弃 12 条 \/ 保留 3 条/);
  assert.match(html, /前面的对话压成一段摘要。/);
});

test("the audit turn card keeps the tool calls the conversation dropped", async () => {
  const audit = await read("audit.js");
  const start = audit.indexOf("function turnsView()");
  const end = audit.indexOf("function invocationsView", start);
  assert.ok(start >= 0 && end > start, "turnsView must exist");
  const turnsView = runInNewContext(`${audit.slice(start, end)}; turnsView`, {
    state: {
      turns: [{
        turnId: "turn-1", conversationId: "conversation-a", source: "companion", status: "completed",
        modelId: "m", effort: "high", startedAt: "2026-11-19T03:35:00.000Z", durationMs: 1234,
        input: "整理资料", reply: "已整理。",
        toolCalls: [{ toolCallId: "c1", name: "dispatch_task", inputSummary: '{"objective":"整理资料"}', durationMs: 3000 }],
        compactions: [], historySearches: [], runs: [],
      }],
      turnTotal: 1, turnFilter: null, turnError: null, turnLoading: false, turnQuery: "",
    },
    num: (value: number) => String(value ?? 0),
    esc: (value: unknown) => String(value ?? ""),
    badge: (text: string) => `<span>${text}</span>`,
    ms: (value: number) => `${value} ms`,
    stamp: () => "11:35",
    usd: () => "$0",
    assemblyBlock: () => "",
  }) as () => string;
  const html = turnsView();
  // The landed turn is named by id and conversation, and the call the
  // conversation no longer shows is still here, with its input and duration.
  // 落点用 id 与对话点名该回合；对话不再显示的调用仍在这里，带着输入与耗时。
  assert.match(html, /data-au-turn-id="turn-1"/);
  assert.match(html, /data-au-turn-conversation="conversation-a"/);
  assert.match(html, /dispatch_task/);
  assert.match(html, /"objective":"整理资料"/);
  assert.match(html, /3000 ms/);
  assert.match(html, /已整理。/);
});

test("the audit landing asks for the turn id and keeps only that turn", async () => {
  const audit = await read("audit.js");
  const start = audit.indexOf("async function loadTurns()");
  const end = audit.indexOf("async function refreshTurns", start);
  assert.ok(start >= 0 && end > start, "loadTurns must exist");
  const state = {
    turns: [], turnTotal: 0, turnError: "stale", turnQuery: "",
    turnFilter: { turnId: "turn-1", conversationId: "conversation-a" },
  };
  const urls: string[] = [];
  const loadTurns = runInNewContext(`${audit.slice(start, end)}; loadTurns`, {
    state,
    turnSeq: 0,
    URLSearchParams,
    api: async (url: string) => {
      urls.push(url);
      return {
        turns: [
          { turnId: "turn-1", conversationId: "conversation-a" },
          { turnId: "turn-1", conversationId: "conversation-b" },
          { turnId: "turn-2", conversationId: "conversation-a" },
        ],
        total: 3,
      };
    },
  }) as () => Promise<boolean>;
  assert.equal(await loadTurns(), true);
  // The request carries the short turn id, not a request that could overflow the
  // GET header limit; the landing keeps the matching conversation only.
  // 请求携带短回合 id，而不是可能撑爆 GET 头部上限的请求；落点只保留匹配的对话。
  assert.match(urls.at(-1) ?? "", /q=turn-1/);
  assert.deepEqual(state.turns, [{ turnId: "turn-1", conversationId: "conversation-a" }]);
  assert.equal(state.turnTotal, 1);
  assert.equal(state.turnError, null);
});

test("the audit shows the write scopes a step was checked against", async () => {
  const audit = await read("audit.js");
  const auditCss = await read("audit.css");
  // "Every write has a permission check" is only inspectable if the audit
  // names the scope, not just how many there are.
  // 只有当审计点名 Scope，而不只是数量时，"每个写入都有权限校验"才是可检查的。
  assert.match(audit, /au-scopes/);
  assert.match(audit, /s\.resource/);
  assert.match(auditCss, /\.au-scopes/);
});

test("an audit turn reads as a right-hand request and a left-hand answer", async () => {
  const audit = await read("audit.js");
  const auditCss = await read("audit.css");
  // The screenshot showed two identical grey <pre> blocks under 输入 and 回复;
  // the exchange now has sides, and the duplicated input preview in the head is
  // gone.
  // 截图里"输入"与"回复"下是两个相同的灰色 <pre>；现在交流有左右两侧，标题里重复的输入
  // 预览也去掉了。
  assert.match(audit, /class="au-turn-query"/);
  assert.match(audit, /class="au-turn-answer"/);
  assert.match(audit, /class="au-turn-role">你/);
  assert.match(audit, /class="au-turn-role">clone-ai/);
  assert.doesNotMatch(audit, /<p class="au-note">输入<\/p>/);
  assert.match(auditCss, /\.au-turn-query\s*\{[^}]*justify-self:\s*end/);
  assert.match(auditCss, /\.au-turn-answer\s*\{[^}]*justify-self:\s*start/);
  assert.match(auditCss, /\.au-turns\s*\{[^}]*display:\s*grid/);
});

test("a new request is routed, and a task record names its conversation", async () => {
  const app = await read("app.js");
  const css = await read("style.css");
  // The owner does not choose a new conversation versus a new task: a
  // new-request send asks the router which Main Agent handles it.
  // 所有者不选择新建对话还是新建任务：新请求发送时由路由器决定哪个 Main Agent 处理。
  assert.match(app, /\/api\/main-agent\/route/);
  assert.match(app, /state\.routing/);
  assert.match(app, /state\.routeContext/);
  assert.match(app, /welcome-routing/);
  assert.match(app, /function dispatchSourceMarkup\(session\)/);
  assert.match(app, /\$\{dispatchSourceMarkup\(session\)\}/);
  assert.match(app, /data-open-conversation/);
  assert.match(css, /\.dispatch-source/);

  const start = app.indexOf("function dispatchSourceMarkup");
  const end = app.indexOf("function renderSession", start);
  assert.ok(start >= 0 && end > start, "dispatchSourceMarkup must exist");
  const dispatchSourceMarkup = runInNewContext(
    `const MAIN_CONVERSATION_ID = "main-agent-conversation"; ${app.slice(start, end)}; dispatchSourceMarkup`,
    { escape: (value: unknown) => String(value ?? "") },
  ) as (session: unknown) => string;
  const markup = dispatchSourceMarkup({ id: "run-1", dispatchedBy: "conversation-abc" });
  assert.match(markup, /所属对话/);
  assert.match(markup, /data-open-conversation="conversation-abc"/);
  assert.match(dispatchSourceMarkup({ id: "run-2", dispatchedBy: "main-agent-conversation" }), /来自主对话/);
  // A conversation view has no parent line, and a run with no parent has none either.
  // 对话视图没有所属对话行；没有父对话的 Run 也没有。
  assert.equal(dispatchSourceMarkup({ id: "conversation-a", kind: "conversation", dispatchedBy: "conversation-a" }), "");
  assert.equal(dispatchSourceMarkup({ id: "run-3" }), "");
});

test("the audit shows the history a turn searched", async () => {
  const audit = await read("audit.js");
  const auditCss = await read("audit.css");
  assert.match(audit, /turn\.historySearches/);
  assert.match(audit, /历史检索/);
  assert.match(audit, /全部对话/);
  assert.match(auditCss, /\.au-assembly-searches/);
});
