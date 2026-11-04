const MAIN_CONVERSATION_ID = "main-agent-conversation";
const $ = (id) => document.getElementById(id);
const ui = window.CloneUI;
const state = {
  signatures: {},
  drafts: new Map(),
  dashboard: null,
  selectedId: localStorage.getItem("clone-ai:selected-session"),
  composingNew: false,
  streaming: false,
  sessionEpoch: 0,
  refreshTimer: null,
  scrollPositions: new Map(),
  openDisclosures: new Map(),
  disclosureScrollPositions: new Map(),
  schedules: [],
  settings: null,
  providers: [],
  gateways: [],
  gatewayLoading: false,
  situation: null,
  config: null,
  connectors: [],
  whatsapp: null,
  whatsappLoading: false,
  whatsappDirty: false,
  modelOptions: [],
  modelOptionsLoaded: false,
  modelOptionsLoading: false,
  memories: [],
  settingsSection: "agents",
  locale: "zh-CN",
  strings: {},
};
const icon = (name) => name === "spark"
  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2Z"/></svg>`
  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>`;
const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
function plainPreview(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)([^*_\n]+)\1/g, "$2")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const t = (key) => (state.strings && state.strings[key]) || key;
function notifyDesktopNavigation(section) {
  try {
    window.webkit?.messageHandlers?.cloneNavigation?.postMessage(section);
  } catch {
    // Browser previews do not have the native navigation bridge.
    // 浏览器预览没有原生导航桥接。
  }
}
const time = (value) => new Intl.DateTimeFormat(state.locale || "zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const day = (value) => new Intl.DateTimeFormat(state.locale || "zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(value));
function applyChrome(locale, strings) {
  const next = strings || {};
  const changed = state.locale !== locale || JSON.stringify(state.strings) !== JSON.stringify(next);
  state.locale = locale || "zh-CN";
  state.strings = next;
  document.documentElement.lang = state.locale;
  document.title = t("title");
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (!key) return;
    const attr = node.getAttribute("data-i18n-attr");
    const value = t(key);
    if (attr) node.setAttribute(attr, value);
    else node.textContent = value;
  });
  const query = $("query");
  if (query) query.setAttribute("aria-label", t("query-label"));
  const localeSelect = $("config-locale");
  if (localeSelect && document.activeElement !== localeSelect) localeSelect.value = state.locale;
  if (changed) state.signatures = {};
}
const api = async (path, options = {}) => {
  const headers = new Headers(options.headers);
  if (window.CLONE_AI_TOKEN) headers.set("Authorization", `Bearer ${window.CLONE_AI_TOKEN}`);
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(body.error || t("local-request-failed"));
  return body;
};
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;
let sidebarResizeActive = false;
function applySidebarWidth(value, persist = true) { const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 400)); const width = Math.round(Math.max(SIDEBAR_MIN, Math.min(max, value))); document.documentElement.style.setProperty("--sidebar-width", `${width}px`); document.querySelector(".app-shell").style.setProperty("--sidebar-width", `${width}px`); const handle = $("sidebar-resizer"); handle.setAttribute("aria-valuenow", String(width)); if (persist) localStorage.setItem("clone-ai:sidebar-width", String(width)); }
function restoreSidebarWidth() { const saved = Number(localStorage.getItem("clone-ai:sidebar-width")); applySidebarWidth(Number.isFinite(saved) ? saved : 278, false); }
const statusMeta = (status) => {
  if (status === "waiting_approval") return { label: t("status-waiting"), className: "waiting", dot: "waiting" };
  if (status === "waiting_review") return { label: t("status-review"), className: "waiting", dot: "waiting" };
  if (status === "completed") return { label: t("status-completed"), className: "completed", dot: "completed" };
  if (status === "failed" || status === "cancelled") return { label: t("status-needs-attention"), className: "needs-attention", dot: "needs-attention" };
  return { label: t("status-running"), className: "running", dot: "running" };
};
function announce(message, error = false) { const node = $("notice"); node.textContent = message; node.className = `notice visible${error ? " error" : ""}`; clearTimeout(node.timer); node.timer = setTimeout(() => node.className = "notice", 3200); }
function sessionMarkup(session) {
  const status = statusMeta(session.status);
  const child = session.parentId !== undefined;
  const metaText = plainPreview(session.preview) || status.label;
  // The relation is shown, not implied: a task of the chat says so, and the chat
  // says how many tasks it owns. Deleting the chat takes them with it.
  // 关系要明示：属于对话的任务会标出来，对话则说明自己有几个任务。删除对话会一并带走它们。
  const relation = child ? "子任务 · " : session.childCount ? `${session.childCount} 个子任务 · ` : "";
  return `<div class="session-item${child ? " is-child" : ""}${session.kind === "conversation" ? " is-conversation" : ""}"><button class="session" type="button" data-session="${escape(session.id)}" aria-current="${String(session.id === state.selectedId)}"><span class="status-dot ${status.dot}"></span><span class="session-copy"><span class="session-title">${escape(plainPreview(session.title))}</span><span class="session-meta">${escape(relation + metaText)}</span></span></button><button class="session-delete" type="button" data-delete-session="${escape(session.id)}" aria-label="${child ? "隐藏这条子任务" : session.kind === "conversation" ? "隐藏对话及其子任务" : "隐藏会话"}">×</button></div>`;
}
function renderSessions(rawSessions) {
  // A derived task sits under the conversation that spawned it, so one request
  // never reads as two chats. 派生任务排在其所属对话之下，使一次请求不会读成两个对话。
  const ids = new Set(rawSessions.map((session) => session.id));
  const childrenOf = new Map();
  for (const session of rawSessions) {
    if (session.parentId === undefined || !ids.has(session.parentId)) continue;
    const list = childrenOf.get(session.parentId) || [];
    list.push(session);
    childrenOf.set(session.parentId, list);
  }
  const sessions = [];
  for (const session of rawSessions) {
    if (session.parentId !== undefined && ids.has(session.parentId)) continue;
    sessions.push(session);
    for (const child of childrenOf.get(session.id) || []) sessions.push(child);
  }
  const signature = JSON.stringify([state.selectedId, sessions.map((session) => [session.id, session.title, session.preview, session.status, session.updatedAt, session.parentId, session.childCount]), state.dashboard?.deletedConversations]);
  if (state.signatures.sessions === signature) return;
  state.signatures.sessions = signature;
  $("session-count").textContent = String(sessions.length);
  if (!sessions.length) { $("session-list").innerHTML = `<div class="empty-sessions">${t("empty-sessions").replace("\n", "<br/>")}</div>`; return; }
  const todayKey = new Date().toDateString();
  const today = sessions.filter((session) => new Date(session.updatedAt).toDateString() === todayKey);
  const earlier = sessions.filter((session) => new Date(session.updatedAt).toDateString() !== todayKey);
  const hidden = (state.dashboard?.deletedConversations || []).map((entry) => `<div class="session-item is-hidden-conversation"><span class="session-copy"><span class="session-title">${escape(entry.title)}${entry.childCount ? ` · ${entry.childCount} 个子任务` : ""}</span><span class="session-meta">已隐藏</span></span><button class="session-restore" type="button" data-restore-conversation="${escape(entry.id)}">恢复</button></div>`).join("");
  const hiddenBlock = hidden ? `<div class="session-group">已隐藏</div>${hidden}` : "";
  $("session-list").innerHTML = `${today.length ? `<div class="session-group">${t("today")}</div>${today.map(sessionMarkup).join("")}` : ""}${earlier.length ? `<div class="session-group">${t("earlier")}</div>${earlier.map(sessionMarkup).join("")}` : ""}${hiddenBlock}`;
}
function renderSchedules(schedules, occurrences = [], reportDeliveries = [], reportError = false) {
  state.schedules = schedules;
  const signature = JSON.stringify([schedules, occurrences, reportDeliveries, reportError]);
  if (state.signatures.schedules === signature) return;
  state.signatures.schedules = signature;
  $("schedule-count").textContent = String(schedules.filter((schedule) => schedule.enabled).length);
  const rows = schedules.length ? schedules.map((schedule) => `<div class="schedule-row"><div><b>${escape(schedule.query)}</b><span>${escape(schedule.description)} · ${schedule.enabled ? t("enabled") : t("paused")}</span></div><button class="schedule-toggle" type="button" data-schedule-toggle="${escape(schedule.id)}" data-schedule-enabled="${String(!schedule.enabled)}">${schedule.enabled ? t("pause") : t("enable")}</button></div>`).join("") : `<div class="schedule-empty">${t("empty-schedules").replace("\n", "<br/>")}</div>`;
  const warnings = occurrences.map((item) => `<div class="schedule-row"><div><b>${escape(item.schedule.query)}</b><span>${escape(t("schedule-unknown"))}</span></div><div><button class="schedule-toggle" type="button" data-schedule-occurrence="${escape(item.id)}" data-resolution="retry">${escape(t("schedule-retry"))}</button><button class="schedule-toggle" type="button" data-schedule-occurrence="${escape(item.id)}" data-resolution="dismiss">${escape(t("schedule-dismiss"))}</button></div></div>`).join("");
  const reportWarnings = reportDeliveries.map((item) => `<div class="schedule-row"><div><b>${escape(t("report-unknown-title"))}</b><span>${escape(item.day)} · ${escape(t("report-unknown"))}</span></div><div><button class="schedule-toggle" type="button" data-report-day="${escape(item.day)}" data-resolution="retry">${escape(t("schedule-retry"))}</button><button class="schedule-toggle" type="button" data-report-day="${escape(item.day)}" data-resolution="dismiss">${escape(t("schedule-dismiss"))}</button></div></div>`).join("");
  const reportFailure = reportError ? `<div class="schedule-row"><div><b>${escape(t("report-state-error-title"))}</b><span>${escape(t("report-state-error"))}</span></div></div>` : "";
  $("schedule-list").innerHTML = rows + warnings + reportWarnings + reportFailure;
}
function agentRoleLabel(role) { return ({ direct: t("role-direct"), research: t("role-research"), draft: t("role-draft"), review: t("role-review"), external: t("role-external") }[role] || role); }
function providerLabel(id) { return ({ "codex-cli": "Codex CLI", "claude-code": "Claude Code", pi: "Pi" }[id] || id); }
function renderSettings(settings, providers) {
  state.settings = settings; state.providers = providers;
  renderAgentPage();
}
function renderGateways(gateways) {
  state.gateways = gateways;
  renderAgentPage();
}
function renderAgentPage() {
  const host = $("agent-page");
  if (!host || !state.settings) return;
  const settings = state.settings;
  const providers = state.providers || [];
  const gateway = state.gateways.find((candidate) => candidate.id === "magpie");
  const mainAgentModel = state.config?.config?.mainAgentModel || "";
  const signature = JSON.stringify([settings, providers, gateway, mainAgentModel, state.gatewayLoading]);
  if (state.signatures.agentPage === signature) return;
  state.signatures.agentPage = signature;
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const missing = providers.filter((provider) => !provider.installed && provider.installable);
  const installed = providers.filter((provider) => provider.installed);
  const enabledRoles = settings.agents.filter((agent) => agent.enabled).length;
  const gatewayState = gateway?.running
    ? { label: t("gateway-running"), tone: "success" }
    : gateway?.installed
      ? { label: t("gateway-stopped"), tone: "warning" }
      : { label: t("gateway-not-found"), tone: "neutral" };
  const installButton = ui.button({
    label: missing.length ? `${t("install-missing")} (${missing.length})` : providers.some((provider) => !provider.installed) ? t("no-auto-install") : t("providers-ready"),
    iconName: missing.length ? "plus" : "check",
    variant: missing.length ? "primary" : "secondary",
    disabled: missing.length === 0,
    attributes: { "data-install-missing": "", id: "install-missing-providers" },
  });
  const gatewayBadge = ui.badge(
    state.gatewayLoading && gateway === undefined ? t("gateway-checking") : gatewayState.label,
    state.gatewayLoading && gateway === undefined ? "neutral" : gatewayState.tone,
    { dot: true },
  );
  const gatewayApis = (gateway?.apis || []).filter((api) => ["/v1/responses", "/v1/messages", "/v1/chat/completions"].includes(api)).slice(0, 3);
  const exposedModels = (gateway?.models || []).filter((model) => model.compatible !== false);
  const selectedModel = selectedGatewayModel(mainAgentModel, exposedModels);
  const modelSelect = exposedModels.length
    ? ui.select({
        value: selectedModel,
        attributes: { id: "gateway-model", "aria-label": t("gateway-model") },
        options: exposedModels.map((model) => ({
          value: model.id,
          label: `${model.name}${model.provider && model.provider !== "360" ? ` · ${model.provider}` : ""}`,
        })),
      })
    : "";
  const gatewayControls = gateway?.running && exposedModels.length
    ? `<div class="gateway-controls">
        <div class="gateway-controls__row">${modelSelect}${ui.button({ label: t("gateway-use"), iconName: "arrow", variant: "primary", disabled: !selectedModel, attributes: { "data-gateway-apply": "" } })}</div>
        <div class="c-cluster">${ui.button({ label: t("gateway-refresh"), iconName: "refresh", variant: "secondary", attributes: { "data-gateway-refresh": "" } })}${mainAgentModel.startsWith("magpie/") ? ui.button({ label: t("gateway-clear"), variant: "ghost", attributes: { "data-gateway-clear": "" } }) : ""}</div>
      </div>`
    : `<div class="gateway-controls"><div class="c-cluster">${ui.button({ label: t("gateway-refresh"), iconName: "refresh", variant: "secondary", attributes: { "data-gateway-refresh": "" } })}</div><span class="gateway-hint">${escape(gateway?.running && gateway.modelCount > 0 ? t("gateway-pi-hint") : gateway?.error || t("gateway-start-hint"))}</span></div>`;
  const gatewayCard = ui.card({
    title: "Magpie Gateway",
    subtitle: t("gateway-subtitle"),
    tone: gateway?.running ? "accent" : "warning",
    className: "agent-gateway",
    actions: gatewayBadge,
    body: `<div class="gateway-layout"><div class="gateway-summary">${ui.providerMark("Magpie", "magpie")}<div class="gateway-summary__copy"><strong>${escape(gateway?.running ? t("gateway-connected") : gateway?.installed ? t("gateway-installed") : t("gateway-unavailable"))}</strong><code>${escape(gateway?.endpoint ? `${gateway.endpoint}/v1` : "http://127.0.0.1:3425/v1")}</code><div class="gateway-details">${gateway?.running ? ui.badge(`${exposedModels.length}/${gateway.modelCount} ${t("gateway-models-usable")}`, exposedModels.length ? "neutral" : "warning") : ""}${gateway?.version ? ui.badge(`v${gateway.version}`, "neutral") : ""}${gatewayApis.map((api) => ui.badge(api, "neutral")).join("")}</div><p class="agent-role-note">${escape(t("gateway-recognition-note"))}</p></div></div>${gatewayControls}</div>`,
  });
  const providerRows = providers.map((provider) => {
    const unrestricted = provider.hostAccess === "unrestricted";
    const access = provider.executionBlocked
      ? t("worker-blocked")
      : unrestricted
        ? t("worker-unrestricted")
        : provider.sandbox === "seatbelt"
          ? t("worker-sandboxed")
          : t("worker-runnable");
    const accessBadge = provider.executionBlocked
      ? ui.badge(access, "warning")
      : unrestricted
        ? ui.badge(access, "warning")
        : ui.badge(access, "success", { dot: true });
    const effortLevels = Array.isArray(provider.efforts) ? provider.efforts : [];
    const effortSelect = effortLevels.length
      ? `<select class="agent-effort-select" data-provider-effort="${escape(provider.id)}" aria-label="${escape(t("provider-effort"))} · ${escape(provider.title)}"><option value="">${escape(t("effort-default"))}</option>${effortLevels.map((level) => `<option value="${escape(level)}"${provider.effort === level ? " selected" : ""}>${escape(level)}</option>`).join("")}</select>`
      : "";

    const action = provider.installed
      ? provider.executionBlocked
        ? ui.button({
            label: t("worker-allow"),
            variant: "secondary",
            className: "c-button--compact",
            attributes: { "data-provider-access": provider.id, "data-allow": "true" },
          })
        : unrestricted
          ? ui.button({
              label: t("worker-disable"),
              variant: "secondary",
              className: "c-button--compact",
              attributes: { "data-provider-access": provider.id, "data-allow": "false" },
            })
          : ui.badge(t("worker-default"), "success", { dot: true })
      : provider.installable
        ? ui.button({
            label: t("install"),
            variant: "primary",
            className: "c-button--compact",
            attributes: { "data-install-provider": provider.id },
          })
        : ui.badge(t("manual-install"), "neutral");
    const status = provider.installed
      ? ui.badge(t("detected"), "success", { dot: true })
      : provider.installable
        ? ui.badge(t("installable"), "warning")
        : ui.badge(t("missing"), "danger");
    const source = provider.resolutionSource === "path"
      ? t("resolution-path")
      : provider.resolutionSource === "known-directory"
        ? t("resolution-fallback")
        : provider.resolutionSource === "absolute"
          ? t("resolution-explicit")
          : "";
    const meta = `${status}${provider.userConfigured ? ui.badge(t("user-config"), "accent") : ""}<span>${escape(provider.command)}</span>${accessBadge}${source ? `<span>${escape(source)}</span>` : ""}`;
    return ui.listRow({
      leading: ui.providerMark(provider.title, provider.id),
      title: provider.title,
      description: `${t("provider-purpose")} · ${provider.command}`,
      meta: `<span class="c-cluster">${meta}</span>${provider.resolvedPath ? `<code class="agent-provider-path" title="${escape(provider.resolvedPath)}">${escape(provider.resolvedPath)}</code>` : ""}`,
      actions: `${effortSelect}${action}`,
      tone: provider.installed ? "default" : "warning",
    });
  }).join("");
  const agentRows = settings.agents.map((agent) => {
    const provider = providerById.get(agent.providerId);
    const options = providers.map((candidate) => ({
      value: candidate.id,
      label: `${providerLabel(candidate.id)}${candidate.installed ? "" : ` · ${t("missing")}`}`,
      disabled: !candidate.installed,
    }));
    const description = agent.role === "external" ? t("external-unavailable") : agent.description;
    const purpose = agent.role === "external" ? t("external-unavailable-detail") : agent.purpose;
    return ui.listRow({
      leading: ui.providerMark(providerLabel(agent.providerId), agent.providerId),
      title: agent.title,
      description,
      meta: `${ui.badge(agentRoleLabel(agent.role), "neutral")}${provider?.installed ? ui.badge(providerLabel(agent.providerId), "accent") : ui.badge(`${providerLabel(agent.providerId)} · ${t("missing")}`, "warning")}<span>${escape(purpose)}</span>`,
      actions: `<div class="c-cluster">${ui.select({ options, value: agent.providerId, className: "agent-role-select", attributes: { "data-agent-provider": agent.id, "aria-label": `${t("provider-for")} ${agent.title}` } })}${ui.switchControl({ checked: agent.enabled, disabled: agent.required, label: agent.required ? t("required-role") : agent.enabled ? t("disable-role") : t("enable-role"), attributes: { "data-agent-toggle": agent.id } })}</div>`,
      tone: provider?.installed ? "default" : "warning",
    });
  }).join("");
  host.innerHTML = `<div class="agent-page">
    ${ui.sectionHeader({
      eyebrow: t("agent-page-eyebrow"),
      title: t("agents-title"),
      description: t("agents-lead"),
      actions: `${ui.button({ label: t("gateway-refresh"), iconName: "refresh", variant: "secondary", attributes: { "data-settings-refresh": "" } })}${installButton}`,
    })}
    <div class="c-stat-grid agent-overview">${ui.stat({ label: t("stat-providers"), value: `${installed.length}/${providers.length}`, detail: t("stat-providers-detail"), tone: installed.length ? "success" : "warning" })}${ui.stat({ label: t("stat-roles"), value: `${enabledRoles}/${settings.agents.length}`, detail: t("stat-roles-detail") })}${ui.stat({ label: t("stat-gateway"), value: gateway?.running ? t("online") : t("offline"), detail: gateway?.modelCount ? `${exposedModels.length}/${gateway.modelCount} ${t("gateway-models-usable")}` : t("gateway-subtitle"), tone: gateway?.running && exposedModels.length ? "success" : "warning" })}</div>
    ${gatewayCard}
    <div class="agent-section-head"><div><h3>${t("local-providers")}</h3><p>${t("providers-section-lead")}</p></div><div class="c-segmented" aria-label="${escape(t("providers-state"))}">${ui.badge(`${installed.length} ${t("connected")}`, "success", { dot: true })}${missing.length ? ui.badge(`${missing.length} ${t("installable")}`, "warning") : ""}</div></div>
    <div id="provider-registry" class="c-list agent-provider-list">${providerRows || ui.emptyState({ iconName: "terminal", title: t("empty-providers"), body: t("empty-providers-body") })}</div>
    <div class="agent-section-head"><div><h3>${t("roles-bindings")}</h3><p>${t("roles-section-lead")}</p></div></div>
    <div id="agent-settings-list" class="c-list agent-role-list">${agentRows}</div>
    <p class="agent-role-note">${escape(t("agents-note"))}</p>
  </div>`;
}
function selectedGatewayModel(current, models) {
  const selected = current.startsWith("magpie/") ? current.slice("magpie/".length) : "";
  return models.some((model) => model.id === selected) ? selected : models[0]?.id || "";
}
async function refreshGateways({ announceFailure = false } = {}) {
  state.gatewayLoading = true;
  state.signatures.agentPage = "";
  renderAgentPage();
  try {
    const result = await api("/api/gateways");
    renderGateways(result.gateways || []);
  } catch (error) {
    if (announceFailure) announce(error.message, true);
  } finally {
    state.gatewayLoading = false;
    state.signatures.agentPage = "";
    renderAgentPage();
  }
}
async function useGatewayModel() {
  const model = $("gateway-model")?.value;
  if (!model) {
    announce(t("gateway-model-required"), true);
    return;
  }
  const button = document.querySelector("[data-gateway-apply]");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/gateways/magpie/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (state.config?.config) state.config.config.mainAgentModel = result.config?.mainAgentModel;
    await refresh({ preserveScroll: true });
    await refreshGateways();
    announce(t("gateway-model-applied"));
  } catch (error) {
    if (button) button.disabled = false;
    announce(error.message, true);
  }
}
async function clearGatewayModel() {
  try {
    await api("/api/gateways/magpie/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    await refresh({ preserveScroll: true });
    await refreshGateways();
    announce(t("gateway-model-cleared"));
  } catch (error) {
    announce(error.message, true);
  }
}
function renderSituation(situation, config) {
  state.situation = situation;
  state.config = config;
  const signature = JSON.stringify([situation, config]);
  if (state.signatures.situation === signature) {
    renderAgentPage();
    return;
  }
  state.signatures.situation = signature;
  const overdue = situation.overdue || [];
  const dueSoon = situation.dueSoon || [];
  const goals = situation.activeGoals || [];
  const boundaries = situation.selfModel || [];
  const rows = [];
  if (overdue.length) rows.push(`<div class="settings-card"><h4>已逾期 (${overdue.length})</h4>${overdue.slice(0, 6).map((item) => `<p>${escape(item.title)} · 应于 ${escape(String(item.dueAt || "").slice(0, 10))}</p>`).join("")}</div>`);
  if (dueSoon.length) rows.push(`<div class="settings-card"><h4>即将到期 (${dueSoon.length})</h4>${dueSoon.slice(0, 6).map((item) => `<p>${escape(item.title)} · ${escape(String(item.dueAt || "").slice(0, 10))}</p>`).join("")}</div>`);
  if (goals.length) rows.push(`<div class="settings-card"><h4>进行中的目标 (${goals.length})</h4>${goals.slice(0, 6).map((item) => `<p>${escape(item.title)}</p>`).join("")}</div>`);
  if (boundaries.length) rows.push(`<div class="settings-card"><h4>你声明过的边界 (${boundaries.length})</h4>${boundaries.slice(0, 6).map((item) => `<p>${escape(item.statement)}</p>`).join("")}</div>`);
  const observed = situation.observations || [];
  if (observed.length) rows.push(`<div class="settings-card"><h4>观察来源</h4>${observed.map((item) => `<p>${escape(item.connectorId)} · ${item.error ? `读取失败：${escape(item.error)}` : `${item.count} 条`}</p>`).join("")}</div>`);
  $("situation-overview").innerHTML = rows.length
    ? rows.join("")
    : `<div class="memory-empty">还没有记录任何目标、承诺或观察。分身只会依据你确认过的内容行动。</div>`;
  const paths = config.paths || {};
  $("config-paths").innerHTML = `<h4>本地数据</h4><p>数据目录：${escape(paths.dataDirectory || "-")}</p><p>项目运行目录：${escape(paths.workspaceRuntimeDirectory || "-")}</p><p>Provider 配置：${escape(paths.providersFile || "-")}</p><p>记忆：${escape(paths.memoryDirectory || "-")}</p><span class="settings-value">仅本机</span>`;
  const workspacePath = config.config?.workspacePath || paths.workspacePath || "";
  const workspace = $("config-workspace");
  if (workspace) {
    workspace.textContent = workspacePath || t("workspace-unset");
    workspace.title = workspacePath;
  }
  renderModelOptions();
  renderMainAgentEffort();
  renderAgentPage();
}

/** Render the owner-facing phone binding state; secrets are deliberately never rendered. 渲染面向所有者的手机绑定状态；这里刻意不渲染任何秘密值。 */
function renderWhatsApp(status) {
  if (!status) return;
  state.whatsapp = status;
  const configured = status.configured === true;
  const bridgeRunning = status.bridge?.running === true;
  const tunnelRunning = status.tunnel?.running === true;
  const tunnelUrl = status.tunnel?.webhookUrl || "";
  const verified = Boolean(status.bridge?.webhookVerifiedAt);
  const phone = status.phoneNumberId ? `Phone Number ID ${status.phoneNumberId}` : "还没有保存 Phone Number ID";
  if ($("mobile-state")) $("mobile-state").textContent = status.ready ? "已连接" : configured ? (bridgeRunning ? "待验证" : "已停止") : "未绑定";
  if ($("whatsapp-credential-state")) $("whatsapp-credential-state").textContent = configured ? "已保存" : "未配置";
  if ($("whatsapp-tunnel-state")) $("whatsapp-tunnel-state").textContent = tunnelRunning ? "运行中" : "未启动";
  if ($("whatsapp-ready-state")) $("whatsapp-ready-state").textContent = status.ready ? "已接通" : "等待配置";
  const allowed = Array.isArray(status.allowedNumbers) ? status.allowedNumbers : [];
  if (!state.whatsappDirty && $("whatsapp-allowed-numbers") && document.activeElement !== $("whatsapp-allowed-numbers")) {
    $("whatsapp-allowed-numbers").value = allowed.join(", ");
  }
  if (!state.whatsappDirty && $("whatsapp-phone-number-id") && document.activeElement !== $("whatsapp-phone-number-id")) {
    $("whatsapp-phone-number-id").value = status.phoneNumberId || "";
  }
  if (!state.whatsappDirty && $("whatsapp-verify-token") && document.activeElement !== $("whatsapp-verify-token")) {
    $("whatsapp-verify-token").value = status.verifyToken || "";
  }
  if ($("whatsapp-webhook-url")) $("whatsapp-webhook-url").textContent = tunnelUrl || "还没有公网地址";
  const install = $("whatsapp-install-cloudflared");
  if (install) install.hidden = status.tunnel?.cloudflaredInstalled === true;
  if ($("whatsapp-start-tunnel")) $("whatsapp-start-tunnel").disabled = !configured || status.tunnel?.cloudflaredInstalled !== true || tunnelRunning;
  if ($("whatsapp-stop-tunnel")) $("whatsapp-stop-tunnel").disabled = !tunnelRunning;
  if ($("whatsapp-copy-webhook")) $("whatsapp-copy-webhook").disabled = !tunnelUrl;
  if ($("whatsapp-verify")) $("whatsapp-verify").disabled = !configured;
  if ($("whatsapp-stop-bridge")) $("whatsapp-stop-bridge").disabled = !bridgeRunning;
  if ($("whatsapp-tunnel-hint")) {
    $("whatsapp-tunnel-hint").textContent = status.tunnel?.error
      || (status.bridge?.stale
        ? "检测到旧版本手机桥仍在运行；点击“保存并启动手机桥”会安全地替换它。"
        : tunnelRunning ? "复制这个 HTTPS 地址 + /webhook 到 Meta；隧道地址通常会在重启后变化。" : status.tunnel?.cloudflaredInstalled ? "点击启动免费隧道，生成 Meta 可访问的地址。" : "还没有 cloudflared；可以在这里一键安装。");
  }
  if ($("whatsapp-verify-result")) $("whatsapp-verify-result").textContent = configured ? phone : "先填写四项凭据和一个手机号。";
  const overview = $("whatsapp-overview");
  if (overview) {
    overview.innerHTML = `<div class="mobile-status-card ${configured ? "is-ready" : ""}"><b>${configured ? "本机已保存绑定" : "还没有绑定手机"}</b><span>${escape(phone)}</span><span>${bridgeRunning ? "手机桥在线" : "手机桥未启动"} · ${tunnelRunning ? "公网入口在线" : "公网入口未启动"}</span>${status.bridge?.error ? `<span class="mobile-status-error">${escape(status.bridge.error)}</span>` : ""}</div>`;
  }
  const checklist = $("whatsapp-checklist");
  if (checklist) {
    const rows = [
      [configured, "填写 Cloud API 凭据和白名单号码"],
      [bridgeRunning, "手机桥在本机运行"],
      [tunnelRunning, "HTTPS Webhook 地址已生成"],
      [verified, "Meta 已成功验证 Webhook"],
      [Boolean(status.bridge?.lastMessageAt), status.bridge?.lastMessageAt ? `收到手机消息（${time(status.bridge.lastMessageAt)}）` : "从手机发一条 WhatsApp 做最终测试"],
    ];
    checklist.innerHTML = rows.map(([done, text]) => `<li class="${done ? "is-done" : ""}"><span>${done ? "✓" : "○"}</span>${escape(String(text))}</li>`).join("");
  }
}

async function refreshWhatsApp() {
  if (state.whatsappLoading) return;
  state.whatsappLoading = true;
  try {
    const result = await api("/api/mobile/whatsapp");
    renderWhatsApp(result.status);
  } catch (error) {
    announce(error.message, true);
  } finally {
    state.whatsappLoading = false;
  }
}

async function saveWhatsAppBinding() {
  const button = $("whatsapp-save");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/mobile/whatsapp/binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        allowedNumbers: $("whatsapp-allowed-numbers").value,
        phoneNumberId: $("whatsapp-phone-number-id").value,
        accessToken: $("whatsapp-access-token").value,
        appSecret: $("whatsapp-app-secret").value,
        verifyToken: $("whatsapp-verify-token").value,
      }),
    });
    $("whatsapp-access-token").value = "";
    $("whatsapp-app-secret").value = "";
    state.whatsappDirty = false;
    renderWhatsApp(result.status);
    announce("手机绑定已保存，手机桥已启动。");
  } catch (error) {
    announce(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function verifyWhatsAppBinding() {
  const button = $("whatsapp-verify");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/mobile/whatsapp/verify", { method: "POST" });
    renderWhatsApp(result.status);
    const name = result.profile?.verifiedName || "Meta 号码";
    const phone = result.profile?.displayPhoneNumber || "";
    $("whatsapp-verify-result").textContent = `${name}${phone ? ` · ${phone}` : ""} 已验证`;
    announce("Meta 凭据验证通过。");
  } catch (error) {
    if ($("whatsapp-verify-result")) $("whatsapp-verify-result").textContent = error.message;
    announce(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function startWhatsAppTunnel() {
  const button = $("whatsapp-start-tunnel");
  if (button) { button.disabled = true; button.textContent = "正在启动…"; }
  try {
    const result = await api("/api/mobile/whatsapp/tunnel/start", { method: "POST" });
    renderWhatsApp(result.status);
    announce("公网 Webhook 地址已生成。");
  } catch (error) {
    announce(error.message, true);
    await refreshWhatsApp();
  } finally {
    if (button) { button.disabled = false; button.textContent = "启动免费隧道"; }
  }
}

async function installCloudflared() {
  if (!(await confirmDialog("这会用 Homebrew 安装 cloudflared。安装不会触碰 WhatsApp 凭据。继续吗？", "安装"))) return;
  const button = $("whatsapp-install-cloudflared");
  if (button) { button.disabled = true; button.textContent = "正在安装…"; }
  try {
    const result = await api("/api/mobile/whatsapp/tunnel/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acknowledgeInstall: true }),
    });
    renderWhatsApp(result.status);
    announce(result.installed ? "cloudflared 已安装。" : "安装命令结束，但仍未找到 cloudflared；请查看安装输出。");
  } catch (error) {
    announce(error.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = "安装 cloudflared"; }
  }
}

async function stopWhatsAppTunnel() {
  try {
    const result = await api("/api/mobile/whatsapp/tunnel/stop", { method: "POST" });
    renderWhatsApp(result.status);
    announce("公网隧道已停止。");
  } catch (error) {
    announce(error.message, true);
  }
}

async function stopWhatsAppBridge() {
  const button = $("whatsapp-stop-bridge");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/mobile/whatsapp/bridge/stop", { method: "POST" });
    renderWhatsApp(result.status);
    announce("手机桥已停止；保存的凭据仍然保留。");
  } catch (error) {
    announce(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function generateWhatsAppVerifyToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  const input = $("whatsapp-verify-token");
  if (input) {
    input.value = token;
    state.whatsappDirty = true;
    input.focus();
    input.select();
  }
}

async function copyText(value, successMessage) {
  if (!value) {
    announce("还没有可复制的内容。", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    announce(successMessage);
  } catch {
    announce("复制失败，请手动选中文本复制。", true);
  }
}

function openMobileBinding() {
  closeSchedules();
  setSidebarOpen(false);
  state.settingsSection = "mobile";
  notifyDesktopNavigation("settings");
  openSettings();
  selectSettingsSection("mobile", true);
  void refreshWhatsApp();
}

function openMetaDeveloperConsole() {
  if (window.CloneNative?.openURL) {
    window.CloneNative.openURL("https://developers.facebook.com/apps/");
    return;
  }
  announce("当前窗口无法打开外部链接，请手动访问 developers.facebook.com/apps。", true);
}

function renderModelOptions() {
  const select = $("config-main-agent-model");
  if (!select) return;
  const current = state.config?.config?.mainAgentModel || "";
  const models = [];
  const seen = new Set();
  for (const model of state.modelOptions || []) {
    if (!model?.reference || seen.has(model.reference)) continue;
    seen.add(model.reference);
    const label = String(model.label || model.id || model.reference);
    const provider = String(model.provider || "");
    models.push({
      value: model.reference,
      label: `${label}${provider && provider !== "magpie" && !label.includes(provider) ? ` · ${provider}` : ""}`,
    });
  }
  if (current && !seen.has(current)) {
    models.unshift({ value: current, label: `${current} · ${t("model-current")}` });
  }
  const signature = JSON.stringify([models, current]);
  if (select.dataset.signature === signature) {
    if (document.activeElement !== select) select.value = current;
    return;
  }
  select.dataset.signature = signature;
  select.innerHTML = `<option value="">${escape(t("model-default"))}</option>${models.map((model) => `<option value="${escape(model.value)}">${escape(model.label)}</option>`).join("")}`;
  select.value = current;
}

async function loadModelOptions({ force = false } = {}) {
  if ((!force && state.modelOptionsLoaded) || state.modelOptionsLoading) return;
  state.modelOptionsLoading = true;
  try {
    const result = await api("/api/options");
    state.modelOptions = Array.isArray(result.models) ? result.models : [];
    state.modelOptionsLoaded = true;
    renderModelOptions();
  } catch {
    // A catalog failure must not hide the rest of the settings surface.
    // 目录读取失败不应遮住其余设置界面。
    state.modelOptionsLoaded = true;
  } finally {
    state.modelOptionsLoading = false;
  }
}

function renderConnectors(connectors) { state.connectors = connectors; const signature = JSON.stringify(connectors); if (state.signatures.connectors === signature) return; state.signatures.connectors = signature; $("connector-list").innerHTML = connectors.length ? connectors.map((connector) => `<article class="agent-setting"><div><h3>${escape(connector.id)}</h3><p>${escape(connector.target || "（未设置目录）")}</p><small>只读观察，绝不获得执行权限</small></div><label class="agent-switch" title="${connector.enabled ? "停用此来源" : "启用此来源"}"><input type="checkbox" data-connector-toggle="${escape(connector.id)}" ${connector.enabled ? "checked" : ""}/><span></span></label><button class="schedule-toggle" type="button" data-connector-remove="${escape(connector.id)}">移除</button></article>`).join("") : `<div class="memory-empty">还没有观察来源。选择目录后，分身才能知道你没主动告诉它的事。</div>`; }

async function saveConnectors(connectors, message) { try { await api("/api/connectors", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectors }) }); await refresh(); announce(message); } catch (error) { announce(error.message, true); } }

function chooseNativeDirectory(purpose, onChoose) {
  if (window.CloneNative?.chooseDirectory) {
    window.CloneNative.onDirectoryChosen = (selectedPurpose, path) => {
      window.CloneNative.onDirectoryChosen = undefined;
      window.CloneNative.onDirectoryCancelled = undefined;
      if (selectedPurpose === purpose) void onChoose(path);
    };
    window.CloneNative.onDirectoryCancelled = () => {
      window.CloneNative.onDirectoryChosen = undefined;
      window.CloneNative.onDirectoryCancelled = undefined;
    };
    window.CloneNative.chooseDirectory(purpose);
    return;
  }
  announce(t("directory-native-only"), true);
}

async function chooseWorkspace() {
  chooseNativeDirectory("workspace", async (workspacePath) => {
    try {
      await api("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspacePath }),
      });
      await refresh({ preserveScroll: true });
      announce(t("workspace-saved"));
    } catch (error) {
      announce(error.message, true);
    }
  });
}

function revealWorkspace() {
  const path = state.config?.config?.workspacePath || state.config?.paths?.workspacePath || "";
  if (!path) {
    announce(t("workspace-unset"), true);
    return;
  }
  if (window.CloneNative?.revealInFinder) {
    window.CloneNative.revealInFinder(path);
    return;
  }
  announce(t("directory-native-only"), true);
}

async function addConnector() {
  chooseNativeDirectory("connector", async (target) => {
    const existing = state.connectors || [];
    if (existing.some((connector) => connector.target === target)) {
      announce(t("connector-duplicate"));
      return;
    }
    const id = `files:${Date.now().toString(36)}`;
    await saveConnectors([...existing, { id, enabled: true, target }], t("connector-added"));
  });
}

async function setConnectorEnabled(id, enabled) { const next = (state.connectors || []).map((connector) => connector.id === id ? { ...connector, enabled } : connector); await saveConnectors(next, enabled ? "观察来源已启用。" : "观察来源已停用。"); }

async function removeConnector(id) { await saveConnectors((state.connectors || []).filter((connector) => connector.id !== id), "观察来源已移除。"); }

function renderMainAgentEffort() {
  const select = $("config-main-agent-effort");
  if (!select) return;
  const current = state.config?.config?.mainAgentEffort || "";
  const model = String(state.config?.config?.mainAgentModel || "").replace(/^magpie\//, "");
  // The gateway knows which levels this exact model offers; without it, fall back
  // to the levels the CLIs understand so the choice is never invented.
  // 网关知道这个模型具体支持哪些档位；拿不到时退回 CLI 通用档位，绝不凭空编造。
  const fromGateway = (state.gateway?.models || []).find((entry) => entry.id === model)?.reasoningLevels;
  const levels = Array.isArray(fromGateway) && fromGateway.length > 0 ? fromGateway : EFFORT_LEVELS;
  const signature = JSON.stringify([levels, current]);
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;
  select.innerHTML = `<option value="">${escape(t("effort-default"))}</option>${levels.map((level) => `<option value="${escape(level)}"${current === level ? " selected" : ""}>${escape(level)}</option>`).join("")}`;
}

async function saveMainAgentEffort() { const select = $("config-main-agent-effort"); if (!select) return; try { await api("/api/config", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mainAgentEffort: select.value }) }); await refresh({ preserveScroll: true }); announce(t("effort-saved")); } catch (error) { announce(error.message, true); } }

async function saveMainAgentModel() { const select = $("config-main-agent-model"); if (!select) return; try { await api("/api/config", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mainAgentModel: select.value }) }); await refresh({ preserveScroll: true }); announce(t("model-saved")); } catch (error) { announce(error.message, true); } }

async function saveLocale() {
  const locale = $("config-locale")?.value;
  if (locale !== "zh-CN" && locale !== "en") return;
  try {
    await api("/api/config", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale }) });
    await refresh({ preserveScroll: true });
  } catch (error) { announce(error.message, true); }
}

function renderAudit(sessions) { const signature = JSON.stringify(sessions.map((session) => [session.id, session.title, session.status, session.updatedAt])); if (state.signatures.audit === signature) return; state.signatures.audit = signature; $("audit-session-list").innerHTML = sessions.length ? sessions.map((session) => `<article class="audit-session"><div><b>${escape(session.title)}</b><span>${escape(statusMeta(session.status).label)} · ${time(session.updatedAt)}</span></div><button class="audit-open" type="button" data-open-audit-run="${escape(session.id)}">查看记录</button></article>`).join("") : `<div class="memory-empty">还没有可查看的执行记录。</div>`; }
function renderMemoryCandidates(candidates) {
  if (!candidates || !candidates.length) { $("memory-candidates").innerHTML = ""; return; }
  $("memory-candidates").innerHTML = `<h4>待确认的记忆候选（${candidates.length}）</h4><p class="candidates-hint">后台 Agent 从已完成任务中提炼了这些候选；提升后会写入本地记忆库，拒绝则丢弃。</p>${candidates.map((candidate) => `<article class="memory-card candidate-card"><textarea readonly aria-label="候选记忆内容">${escape(candidate.summary)}</textarea><div class="memory-meta"><span>${escape(candidate.type || "fact")} · ${escape(candidate.confidence)} 置信度</span>${candidate.sensitivity ? `<span>${escape(candidate.sensitivity)}</span>` : ""}<span>引用 ${(candidate.sourceEvidenceIds || []).length} 条证据</span></div><div class="candidate-actions"><button class="approve" type="button" data-promote-candidate="${escape(candidate.id)}">提升为记忆</button><button class="secondary" type="button" data-reject-candidate="${escape(candidate.id)}">拒绝</button></div></article>`).join("")}`;
}
async function decideCandidate(id, action) { try { await api(`/api/memory/candidates/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await refresh(); announce(action === "promote" ? "候选已提升为正式记忆。" : "候选已拒绝。"); } catch (error) { announce(error.message, true); } }
function renderMemorySearch(results) { $("memory-search-results").innerHTML = results.length ? results.map((match) => `<article class="memory-match"><div><b>${escape(match.summary)}</b><small>匹配：${escape((match.matchedTerms || []).join("、") || "相关上下文")}</small></div><span>${Math.round(match.score * 100)}%</span></article>`).join("") : `<div class="memory-empty">没有找到会被当前检索规则召回的使用中记忆。分身和子 Agent 看到的就是这些结果。</div>`; }

