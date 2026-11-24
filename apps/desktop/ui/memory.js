/*
 * Memory library: search-first, flat, disclosed on demand.
 *
 * The default view is one flat list ordered by last use, with a search box and
 * a type filter. Classification is a machine signal (budget, recall, conflict)
 * and an inline chip, not a browsing tree: with a handful of memories five
 * collapsible groups hide more than they explain.
 *
 * 记忆库：搜索优先、平铺、按需披露。
 *
 * 默认视图是一份按最近使用排序的平铺列表，配搜索框与类型筛选。分类是机器信号（预算、
 * 召回、冲突）与行内标签，而不是浏览树：记忆只有几条时，五个可折叠分组藏起来的比说
 * 明的更多。
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
  const TYPE_LABELS = Object.fromEntries(CATEGORIES.map(([key, label]) => [key, label]));
  const state = { query: "", status: "active", type: "all", open: new Set(), details: new Map(), editing: new Set(), painted: null, paintedAt: null };

  const host = () => document.getElementById("memory-root");
  const day = (value) => (value ? new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—");
  const stamp = (value) => (value ? new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  const badge = (text, tone) => `<span class="mem-badge mem-${tone}">${escape(text)}</span>`;
  /** An unknown stored type is displayed and filtered as a fact. 未知的存储类型按事实显示与筛选。 */
  const typeOf = (item) => (TYPE_LABELS[item.type] === undefined ? "fact" : item.type);

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

  /** Search and status apply to every count; the type filter is the last step. 搜索与状态作用于所有计数；类型筛选是最后一步。 */
  function filtered(memories, type = state.type) {
    const q = state.query.trim().toLowerCase();
    return memories.filter((item) => {
      if (state.status !== "all" && item.status !== state.status) return false;
      if (type !== "all" && typeOf(item) !== type) return false;
      if (!q) return true;
      return `${item.summary} ${item.content ?? ""} ${item.id}`.toLowerCase().includes(q);
    });
  }

  /** Default order: last used first, falling back to the last edit. 默认顺序：最近使用的在前，其次看最近编辑。 */
  function ordered(memories) {
    const time = (value) => {
      const parsed = Date.parse(String(value ?? ""));
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    const last = (item) => Math.max(time(item.updatedAt), time(item.lastAccessedAt));
    return memories.slice().sort((left, right) => last(right) - last(left));
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
      <small>分类影响上下文预算与召回排序；保存会同时改写对应的 .md 文件。</small></div>`;
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

  /** Recent changes to this memory, newest first, with the one undo takes back. 这条记忆的最近变更，最新在前，并标出撤销会撤回的那一次。 */
  function history(item) {
    const detail = state.details.get(item.id) ?? undefined;
    if (detail === undefined) return `<h6 class="mem-subhead">变更记录</h6><p class="mem-pending">读取变更记录…</p>`;
    const versions = detail.versions ?? [];
    if (versions.length === 0) {
      return `<h6 class="mem-subhead">变更记录</h6><p class="mem-note">还没有记录到变更。修改、归档或恢复这条记忆后，这里会出现可撤销的版本。</p>`;
    }
    return `<h6 class="mem-subhead">变更记录 <small>最近 ${versions.length} 次</small></h6>
      <ul class="mem-usage">${versions.slice(0, 8).map((version, index) => `<li>
        <span>${stamp(version.recordedAt)}</span>
        <span>${escape(version.change)}</span>
        ${version.sequence === undefined ? "" : `<small>#${version.sequence}</small>`}
        ${index === 0 ? `<small>撤销将恢复这一版</small>` : `<small>${escape(String(version.entry?.summary ?? "").slice(0, 60))}</small>`}
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
        <span class="mem-tags">${badge(TYPE_LABELS[typeOf(item)], "type")}${item.status === "archived" ? badge("已归档", "muted") : ""}${badge(SENS[item.sensitivity] ?? item.sensitivity, sensitive ? "secret" : item.sensitivity === "public" ? "public" : "private")}</span>
        <span class="mem-meta">召回 ${item.accessCount || 0}${used} · ${day(item.updatedAt)}</span>
      </summary>
      <div class="mem-body">
        ${editing ? editor(item) : bodyOf(item)}
        ${provenance(item)}
        ${usage(item)}
        ${history(item)}
        <div class="mem-actions">
          <button type="button" class="mem-btn" data-mem-edit="${escape(item.id)}">${editing ? "收起编辑" : "编辑"}</button>
          ${(index?.versions?.length ?? 0) > 0
            ? `<button type="button" class="mem-btn" data-mem-undo="${escape(item.id)}">撤销上一次修改</button>`
            : ""}
          ${item.status === "archived"
            ? `<button type="button" class="mem-btn" data-mem-status="${escape(item.id)}" data-mem-next="active">恢复使用</button><button type="button" class="mem-btn mem-btn-danger" data-mem-delete="${escape(item.id)}">删除</button>`
            : `<button type="button" class="mem-btn" data-mem-status="${escape(item.id)}" data-mem-next="archived">归档</button>`}
        </div>
      </div>
    </details>`;
  }

  /** The overview cards are controls: reflect the active filter on them. 概览卡片是控件：让它们反映当前筛选。 */
  function syncOverview() {
    const overview = document.getElementById("library-overview");
    if (overview === null) return;
    for (const button of overview.querySelectorAll("[data-memory-filter]")) {
      button.setAttribute("aria-pressed", button.dataset.memoryFilter === state.status ? "true" : "false");
    }
  }

  function render(options = {}) {
    const root = ensureHost();
    if (!root || !state.library) return;
    // A background repaint must not steal an edit. The markup cache below only
    // helps when the data is unchanged; this guard covers the other half — data
    // did change (another memory was updated, or every recall bumps access
    // counts) while the owner is typing. Skipping the paint leaves the DOM as
    // it is; the next user action or a later poll repaints it.
    // 后台重绘不得抢走正在进行的编辑。下面的标记缓存只在数据未变时有帮助；这个守卫覆盖另一半——
    // 所有者正在输入，而数据确实变了（另一条记忆被更新，或每次召回都会增加计数）。跳过重绘会保持
    // DOM 原样；下一次用户操作或后续轮询再重绘。
    if (options.background === true) {
      const active = document.activeElement;
      const typing = active !== null && active !== undefined
        && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
        && typeof root.contains === "function" && root.contains(active);
      if (typing) return;
    }
    const library = state.library;
    const memories = library.memories || [];
    const inScope = filtered(memories, "all");
    const visible = filtered(memories);
    // Chip counts follow the search and status filters but not the type filter,
    // so the owner can see what switching to another type would show.
    // chip 计数跟随搜索与状态筛选，但不跟随类型筛选，使所有者能看到切到另一类会显示什么。
    const counts = new Map(CATEGORIES.map(([key]) => [key, inScope.filter((item) => typeOf(item) === key).length]));
    const chips = [["all", "全部", inScope.length], ...CATEGORIES.map(([key, label]) => [key, label, counts.get(key) ?? 0])]
      .filter(([key, , count]) => key === "all" || count > 0 || state.type === key)
      .map(([key, label, count]) => `<button type="button" class="mem-type-chip" data-mem-type="${key}" aria-pressed="${state.type === key ? "true" : "false"}">${escape(label)}<small>${count}</small></button>`)
      .join("");
    const empty = memories.length === 0
      ? "记忆库还是空的。写下一条你希望分身长期记住的偏好、边界或事实——它会成为一个你随时可以打开和修改的 .md 文件。"
      : state.status === "archived"
        ? "没有已归档的记忆。归档会让记忆退出召回，但文件仍保留——随时可以恢复或删除。"
        : state.query.trim().length > 0
          ? "没有符合筛选的记忆。"
          : state.type !== "all"
            ? `没有“${TYPE_LABELS[state.type]}”类的记忆。`
            : "没有符合筛选的记忆。";
    const conflicts = (library.conflicts || []).map((item) => `<article class="mem-row mem-conflict"><div class="mem-head"><span class="mem-title">磁盘上的改动与已验证版本冲突</span><span class="mem-meta">${escape(item.summary)}</span></div><div class="mem-body"><div class="mem-actions"><button type="button" class="mem-btn" data-memory-conflict="${escape(item.id)}">保留文件版本</button></div></div></article>`).join("");
    const markup = `
      <div class="mem-toolbar">
        <input class="mem-search" type="search" placeholder="搜索摘要或正文" value="${escape(state.query)}" data-mem-query aria-label="搜索记忆"/>
        <select data-mem-status aria-label="按状态筛选"><option value="active"${state.status === "active" ? " selected" : ""}>使用中</option><option value="archived"${state.status === "archived" ? " selected" : ""}>已归档</option><option value="all"${state.status === "all" ? " selected" : ""}>全部</option></select>
        <span class="mem-count">${visible.length}/${memories.length} 条</span>
      </div>
      <div class="mem-type-filters" role="group" aria-label="按类型筛选">${chips}</div>
      ${conflicts}
      <div class="mem-list">${visible.length ? ordered(visible).map(row).join("") : `<div class="mem-empty">${empty}</div>`}</div>`;
    // Handing the same library back to this view must not touch the DOM: a real
    // innerHTML assignment replaces the whole subtree, detaching the input the
    // owner is typing into and discarding an unsaved edit. Only a changed picture
    // is worth painting.
    // 把同一份 library 再交给本视图时不得触碰 DOM：真实的 innerHTML 赋值会替换整棵子树，
    // 摘下所有者正在输入的输入框，并丢弃未保存的编辑。只有内容真的变了才值得重绘。
    syncOverview();
    if (state.paintedAt === root && state.painted === markup) return;
    state.paintedAt = root;
    state.painted = markup;
    root.innerHTML = markup;
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
      render({ background: true });
    };
  }

  document.addEventListener("toggle", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLDetailsElement) || !host()?.contains(node)) return;
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

  // The counts above the list are controls, not decoration: the archived set is
  // one click away instead of hidden behind the status select. Those cards are
  // rendered by the main client, so this listener deliberately does not require
  // #memory-root containment.
  // 列表上方的计数是控件而不是装饰：归档集点一下就能看到，而不是藏在状态选择框后面。
  // 卡片由主客户端渲染，因此这个监听器刻意不要求位于 #memory-root 内。
  document.addEventListener("click", (event) => {
    const t = event.target;
    if (!(t instanceof Element)) return;
    const filter = t.closest("[data-memory-filter]");
    if (filter !== null) {
      state.status = filter.dataset.memoryFilter;
      render();
      host()?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    const focus = t.closest("[data-memory-focus]");
    if (focus !== null) document.getElementById(focus.dataset.memoryFocus)?.scrollIntoView({ block: "start", behavior: "smooth" });
  });

  document.addEventListener("click", async (event) => {
    const t = event.target;
    if (!(t instanceof Element) || !host()?.contains(t)) return;
    const pick = (selector) => t.closest(selector);
    let el;
    if ((el = pick("[data-mem-type]"))) { state.type = el.dataset.memType; render(); return; }
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
        // The library itself changed, so the main client's signature differs and
        // the overview repaints on the next refresh. `state` here is this view's
        // own object; the `state.signatures` write that used to sit here threw a
        // TypeError and swallowed the success path.
        // 记忆库本身变了，主客户端的签名因此不同，概览会在下一次 refresh 时重绘。这里的
        // `state` 是本视图自己的对象；原先这里的 `state.signatures` 写入会抛 TypeError 并
        // 吞掉成功路径。
        await refresh();
        announce(el.dataset.memNext === "archived" ? "记忆已归档。" : "记忆已恢复使用。");
      } catch (error) { announce(error.message, true); }
      return;
    }
    if ((el = pick("[data-mem-delete]"))) {
      const id = el.dataset.memDelete;
      const memory = (state.library?.memories || []).find((item) => item.id === id);
      if (memory === undefined) return;
      // Deletion is irreversible; the archive step before it is the undoable
      // one. The confirmation says both facts instead of only "are you sure".
      // 删除不可逆；它之前的归档步骤才是可撤销的那一步。确认框把两件事都说明，而不是只问
      // "确定吗"。
      if (!(await confirmDialog(`永久删除“${memory.summary}”？这会移除它的 .md 文件、检索索引和版本记录，无法撤销。`, "永久删除"))) return;
      try {
        await api(`/api/memory/governed/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.details.delete(id);
        state.open.delete(id);
        state.editing.delete(id);
        await refresh();
        announce("记忆已永久删除。");
      } catch (error) { announce(error.message, true); }
      return;
    }
    if ((el = pick("[data-open-memory-source]"))) { closeSettings(); void selectSession(el.dataset.openMemorySource); return; }
    if ((el = pick("[data-mem-undo]"))) {
      const id = el.dataset.memUndo;
      try {
        await api(`/api/memory/governed/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ undo: true }),
        });
        state.details.delete(id);
        await refresh();
        announce("已撤销上一次修改。");
      } catch (error) { announce(error.message, true); }
      return;
    }
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