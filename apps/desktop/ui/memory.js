/*
 * Memory library: classified, layered, disclosed on demand.
 *
 * Level 1 — a category header per kind of memory (commitments and boundaries,
 * preferences, decisions, procedures, facts) with its count and how often its
 * memories have been used.
 * Level 2 — the rows inside a category: summary, status, sensitivity, recalls.
 * Level 3 — one opened memory: body, provenance, and the runs that actually
 * recalled it, from the journal.
 * Level 4 — editing, inside the opened row.
 *
 * 记忆库：先分类，再分层，按需披露。
 *
 * 第 1 层——按记忆种类分组（承诺与边界、偏好、决定、流程、事实），显示条数与被使用次数；
 * 第 2 层——组内的条目：摘要、状态、敏感度、召回次数；
 * 第 3 层——展开的那一条：正文、来源，以及 Journal 里真正召回它的 Run；
 * 第 4 层——编辑，位于展开行内。
 */
(() => {
  const CATEGORIES = [
    ["commitment", "承诺与边界", "你对外承诺的事，以及你不接受的事。"],
    ["preference", "偏好", "你希望分身一直遵循的做法。"],
    ["decision", "决定", "已经定下来、以后要照着走的选择。"],
    ["procedure", "流程", "固定步骤与做法。"],
    ["fact", "事实", "关于你的稳定事实与背景。"],
  ];
  const SENS = { private: "私有", public: "公开", secret: "机密" };
  const state = { query: "", status: "active", open: new Set(), openGroups: new Set(), details: new Map(), editing: new Set() };

  const host = () => document.getElementById("memory-root");
  const day = (value) => (value ? new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—");
  const stamp = (value) => (value ? new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  const badge = (text, tone) => `<span class="mem-badge mem-${tone}">${escape(text)}</span>`;

  function ensureHost() {
    if (host()) return host();
    const panel = document.querySelector('[data-settings-panel="memory"]');
    if (!panel) return null;
    const node = document.createElement("div");
    node.id = "memory-root";
    const legacy = panel.querySelector("#library-list");
    panel.insertBefore(node, legacy ?? null);
    return node;
  }

  function filtered(memories) {
    const q = state.query.trim().toLowerCase();
    return memories.filter((item) => {
      if (state.status !== "all" && item.status !== state.status) return false;
      if (!q) return true;
      return `${item.summary} ${item.content ?? ""} ${item.id}`.toLowerCase().includes(q);
    });
  }

  /** Group into the fixed category order; an unknown type falls under facts. 按固定顺序分组；未知类型归入事实。 */
  function grouped(memories) {
    const buckets = new Map(CATEGORIES.map(([key]) => [key, []]));
    for (const item of memories) {
      const key = buckets.has(item.type) ? item.type : "fact";
      buckets.get(key).push(item);
    }
    for (const list of buckets.values()) list.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return CATEGORIES
      .map(([key, label, hint]) => ({ key, label, hint, items: buckets.get(key) }))
      .filter((group) => group.items.length > 0);
  }

  function editor(item) {
    const types = CATEGORIES.map(([v, l]) => `<option value="${v}"${item.type === v ? " selected" : ""}>${l}</option>`).join("");
    const sens = Object.entries(SENS).map(([v, l]) => `<option value="${v}"${item.sensitivity === v ? " selected" : ""}>${l}</option>`).join("");
    return `<div class="mem-editor">
      <input class="mem-input" type="text" value="${escape(item.summary)}" data-library-summary="${escape(item.id)}" aria-label="记忆摘要"/>
      <textarea class="mem-textarea" rows="4" data-library-content="${escape(item.id)}" aria-label="记忆正文">${escape(item.content ?? "")}</textarea>
      <div class="mem-tools">
        <select data-library-type="${escape(item.id)}" aria-label="分类">${types}</select>
        <select data-library-sensitivity="${escape(item.id)}" aria-label="敏感度">${sens}</select>
        <button type="button" class="mem-btn mem-btn-primary" data-save-library="${escape(item.id)}">保存</button>
        <button type="button" class="mem-btn" data-mem-edit="${escape(item.id)}">取消</button>
      </div>
      <small>分类决定它出现在哪一组；保存会同时改写对应的 .md 文件。</small></div>`;
  }

  /** A body identical to the summary is not worth saying twice. 正文与摘要相同的，不必重复说一遍。 */
  function bodyOf(item) {
    const content = (item.content ?? "").trim();
    const summary = (item.summary ?? "").trim();
    return content.length === 0 || content === summary
      ? `<p class="mem-content mem-content-same">正文与摘要相同；直接编辑即可补充背景或例外。</p>`
      : `<p class="mem-content">${escape(content)}</p>`;
  }

  function provenance(item) {
    const detail = state.details.get(item.id) ?? undefined;
    const runs = item.sourceRunId && item.sourceRunId !== "owner"
      ? `<button type="button" class="mem-link" data-open-memory-source="${escape(item.sourceRunId)}">Run ${escape(item.sourceRunId.slice(0, 8))}</button>`
      : "由你写入";
    const evidence = detail === undefined
      ? `<span class="mem-pending">读取来源…</span>`
      : detail.evidence.length === 0
        ? "无引用证据"
        : detail.evidence.map((entry) => `<span class="mem-evidence">${escape(entry.kind)} · ${escape(entry.locator ?? entry.summary.slice(0, 60))}</span>`).join("");
    const file = detail?.file?.path;
    return `<dl class="mem-detail">
      <dt>来源</dt><dd>${runs}</dd>
      <dt>证据</dt><dd>${evidence}</dd>
      <dt>时间</dt><dd>创建 ${day(item.createdAt)} · 更新 ${day(item.updatedAt)}${item.expiresAt ? ` · 到期 ${day(item.expiresAt)}` : ""}</dd>
      <dt>标识</dt><dd><code>${escape(item.id)}</code>${file ? ` <span class="mem-file" title="${escape(file)}">${escape(file.split("/").slice(-2).join("/"))}</span>` : ""}</dd>
    </dl>`;
  }

  /** Where this memory was actually used: the journal's recall records, newest first. 它实际用在哪：Journal 的召回记录，最新在前。 */
  function usage(item) {
    const detail = state.details.get(item.id) ?? undefined;
    if (detail === undefined) return `<h6 class="mem-subhead">用在哪里</h6><p class="mem-pending">读取使用记录…</p>`;
    const entries = detail.usage ?? [];
    if (entries.length === 0) {
      return `<h6 class="mem-subhead">用在哪里</h6><p class="mem-note">还没有任何任务取用过这条记忆。Worker 派发与主对话读取都会记在这里。</p>`;
    }
    return `<h6 class="mem-subhead">用在哪里 <small>最近 ${entries.length} 次</small></h6><ul class="mem-usage">${entries.map((entry) => `<li>
      <span>${stamp(entry.at)}</span>
      ${entry.runId ? `<button type="button" class="mem-link" data-open-memory-source="${escape(entry.runId)}">Run ${escape(entry.runId.slice(0, 8))}</button>` : `<em>主对话</em>`}
      ${entry.query ? `<small>“${escape(entry.query)}”</small>` : ""}
    </li>`).join("")}</ul>`;
  }

  function row(item) {
    const index = state.details.get(item.id);
    const open = state.open.has(item.id);
    const editing = state.editing.has(item.id);
    const sensitive = item.sensitivity === "secret";
    const used = index === null || index === undefined ? "" : (index.usage?.length ?? 0) > 0 ? ` · 用于 ${index.usage.length} 次` : "";
    return `<details class="mem-row" data-mem-row="${escape(item.id)}"${open ? " open" : ""}>
      <summary class="mem-head">
        <span class="mem-title">${escape(item.summary)}</span>
        <span class="mem-tags">${item.status === "archived" ? badge("已归档", "muted") : ""}${badge(SENS[item.sensitivity] ?? item.sensitivity, sensitive ? "secret" : item.sensitivity === "public" ? "public" : "private")}</span>
        <span class="mem-meta">召回 ${item.accessCount || 0}${used} · ${day(item.updatedAt)}</span>
      </summary>
      <div class="mem-body">
        ${editing ? editor(item) : bodyOf(item)}
        ${provenance(item)}
        ${usage(item)}
        <div class="mem-actions">
          <button type="button" class="mem-btn" data-mem-edit="${escape(item.id)}">${editing ? "收起编辑" : "编辑"}</button>
          ${item.status === "archived"
            ? `<button type="button" class="mem-btn" data-mem-status="${escape(item.id)}" data-mem-next="active">恢复使用</button>`
            : `<button type="button" class="mem-btn" data-mem-status="${escape(item.id)}" data-mem-next="archived">归档</button>`}
        </div>
      </div>
    </details>`;
  }

  function groupBlock(group, searching) {
    const used = group.items.reduce((sum, item) => sum + (item.accessCount || 0), 0);
    const archived = group.items.filter((item) => item.status === "archived").length;
    // Before the owner has opened anything, the first grouping level stays visible;
    // opening a category is remembered so a refresh never collapses what was read.
    // 所有者还没展开过任何分组时，第一层分组保持可见；展开状态会被记住，刷新不会把它收起。
    const open = searching || state.openGroups.has(group.key) || state.openGroups.size === 0;
    return `<details class="mem-group" data-mem-group="${escape(group.key)}"${open ? " open" : ""}>
      <summary class="mem-group-head">
        <span class="mem-group-name">${escape(group.label)}</span>
        <span class="mem-group-hint">${escape(group.hint)}</span>
        <span class="mem-group-count">${group.items.length} 条${used ? ` · 召回 ${used}` : ""}${archived ? ` · ${archived} 已归档` : ""}</span>
      </summary>
      <div class="mem-group-body">${group.items.map(row).join("")}</div>
    </details>`;
  }

  function render() {
    const root = ensureHost();
    if (!root || !state.library) return;
    const library = state.library;
    const memories = library.memories || [];
    const visible = filtered(memories);
    const groups = grouped(visible);
    const searching = state.query.trim().length > 0;
    const conflicts = (library.conflicts || []).map((item) => `<article class="mem-row mem-conflict"><div class="mem-head"><span class="mem-title">磁盘上的改动与已验证版本冲突</span><span class="mem-meta">${escape(item.summary)}</span></div><div class="mem-body"><div class="mem-actions"><button type="button" class="mem-btn" data-memory-conflict="${escape(item.id)}">保留文件版本</button></div></div></article>`).join("");
    root.innerHTML = `
      <div class="mem-toolbar">
        <input class="mem-search" type="search" placeholder="搜索摘要或正文" value="${escape(state.query)}" data-mem-query aria-label="搜索记忆"/>
        <select data-mem-status aria-label="按状态筛选"><option value="active"${state.status === "active" ? " selected" : ""}>使用中</option><option value="archived"${state.status === "archived" ? " selected" : ""}>已归档</option><option value="all"${state.status === "all" ? " selected" : ""}>全部</option></select>
        <span class="mem-count">${visible.length}/${memories.length} 条 · ${groups.length} 组</span>
      </div>
      ${conflicts}
      <div class="mem-groups">${groups.length ? groups.map((group) => groupBlock(group, searching)).join("") : `<div class="mem-empty">${memories.length ? "没有符合筛选的记忆。" : "记忆库还是空的。写下一条你希望分身长期记住的偏好、边界或事实——它会成为一个你随时可以打开和修改的 .md 文件。"}</div>`}</div>`;
  }

  async function loadDetail(id) {
    if (state.details.has(id)) return;
    state.details.set(id, null);
    try {
      state.details.set(id, await api(`/api/memory/governed/${encodeURIComponent(id)}`));
    } catch (error) {
      state.details.set(id, { evidence: [], usage: [], file: null });
      announce(`读取记忆来源失败：${error.message}`, true);
    }
    render();
  }

  // The main client owns fetching and legacy rendering; this view only adds the
  // index. Wrapping keeps one source of truth for the data and no double polling.
  // 主客户端负责取数与旧版渲染；本视图只增加索引。用包装保持数据只有一处来源，也不额外轮询。
  const original = typeof renderLibrary === "function" ? renderLibrary : undefined;
  if (original) {
    renderLibrary = (library) => {
      original(library);
      state.library = library;
      render();
    };
  }

  document.addEventListener("toggle", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLDetailsElement) || !host()?.contains(node)) return;
    if (node.matches("[data-mem-group]")) {
      if (node.open) state.openGroups.add(node.dataset.memGroup);
      else state.openGroups.delete(node.dataset.memGroup);
      return;
    }
    if (!node.matches("[data-mem-row]")) return;
    const id = node.dataset.memRow;
    if (node.open) {
      state.open.add(id);
      void loadDetail(id);
    } else {
      state.open.delete(id);
      state.editing.delete(id);
      render();
    }
  }, true);

  document.addEventListener("click", async (event) => {
    const t = event.target;
    if (!(t instanceof Element) || !host()?.contains(t)) return;
    const pick = (selector) => t.closest(selector);
    let el;
    if ((el = pick("[data-mem-edit]"))) {
      const id = el.dataset.memEdit;
      if (state.editing.has(id)) state.editing.delete(id); else state.editing.add(id);
      render();
      return;
    }
    if ((el = pick("[data-save-library]"))) { await saveLibraryMemory(el.dataset.saveLibrary); state.editing.delete(el.dataset.saveLibrary); return; }
    if ((el = pick("[data-mem-status]"))) {
      const id = el.dataset.memStatus;
      const memory = (state.library?.memories || []).find((item) => item.id === id);
      if (memory === undefined) return;
      try {
        await api(`/api/memory/governed/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ summary: memory.summary, content: memory.content, type: memory.type, sensitivity: memory.sensitivity, status: el.dataset.memNext }),
        });
        state.signatures.library = null;
        await refresh();
        announce(el.dataset.memNext === "archived" ? "记忆已归档。" : "记忆已恢复使用。");
      } catch (error) { announce(error.message, true); }
      return;
    }
    if ((el = pick("[data-open-memory-source]"))) { closeSettings(); void selectSession(el.dataset.openMemorySource); return; }
    if ((el = pick("[data-memory-conflict]"))) { await keepMemoryFile(el.dataset.memoryConflict); return; }
  });

  document.addEventListener("input", (event) => {
    const t = event.target;
    if (t instanceof HTMLInputElement && t.matches("[data-mem-query]")) {
      state.query = t.value;
      const position = t.selectionStart;
      render();
      const next = host()?.querySelector("[data-mem-query]");
      next?.focus();
      next?.setSelectionRange(position, position);
    }
  });
  document.addEventListener("change", (event) => {
    const t = event.target;
    if (t instanceof HTMLSelectElement && t.matches("[data-mem-status]")) { state.status = t.value; render(); }
  });

  window.CloneMemory = Object.freeze({ render });
})();