/**
 * The opportunity strip: what the twin noticed without being asked.
 *
 * Cards render above the conversation, not buried in a settings panel —
 * "the twin proactively found you" has to mean you see it where you already
 * are. Accept creates a run (the backend plans and queues it); dismiss
 * removes the card. Both record the decision in the journal.
 *
 * 机会卡片：分身不等人提问时发现的东西。
 *
 * 卡片渲染在对话区上方，而不是埋在设置面板里——“分身主动找你”必须意味着你在
 * 本来就在的地方看到它。接受会创建 Run（后端会规划并入队）；拒绝会移除卡片。
 * 两个决定都记入 Journal。
 */
// A failure card's next action is diagnosis, not another blind run. Repeating
// "accept" created a trail of identical failed sessions and never surfaced why.
// 失败卡片的下一步是诊断，而不是再盲目跑一遍。重复“接受”只会堆出相同失败会话，
// 却从不把原因告诉所有者。
function isFailureCard(card) {
  return card.source === "failed_task";
}

function renderOpportunities(cards) {
  state.opportunities = cards;
  const signature = JSON.stringify(cards);
  if (state.signatures.opportunities === signature) return;
  state.signatures.opportunities = signature;
  const strip = $("opportunity-strip");
  if (!cards.length) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.hidden = false;
  strip.innerHTML = cards.slice(0, 4).map((card) => {
    const failed = isFailureCard(card);
    return `<article class="opportunity-card${failed ? " is-failure" : ""}">
      <div class="opportunity-icon" aria-hidden="true">${failed ? "!" : "✦"}</div>
      <div class="opportunity-copy">
        <div class="opportunity-head"><span class="opportunity-source">${escape(opportunitySourceLabel(card.source))}</span><b>${escape(plainPreview(card.title))}</b></div>
        <p class="opportunity-why">${escape(plainPreview(card.whyNow))}</p>
        <p class="opportunity-proposal">${escape(plainPreview(card.proposedResult))}</p>
      </div>
      <div class="opportunity-actions">
        <button class="approve" type="button" data-accept-opportunity="${escape(card.id)}">${failed ? "查看原因" : "开始处理"}</button>
        ${failed ? `<button class="secondary" type="button" data-open-failure-settings>Agent 设置</button>` : ""}
        <button class="opportunity-dismiss" type="button" data-dismiss-opportunity="${escape(card.id)}">忽略</button>
      </div>
    </article>`;
  }).join("");
}

