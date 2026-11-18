# SHADOWPORT · 暗港 — benchmark workspace rules

## Build constraints

- This is a **classic-script** page. `vendor/three.iife.js` exposes a global `THREE`; do not use ES module imports.
- `index.html` loads `vendor/three.iife.js` and `game.js`. You may add more classic scripts and edit `index.html`.
- No external assets, no network requests, no CDN. Procedural geometry, canvas textures and WebAudio only.
- Target macOS and Windows GPUs: WebGL2, one directional shadow light, instanced/merged geometry, capped pixel ratio.

## Browser verification

A read-only static server serves this workspace at **http://127.0.0.1:__PORT__/**.

The `playwright.*` tools are available to workers:

- `browser_navigate` opens the preview URL.
- `browser_console_messages` returns console errors after a change.
- `browser_evaluate` runs one JS expression and returns JSON — use it to read `window.__game`, count scene objects, simulate a few frames, or assert that a control changed.
- `browser_take_screenshot` saves a PNG under the workspace.
- `browser_press_key` presses one key (released immediately); a held movement key needs `browser_evaluate`.

After writing or editing, navigate once, check console errors, assert the important state, and take one screenshot. Do not navigate to other hosts.

## Quality bar

- First frame in under 5 seconds locally; no uncaught console errors.
- Pointer lock on click; keyboard + mouse controls work; Escape pauses.
- The game has one complete objective loop and a debrief; death restarts.
- If the browser check fails, fix it and check again before reporting success.

## Verification contract

Expose a small test hook for the owner's checker:

```js
window.__game = { state, player, enemies, relays, begin, pause, resume, fire, reload, interact, nearTarget, endGame };
```

- `state.phase` moves through `menu` → `playing` → `ended`.
- `player.position` is a `THREE.Vector3`; `player.health` and `player.ammo` are numbers.
- `relays` has three entries, each with `position`, `cut`, and the page's interaction logic.
- `enemies` entries have `position`, `health` and `alive`.
- `state.extraction` is `{x, z}`.
- `begin()` starts a run; `interact()` cuts a relay when near one, and extracts after all three.

## Execution shape

This is a long build. Submit one self-contained step with `propose_work_plan` and return; do not use
`dispatch_task`, which waits inside the chat turn. The queued run executes the worker.
