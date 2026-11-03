(() => {
  const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[character]));

  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4.5"/>',
    shield: '<path d="M12 3 20 6v5c0 5-3.4 8.8-8 10-4.6-1.2-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    book: '<path d="M8 3h8a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z"/><path d="M8 9h8M8 13h5"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="M8 10h8M8 14h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    gateway: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2"/><path d="M18 13v2m0 4v2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="M10.3 3.8 2.4 18a2 2 0 0 0 1.8 3h15.6a2 2 0 0 0 1.8-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3M9 9h6v6H9z"/>',
    spark: '<path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 5l3 3M14 7l2 2"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
    arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
  };

  const icon = (name, className = "") => {
    const body = paths[name] ?? paths.spark;
    return `<svg class="c-icon${className ? ` ${escape(className)}` : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };

  const attributeString = (attributes = {}) => Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => value === true ? escape(name) : `${escape(name)}="${escape(value)}"`)
    .join(" ");

  const button = ({
    label,
    iconName,
    variant = "secondary",
    attributes = {},
    type = "button",
    disabled = false,
    className = "",
  }) => `<button class="c-button c-button--${escape(variant)}${className ? ` ${escape(className)}` : ""}" type="${escape(type)}"${disabled ? " disabled" : ""} ${attributeString(attributes)}>${iconName ? icon(iconName) : ""}<span>${escape(label)}</span></button>`;

  const iconButton = ({
    label,
    iconName,
    variant = "ghost",
    attributes = {},
    className = "",
  }) => `<button class="c-icon-button c-icon-button--${escape(variant)}${className ? ` ${escape(className)}` : ""}" type="button" aria-label="${escape(label)}" title="${escape(label)}" ${attributeString(attributes)}>${icon(iconName)}</button>`;

  const badge = (label, tone = "neutral", { dot = false, className = "" } = {}) => `<span class="c-badge c-badge--${escape(tone)}${className ? ` ${escape(className)}` : ""}">${dot ? '<span class="c-badge__dot" aria-hidden="true"></span>' : ""}${escape(label)}</span>`;

  const sectionHeader = ({ eyebrow, title, description, actions = "", className = "" }) => `<header class="c-page-header${className ? ` ${escape(className)}` : ""}"><div class="c-page-header__copy">${eyebrow ? `<span class="c-eyebrow">${escape(eyebrow)}</span>` : ""}<h2>${escape(title)}</h2>${description ? `<p>${escape(description)}</p>` : ""}</div>${actions ? `<div class="c-toolbar">${actions}</div>` : ""}</header>`;

  const card = ({ title, subtitle, body, actions = "", className = "", tone = "default" }) => `<section class="c-card c-card--${escape(tone)}${className ? ` ${escape(className)}` : ""}">${(title || subtitle || actions) ? `<header class="c-card__header"><div>${title ? `<h3>${escape(title)}</h3>` : ""}${subtitle ? `<p>${escape(subtitle)}</p>` : ""}</div>${actions ? `<div class="c-toolbar">${actions}</div>` : ""}</header>` : ""}<div class="c-card__body">${body}</div></section>`;

  const listRow = ({
    leading = "",
    title,
    description = "",
    meta = "",
    actions = "",
    className = "",
    tone = "default",
  }) => `<article class="c-list-row c-list-row--${escape(tone)}${className ? ` ${escape(className)}` : ""}">${leading ? `<div class="c-list-row__leading">${leading}</div>` : ""}<div class="c-list-row__copy"><div class="c-list-row__title">${escape(title)}</div>${description ? `<div class="c-list-row__description">${escape(description)}</div>` : ""}${meta ? `<div class="c-list-row__meta">${meta}</div>` : ""}</div>${actions ? `<div class="c-list-row__actions">${actions}</div>` : ""}</article>`;

  const field = ({ label, hint = "", control, className = "" }) => `<label class="c-field${className ? ` ${escape(className)}` : ""}"><span class="c-field__label">${escape(label)}</span>${control}${hint ? `<span class="c-field__hint">${escape(hint)}</span>` : ""}</label>`;

  const select = ({ options, value, attributes = {}, className = "" }) => `<select class="c-select${className ? ` ${escape(className)}` : ""}" ${attributeString(attributes)}>${options.map((option) => `<option value="${escape(option.value)}"${String(option.value) === String(value) ? " selected" : ""}${option.disabled ? " disabled" : ""}>${escape(option.label)}</option>`).join("")}</select>`;

  const switchControl = ({ checked, attributes = {}, label, disabled = false }) => `<label class="c-switch" title="${escape(label)}"><input type="checkbox" aria-label="${escape(label)}" ${checked ? "checked" : ""}${disabled ? " disabled" : ""} ${attributeString(attributes)}/><span class="c-switch__track" aria-hidden="true"></span></label>`;

  const segmented = ({ items, value, dataAttribute, label }) => `<div class="c-segmented" role="tablist" aria-label="${escape(label)}">${items.map((item) => `<button class="c-segmented__item" type="button" role="tab" aria-selected="${String(item.value === value)}" data-${escape(dataAttribute)}="${escape(item.value)}">${escape(item.label)}${item.count === undefined ? "" : `<span>${escape(item.count)}</span>`}</button>`).join("")}</div>`;

  const emptyState = ({ iconName = "spark", title, body = "", action = "" }) => `<div class="c-empty-state"><span class="c-empty-state__icon">${icon(iconName)}</span><strong>${escape(title)}</strong>${body ? `<p>${escape(body)}</p>` : ""}${action}</div>`;

  const stat = ({ label, value, detail = "", tone = "default" }) => `<div class="c-stat c-stat--${escape(tone)}"><span>${escape(label)}</span><strong>${escape(value)}</strong>${detail ? `<small>${escape(detail)}</small>` : ""}</div>`;

  const providerMark = (label, id = "") => {
    const source = String(label || id);
    const letters = source.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "A";
    return `<span class="c-provider-mark c-provider-mark--${escape(id || letters.toLowerCase())}" aria-hidden="true">${escape(letters)}</span>`;
  };

  window.CloneUI = Object.freeze({
    attr: attributeString,
    badge,
    button,
    card,
    emptyState,
    escape,
    field,
    icon,
    iconButton,
    listRow,
    providerMark,
    sectionHeader,
    segmented,
    select,
    stat,
    switchControl,
  });
})();