function opportunitySourceLabel(source) { return { deadline: "临近承诺", failed_task: "任务跟进", neglected_goal: "目标提醒", observation: "新观察" }[source] || "机会"; }

async function decideOpportunity(id, action) {
  try {
    const card = (state.opportunities || []).find((candidate) => candidate.id === id);
    if (action === "accept" && card && isFailureCard(card)) {
      const result = await api(`/api/opportunities/${encodeURIComponent(id)}/accept`, { method: "POST" });
      state.signatures.opportunities = null;
      await refresh({ scrollToBottom: false });
      if (result.runId) void selectSession(result.runId);
      announce(result.inspectOnly ? "已打开失败记录；请查看原因后再决定重试。" : "已记录这个决定。");
      return;
    }
    const result = await api(`/api/opportunities/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    state.signatures.opportunities = null;
    await refresh({ scrollToBottom: false });
    announce(action === "accept" ? `已接受。任务 ${String(result.runId || "").slice(0, 8)} 已开始准备。` : "已记录这个决定。");
  } catch (error) { announce(error.message, true); }
}

const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MEMORY_TYPES = [["preference", "偏好"], ["fact", "事实"], ["decision", "决定"], ["procedure", "流程"], ["commitment", "承诺"]];
const MEMORY_SENSITIVITIES = [["private", "私有"], ["public", "公开"], ["secret", "机密"]];
function options(pairs, selected) { return pairs.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join(""); }

function renderLibrary(library) {
  state.library = library;
  // Never redraw a field the owner is typing into: the .md content is
  // long-form prose, and losing a half-written paragraph to a background poll
  // is the fastest way to make an editor untrustworthy. The guard is limited
  // to text entry — a focused button is not an edit in progress, and treating
  // it as one would freeze the panel until the owner clicked elsewhere.
  const activeElement = document.activeElement;
  const editing = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
  if (editing && activeElement.closest("#library-list, #library-new-content, #library-new-summary, .memory-tools")) return;
  const signature = JSON.stringify(library);
  if (state.signatures.library === signature) return;
  state.signatures.library = signature;
  const stats = library.stats || { active: 0, archived: 0, total: 0, pending: 0, contentDirectory: "" };
  $("library-overview").innerHTML = `<article class="memory-stat"><b>${stats.active}</b><span>使用中</span></article><article class="memory-stat"><b>${stats.archived}</b><span>已归档</span></article><article class="memory-stat"><b>${stats.pending}</b><span>待确认候选</span></article><article class="memory-stat file-stat"><b>.md</b><span>${escape(stats.contentDirectory || "-")}</span></article>`;
  const memories = library.memories || [];
  const conflicts = (library.conflicts || []).map((item) => `<article class="memory-card"><b>${escape(t("memory-conflict"))}</b><p>${escape(item.summary)}</p><button class="secondary" type="button" data-memory-conflict="${escape(item.id)}">${escape(t("memory-keep-file"))}</button></article>`).join("");
  const cards = memories.length ? memories.map((item) => `<article class="memory-card library-card" data-library-card="${escape(item.id)}">
    <input class="library-summary" type="text" value="${escape(item.summary)}" data-library-summary="${escape(item.id)}" aria-label="记忆摘要"/>
    <textarea class="library-content" data-library-content="${escape(item.id)}" aria-label="记忆正文" rows="4">${escape(item.content || "")}</textarea>
    <div class="memory-meta">
      <select data-library-type="${escape(item.id)}" aria-label="类型">${options(MEMORY_TYPES, item.type)}</select>
      <select data-library-sensitivity="${escape(item.id)}" aria-label="敏感度">${options(MEMORY_SENSITIVITIES, item.sensitivity)}</select>
      <select class="memory-status" data-library-status="${escape(item.id)}" aria-label="状态"><option value="active" ${item.status === "active" ? "selected" : ""}>使用中</option><option value="archived" ${item.status === "archived" ? "selected" : ""}>已归档</option></select>
      <span>${escape(item.confidence)} 置信度</span>
      <span>召回 ${item.accessCount || 0} 次</span>
      ${item.sourceRunId && item.sourceRunId !== "owner" ? `<button class="memory-source" type="button" data-open-memory-source="${escape(item.sourceRunId)}">查看来源</button>` : `<span>由你写入</span>`}
      <span class="library-file">${escape(item.id)}.md</span>
      <button class="memory-save" type="button" data-save-library="${escape(item.id)}">保存</button>
    </div>
  </article>`).join("") : `<div class="memory-empty">记忆库还是空的。写下一条你希望分身长期记住的偏好、边界或事实——它会成为一个你随时可以打开和修改的 .md 文件。</div>`;
  $("library-list").innerHTML = conflicts + cards;
  if (library.syncError) announce(`磁盘上的记忆文件读取失败：${library.syncError}`, true);
}

async function saveLibraryMemory(id) {
  const pick = (attribute) => document.querySelector(`[data-library-${attribute}="${CSS.escape(id)}"]`);
  const body = {
    summary: pick("summary").value,
    content: pick("content").value,
    type: pick("type").value,
    sensitivity: pick("sensitivity").value,
    status: pick("status").value,
  };
  const button = document.querySelector(`[data-save-library="${CSS.escape(id)}"]`);
  if (button) button.disabled = true;
  try {
    await api(`/api/memory/governed/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.signatures.library = null;
    await refresh();
    announce("记忆已保存，对应的 .md 文件也已更新。");
  } catch (error) { announce(error.message, true); } finally { if (button) button.disabled = false; }
}
async function keepMemoryFile(id) { if (!(await confirmDialog(t("memory-keep-confirm"), t("memory-keep-file")))) return; try { await api(`/api/memory/governed/conflicts/${encodeURIComponent(id)}/keep-file`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmDiscardPendingChange: true }) }); await refresh(); announce(t("memory-conflict-resolved")); } catch (error) { announce(error.message, true); } }

