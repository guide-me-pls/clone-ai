/*
 * Audit & eval view. One self-contained module so the conversation UI and this
 * view can change independently. It only reads /api/audit and posts two owner
 * actions (label a run, delete/restore a session); the journal stays the truth.
 *
 * 审计与评估视图。独立模块，使对话界面与本视图可以各自演进。它只读 /api/audit，并提交两类
 * 所有者动作（给 Run 打标、删除/恢复会话）；Journal 仍是唯一真相。
 */
(() => {
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  const STATUS = {
    completed: ["已完成", "ok"], failed: ["失败", "bad"], cancelled: ["已取消", "mute"], running: ["运行中", "info"],
    queued: ["排队中", "info"], planning: ["规划中", "info"], verifying: ["验证中", "info"],
    waiting_approval: ["等待审批", "warn"], waiting_review: ["等待复核", "warn"], created: ["已创建", "mute"],
  };
  const STAGE = { none: "无", planning: "规划", policy: "策略", execution: "执行", verification: "验证", cancelled: "取消", unknown: "未记录" };
  const OUTCOME = { allowed: ["允许", "ok"], approval_required: ["需审批", "warn"], denied: ["拒绝", "bad"] };
  const state = { data: null, turns: [], view: "overview", status: "all", provider: "all", query: "", showDeleted: true, selected: null, loading: false, error: null, raw: false, traces: new Map(), review: null, reviewBusy: false, reviewError: null };

  const root = () => document.getElementById("audit-root");
  const pct = (value) => (value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`);
  const ms = (value) => {
    if (value === null || value === undefined) return "—";
    if (value < 1000) return `${value} ms`;
    const s = value / 1000;
    return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
  };
  const usd = (value) => (value === undefined || value === null ? "—" : value === 0 ? "$0" : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);
  const num = (value) => (value ?? 0).toLocaleString("zh-CN");
  const stamp = (value) => (value ? new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
  const badge = (text, tone = "mute") => `<span class="au-badge au-${tone}">${esc(text)}</span>`;
  const statusBadge = (status) => { const [label, tone] = STATUS[status] ?? [status, "mute"]; return badge(label, tone); };

  async function load() {
    state.loading = true; state.error = null; render();
    try {
      state.data = await api("/api/audit");
      state.turns = (await api("/api/audit/turns?limit=100").catch(() => ({ turns: [] }))).turns ?? [];
      state.review = (await api("/api/audit/review").catch(() => ({ review: null }))).review ?? null;
      if (state.selected && !state.data.records.some((r) => r.runId === state.selected)) state.selected = null;
    } catch (error) { state.error = error.message; }
    state.loading = false; render();
  }

  const records = () => state.data?.records ?? [];
  const providersOf = (record) => [...new Set(record.executions.map((e) => e.providerId).filter(Boolean))];
  const costOf = (record) => record.executions.reduce((sum, e) => sum + (e.gatewayUsage?.costUsd ?? 0), 0);
  const filtered = () => records().filter((r) => {
    if (!state.showDeleted && r.deleted) return false;
    if (state.status === "failed" && r.status !== "failed") return false;
    if (state.status === "completed" && r.status !== "completed") return false;
    if (state.status === "active" && ["completed", "failed", "cancelled"].includes(r.status)) return false;
    if (state.status === "review" && r.status !== "waiting_review") return false;
    if (state.provider !== "all" && !providersOf(r).includes(state.provider)) return false;
    const q = state.query.trim().toLowerCase();
    if (q && !`${r.runId} ${r.taskTitle ?? ""} ${r.objective ?? ""} ${r.outcome.reason ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });

  /* ---------- charts (plain SVG/CSS; no dependency) ---------- */
  function dayChart(days) {
    const max = Math.max(1, ...days.map((d) => d.completed + d.failed + d.other));
    const w = 28, gap = 8, h = 120;
    const bars = days.map((d, i) => {
      const x = i * (w + gap);
      const seg = (value, offset, cls) => (value ? `<rect class="${cls}" x="${x}" y="${h - offset - (value / max) * h}" width="${w}" height="${(value / max) * h}" rx="3"/>` : "");
      const total = d.completed + d.failed + d.other;
      return `<g><title>${esc(d.day)}：完成 ${d.completed} · 失败 ${d.failed} · 其他 ${d.other}</title>`
        + seg(d.completed, 0, "au-seg-ok") + seg(d.failed, (d.completed / max) * h, "au-seg-bad") + seg(d.other, ((d.completed + d.failed) / max) * h, "au-seg-mute")
        + `<text x="${x + w / 2}" y="${h + 14}" text-anchor="middle">${esc(d.day.slice(5))}</text>`
        + (total ? `<text x="${x + w / 2}" y="${h - (total / max) * h - 4}" text-anchor="middle" class="au-count">${total}</text>` : "") + `</g>`;
    }).join("");
    const width = days.length * (w + gap) - gap;
    return `<svg class="au-daychart" viewBox="0 -14 ${width} ${h + 32}" role="img" aria-label="最近 14 天运行数量">${bars}</svg>`
      + `<div class="au-legend"><i class="au-dot au-seg-ok"></i>完成 <i class="au-dot au-seg-bad"></i>失败 <i class="au-dot au-seg-mute"></i>其他</div>`;
  }

  function hbars(map, labels = {}, tone = "bad") {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return `<p class="au-empty">暂无数据</p>`;
    const max = entries[0][1];
    return `<div class="au-hbars">${entries.map(([key, value]) => `<div class="au-hbar"><span class="au-hbar-label">${esc(labels[key] ?? key)}</span><span class="au-hbar-track"><i class="au-fill-${tone}" style="width:${(value / max) * 100}%"></i></span><b>${value}</b></div>`).join("")}</div>`;
  }

  function stat(label, value, detail = "", tone = "") {
    return `<div class="au-stat ${tone ? `au-stat-${tone}` : ""}"><span>${esc(label)}</span><strong>${esc(value)}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</div>`;
  }

  /* ---------- views ---------- */
  function overview() {
    const s = state.data.summary;
    const failed = s.byStatus.failed ?? 0;
    const providerRows = Object.entries(s.byProvider).map(([id, p]) => {
      const done = p.completed + p.failed;
      const rate = done ? p.completed / done : null;
      return `<tr><td><b>${esc(id)}</b></td><td>${p.runs}</td><td><span class="au-ratebar"><i style="width:${(rate ?? 0) * 100}%"></i></span> ${pct(rate)}</td><td>${p.failed}</td><td>${ms(p.medianDurationMs)}</td><td>${usd(p.costUsd)}</td><td>${p.gatewayErrors ? badge(`${p.gatewayErrors} 个网关错误`, "bad") : "—"}</td></tr>`;
    }).join("");
    return `
      <div class="au-stats">
        ${stat("运行总数", s.runs)}
        ${stat("通过率", pct(s.passRate), "完成 ÷ （完成 + 失败）", s.passRate !== null && s.passRate < 0.5 ? "bad" : "")}
        ${stat("待你复核", s.byStatus.waiting_review ?? 0, "验证器无法自动判断，等你确认", (s.byStatus.waiting_review ?? 0) ? "warn" : "")}
        ${stat("失败", failed, "点击「运行记录」查看原因", failed ? "bad" : "")}
        ${stat("平均耗时", ms(s.averageDurationMs))}
        ${stat("网关费用", usd(s.totals.costUsd), `${num(s.totals.inputTokens)} 入 / ${num(s.totals.outputTokens)} 出 tokens`)}
        ${stat("网关错误", s.totals.gatewayErrors, "模型请求返回 4xx/5xx 的次数", s.totals.gatewayErrors ? "warn" : "")}
      </div>
      <div class="au-grid">
        <section class="au-card"><h4>最近 14 天</h4>${dayChart(s.byDay)}</section>
        <section class="au-card"><h4>失败发生在哪一步</h4>${hbars(s.byFailureStage, STAGE)}<p class="au-note">规划→策略→执行→验证。「未记录」表示 Journal 里没有留下原因。</p></section>
        <section class="au-card"><h4>失败类别</h4>${hbars(s.byFailureCategory)}</section>
        <section class="au-card au-wide"><h4>各 Agent 工具对比</h4>${providerRows ? `<table class="au-table"><thead><tr><th>工具</th><th>运行</th><th>成功率</th><th>失败</th><th>中位耗时</th><th>费用</th><th>网关</th></tr></thead><tbody>${providerRows}</tbody></table>` : `<p class="au-empty">还没有执行记录。</p>`}<p class="au-note">费用与网关错误来自 Magpie，按时间窗口关联到执行，是推断而非精确归因。</p></section>
      </div>`;
  }

  function runRow(r) {
    const why = r.outcome.reason && r.status !== "completed" ? `<small class="au-why">${esc(STAGE[r.outcome.failureStage] ?? r.outcome.failureStage)}${r.outcome.failureCategory ? ` · ${esc(r.outcome.failureCategory)}` : ""}：${esc(r.outcome.reason.slice(0, 140))}</small>` : "";
    const label = r.label ? badge(r.label.verdict === "pass" ? "人工：合格" : "人工：不合格", r.label.verdict === "pass" ? "ok" : "bad") : "";
    return `<button type="button" class="au-row${r.runId === state.selected ? " is-selected" : ""}${r.deleted ? " is-deleted" : ""}" data-au-run="${esc(r.runId)}">
      <span class="au-row-main"><b>${esc(r.taskTitle || r.objective || r.runId.slice(0, 8))}</b>${why}</span>
      <span class="au-row-meta">${statusBadge(r.status)}${r.deleted ? badge("已删除", "mute") : ""}${label}<small>${esc(providersOf(r).join(", ") || "—")} · ${ms(r.durationMs)} · ${usd(costOf(r))} · ${stamp(r.createdAt)}</small></span></button>`;
  }

  function runs() {
    const list = filtered();
    const providers = [...new Set(records().flatMap(providersOf))];
    const chips = [["all", "全部"], ["failed", "失败"], ["completed", "完成"], ["review", "待复核"], ["active", "进行中"]]
      .map(([v, l]) => `<button type="button" class="au-chip${state.status === v ? " is-on" : ""}" data-au-status="${v}">${l}</button>`).join("");
    const selected = records().find((r) => r.runId === state.selected);
    return `<div class="au-toolbar">${chips}
        <select data-au-provider aria-label="按工具筛选"><option value="all">所有工具</option>${providers.map((p) => `<option value="${esc(p)}"${state.provider === p ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        <input type="search" data-au-query placeholder="搜索任务、原因、Run ID" value="${esc(state.query)}" />
        <label class="au-check"><input type="checkbox" data-au-deleted ${state.showDeleted ? "checked" : ""}/> 含已删除</label></div>
      <div class="au-split"><div class="au-list" role="list">${list.length ? list.map(runRow).join("") : `<p class="au-empty">没有符合条件的运行记录。</p>`}</div>
      <aside class="au-detail">${selected ? detail(selected) : `<p class="au-empty">选择左侧一条记录，查看它的完整轨迹：计划、策略判定、执行时间线、网关用量、证据与验证。</p>`}</aside></div>`;
  }

  function stages(r) {
    const failedAt = r.outcome.failureStage;
    const done = r.status === "completed";
    const nodes = [
      ["规划", r.plan.length ? "ok" : (failedAt === "planning" ? "bad" : "mute")],
      ["策略", r.policy.some((p) => p.outcome === "denied") ? "bad" : r.policy.length ? (r.policy.some((p) => p.outcome === "approval_required") ? "warn" : "ok") : "mute"],
      ["执行", r.executions.length ? (r.executions.some((e) => e.outcome === "failed") ? "bad" : done || r.executions.every((e) => e.outcome === "completed") ? "ok" : "info") : "mute"],
      ["验证", r.verification ? (r.verification.passed ? "ok" : r.verification.needsReview ? "warn" : "bad") : "mute"],
    ];
    return `<ol class="au-stages">${nodes.map(([l, t], i) => `<li class="au-stage au-${t}${STAGE[failedAt] === l ? " is-fail" : ""}"><i>${i + 1}</i>${l}</li>`).join("")}</ol>`;
  }

  function timeline(r) {
    if (!r.executions.length) return `<p class="au-empty">没有执行记录${r.outcome.failureStage === "policy" ? "：在策略阶段就被拒绝了" : ""}。</p>`;
    const total = Math.max(1, ...r.executions.map((e) => e.durationMs ?? 0));
    return r.executions.map((e) => {
      const u = e.gatewayUsage;
      const tone = e.outcome === "failed" ? "bad" : e.outcome === "completed" ? "ok" : "info";
      return `<div class="au-exec"><div class="au-exec-head"><b>${esc(e.providerId ?? "?")}</b><span>${esc(e.agentId ?? "")}${e.workOrderId ? ` · ${esc(e.workOrderId)}` : ""} · 步骤 ${esc(e.stepId)}</span>${badge(e.outcome === "failed" ? "失败" : e.outcome === "completed" ? "完成" : "未结束", tone)}<em>${ms(e.durationMs)}</em></div>
        <div class="au-bar"><i class="au-fill-${tone}" style="width:${Math.max(3, ((e.durationMs ?? 0) / total) * 100)}%"></i></div>
        <div class="au-chips"><span>${e.progressEvents} 条进度</span>${u ? `<span>${u.calls} 次模型调用</span><span>${num(u.inputTokens)}↑ ${num(u.outputTokens)}↓ tokens</span><span>${usd(u.costUsd)}</span><span>${esc(u.models.join(", "))}</span><span title="网关无法确认请求属于哪个 Run">按时间窗口推断</span>` : `<span>无网关数据</span>`}</div>
        ${e.failure ? `<div class="au-callout au-callout-bad"><b>${esc(e.failure.category ?? "失败")}</b>${e.failure.exitCode != null ? ` · 退出码 ${esc(e.failure.exitCode)}` : ""}<pre>${esc(e.failure.message)}</pre></div>` : ""}
        ${u?.errorSamples?.length ? `<div class="au-callout au-callout-warn"><b>网关返回的错误（${u.errors}）</b>${u.errorSamples.map((x) => `<pre>${esc(x.status)} ${esc(x.model ?? "")}\n${esc(x.message)}</pre>`).join("")}</div>` : ""}</div>`;
    }).join("");
  }

  /** The run's whole journal trace, loaded on demand. 该 Run 的完整 Journal 轨迹，按需加载。 */
  function traceBlock(r) {
    const trace = state.traces.get(r.runId);
    if (trace === undefined) return `<button type="button" class="au-btn" data-au-trace="${esc(r.runId)}">加载完整轨迹</button>`;
    if (trace === null) return `<p class="au-empty">正在读取轨迹…</p>`;
    if (trace.length === 0) return `<p class="au-empty">这条记录没有可显示的轨迹事件。</p>`;
    return `<ol class="au-trace">${trace.map((item) => `<li class="au-trace-item">
      <time>${stamp(item.at)}</time>
      <div><b>${esc(item.label)}</b><span>${esc(item.detail)}</span></div>
      <details class="au-trace-raw"><summary>原始数据</summary><pre>${esc(item.payload)}</pre></details>
    </li>`).join("")}</ol>`;
  }

  function policyBlock(r) {
    if (!r.policy.length) return `<p class="au-empty">没有策略判定记录。</p>`;
    return r.policy.map((p) => {
      const [label, tone] = OUTCOME[p.outcome] ?? [p.outcome, "mute"];
      const verdicts = (p.scopeVerdicts ?? []).map((v) => `<li>${badge((OUTCOME[v.outcome] ?? [v.outcome])[0], (OUTCOME[v.outcome] ?? [0, "mute"])[1])} <code>${esc(v.scope.domain)}:${esc(v.scope.access)}:${esc(v.scope.resource)}</code> ${esc(v.reason)}</li>`).join("");
      return `<div class="au-policy"><div>${badge(label, tone)} 步骤 <code>${esc(p.stepId)}</code> — ${esc(p.reason)}${p.policyIds?.length ? ` <small>策略 ${p.policyIds.map((x) => esc(x.slice(0, 8))).join(", ")}</small>` : ""}</div>${verdicts ? `<ul>${verdicts}</ul>` : ""}</div>`;
    }).join("");
  }

  function labelBlock(r) {
    const finished = ["completed", "failed", "cancelled", "waiting_review"].includes(r.status);
    if (!finished) return `<p class="au-empty">运行结束后才能做人工判定。</p>`;
    const systemPass = r.status === "completed";
    let agree = "";
    if (r.label && r.status === "waiting_review") {
      agree = badge("系统在等你判定，这就是最终结论", "info");
    } else if (r.label) {
      const same = (r.label.verdict === "pass") === systemPass;
      agree = same ? badge("与系统判定一致", "ok") : badge(systemPass ? "误判通过：系统说完成，你判不合格" : "误判失败：系统说失败，你判合格", "bad");
    }
    return `<div class="au-label"><div>系统判定：${statusBadge(r.status)} ${r.label ? `· 你的判定：${badge(r.label.verdict === "pass" ? "合格" : "不合格", r.label.verdict === "pass" ? "ok" : "bad")} ${agree}` : "· 你还没有判定"}</div>
      <textarea data-au-note rows="2" placeholder="备注（可选）：结果哪里对、哪里不对">${esc(r.label?.note ?? "")}</textarea>
      <div class="au-actions"><button type="button" class="au-btn au-btn-ok" data-au-label="pass" data-au-run="${esc(r.runId)}">结果合格</button><button type="button" class="au-btn au-btn-bad" data-au-label="fail" data-au-run="${esc(r.runId)}">结果不合格</button></div></div>`;
  }

  function detail(r) {
    const reason = r.status !== "completed" && r.outcome.reason
      ? `<div class="au-callout au-callout-bad"><b>为什么没成功</b> · 阶段：${esc(STAGE[r.outcome.failureStage] ?? r.outcome.failureStage)}${r.outcome.failureCategory ? ` · 类别：${esc(r.outcome.failureCategory)}` : ""}<pre>${esc(r.outcome.reason)}</pre></div>` : "";
    const evidence = r.evidence.length ? r.evidence.map((e) => `<li>${badge(e.kind, "info")} ${esc(e.locator ?? "")} <small>${esc((e.summary ?? "").slice(0, 160))}</small></li>`).join("") : `<li class="au-empty">没有证据。</li>`;
    const plan = r.plan.map((p) => `<li><code>${esc(p.id)}</code> ${esc(p.title)} ${badge(p.risk, p.risk === "read_only" ? "ok" : p.risk === "reversible_write" ? "info" : "warn")}${p.agentId ? ` <small>${esc(p.agentId)}</small>` : ""}${p.scopes ? ` <small>${p.scopes.length} 个 scope</small>` : ""}</li>`).join("");
    return `<header class="au-detail-head"><div><h4>${esc(r.taskTitle || r.runId.slice(0, 8))}</h4><small>${esc(r.runId)}</small></div>${statusBadge(r.status)}${r.deleted ? badge("已删除", "mute") : ""}</header>
      <div class="au-facts"><span>创建 ${stamp(r.createdAt)}</span><span>耗时 ${ms(r.durationMs)}</span><span>触发 ${esc(r.triggerKind ?? "—")}</span><span>${r.basis.events} 条事件</span></div>
      ${stages(r)}${reason}
      <h5>执行时间线</h5>${timeline(r)}
      <h5>完整轨迹 <small class="au-hint">按发生顺序，每条都可展开原始数据</small></h5>${traceBlock(r)}
      <h5>策略判定</h5>${policyBlock(r)}
      <h5>计划</h5><ul class="au-plain">${plan || `<li class="au-empty">无计划。</li>`}</ul>
      <h5>证据</h5><ul class="au-plain">${evidence}</ul>
      <h5>验证</h5>${r.verification ? `<p>${badge(r.verification.passed ? "通过" : r.verification.needsReview ? "需人工复核" : "未通过", r.verification.passed ? "ok" : r.verification.needsReview ? "warn" : "bad")} ${esc(r.verification.summary)}${r.verification.unverifiedCriteria.length ? `<br><small>未能自动验证：${esc(r.verification.unverifiedCriteria.join("；"))}</small>` : ""}</p>` : `<p class="au-empty">未进入验证。</p>`}
      <h5>人工判定（评估真值）</h5>${labelBlock(r)}
      <h5>完整性</h5><p class="au-digest"><code title="对该 Run 全部事件的 sha256，可与 Journal 对账">${esc(r.digest)}</code> <button type="button" class="au-link" data-au-copy="${esc(r.digest)}">复制</button></p>
      <div class="au-actions"><button type="button" class="au-btn" data-au-open="${esc(r.runId)}"${r.deleted ? " disabled" : ""}>打开对话</button>
        ${r.deleted ? `<button type="button" class="au-btn" data-au-restore="${esc(r.runId)}">恢复会话</button>` : `<button type="button" class="au-btn au-btn-bad" data-au-delete="${esc(r.runId)}">删除会话</button>`}
        <button type="button" class="au-btn" data-au-raw>${state.raw ? "收起" : "查看"}原始记录</button></div>
      ${state.raw ? `<pre class="au-raw">${esc(JSON.stringify(r, null, 2))}</pre>` : ""}`;
  }

  function reviewBlock() {
    const busy = state.reviewBusy ? "生成中…（读取最近运行，可能需要十几秒）" : "生成评审";
    const review = state.review;
    const error = state.reviewError ? `<div class="au-callout au-callout-bad"><b>评审失败</b><pre>${esc(state.reviewError)}</pre></div>` : "";
    if (!review) {
      return `<section class="au-card au-review"><div class="au-review-head"><div><h4>AI 自我评审</h4><p class="au-note">读取最近运行、失败原因、网关错误和你的判定，给出发现项与可一键应用的配置改动。只碰模型与推理强度，全部可撤销。</p></div><button type="button" class="au-btn au-btn-primary" data-au-review-run ${state.reviewBusy ? "disabled" : ""}>${busy}</button></div>${error}</section>`;
    }
    const findings = review.findings.length
      ? `<ul class="au-findings">${review.findings.map((finding) => `<li>${badge({ high: "高", medium: "中", low: "低" }[finding.severity] ?? finding.severity, finding.severity === "high" ? "bad" : finding.severity === "medium" ? "warn" : "mute")}<div><b>${esc(finding.area || "发现")}</b><span>${esc(finding.recommendation)}</span>${finding.evidence ? `<small>依据：${esc(finding.evidence)}</small>` : ""}</div></li>`).join("")}</ul>`
      : `<p class="au-empty">没有发现需要改动的地方。</p>`;
    const actions = review.actions.length
      ? `<div class="au-actions-list">${review.actions.map((action) => `<div class="au-action${action.appliedAt ? " is-applied" : ""}">
          <div><b>${esc(action.title)}</b>${action.reason ? `<span>${esc(action.reason)}</span>` : ""}<small>${esc(action.kind)}${action.providerId ? ` · ${esc(action.providerId)}` : ""} · ${action.from === undefined ? "默认" : esc(action.from)} → <code>${esc(action.value)}</code></small></div>
          <div class="au-actions">${action.appliedAt
            ? `<span class="au-applied-mark">已应用</span><button type="button" class="au-btn" data-au-revert="${esc(action.id)}">撤销</button>`
            : `<button type="button" class="au-btn au-btn-primary" data-au-apply="${esc(action.id)}">应用</button>`}</div>
        </div>`).join("")}</div>`
      : `<p class="au-empty">这次评审没有提出可以一键应用的配置改动。</p>`;
    return `<section class="au-card au-review">
      <div class="au-review-head"><div><h4>AI 自我评审</h4><p class="au-note">生成于 ${stamp(review.generatedAt)}${review.model ? ` · 评审模型 ${esc(review.model)}` : ""} · ${review.ai ? "模型参与生成" : "只有实测数据（模型未参与）"}</p></div><button type="button" class="au-btn" data-au-review-run ${state.reviewBusy ? "disabled" : ""}>${busy}</button></div>
      ${error}
      <p class="au-review-summary">${esc(review.summary)}</p>
      <h5>发现</h5>${findings}
      <h5>可一键应用的改动 <small class="au-hint">只改配置，写入前后值，可撤销</small></h5>${actions}
    </section>`;
  }

  function evaluation() {
    const e = state.data.summary.evaluation;
    const queue = records().filter((r) => !r.label && ["completed", "failed", "waiting_review"].includes(r.status)).slice(0, 12);
    const dis = records().filter((r) => r.label && ["completed", "failed"].includes(r.status) && (r.label.verdict === "pass") !== (r.status === "completed"));
    return `${reviewBlock()}<div class="au-stats">
        ${stat("已人工判定", e.labeled, "评估的真值样本")}
        ${stat("与系统一致率", pct(e.agreement), "系统判定 vs 你的判定", e.agreement !== null && e.agreement < 0.8 ? "warn" : "")}
        ${stat("误判通过", e.falsePass, "系统说完成，你判不合格——最危险", e.falsePass ? "bad" : "")}
        ${stat("误判失败", e.falseFail, "系统说失败，你判合格")}
        ${stat("待判定", e.unlabeledFinished, "已结束但还没有你的判定")}
      </div>
      <p class="au-note">这里的评估不依赖模型打分：你对结果做「合格 / 不合格」的判定，系统把它和自己的验证结论对照。误判通过说明验证器放过了不该放过的结果，应当收紧验证标准。样本越多越可信。</p>
      <div class="au-grid">
        <section class="au-card au-wide"><h4>待判定队列</h4>${queue.length ? queue.map((r) => `<div class="au-queue"><div><b>${esc(r.taskTitle || r.runId.slice(0, 8))}</b> ${statusBadge(r.status)}<small>${esc(providersOf(r).join(", "))} · ${ms(r.durationMs)}</small></div><div class="au-actions"><button type="button" class="au-btn au-btn-ok" data-au-quick="pass" data-au-run="${esc(r.runId)}">合格</button><button type="button" class="au-btn au-btn-bad" data-au-quick="fail" data-au-run="${esc(r.runId)}">不合格</button><button type="button" class="au-btn" data-au-jump="${esc(r.runId)}">查看</button></div></div>`).join("") : `<p class="au-empty">没有待判定的运行。</p>`}</section>
        <section class="au-card au-wide"><h4>系统与你不一致的记录</h4>${dis.length ? dis.map((r) => `<div class="au-queue"><div><b>${esc(r.taskTitle || r.runId.slice(0, 8))}</b> ${statusBadge(r.status)} ${badge(r.label.verdict === "pass" ? "你：合格" : "你：不合格", r.label.verdict === "pass" ? "ok" : "bad")}<small>${esc(r.label.note ?? "")}</small></div><button type="button" class="au-btn" data-au-jump="${esc(r.runId)}">查看</button></div>`).join("") : `<p class="au-empty">暂无不一致。</p>`}</section>
      </div>`;
  }

  /** Main Agent turns: input, reply, tools, model usage. 主 Agent 回合：输入、回复、工具、模型用量。 */
  function turnsView() {
    const turns = state.turns ?? [];
    if (!turns.length) return `<p class="au-empty">还没有主 Agent 回合记录。CLI、桌面或 WhatsApp 的每一次对话都会出现在这里。</p>`;
    return `<div class="au-turns">${turns.map((turn) => {
      const tone = turn.status === "completed" ? "ok" : turn.status === "failed" ? "bad" : turn.status === "interrupted" ? "warn" : "info";
      const label = turn.status === "completed" ? "完成" : turn.status === "failed" ? "失败" : turn.status === "interrupted" ? "中断" : "进行中";
      const usage = turn.usage ? `<span>${num(turn.usage.totalTokens ?? 0)} tokens</span>${turn.usage.costUsd !== undefined ? `<span>${usd(turn.usage.costUsd)}</span>` : ""}` : "";
      const tools = turn.toolCalls.length
        ? `<ul class="au-turn-tools">${turn.toolCalls.map((call) => `<li><code>${esc(call.name)}</code>${call.isError ? badge("错误", "bad") : ""}${call.durationMs !== undefined ? `<em>${ms(call.durationMs)}</em>` : ""}${call.inputSummary ? `<span>${esc(call.inputSummary.slice(0, 240))}</span>` : ""}</li>`).join("")}</ul>`
        : `<p class="au-empty">本轮没有调用工具。</p>`;
      return `<section class="au-card au-turn">
        <div class="au-turn-head"><b>${esc(turn.input.replace(/\s+/g, " ").slice(0, 140) || "（无输入）")}</b>${badge(label, tone)}
          <small>${esc(turn.source)} · ${esc(turn.modelId ?? "默认模型")}${turn.effort ? ` · ${esc(turn.effort)}` : ""} · ${stamp(turn.startedAt)}${turn.durationMs !== undefined ? ` · ${ms(turn.durationMs)}` : ""}</small></div>
        <div class="au-turn-body"><p class="au-note">输入</p><pre>${esc(turn.input)}</pre>
          ${turn.reply ? `<p class="au-note">回复</p><pre>${esc(turn.reply)}</pre>` : ""}
          ${turn.error ? `<div class="au-callout au-callout-bad"><b>错误</b><pre>${esc(turn.error)}</pre></div>` : ""}</div>
        ${tools}
        <div class="au-chips">${usage}${turn.promptMaterialHash ? `<span>prompt ${esc(turn.promptMaterialHash.slice(0, 8))}</span>` : ""}${turn.spawnedRunIds?.length ? `<span>${turn.spawnedRunIds.length} 个 Run</span>` : ""}</div>
      </section>`;
    }).join("")}</div>`;
  }

  function render() {
    const host = root();
    if (!host) return;
    const keep = host.querySelector(".au-list")?.scrollTop ?? 0;
    const keepDetail = host.querySelector(".au-detail")?.scrollTop ?? 0;
    const tabs = [["overview", "总览"], ["turns", "主 Agent 回合"], ["runs", "运行记录"], ["eval", "评估"]]
      .map(([v, l]) => `<button type="button" class="au-tab${state.view === v ? " is-on" : ""}" data-au-view="${v}">${l}</button>`).join("");
    let body = "";
    if (state.error) body = `<div class="au-callout au-callout-bad"><b>读取审计失败</b><pre>${esc(state.error)}</pre></div>`;
    else if (!state.data) body = `<p class="au-empty">${state.loading ? "正在读取…" : "尚未加载。"}</p>`;
    else if (!state.data.records.length && !(state.turns ?? []).length) body = `<p class="au-empty">还没有任何记录。发起一个任务或对话后，这里会出现它的完整轨迹。</p>`;
    else body = state.view === "overview" ? overview() : state.view === "turns" ? turnsView() : state.view === "runs" ? runs() : evaluation();
    host.innerHTML = `<div class="au-head"><div><h3>审计与评估</h3><p>每个 Run 的轨迹都从 Journal 投影而来：为什么成功或失败、哪个工具、花了多久和多少钱，一目了然。</p></div>
        <div class="au-actions"><button type="button" class="au-btn" data-au-refresh>${state.loading ? "刷新中…" : "刷新"}</button><button type="button" class="au-btn" data-au-export>导出 JSONL</button></div></div>
      <div class="au-tabs" role="tablist">${tabs}</div>${body}`;
    const list = host.querySelector(".au-list"); if (list) list.scrollTop = keep;
    const side = host.querySelector(".au-detail"); if (side) side.scrollTop = keepDetail;
  }

  async function exportJsonl() {
    try {
      const response = await fetch("/api/audit/export", { headers: authHeaders() });
      if (!response.ok) throw new Error(`导出失败（${response.status}）`);
      const url = URL.createObjectURL(await response.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: `clone-ai-audit-${new Date().toISOString().slice(0, 10)}.jsonl` });
      document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (error) { announce(error.message, true); }
  }
  // Reuse whatever auth the main client attaches by asking it for a throwaway request's headers.
  // 复用主客户端附带的认证：不重新实现 token 逻辑。
  function authHeaders() { return typeof apiHeaders === "function" ? apiHeaders() : (window.CLONE_AI_TOKEN ? { authorization: `Bearer ${window.CLONE_AI_TOKEN}` } : {}); }

  async function label(runId, verdict, note) {
    try {
      await api(`/api/audit/${encodeURIComponent(runId)}/label`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verdict, note }) });
      announce(verdict === "pass" ? "已记为合格。" : "已记为不合格。");
      await load();
    } catch (error) { announce(error.message, true); }
  }

  document.addEventListener("click", async (event) => {
    const t = event.target;
    if (!(t instanceof Element) || !root()?.contains(t)) return;
    const pick = (selector) => t.closest(selector);
    let el;
    if ((el = pick("[data-au-view]"))) { state.view = el.dataset.auView; render(); return; }
    if ((el = pick("[data-au-status]"))) { state.status = el.dataset.auStatus; render(); return; }
    if (pick("[data-au-refresh]")) { await load(); return; }
    if (pick("[data-au-export]")) { await exportJsonl(); return; }
    if ((el = pick("[data-au-copy]"))) { try { await navigator.clipboard.writeText(el.dataset.auCopy); announce("摘要已复制。"); } catch { announce("无法访问剪贴板。", true); } return; }
    if (pick("[data-au-raw]")) { state.raw = !state.raw; render(); return; }
    if ((el = pick("[data-au-quick]"))) { await label(el.dataset.auRun, el.dataset.auQuick, ""); return; }
    if ((el = pick("[data-au-label]"))) { await label(el.dataset.auRun, el.dataset.auLabel, root().querySelector("[data-au-note]")?.value ?? ""); return; }
    if ((el = pick("[data-au-jump]"))) { state.view = "runs"; state.status = "all"; state.selected = el.dataset.auJump; render(); return; }
    if (pick("[data-au-review-run]")) {
      state.reviewBusy = true; state.reviewError = null; render();
      try {
        state.review = (await api("/api/audit/review", { method: "POST" })).review;
      } catch (error) {
        state.reviewError = error.message;
      }
      state.reviewBusy = false; render();
      return;
    }
    if ((el = pick("[data-au-apply]")) || (el = pick("[data-au-revert]"))) {
      const actionId = el.dataset.auApply ?? el.dataset.auRevert;
      const path = el.dataset.auApply ? "/api/audit/apply" : "/api/audit/revert";
      try {
        const result = await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId }) });
        state.review = result.review ?? state.review;
        announce(el.dataset.auApply ? "改动已应用，可在同一行撤销。" : "改动已撤销。");
      } catch (error) { announce(error.message, true); }
      render();
      return;
    }
    if ((el = pick("[data-au-trace]"))) {
      const runId = el.dataset.auTrace;
      state.traces.set(runId, null);
      render();
      try {
        const result = await api(`/api/runs/${encodeURIComponent(runId)}/trace`);
        state.traces.set(runId, result.items ?? []);
      } catch (error) {
        state.traces.set(runId, []);
        announce(`读取轨迹失败：${error.message}`, true);
      }
      render();
      return;
    }
    if ((el = pick("[data-au-open]"))) { closeSettings(); void selectSession(el.dataset.auOpen); return; }
    if ((el = pick("[data-au-delete]"))) {
      if (!(await confirmDialog("删除这个会话？它会从对话列表消失，但审计记录会保留并标为「已删除」，评估数据不会丢。之后可在这里恢复。", "删除"))) return;
      try { await api(`/api/sessions/${encodeURIComponent(el.dataset.auDelete)}`, { method: "DELETE" }); announce("会话已删除，审计记录保留。"); await load(); void refresh({ preserveScroll: false }); } catch (error) { announce(error.message, true); }
      return;
    }
    if ((el = pick("[data-au-restore]"))) {
      try { await api(`/api/sessions/${encodeURIComponent(el.dataset.auRestore)}/restore`, { method: "POST" }); announce("会话已恢复。"); await load(); void refresh({ preserveScroll: false }); } catch (error) { announce(error.message, true); }
      return;
    }
    if ((el = pick("[data-au-run]"))) { state.selected = el.dataset.auRun; state.raw = false; render(); }
  });
  document.addEventListener("input", (event) => {
    const t = event.target;
    if (t instanceof HTMLInputElement && t.matches("[data-au-query]")) { state.query = t.value; const pos = t.selectionStart; render(); const next = root().querySelector("[data-au-query]"); next?.focus(); next?.setSelectionRange(pos, pos); }
  });
  document.addEventListener("change", (event) => {
    const t = event.target;
    if (t instanceof HTMLSelectElement && t.matches("[data-au-provider]")) { state.provider = t.value; render(); }
    if (t instanceof HTMLInputElement && t.matches("[data-au-deleted]")) { state.showDeleted = t.checked; render(); }
  });

  // Load whenever the audit section opens. 每次打开审计分区时加载。
  const original = typeof selectSettingsSection === "function" ? selectSettingsSection : undefined;
  if (original) {
    selectSettingsSection = (section) => { original(section); if (section === "audit") void load(); };
  }
  window.CloneAudit = Object.freeze({ load });
})();
