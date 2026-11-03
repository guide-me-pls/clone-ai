/*
 * Memory library with progressive disclosure.
 *
 * The list shows only what you scan for — the one-line summary, its type, status
 * and how often it was recalled. Opening one fetches its body and provenance
 * from /api/memory/governed/:id, which also counts as a use. Editing is still
 * available, but only inside the opened row, so a long library reads as an index
 * instead of a wall of textareas.
 *
 * 渐进式披露的记忆库。
 *
 * 列表只显示你扫读时需要的东西——一句话摘要、类型、状态、被召回次数。展开某一条时才去
 * /api/memory/governed/:id 取正文与来源（并计为一次使用）。编辑仍在展开行内，因此长记忆库
 * 读起来是一份索引，而不是一堵文本域。
 */
(() => {
  const TYPES = { preference: "偏好", fact: "事实", decision: "决定", procedure: "流程", commitment: "承诺" };
  const SENS = { private: "私有", public: "公开", secret: "机密" };
  const state = { query: "", type: "all", status: "active", open: new Set(), details: new Map(), editing: new Set() };

  const host = () => document.getElementById("memory-root");
  const day = (value) => (value ? new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—");
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
      if (state.type !== "all" && item.type !== state.type) return false;
      if (state.status !== "all" && item.status !== state.status) return false;
      if (!q) return true;
      return `${item.summary} ${item.content ?? ""} ${item.id}`.toLowerCase().includes(q);
    });
  }

  function editor(item) {
    const types = Object.entries(TYPES).map(([v, l]) => `<option value="${v}"${item.type === v ? " selected" : ""}>${l}</option>`).join("");
    const sens = Object.entries(SENS).map(([v, l]) => `<option value="${v}"${item.sensitivity === v ? " selected" : ""}>${l}</option>`).join("");
    return `<div class="mem-editor">
      <input class="mem-input" type="text" value="${escape(item.summary)}" data-library-summary="${escape(item.id)}" aria-label="记忆摘要"/>
      <textarea class="mem-textarea" rows="4" data-library-content="${escape(item.id)}" aria-label="记忆正文">${escape(item.content ?? "")}</textarea>
      <div class="mem-tools">
        <select data-library-type="${escape(item.id)}" aria-label="类型">${types}</select>
        <select data-library-sensitivity="${escape(item.id)}" aria-label="敏感度">${sens}</select>
        <button type="button" class="mem-btn mem-btn-primary" data-save-library="${escape(item.id)}">保存</button>
        <button type="button" class="mem-btn" data-mem-edit="${escape(item.id)}">取消</button>
      </div>
      <small>保存会同时改写对应的 .md 文件。</small></div>`;
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
    const detail = state.details.get(item.id);
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

  function row(item) {
    const open = state.open.has(item.id);
    const editing = state.editing.has(item.id);
    const sensitive = item.sensitivity === "secret";
    return `<details class="mem-row" data-mem-row="${escape(item.id)}"${open ? " open" : ""}>
      <summary class="mem-head">
        <span class="mem-title">${escape(item.summary)}</span>
        <span class="mem-tags">${badge(TYPES[item.type] ?? item.type, "type")}${item.status === "archived" ? badge("已归档", "muted") : ""}${badge(SENS[item.sensitivity] ?? item.sensitivity, sensitive ? "secret" : item.sensitivity === "public" ? "public" : "private")}</span>
        <span class="mem-meta">召回 ${item.accessCount || 0} · ${day(item.updatedAt)}</span>
      </summary>
      <div class="mem-body">
        ${editing ? editor(item) : bodyOf(item)}
        ${provenance(item)}
        <div class="mem-actions">
          <button type="button" class="mem-btn" data-mem-edit="${escape(item.id)}">${editing ? "收起编辑" : "编辑"}</button>
          ${item.status === "archived"
            ? `<button type="button" class="mem-btn" data-mem-status="${escape(item.id)}" data-mem-next="active">恢复使用</button>`
            : `<button type="button" class="mem-btn" data-mem-status="${escape(item.id)}" data-mem-next="archived">归档</button>`}
        </div>
      </div>
    </details>`;
  }

  function render() {
    const root = ensureHost();
    if (!root || !state.library) return;
    const library = state.library;
    const memories = library.memories || [];
    const visible = filtered(memories);
    const conflicts = (library.conflicts || []).map((item) => `<article class="mem-row mem-conflict"><div class="mem-head"><span class="mem-title">磁盘上的改动与已验证版本冲突</span><span class="mem-meta">${escape(item.summary)}</span></div><div class="mem-body"><div class="mem-actions"><button type="button" class="mem-btn" data-memory-conflict="${escape(item.id)}">保留文件版本</button></div></div></article>`).join("");
    const types = Object.entries(TYPES).map(([v, l]) => `<option value="${v}"${state.type === v ? " selected" : ""}>${l}</option>`).join("");
    root.innerHTML = `
      <div class="mem-toolbar">
        <input class="mem-search" type="search" placeholder="搜索摘要或正文" value="${escape(state.query)}" data-mem-query aria-label="搜索记忆"/>
        <select data-mem-type aria-label="按类型筛选"><option value="all">所有类型</option>${types}</select>
        <select data-mem-status aria-label="按状态筛选"><option value="active"${state.status === "active" ? " selected" : ""}>使用中</option><option value="archived"${state.status === "archived" ? " selected" : ""}>已归档</option><option value="all"${state.status === "all" ? " selected" : ""}>全部</option></select>
        <span class="mem-count">${visible.length}/${memories.length} 条</span>
      </div>
      ${conflicts}
      <div class="mem-list">${visible.length ? visible.map(row).join("") : `<div class="mem-empty">${memories.length ? "没有符合筛选的记忆。" : "记忆库还是空的。写下一条你希望分身长期记住的偏好、边界或事实——它会成为一个你随时可以打开和修改的 .md 文件。"}</div>`}</div>`;
  }

  async function loadDetail(id) {
    if (state.details.has(id)) return;
    state.details.set(id, null);
    try {
      state.details.set(id, await api(`/api/memory/governed/${encodeURIComponent(id)}`));
    } catch (error) {
      state.details.set(id, { evidence: [], file: null });
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
    const row = event.target;
    if (!(row instanceof HTMLDetailsElement) || !row.matches("[data-mem-row]") || !host()?.contains(row)) return;
    const id = row.dataset.memRow;
    if (row.open) {
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
    if (t instanceof HTMLSelectElement && t.matches("[data-mem-type]")) { state.type = t.value; render(); }
    if (t instanceof HTMLSelectElement && t.matches("[data-mem-status]")) { state.status = t.value; render(); }
  });

  window.CloneMemory = Object.freeze({ render });
})();