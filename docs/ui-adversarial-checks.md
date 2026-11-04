# Adversarial UI checks

Run these before shipping a UI change. They exist because every "weird" bug so
far came from a silent gap: an id the script expected and the markup no longer
had, a CSS `display` that beat the `hidden` attribute, a preview that carried
raw markdown into a one-line row, a list item whose trailing `<br>` produced an
empty line.

发布界面改动前跑这些检查。它们之所以存在，是因为到目前为止每个"莫名其妙"的问题都来自
一处静默的缺口：脚本期望的 id 在标记里已不存在、CSS 的 `display` 压过了 `hidden` 属性、
预览把原始 Markdown 带进单行、列表项尾部多余的 `<br>` 多出一整行。

## Automated (no browser)

```bash
npm test
```

`test/ui-structure.test.ts` fails when:

- `index.html` has duplicate ids;
- the scripts read an id that neither the markup nor a template defines;
- a referenced asset (`*.css`, `*.js`) is missing;
- a `data-i18n` key has no string in the locale table;
- the session row lacks `white-space: nowrap` / `text-overflow: ellipsis`;
- the trace text lacks `overflow-wrap: anywhere`;
- `[hidden]` is not forced to `display: none`.

`test/companion-control-plane.test.ts` also asserts that sidebar previews are
plain text and that a run trace is ordered and readable.

## Browser pass (preview tools)

With the daemon running against a seeded data directory, repeat at **1280×900,
1024×768, 390×844**:

1. Chat: send nothing; confirm the welcome and composer are one centred group.
2. Session list: one line per row; long title and markdown preview ellipsize.
3. Settings → Agent: every provider row keeps its effort select inside the row.
4. Settings → 记忆与数据: groups open, a row expands, its usage list wraps.
5. Settings → 审计与轨迹: a run's stage strip, timeline, and 完整轨迹 render;
   open 原始数据 on a trace item and confirm it wraps instead of stretching.
6. For each view record `document.documentElement.scrollWidth === innerWidth`
   and no element with `right > innerWidth + 2` (the off-canvas sidebar at
   mobile width is expected and excluded).
7. Stress: set a session title to a 400-character unbroken string and a preview
   to repeated markdown; no row may grow taller than one line.

## What is still manual

Screenshots need a human eye for taste, spacing and contrast; the checks above
only catch breakage. Dark mode is not implemented yet, so it is not checked.
截图仍需人眼判断观感、间距与对比度；上面的检查只负责发现"破"。目前没有暗色模式，故未检查。