async function createLibraryMemory() {
  const summary = $("library-new-summary").value.trim();
  if (summary.length < 3) { announce("请写下一条至少三个字的摘要。", true); return; }
  const button = $("library-create");
  button.disabled = true;
  try {
    await api("/api/memory/governed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary, content: $("library-new-content").value.trim(), type: $("library-new-type").value, sensitivity: $("library-new-sensitivity").value }) });
    $("library-new-summary").value = "";
    $("library-new-content").value = "";
    state.signatures.library = null;
    await refresh();
    announce("已写入记忆库。");
  } catch (error) { announce(error.message, true); } finally { button.disabled = false; }
}

function renderContext(context) {
  state.context = context;
  const signature = JSON.stringify(context);
  if (state.signatures.context === signature) return;
  state.signatures.context = signature;
  const compactions = context.compactions || [];
  // entriesOutOfContext is the headline: it is the part of the conversation the
  // model can no longer see but that search_history can still reach.
  $("context-overview").innerHTML = `<article class="memory-stat"><b>${context.messageEntries || 0}</b><span>历史消息</span></article><article class="memory-stat"><b>${compactions.length}</b><span>压缩次数</span></article><article class="memory-stat"><b>${context.entriesOutOfContext || 0}</b><span>已压缩出上下文</span></article><article class="memory-stat file-stat"><b>jsonl</b><span>${escape(context.directory || "-")}</span></article>`;
  $("context-compactions").innerHTML = compactions.length ? `<h4>压缩记录</h4><p class="candidates-hint">每一次压缩都写下了一段摘要，被摘要掉的原文仍在磁盘上，可以被搜索回来。</p>${compactions.map((item) => `<article class="memory-card"><div class="memory-meta"><span>${escape(String(item.at || "").slice(0, 16).replace("T", " "))}</span><span>压缩前约 ${item.tokensBefore || 0} tokens</span></div><p class="context-summary">${escape(item.summaryPreview || "（没有摘要文本）")}</p></article>`).join("")}` : `<div class="memory-empty">还没有发生过压缩。对话仍然完整地在模型上下文里。</div>`;
  const conversations = context.conversations || [];
  $("context-conversations").innerHTML = conversations.length ? `<h4>对话（${conversations.length}）</h4>${conversations.map((item) => `<article class="memory-card"><div class="memory-meta">${item.active ? `<span class="context-active">当前对话</span>` : ""}<span>${item.messages} 条消息</span><span>${time(item.updatedAt)}</span></div><p class="context-summary">${escape(item.preview || "（没有预览）")}</p></article>`).join("")}` : "";
}

function renderContextSearch(excerpts) {
  $("context-search-results").innerHTML = excerpts.length ? excerpts.map((item) => `<article class="memory-match context-match"><div><b>${escape(item.speaker)} · ${escape(String(item.at || "").slice(0, 16).replace("T", " "))}${item.outOfContext ? " · 已压缩出上下文" : ""}</b><small>${escape(item.excerpt)}</small></div><span>${Math.round(item.score * 100)}%</span></article>`).join("") : `<div class="memory-empty">完整历史里没有匹配的内容。</div>`;
}

async function searchContextHistory(query) { try { renderContextSearch((await api(`/api/context/search?q=${encodeURIComponent(query)}`)).excerpts || []); } catch (error) { announce(error.message, true); } }
function welcomeMarkup() {
  return `<div class="welcome">
    <div class="welcome-copy">
      <span class="welcome-eyebrow">开始新任务</span>
      <h2>今天想推进什么？</h2>
      <p>直接描述目标，或贴一段上下文。我会先拆解、准备和验证；会影响外部世界的动作会先停下来问你。</p>
    </div>
  </div>`;
}
function richText(value) {
  const blocks = [];
  const source = String(value ?? "").replace(/\r\n?/g, "\n")
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
      const index = blocks.push(`<div class="md-code-wrap"><button class="md-copy" type="button" data-copy-code>复制</button><pre class="md-code"><code>${escape(code.replace(/^\n+|\n+$/g, ""))}</code></pre></div>`) - 1;
      return `\n\u0000BLOCK${index}\u0000\n`;
    });
  return escape(source)
    .replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,4}\s+(.+)$/gm, '<div class="md-heading">$1</div>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<div class="md-list-line"><span aria-hidden="true">•</span><span>$1</span></div>')
    .replace(/^\s*(\d+)[.)]\s+(.+)$/gm, '<div class="md-list-line md-list-line--ordered"><span>$1.</span><span>$2</span></div>')
    .replace(/\n/g, "<br>")
    // A block element already starts a new line, so a <br> next to it only adds an
    // empty line: list items used to render double-spaced with the marker far from
    // its text. 块级元素本身就会换行，紧邻的 <br> 只会多出一整行——列表项因此被拉开双倍行距，
    // 圆点离正文很远。
    .replace(/<br>(?=<div class="md-(?:heading|list-line))/g, "")
    .replace(/(<\/div>)<br>/g, "$1")
    .replace(/\u0000BLOCK(\d+)\u0000/g, (match, index) => blocks[Number(index)] ?? "");
}
function messageMarkup(message) {
  const clone = message.role === "clone";
  const text = String(message.text ?? "").trim();
  if (!text) return "";
  const tone = message.tone ? ` ${message.tone}` : "";
  const collapsible = clone && text.length > 480;
  const body = clone ? richText(text) : escape(text).replace(/\n/g, "<br>");
  // The conversation reads like Codex: the owner is a compact right-aligned
  // instruction, while the agent's work stays in the main reading column.
  // 对话按 Codex 的方式排版：所有者指令靠右且紧凑，Agent 工作留在主阅读栏。
  const technical = message.tone === "warning"
    && !text.includes("下一步：")
    && /Unrestricted host execution|permission_denied|no enforced sandbox/i.test(text);
  const displayed = technical
    ? "这次任务没有执行：本机 Worker 默认禁止不受限访问。请到「设置 → Agent」为绑定的 Worker 明确开启运行权限，或改用一个已允许的 Worker。"
    : text;
  const displayedBody = clone && technical ? escape(displayed) : body;
  const needsAgentSettings = clone && message.tone === "warning"
    && /设置\s*→\s*Agent|Worker|Provider|permission_denied|no enforced sandbox|Unrestricted host execution/i.test(text);
  const actions = needsAgentSettings
    ? `<div class="message-actions"><button class="secondary" type="button" data-open-agent-settings>打开 Agent 设置</button></div>`
    : "";
  return `<article class="message ${clone ? "clone" : "person"}"><div class="message-heading"><b>${clone ? "clone-ai" : "你"}</b><time>${time(message.occurredAt)}</time></div><div class="message-body">${clone ? `<div class="clone-card${tone}"><div class="clone-text${collapsible ? " collapsible collapsed" : ""}">${displayedBody}</div>${collapsible ? `<button class="clone-expand" type="button" data-expand>展开全部</button>` : ""}${actions}</div>` : `<div class="message-copy">${body}</div>`}</div></article>`;
}
function displayAgentTitle(agent) { return agent.title; }
function displayAgentDetail(agent) { const provider = agent.providerId ? `${providerLabel(agent.providerId)} · ` : ""; return provider + (agent.status === "completed" ? "已提交可验证证据" : (agent.summary || "正在按任务边界推进")); }
function disclosureOpen(session, name, fallback = false) { return state.openDisclosures.get(session.id)?.get(name) ?? fallback; }
function planMarkup(session) { if (!session.plan) return ""; const fallback = session.status === "waiting_approval" || !["completed", "failed", "cancelled"].includes(session.status); const open = disclosureOpen(session, "plan", fallback) ? " open" : ""; return `<details class="activity-card plan-card" data-disclosure="plan"${open}><summary class="activity-summary">${icon("spark")}<b>执行计划</b><span>${session.plan.steps.length} 步</span></summary><p class="plan-summary">${escape(session.plan.summary)}</p><div class="plan-steps">${session.plan.steps.map((step, index) => `<div class="plan-step"><span class="plan-step-index">${index + 1}</span><b>${escape(step.title)}</b><span>${step.delegated ? "委派执行" : step.risk === "read_only" ? "直接处理" : "需确认"}</span></div>`).join("")}</div></details>`; }
function agentsMarkup(session) { if (!session.subagents.length) return ""; const completed = session.subagents.filter((agent) => agent.status === "completed").length; const fallback = session.status === "waiting_approval" || !["completed", "failed", "cancelled"].includes(session.status); const open = disclosureOpen(session, "agents", fallback) ? " open" : ""; return `<details class="activity-card" data-disclosure="agents"${open}><summary class="activity-summary">${icon("spark")}<b>Agent 协作</b><span>${completed}/${session.subagents.length} 已完成</span></summary><div class="agent-list">${session.subagents.map((agent) => { const status = statusMeta(agent.status); return `<div class="agent-row"><span class="status-dot ${status.dot}"></span><div><strong>${escape(displayAgentTitle(agent))}</strong><small>${escape(displayAgentDetail(agent))}</small></div><span class="agent-status">${escape(status.label)}</span></div>`; }).join("")}</div></details>`; }
function approvalMarkup(session) { if (!session.approvals.length) return ""; return `<section class="approval-card"><div class="approval-kicker">需要你的决定</div><h2>是否继续执行外部动作？</h2><p>${escape(session.approvals[0].description)}</p><div class="approval-actions"><button class="approve" type="button" data-approve="${escape(session.id)}">确认并继续</button><button class="secondary" type="button" data-reject="${escape(session.id)}">拒绝</button></div></section>`; }
function reviewMarkup(session) { const verification = session.verification; if (session.status !== "waiting_review" || !verification?.needsReview) return ""; const criteria = (verification.unverifiedCriteria || []).map((criterion) => `<li>${escape(criterion)}</li>`).join(""); return `<section class="approval-card"><div class="approval-kicker">${escape(t("status-review"))}</div><h2>${escape(t("review-title"))}</h2><ul>${criteria}</ul><div class="approval-actions"><button class="approve" type="button" data-review="${escape(session.id)}" data-review-decision="accept">${escape(t("review-accept"))}</button><button class="secondary" type="button" data-review="${escape(session.id)}" data-review-decision="reject">${escape(t("review-reject"))}</button></div></section>`; }
function recalledMemoryMarkup(session) { const memories = session.recalledMemories || []; if (!memories.length) return ""; return `<details class="activity-card" data-disclosure="memory"><summary class="activity-summary">${icon("spark")}<b>本次任务使用的 Memory</b><span>${memories.length} 条</span></summary><div class="agent-list">${memories.map((memory) => `<div class="agent-row"><div><strong>${escape(memory.summary)}</strong><small>匹配：${escape((memory.matchedTerms || []).join("、") || "相关上下文")} · ${Math.round((memory.score || 0) * 100)}%</small></div></div>`).join("")}</div></details>`; }
function evidenceMarkup(session) { return session.evidenceCount ? `<div class="evidence">${icon("check")}已记录 ${session.evidenceCount} 条可验证证据</div>` : ""; }
function traceMarkup(session) { const trace = session.trace || session.activity || []; if (!trace.length) return ""; const open = disclosureOpen(session, "trace") ? " open" : ""; return `<details class="activity-card" data-disclosure="trace"${open}><summary class="activity-summary">${icon("check")}<b>本地执行轨迹</b><span>${trace.length} 条</span></summary><div class="trace" data-scroll-region="trace">${trace.map((item, index) => `<div class="trace-row"><b><span class="trace-sequence">#${item.sequence ?? index + 1}</span>${escape(item.label)}</b><p>${time(item.occurredAt)} · ${escape(item.detail)}</p></div>`).join("")}</div></details>`; }
function setTopbar(session) { if (!session) { $("session-kind").textContent = "个人对话"; $("session-title").textContent = t("new-conversation"); $("session-subtitle").textContent = t("start-intent"); $("session-status").textContent = t("ready"); $("session-status").className = "status-pill"; return; } const status = statusMeta(session.status); $("session-kind").textContent = session.id === MAIN_CONVERSATION_ID ? "个人对话" : "任务记录"; $("session-title").textContent = plainPreview(session.title); $("session-subtitle").textContent = `${plainPreview(session.preview)} · ${time(session.updatedAt)}`; $("session-status").textContent = session.id === MAIN_CONVERSATION_ID && session.status === "completed" ? "已保存" : status.label; $("session-status").className = `status-pill ${status.className}`; }
const SCROLL_BOTTOM_THRESHOLD = 28;
function rememberCurrentScroll() {
  if (!state.selectedId) return;
  const viewport = $("conversation");
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  state.scrollPositions.set(state.selectedId, {
    top: viewport.scrollTop,
    anchor: maxTop - viewport.scrollTop <= SCROLL_BOTTOM_THRESHOLD ? "bottom" : "offset",
  });
}
function rememberDisclosureScrolls() {
  if (!state.selectedId) return;
  const positions = state.disclosureScrollPositions.get(state.selectedId) || new Map();
  document.querySelectorAll("#conversation-inner [data-scroll-region]").forEach((region) => {
    positions.set(region.dataset.scrollRegion, region.scrollTop);
  });
  state.disclosureScrollPositions.set(state.selectedId, positions);
}
function rememberDisclosureScroll(event) {
  const region = event.target;
  if (!(region instanceof HTMLElement) || !region.dataset.scrollRegion || !state.selectedId) return;
  const positions = state.disclosureScrollPositions.get(state.selectedId) || new Map();
  positions.set(region.dataset.scrollRegion, region.scrollTop);
  state.disclosureScrollPositions.set(state.selectedId, positions);
}
function rememberDisclosure(event) {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.dataset.disclosure || !state.selectedId) return;
  const disclosures = state.openDisclosures.get(state.selectedId) || new Map();
  disclosures.set(details.dataset.disclosure, details.open);
  state.openDisclosures.set(state.selectedId, disclosures);
}
function restoreSessionScroll(id, { scrollToBottom = false } = {}) {
  const saved = scrollToBottom ? { top: 0, anchor: "bottom" } : state.scrollPositions.get(id) || { top: 0, anchor: "bottom" };
  requestAnimationFrame(() => {
    if (state.selectedId !== id) return;
    const viewport = $("conversation");
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const top = saved.anchor === "bottom" ? maxTop : Math.min(saved.top, maxTop);
    viewport.scrollTop = top;
    state.scrollPositions.set(id, { top, anchor: saved.anchor });
  });
}
function restoreDisclosureScrolls(id) {
  const positions = state.disclosureScrollPositions.get(id);
  if (!positions) return;
  requestAnimationFrame(() => {
    if (state.selectedId !== id) return;
    document.querySelectorAll("#conversation-inner [data-scroll-region]").forEach((region) => {
      const top = positions.get(region.dataset.scrollRegion);
      if (top !== undefined) region.scrollTop = Math.min(top, Math.max(0, region.scrollHeight - region.clientHeight));
    });
  });
}
function renderSession(session) { setTopbar(session); document.body.classList.toggle("empty-conversation", session === null); const signature = session ? JSON.stringify(session) : "welcome"; if (state.signatures.conversation === signature) return; state.signatures.conversation = signature; const content = $("conversation-inner"); if (!session) { content.innerHTML = welcomeMarkup(); $("conversation").scrollTop = 0; return; } content.innerHTML = `<div class="day-divider">${day(session.updatedAt)}</div>${session.messages.filter((message) => String(message.text ?? "").trim()).map(messageMarkup).join("")}${recalledMemoryMarkup(session)}${planMarkup(session)}${agentsMarkup(session)}${evidenceMarkup(session)}${approvalMarkup(session)}${reviewMarkup(session)}${traceMarkup(session)}`; restoreDisclosureScrolls(session.id); requestAnimationFrame(updateScrollBottom); }
async function selectSession(id, { quiet = false, scrollToBottom = false, epoch = state.sessionEpoch } = {}) { if (!quiet) epoch = ++state.sessionEpoch; state.composingNew = false; if (!quiet) notifyDesktopNavigation("conversation"); if (state.selectedId !== id) { if (state.selectedId) state.drafts.set(state.selectedId, $("query").value); $("query").value = state.drafts.get(id) || ""; resizeComposer(); rememberCurrentScroll(); rememberDisclosureScrolls(); } state.selectedId = id; localStorage.setItem("clone-ai:selected-session", id); renderSessions(state.dashboard?.sessions || []); try { const session = await api(`/api/sessions/${encodeURIComponent(id)}`); if (epoch !== state.sessionEpoch) return; renderSession(session); restoreSessionScroll(id, { scrollToBottom }); } catch (error) { if (epoch !== state.sessionEpoch) return; if (!quiet) announce(error.message, true); state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); renderSession(null); } }
async function refresh({ preserveScroll = true, scrollToBottom = false } = {}) { if (state.streaming) return; const epoch = state.sessionEpoch; if (preserveScroll) { rememberCurrentScroll(); rememberDisclosureScrolls(); } try { const [dashboard, schedules, settings, agents, candidates, situation, config, connectors, library, context, opportunities, mobile] = await Promise.all([api("/api/dashboard"), api("/api/schedules"), api("/api/settings"), api("/api/agents"), api("/api/memory/candidates"), api("/api/situation"), api("/api/config"), api("/api/connectors"), api("/api/memory/governed"), api("/api/context"), api("/api/opportunities"), api("/api/mobile/whatsapp")]); if (epoch !== state.sessionEpoch) return; state.dashboard = dashboard; applyChrome(config.ui?.locale || config.config?.locale || "zh-CN", config.ui?.strings); renderSchedules(schedules.schedules || [], schedules.occurrences || [], schedules.reportDeliveries || [], schedules.reportError === true); renderSettings(settings, agents.providers || []); renderAudit(dashboard.sessions || []); renderLibrary(library); renderOpportunities(opportunities.opportunities || []); renderContext(context); renderMemoryCandidates(candidates.candidates || []); renderSituation(situation, config); renderWhatsApp(mobile.status); renderConnectors(connectors.connectors || []); if (!state.modelOptionsLoaded && !state.modelOptionsLoading) void loadModelOptions(); if (!state.gateways.length && !state.gatewayLoading) void refreshGateways(); const sessions = state.dashboard.sessions || []; if (!state.composingNew && (!state.selectedId || !sessions.some((session) => session.id === state.selectedId))) state.selectedId = sessions.find((session) => session.id === MAIN_CONVERSATION_ID)?.id ?? sessions[0]?.id ?? null; renderSessions(sessions); if (state.composingNew) { state.selectedId = null; renderSession(null); } else if (state.selectedId) await selectSession(state.selectedId, { quiet: true, scrollToBottom, epoch }); else renderSession(null); requestAnimationFrame(() => { $("startup-screen").classList.add("ready"); document.querySelector(".app-shell").classList.add("ready"); }); } catch (error) { announce(error.message, true); const startupTip = document.querySelector("#startup-screen .startup-card span"); if (startupTip && !$("startup-screen").classList.contains("ready")) startupTip.textContent = `连接本地运行时失败：${error.message}（自动重试中…）`; } }
async function createSession(query) { const button = $("submit"); button.disabled = true; rememberCurrentScroll();
  state.streaming = true;
  // The message and a live reply card appear before the request is sent. A model
  // call can take many seconds, and until now the composer kept the text and the
  // conversation showed nothing, so the app looked frozen mid-thought.
  // 消息与实时回复卡片在请求发出之前就出现。模型调用可能耗时数秒，而此前输入框保留原文、
  // 会话区毫无变化，应用看起来就像在思考中卡住了。
  $("query").value = ""; resizeComposer();
  document.body.classList.remove("empty-conversation");
  const inner = $("conversation-inner");
  const welcome = inner.querySelector(".welcome"); if (welcome) inner.innerHTML = "";
  inner.insertAdjacentHTML("beforeend", `<div class="message person"><div class="message-heading"><b>你</b><time>${time(new Date().toISOString())}</time></div><div class="message-body"><div class="message-copy">${escape(query)}</div></div></div>`);
  const card = document.createElement("div"); card.className = "message clone";
  card.innerHTML = `<div class="message-heading"><b>clone-ai</b><time>${time(new Date().toISOString())}</time></div><div class="message-body"><div class="clone-card"><div class="response-pending" data-response-pending role="status" aria-live="polite"><span class="response-pending__pulse" aria-hidden="true"><i></i><i></i><i></i></span><div class="response-pending__copy"><strong data-pending-title>${escape(t("pending-connect-title"))}</strong><p data-pending-detail>${escape(t("pending-connect-detail"))}</p><div class="response-pending__track" aria-hidden="true"></div></div><span class="response-pending__time" data-pending-elapsed>${escape(t("pending-elapsed").replace("{seconds}", "0"))}</span></div><div class="clone-text" data-streaming="1" hidden></div></div>`;
  inner.appendChild(card);
  const target = card.querySelector(".clone-text");
  const pending = card.querySelector("[data-response-pending]");
  const pendingTitle = card.querySelector("[data-pending-title]");
  const pendingDetail = card.querySelector("[data-pending-detail]");
  const pendingElapsed = card.querySelector("[data-pending-elapsed]");
  const pendingStartedAt = performance.now();
  const pendingStages = [
    { at: 0, title: "pending-connect-title", detail: "pending-connect-detail" },
    { at: 4, title: "pending-think-title", detail: "pending-think-detail" },
    { at: 10, title: "pending-slow-title", detail: "pending-slow-detail" },
    { at: 20, title: "pending-long-title", detail: "pending-long-detail" },
  ];
  let pendingStage = -1;
  let pendingTimer = null;
  const updatePending = () => {
    const seconds = Math.max(0, Math.floor((performance.now() - pendingStartedAt) / 1000));
    const nextStage = pendingStages.reduce((selected, stage, index) => seconds >= stage.at ? index : selected, 0);
    if (nextStage !== pendingStage) {
      pendingStage = nextStage;
      pendingTitle.textContent = t(pendingStages[nextStage].title);
      pendingDetail.textContent = t(pendingStages[nextStage].detail);
      pending.dataset.phase = String(nextStage);
    }
    pendingElapsed.textContent = t("pending-elapsed").replace("{seconds}", String(seconds));
  };
  const revealResponse = () => {
    if (pendingTimer !== null) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
    if (pending && !pending.hidden) pending.hidden = true;
    target.hidden = false;
    target.classList.add("is-streaming");
  };
  updatePending();
  pendingTimer = window.setInterval(updatePending, 1000);
  $("conversation").scrollTop = $("conversation").scrollHeight;

  const turnId = globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const turnStartedAt = new Date().toISOString();
  let reply = ""; let result = null; let failed = false; let failure = "";
  const controller = new AbortController();
  let stallTimer = null;
  const armStallTimer = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = window.setTimeout(() => controller.abort(), 180_000);
  };
  armStallTimer();
  try {
    const headers = { "content-type": "application/json" };
    if (window.CLONE_AI_TOKEN) headers.Authorization = `Bearer ${window.CLONE_AI_TOKEN}`;
    const response = await fetch("/api/main-agent/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: query, turnId }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) { const detail = await response.json().catch(() => ({})); throw new Error(detail.error || `请求失败：${response.status}`); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      armStallTimer();
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a partial frame stays buffered.
      // SSE 帧以空行分隔；不完整的帧留在缓冲区等待后续数据。
      let split;
      while ((split = buffer.indexOf(String.fromCharCode(10, 10))) >= 0) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1]; const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === "delta") { revealResponse(); reply += payload.delta; target.textContent = reply; $("conversation").scrollTop = $("conversation").scrollHeight; }
        else if (event === "done") { result = payload; }
        else if (event === "failed") { failure = payload.error || "Main Agent 调用失败。"; throw new Error(failure); }
      }
    }
    if (!result) throw new Error("连接在回复完成前中断。");
    state.drafts.delete(state.selectedId);
    // Re-render the finished reply so links and code blocks are formatted; the
    // streaming view stays plain text because partial markdown renders wrong.
    // 回复完成后重新渲染，让链接与代码块获得格式；流式过程保持纯文本，因为不完整的
    // Markdown 会渲染错乱。
    const firstRun = result.newRuns?.[0];
    revealResponse();
    target.classList.remove("is-streaming");
    target.parentElement?.querySelector("[data-response-error]")?.remove();
    // Add the settled card only after its state is known. A transient error
    // or empty return must not leave a permanent composer inside the chat.
    // 状态确定后才显示最终卡片；异常或空返回绝不会在聊天里留下永久占位。
    target.hidden = false;
    target.innerHTML = reply.trim().length > 0
      ? richText(reply)
      : `<span class="response-fallback">${escape(t(firstRun ? "empty-model-reply-with-run" : "empty-model-reply"))}</span>`;
    // The turn always lands in the one conversation thread; a plan it proposed
    // becomes a task in the sidebar. Switching into a fresh box per message is
    // what made the interface look like it kept spawning new conversations.
    // 每一轮都落进唯一的对话线程；它提案的计划会作为侧栏中的任务出现。每发一条消息就切换
    // 到一个新对话框，正是界面看起来不断裂变的原因。
    state.composingNew = false;
    state.selectedId = MAIN_CONVERSATION_ID;
    if (firstRun) state.scrollPositions.set(firstRun.id, { top: 0, anchor: "bottom" });
    localStorage.setItem("clone-ai:selected-session", MAIN_CONVERSATION_ID);
    state.streaming = false;
    await refresh({ preserveScroll: false, scrollToBottom: true });
    announce(firstRun ? "Main Agent 已提交计划，正在推进。" : "Main Agent 已回复（未创建任务）。");
  } catch (error) {
    failed = true;
    failure = error instanceof Error && error.name === "AbortError"
      ? "Main Agent 在 3 分钟内没有返回任何内容，已停止等待。"
      : error instanceof Error ? error.message : String(error);
    // The typed text is restored so a failed send never loses what was written.
    // 恢复已输入的文本，使一次失败的发送绝不丢失所写内容。
    if (!reply) {
      revealResponse();
      target.classList.remove("is-streaming");
      target.hidden = true;
      target.innerHTML = "";
      target.insertAdjacentHTML("afterend", `<div class="response-error" data-response-error>${escape(t("response-interrupted-detail").replace("{message}", failure))}</div>`);
      $("query").value = query;
      resizeComposer();
    } else {
      revealResponse();
      target.classList.remove("is-streaming");
      target.innerHTML = richText(reply);
    }
    announce(failure, true);
  } finally {
    state.streaming = false;
    if (stallTimer !== null) clearTimeout(stallTimer);
    if (pendingTimer !== null) clearInterval(pendingTimer);
    target.removeAttribute("data-streaming");
    target.classList.remove("is-streaming");
    button.disabled = false;
  }
  if (failed) {
    await api("/api/main-agent/interruptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId, text: query, error: failure, startedAt: turnStartedAt }),
    }).catch(() => undefined);
    await refresh({ preserveScroll: true, scrollToBottom: true }).catch(() => undefined);
  }
}

