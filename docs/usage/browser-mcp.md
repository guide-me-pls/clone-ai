# Local browser verification (Playwright MCP)

[简体中文](browser-mcp.zh-CN.md)

clone-ai's native worker has four file tools. That is enough to write a page, and
not enough to know whether it runs. This page adds a **local, owner-enabled
browser** as an MCP tool source, so a worker can open the page it just wrote,
read the console, assert state, and hand the owner a screenshot.

It is Playwright MCP (`@playwright/mcp`, Microsoft) underneath. clone-ai does not
ship or modify that server; it ships the policy around it.

## What the worker gets

| Tool | Risk | Purpose |
| --- | --- | --- |
| `playwright.browser_navigate` | read | Open `http://127.0.0.1:<port>/` |
| `playwright.browser_console_messages` | read | Read errors/warnings after a change |
| `playwright.browser_snapshot` | read | Accessibility snapshot (DOM/menus) |
| `playwright.browser_evaluate` | write | Read game/DOM state, assert values |
| `playwright.browser_press_key` | write | Press one key (menus, simple controls) |
| `playwright.browser_take_screenshot` | write | Save a PNG under the workspace |
| `playwright.browser_resize` | write | 1280×720 / 1920×1080 layout checks |
| `playwright.browser_wait_for` | read | Wait for text or a short time |
| `playwright.browser_navigate_back` | read | Back in history |
| `playwright.browser_close` | read | Close the page |

`browser_run_code_unsafe`, file upload and drag/drop are **not declared**; the
worker cannot see them even though the server offers them.

The worker cannot see an image. The screenshot exists for the owner; the worker
must verify with `browser_evaluate` assertions and console errors.

## Install

```bash
node --experimental-strip-types scripts/install-browser-mcp.mjs \
  --workspace /path/to/project \
  --port 8135
```

This writes two files in the clone home (default `~/.clone`):

- `mcp.json`: an enabled `playwright` server, rooted at the workspace, with the
  tools above declared and risk-classified;
- `policies.json`: one narrow standing policy for `network read 127.0.0.1`.

Then start the read-only preview server in another terminal:

```bash
node scripts/serve-workspace.mjs --root /path/to/project --port 8135
```

Restart the runtime so the worker builds its tool list from the new `mcp.json`.
The server only serves files under `--root`, binds `127.0.0.1`, supports GET/HEAD,
and sets the MIME types ES modules need.

Requirements: Node 24+, Google Chrome installed, and `npx` available. The first
launch downloads `@playwright/mcp@0.0.85`; later launches use the npx cache. The
browser uses the installed Chrome channel, so no Chromium download is needed.

## Use it in a task

A workspace instruction is enough; the user prompt stays short:

```markdown
## Local browser verification
A read-only static server serves this workspace at http://127.0.0.1:8135/.
After editing a page, navigate once, check console errors, assert the important
state with browser_evaluate, and take one screenshot for the owner.
```

A one-line request such as "把方块改成绿色，写完自己用浏览器验收" is then enough:
the Main Agent plans the edit, and the worker can actually check it.

## Safety boundary

- The browser is **headless**, **isolated**, and rooted at the workspace.
- The declared origin is the local preview server. Other hosts are out of the
  tool's stated purpose; the server is configured with `--allowed-origins` but,
  as Playwright documents, that flag is not a security boundary.
- `browser_navigate` is declared **read** because it is a local observation of
  the owner's own preview. This deliberately does not require a network scope
  for a read-only step. `browser_evaluate` and screenshots are **write** because
  they change page state or create files.
- The browser child process is started by the worker's MCP client and is closed
  when the step ends. It is not an OS sandbox; the tool declaration and the
  workspace root are the boundary.
- Only enable it for a development workspace you are willing to let a browser
  read. Do not point `--workspace` at a directory holding credentials.
- First launch needs network for `npx`; after that the server is local.

## Uninstall

Set `"enabled": false` for the `playwright` server in `mcp.json`, or remove the
entry. Remove the `browser-mcp-local-observation` policy from `policies.json` if
you no longer want the localhost grant. Restart the runtime.

## Status

Wiring and declaration are covered by `test/browser-mcp.test.ts`. The end-to-end
run (worker actually navigating, reading console, asserting state, and saving a
screenshot) is recorded in
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) under
2026-11-17 — Local browser verification via Playwright MCP.
