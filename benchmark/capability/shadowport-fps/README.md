# Shadowport one-query FPS benchmark

**English** · [简体中文](README.zh-CN.md)

Measures one thing: can a **single user message** produce a playable tactical
FPS from a **clean workspace**, and can the agent verify it with a browser instead
of asking the owner to check? It is a capability benchmark, not a graphics
contest; the model is allowed to choose its own scene, mechanics and art.

## The prompt

[`prompt.md`](prompt.md) is the entire user message. It is one paragraph. The
benchmark exists to keep it that way: quality comes from the harness (browser
tools, preview server, budget discipline, verification contract), not from a
longer prompt.

## Workspace contract

[`setup.mjs`](setup.mjs) prepares a clean workspace:

- `index.html` — a minimal classic-script page with a canvas;
- `game.js` — an empty file;
- `vendor/three.iife.js` — Three.js r170 built as a global `THREE`;
- `AGENTS.md` — [`workspace-AGENTS.md`](workspace-AGENTS.md), with the preview
  port substituted.

The rules require classic scripts (no ES modules, no CDN), a local preview
server, and a small public test hook:

```js
window.__game = { state, player, enemies, relays, begin, pause, resume, fire, reload, interact, nearTarget, endGame };
```

`state.phase` moves `menu` → `playing` → `ended`; `player.position` is a
`THREE.Vector3`; `relays` has three entries with `position`/`cut`; `enemies`
have `position`/`health`/`alive`; `state.extraction` is `{x, z}`.

The hook is part of the task, not a test-only afterthought: a game the checker
cannot inspect cannot be scored.

## Prepare

```bash
node benchmark/capability/shadowport-fps/setup.mjs \
  --workspace /tmp/shadowport-clean \
  --three /path/to/three.module.js \
  --port 8138
```

`setup.mjs` uses `esbuild` (the repository devDependency) to build the IIFE. It
does not write any game code.

## Run

```bash
# 1. Local preview server (read-only, loopback)
node scripts/serve-workspace.mjs --root /tmp/shadowport-clean --port 8138

# 2. Install the browser MCP into an isolated clone home
node --experimental-strip-types scripts/install-browser-mcp.mjs \
  --workspace /tmp/shadowport-clean --clone-home /tmp/shadowport-home --port 8138

# 3. One user message
CLONE_AI_MAIN_EFFORT=medium node --experimental-strip-types eval-runs/2026-11-17-browser-mcp/run.mjs \
  /tmp/shadowport-clean /tmp/shadowport-home \
  benchmark/capability/shadowport-fps/prompt.md
```

The Main Agent must queue the build with `propose_work_plan` (a long build does
not hold the chat turn), and the worker must use the `playwright.*` tools to
check console/state and save a screenshot. Run metadata: provider
`openai/gpt-6.1-terra`, worker effort `high`, `MAX_ROUNDS=60`,
`MAX_TOKENS=24000`, work-order duration 600 s.

## Check

```bash
node benchmark/capability/shadowport-fps/verify/check-shadowport.mjs \
  --workspace /tmp/shadowport-clean \
  --out benchmark/capability/shadowport-fps/verify/out \
  --port 8140
```

The checker starts its own static server, drives the hook, and writes
`report.json` / `report.txt` / `shadowport.png`. It does not trust the
workspace's own report.

17 checks, all must pass:

| Group | Checks |
| --- | --- |
| Files | `index.html`, `game.js`, `vendor/three.iife.js` |
| Runtime | no ES module entry; local Three |
| Hook | required `window.__game` keys |
| Start | phase `playing`, health/ammo, ≥5 enemies, 3 relays |
| Movement | `W` moves the player >0.2 m |
| Combat | a shot spends a round and removes enemy health |
| Mission | 3 relays cut; extraction ends the run; debrief visible |
| Hygiene | 0 console errors; 0 external requests |

## Baseline

See [`ANALYSIS.md`](ANALYSIS.md) for the measured run, its token/duration cost,
the exact checks, and the known limits. The short version: a clean one-paragraph
run produced a playable seven-enemy FPS with relays, extraction and a debrief;
the external checker passed 17/17. The first clean attempt's own browser check
hit a stale preview port; the second run uses the matching port and is the
self-verified baseline.

## Why this is a benchmark, not a demo

- The workspace starts empty; the model cannot lean on a previous version.
- The checker is independent of the worker's report and drives the public hook.
- The cost is recorded: a score without tokens and wall time is an anecdote.
- The prompt is one paragraph, so a win is a harness win, not a prompt win.