async function approve(id) { const button = document.querySelector(`[data-approve="${CSS.escape(id)}"]`); if (button) button.disabled = true; try { const result = await api(`/api/runs/${encodeURIComponent(id)}/approve`, { method: "POST" }); await refresh({ preserveScroll: true, scrollToBottom: true }); announce(result.status === "completed" ? "已完成并验证结果。" : "已记录确认，继续处理中。" ); } catch (error) { if (button) button.disabled = false; announce(error.message, true); } }
async function reject(id) { const button = document.querySelector(`[data-reject="${CSS.escape(id)}"]`); if (button) button.disabled = true; try { await api(`/api/runs/${encodeURIComponent(id)}/reject`, { method: "POST" }); await refresh({ preserveScroll: true, scrollToBottom: true }); announce("已拒绝这次外部动作。"); } catch (error) { if (button) button.disabled = false; announce(error.message, true); } }
async function reviewResult(id, decision) { const message = decision === "accept" ? t("review-accept-confirm") : t("review-reject-confirm"); if (!(await confirmDialog(message, t("confirm")))) return; try { const result = await api(`/api/runs/${encodeURIComponent(id)}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) }); await refresh({ preserveScroll: true, scrollToBottom: true }); announce(result.status === "waiting_review" ? t("status-review") : t("review-saved")); } catch (error) { announce(error.message, true); } }
function resizeComposer() { const input = $("query"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 132)}px`; }
function renderScheduleOptions() { const kind = $("schedule-kind").value; const options = $("schedule-options"); $("schedule-time").hidden = kind === "interval"; $("schedule-time").required = kind !== "interval"; if (kind === "interval") { options.innerHTML = `<label>每隔</label><input id="schedule-interval-value" type="number" min="1" max="10080" value="30" aria-label="间隔时长"/><select id="schedule-interval-unit" aria-label="间隔单位"><option value="1">分钟</option><option value="60">小时</option></select><span class="schedule-cron-help">按固定间隔触发，例如每隔 5 分钟；首次触发要等一个间隔，客户端关闭期间错过的不会补跑。</span>`; return; } if (kind === "weekly") { options.innerHTML = `<label>在这些日子执行：</label>${["日", "一", "二", "三", "四", "五", "六"].map((day, index) => `<label><input type="checkbox" name="schedule-weekday" value="${index}" ${index === 1 ? "checked" : ""}/>周${day}</label>`).join("")}`; return; } if (kind === "monthly") { options.innerHTML = `<label>每月 <input id="schedule-day" type="number" min="1" max="31" value="1"/> 日</label>`; return; } if (kind === "yearly") { options.innerHTML = `<label>每年 <select id="schedule-month">${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1} 月</option>`).join("")}</select><input id="schedule-day" type="number" min="1" max="31" value="1"/> 日</label>`; return; } options.innerHTML = `<span class="schedule-cron-help">每天在所选时间触发；如果客户端稍后启动，当天会补触发一次。</span>`; }
function openSchedules() { notifyDesktopNavigation("schedules"); $("schedule-modal").setAttribute("aria-hidden", "false"); renderScheduleOptions(); $("schedule-query").focus(); }
function focusComposerIfVisible() {
  setTimeout(() => {
    const settingsOpen = $("settings-modal").getAttribute("aria-hidden") === "false";
    const schedulesOpen = $("schedule-modal").getAttribute("aria-hidden") === "false";
    if (!settingsOpen && !schedulesOpen && !document.body.classList.contains("sidebar-open")) $("query").focus();
  }, 40);
}
function closeSchedules() { $("schedule-modal").setAttribute("aria-hidden", "true"); notifyDesktopNavigation("conversation"); focusComposerIfVisible(); }
function selectSettingsSection(section, forceReset = false) { const changed = forceReset || state.settingsSection !== section; state.settingsSection = section; document.querySelectorAll("[data-settings-section]").forEach((button) => button.setAttribute("aria-current", String(button.dataset.settingsSection === section))); document.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== section; }); if (changed) { const content = document.querySelector(".settings-content"); if (content) content.scrollTop = 0; } notifyDesktopNavigation(section === "agents" ? "agents" : section === "memory" ? "memory" : "settings"); if (section === "agents" && !state.gatewayLoading) void refreshGateways(); }
function openSettings() { selectSettingsSection(state.settingsSection); $("settings-modal").setAttribute("aria-hidden", "false"); }
function closeSettings() { $("settings-modal").setAttribute("aria-hidden", "true"); notifyDesktopNavigation("conversation"); focusComposerIfVisible(); }
async function createSchedule(query) { const button = $("schedule-create"); const kind = $("schedule-kind").value; const body = { query, kind, time: $("schedule-time").value }; if (kind === "weekly") body.weekdays = [...document.querySelectorAll('input[name="schedule-weekday"]:checked')].map((input) => Number(input.value)); if (kind === "monthly" || kind === "yearly") body.dayOfMonth = Number($("schedule-day").value); if (kind === "yearly") body.month = Number($("schedule-month").value); if (kind === "interval") body.intervalMinutes = Math.max(1, Math.floor(Number($("schedule-interval-value").value) || 0)) * Number($("schedule-interval-unit").value); button.disabled = true; try { await api("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); $("schedule-query").value = ""; await refresh(); announce("定时任务已保存到本地运行时。"); } catch (error) { announce(error.message, true); } finally { button.disabled = false; } }
async function setScheduleEnabled(id, enabled) { try { await api(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }); await refresh(); announce(enabled ? "定时任务已启用。" : "定时任务已暂停。"); } catch (error) { announce(error.message, true); } }
async function resolveScheduleOccurrence(id, resolution) { const message = resolution === "retry" ? t("schedule-retry-confirm") : t("schedule-dismiss-confirm"); if (!(await confirmDialog(message, t("confirm")))) return; try { await api(`/api/schedules/occurrences/${encodeURIComponent(id)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution }) }); await refresh(); announce(t("schedule-resolved")); } catch (error) { announce(error.message, true); } }
async function resolveReportDelivery(day, resolution) { const message = resolution === "retry" ? t("report-retry-confirm") : t("report-dismiss-confirm"); if (!(await confirmDialog(message, t("confirm")))) return; try { await api(`/api/reporting/deliveries/${encodeURIComponent(day)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution, confirmChecked: true }) }); await refresh(); announce(t("schedule-resolved")); } catch (error) { await refresh(); announce(error.message, true); } }
async function updateAgent(id, update, message) { try { await api(`/api/settings/agents/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(update) }); await refresh(); announce(message); } catch (error) { announce(error.message, true); await refresh(); } }
async function setAgentEnabled(id, enabled) { const agent = state.settings?.agents.find((candidate) => candidate.id === id); await updateAgent(id, { enabled }, agent ? `${agent.title}${enabled ? "已启用" : "已关闭"}。` : "Agent 设置已更新。"); }
async function setAgentProvider(id, providerId) { const agent = state.settings?.agents.find((candidate) => candidate.id === id); await updateAgent(id, { providerId }, agent ? `${agent.title} 已绑定到 ${providerLabel(providerId)}。` : "Agent Provider 已更新。"); }
async function installProvider(id) { if (!(await confirmDialog(t("install-warning"), t("install")))) return; const button = document.querySelector(`[data-install-provider="${CSS.escape(id)}"]`); if (button) button.disabled = true; try { await api(`/api/agents/${encodeURIComponent(id)}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acknowledgeGlobalInstall: true }) }); await refresh(); announce(`${providerLabel(id)} 已安装并完成检测。`); } catch (error) { if (button) button.disabled = false; announce(error.message, true); } }
/** Pin the reasoning effort of one worker CLI; the gateway reports which levels its model offers. 固定某个 worker CLI 的推理强度；网关会报告其模型支持的档位。 */
async function setProviderEffort(id, effort) {
  try {
    const current = await api("/api/settings/providers");
    const provider = current.providers.find((item) => item.id === id);
    if (!provider) throw new Error("Provider not found.");
    const next = { ...provider };
    if (effort) next.effort = effort; else delete next.effort;
    await api("/api/settings/providers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    await refresh({ preserveScroll: true });
    announce(t("effort-saved"));
  } catch (error) { announce(error.message, true); }
}

async function setProviderHostAccess(id, allow) { if (allow && !(await confirmDialog(t("worker-allow-warning"), t("worker-allow")))) return; try { const current = await api("/api/settings/providers"); const provider = current.providers.find((item) => item.id === id); if (!provider) throw new Error("Provider not found."); const next = { ...provider }; if (allow) { next.hostAccess = "unrestricted"; next.acknowledgeUnrestrictedHostAccess = true; } else delete next.hostAccess; await api("/api/settings/providers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }); await refresh(); announce(t("worker-access-saved")); } catch (error) { announce(error.message, true); } }
async function installMissingProviders() { if (!(await confirmDialog(t("install-warning"), t("install")))) return; const button = document.querySelector("[data-install-missing]"); if (button) { button.disabled = true; button.querySelector("span").textContent = t("installing"); } try { const result = await api("/api/agents/install-missing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acknowledgeGlobalInstall: true }) }); state.signatures.agentPage = ""; await refresh(); announce(result.installed.length ? `已自动安装 ${result.installed.length} 个 Provider。` : "没有可自动安装的缺失 Provider。"); } catch (error) { announce(error.message, true); await refresh(); } }
async function searchMemories(query) { try { const result = await api(`/api/memory/governed/recall?q=${encodeURIComponent(query)}`); renderMemorySearch(result.matches || []); } catch (error) { announce(error.message, true); } }
function confirmDialog(message, okLabel) { return new Promise((resolve) => { const modal = $("confirm-modal"); $("confirm-message").textContent = message; const ok = $("confirm-ok"); ok.textContent = okLabel || "确认"; modal.setAttribute("aria-hidden", "false"); const done = (result) => { modal.setAttribute("aria-hidden", "true"); ok.onclick = $("confirm-cancel").onclick = modal.onclick = null; resolve(result); }; ok.onclick = () => done(true); $("confirm-cancel").onclick = () => done(false); modal.onclick = (event) => { if (event.target === modal) done(false); }; }); }
async function restoreConversation(id) {
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
    await refresh({ preserveScroll: false });
    announce("对话及其子任务已恢复。");
  } catch (error) { announce(error.message, true); }
}

async function deleteSession(id) { const session = (state.dashboard?.sessions || []).find((item) => item.id === id); const message = id === "main-agent-conversation" ? `隐藏这个对话？它的 ${session?.childCount || 0} 个子任务会一起隐藏。审计日志、记忆和备份不受影响，随时可以恢复。` : session?.parentId ? "隐藏这条子任务？审计记录会保留。父对话不受影响。" : "从会话列表隐藏这条任务？这不会删除本机审计日志、记忆或备份。"; if (!(await confirmDialog(message, "隐藏"))) return; try { await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }); state.scrollPositions.delete(id); state.openDisclosures.delete(id); state.disclosureScrollPositions.delete(id); if (state.selectedId === id) { state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); } await refresh({ preserveScroll: false }); announce("会话已从列表隐藏；数据仍然保留。"); } catch (error) { announce(error.message, true); } }
$("session-list").addEventListener("click", (event) => { const restore = event.target.closest("[data-restore-conversation]"); if (restore) { void restoreConversation(restore.dataset.restoreConversation); return; } const remove = event.target.closest("[data-delete-session]"); if (remove) { void deleteSession(remove.dataset.deleteSession); return; } const button = event.target.closest("[data-session]"); if (button) { closeSchedules(); closeSettings(); setSidebarOpen(false); void selectSession(button.dataset.session); } });
$("conversation-inner").addEventListener("click", (event) => { const suggestion = event.target.closest("[data-suggestion]"); if (suggestion) { $("query").value = suggestion.dataset.suggestion; resizeComposer(); $("query").focus(); } const agentSettings = event.target.closest("[data-open-agent-settings]"); if (agentSettings) { notifyDesktopNavigation("agents"); openSettings(); selectSettingsSection("agents"); return; } const approval = event.target.closest("[data-approve]"); if (approval) void approve(approval.dataset.approve); const rejection = event.target.closest("[data-reject]"); if (rejection) void reject(rejection.dataset.reject); const review = event.target.closest("[data-review]"); if (review) void reviewResult(review.dataset.review, review.dataset.reviewDecision); const copyButton = event.target.closest("[data-copy-code]"); if (copyButton) { const code = copyButton.parentElement?.querySelector("code"); if (code) void navigator.clipboard.writeText(code.textContent || "").then(() => { copyButton.textContent = "已复制"; setTimeout(() => { copyButton.textContent = "复制"; }, 1500); }).catch(() => announce("复制失败，请手动选中代码复制。", true)); } const expand = event.target.closest("[data-expand]"); if (expand) { const text = expand.parentElement?.querySelector(".clone-text"); if (text) { const collapsed = text.classList.toggle("collapsed"); expand.textContent = collapsed ? "展开全部" : "收起"; } } });
$("conversation-inner").addEventListener("toggle", rememberDisclosure, true);
$("conversation-inner").addEventListener("scroll", rememberDisclosureScroll, true);
$("config-workspace-choose").addEventListener("click", () => void chooseWorkspace());
$("config-workspace-reveal").addEventListener("click", revealWorkspace);
$("config-main-agent-model-save").addEventListener("click", () => void saveMainAgentModel());
$("config-main-agent-effort-save").addEventListener("click", () => void saveMainAgentEffort());
document.addEventListener("change", (event) => { const select = event.target instanceof Element && event.target.closest("[data-provider-effort]"); if (select && select.value !== undefined) void setProviderEffort(select.dataset.providerEffort, select.value); });
$("config-locale")?.addEventListener("change", () => void saveLocale());
$("connector-add").addEventListener("click", () => void addConnector());
$("connector-list").addEventListener("click", (event) => { const remove = event.target.closest("[data-connector-remove]"); if (remove) void removeConnector(remove.dataset.connectorRemove); });
$("connector-list").addEventListener("change", (event) => { const toggle = event.target.closest("[data-connector-toggle]"); if (toggle) void setConnectorEnabled(toggle.dataset.connectorToggle, toggle.checked); });
$("schedule-open").addEventListener("click", openSchedules);
$("mobile-open").addEventListener("click", openMobileBinding);
$("schedule-close").addEventListener("click", closeSchedules);
function setSidebarOpen(open) { document.body.classList.toggle("sidebar-open", open); }
$("menu-open").addEventListener("click", () => setSidebarOpen(true));
$("sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
$("settings-close").addEventListener("click", closeSettings);
$("settings-modal").addEventListener("click", (event) => { const button = event.target.closest("[data-settings-section]"); if (button) selectSettingsSection(button.dataset.settingsSection); });
$("whatsapp-binding-form").addEventListener("submit", (event) => { event.preventDefault(); void saveWhatsAppBinding(); });
$("whatsapp-binding-form").addEventListener("input", () => { state.whatsappDirty = true; });
$("whatsapp-verify").addEventListener("click", () => void verifyWhatsAppBinding());
$("whatsapp-stop-bridge").addEventListener("click", () => void stopWhatsAppBridge());
$("whatsapp-generate-token").addEventListener("click", generateWhatsAppVerifyToken);
$("whatsapp-copy-token").addEventListener("click", () => void copyText($("whatsapp-verify-token").value, "Verify Token 已复制。"));
$("whatsapp-start-tunnel").addEventListener("click", () => void startWhatsAppTunnel());
$("whatsapp-stop-tunnel").addEventListener("click", () => void stopWhatsAppTunnel());
$("whatsapp-install-cloudflared").addEventListener("click", () => void installCloudflared());
$("whatsapp-copy-webhook").addEventListener("click", () => void copyText(state.whatsapp?.tunnel?.webhookUrl || "", "Webhook 地址已复制。"));
$("whatsapp-open-meta").addEventListener("click", openMetaDeveloperConsole);
$("schedule-form").addEventListener("submit", (event) => { event.preventDefault(); void createSchedule($("schedule-query").value.trim()); });
$("schedule-kind").addEventListener("change", renderScheduleOptions);
$("schedule-list").addEventListener("click", (event) => { const report = event.target.closest("[data-report-day]"); if (report) { void resolveReportDelivery(report.dataset.reportDay, report.dataset.resolution); return; } const occurrence = event.target.closest("[data-schedule-occurrence]"); if (occurrence) { void resolveScheduleOccurrence(occurrence.dataset.scheduleOccurrence, occurrence.dataset.resolution); return; } const button = event.target.closest("[data-schedule-toggle]"); if (button) void setScheduleEnabled(button.dataset.scheduleToggle, button.dataset.scheduleEnabled === "true"); });
$("agent-page").addEventListener("change", (event) => { const target = event.target; const toggle = target.closest("[data-agent-toggle]"); if (toggle) { void setAgentEnabled(toggle.dataset.agentToggle, toggle.checked); return; } const provider = target.closest("[data-agent-provider]"); if (provider) void setAgentProvider(provider.dataset.agentProvider, provider.value); });
$("agent-page").addEventListener("click", (event) => {
  const refresh = event.target.closest("[data-settings-refresh], [data-gateway-refresh]");
  if (refresh) { void refreshGateways({ announceFailure: true }); return; }
  const applyGateway = event.target.closest("[data-gateway-apply]");
  if (applyGateway) { void useGatewayModel(); return; }
  const clearGateway = event.target.closest("[data-gateway-clear]");
  if (clearGateway) { void clearGatewayModel(); return; }
  const access = event.target.closest("[data-provider-access]");
  if (access) { void setProviderHostAccess(access.dataset.providerAccess, access.dataset.allow === "true"); return; }
  const install = event.target.closest("[data-install-provider]");
  if (install) { void installProvider(install.dataset.installProvider); return; }
  const installMissing = event.target.closest("[data-install-missing]");
  if (installMissing) { void installMissingProviders(); }
});
$("audit-session-list").addEventListener("click", (event) => { const button = event.target.closest("[data-open-audit-run]"); if (button) { closeSettings(); void selectSession(button.dataset.openAuditRun); } });
$("memory-candidates").addEventListener("click", (event) => { const promote = event.target.closest("[data-promote-candidate]"); if (promote) { void decideCandidate(promote.dataset.promoteCandidate, "promote"); return; } const reject = event.target.closest("[data-reject-candidate]"); if (reject) void decideCandidate(reject.dataset.rejectCandidate, "reject"); });
$("library-list").addEventListener("click", (event) => { const conflict = event.target.closest("[data-memory-conflict]"); if (conflict) { void keepMemoryFile(conflict.dataset.memoryConflict); return; } const save = event.target.closest("[data-save-library]"); if (save) { void saveLibraryMemory(save.dataset.saveLibrary); return; } const source = event.target.closest("[data-open-memory-source]"); if (source) { closeSettings(); void selectSession(source.dataset.openMemorySource); } });
$("library-create").addEventListener("click", () => void createLibraryMemory());
$("opportunity-strip").addEventListener("click", (event) => { const settings = event.target.closest("[data-open-failure-settings]"); if (settings) { notifyDesktopNavigation("agents"); openSettings(); selectSettingsSection("agents"); return; } const accept = event.target.closest("[data-accept-opportunity]"); if (accept) { void decideOpportunity(accept.dataset.acceptOpportunity, "accept"); return; } const dismiss = event.target.closest("[data-dismiss-opportunity]"); if (dismiss) void decideOpportunity(dismiss.dataset.dismissOpportunity, "dismiss"); });
$("context-search-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("context-search-query").value.trim(); if (query.length === 0) { announce("请输入内容来搜索历史。", true); return; } void searchContextHistory(query); });
$("memory-search-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("memory-search-query").value.trim(); if (query.length === 0) { announce("请输入内容来测试检索。", true); return; } void searchMemories(query); });
$("new-session").addEventListener("click", () => { state.sessionEpoch += 1; notifyDesktopNavigation("conversation"); closeSchedules(); closeSettings(); setSidebarOpen(false); rememberCurrentScroll(); if (state.selectedId) state.drafts.set(state.selectedId, $("query").value); state.composingNew = true; $("query").value = ""; resizeComposer(); state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); renderSessions(state.dashboard?.sessions || []); renderSession(null); $("query").focus(); });
$("request-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("query").value.trim(); if (query.length === 0) { announce("请输入你想推进的事情。", true); return; } void createSession(query); });
$("query").addEventListener("input", resizeComposer);
$("query").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("request-form").requestSubmit(); } });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { setSidebarOpen(false); closeSchedules(); closeSettings(); } });
function updateScrollBottom() { const viewport = $("conversation"); const far = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 160; $("scroll-bottom").classList.toggle("visible", far); }
$("conversation").addEventListener("scroll", rememberCurrentScroll, { passive: true });
$("conversation").addEventListener("scroll", updateScrollBottom, { passive: true });
$("scroll-bottom").addEventListener("click", () => { const viewport = $("conversation"); viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" }); });
$("sidebar-resizer").addEventListener("pointerdown", (event) => { sidebarResizeActive = true; document.body.classList.add("sidebar-resizing"); event.currentTarget.setPointerCapture(event.pointerId); applySidebarWidth(event.clientX); });
$("sidebar-resizer").addEventListener("pointermove", (event) => { if (sidebarResizeActive) applySidebarWidth(event.clientX); });
$("sidebar-resizer").addEventListener("pointerup", (event) => { sidebarResizeActive = false; document.body.classList.remove("sidebar-resizing"); event.currentTarget.releasePointerCapture(event.pointerId); });
$("sidebar-resizer").addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const current = Number($("sidebar-resizer").getAttribute("aria-valuenow")); applySidebarWidth(current + (event.key === "ArrowRight" ? 16 : -16)); });
window.addEventListener("resize", () => applySidebarWidth(Number($("sidebar-resizer").getAttribute("aria-valuenow")), false));
restoreSidebarWidth();
window.closeSchedules = closeSchedules;
window.closeSettings = closeSettings;
window.openSchedules = openSchedules;
window.openSettings = openSettings;
window.openMobileBinding = openMobileBinding;
window.selectSettingsSection = selectSettingsSection;
window.setSidebarOpen = setSidebarOpen;
window.cloneMarkdownForPreview = richText;
notifyDesktopNavigation("ready");
if (location.protocol === "http:" || location.protocol === "https:") { void refresh({ preserveScroll: false }); state.refreshTimer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000); }
