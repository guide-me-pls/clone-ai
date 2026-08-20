# Local setup guide

**English** · [简体中文](local-setup.zh-CN.md)

How to run Clone AI on your own machine, on Windows and macOS. The runtime is
local-first: everything lives under your clone home, and no data leaves the
machine unless you configure an external integration.

## What you need

- Node.js 24+ (LTS). Clone AI runs on `node --experimental-strip-types`, so no
  build step is needed.
- At least one black-box worker CLI. Supported today: **Claude Code**, **Codex
  CLI**, **Pi**, **opencode**. Each is a launch recipe; nothing about Clone AI
  depends on which one you have.

## Install

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
npm install --ignore-scripts
npm run typecheck
npm test
```

## Start the companion (GUI + daemon)

```bash
npm run companion:debug
# then open http://127.0.0.1:4317 in a browser
```

The desktop shell (Tauri) is a packaged alternative; it builds the same daemon
as a sidecar. `npm run desktop:build` requires the Rust toolchain.

## Talk to the Main Agent from the CLI

```bash
npm run main -- "整理今天需要推进的事情"
npm run main -- "用 pi 调研这个项目的架构并写一份总结"
```

The Main Agent classifies intent, routes to a worker (your explicit choice
wins), and the Kernel validates everything before any process starts.

## Worker recipes (per platform)

Recipes live in `src/workers/providers.json` and can be overridden per user in
`<dataDirectory>/providers.json`. The `command` field is resolved automatically:
`claude.cmd` / `pi.cmd` shims are followed to their real executables, so no
shell and no manual paths are needed.

| Worker | Windows | macOS |
| --- | --- | --- |
| Claude Code | `claude.cmd` (npm global) | `claude` |
| Codex CLI | `codex.cmd` | `codex` |
| Pi | `pi.cmd` | `pi` |
| opencode | `opencode.cmd` | `opencode` |

Credential variables are allowlisted per recipe (`ANTHROPIC_*`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, …). Never put credential values into `providers.json` — only
variable names belong there.

## Where your data lives

| Item | Location |
| --- | --- |
| Clone home | `~/.clone-ai/` (user level) or `CLONE_AI_DATA_DIR` |
| Journal | `<dataDirectory>/journal.jsonl` (or SQLite with `CLONE_AI_JOURNAL=sqlite`) |
| Memory index | `<dataDirectory>/memory-index.db` + `memory/*.md` |
| Bad cases | `<dataDirectory>/reporting/bad-cases.md` |
| User provider overrides | `<dataDirectory>/providers.json` |
| Failure taxonomy | `<dataDirectory>/outcomes/failures.json` |

`~/.clone-ai` is the user-level home; a workspace keeps its own `.clone-ai/`
for legacy data until migration completes.

## Known platform notes

- **Windows**: `.cmd` shims are resolved automatically; process trees are
  terminated via `taskkill /T` on timeout so orphaned agent grandchildren never
  linger. Kill stale `claude.exe` processes before running tests if the suite
  hangs.
- **macOS**: POSIX process groups are used for termination; recipes use the
  bare command names.

## First-run checklist

1. `npm test` green.
2. `npm run main -- "你好"` returns a reply (Main Agent works).
3. One worker installed and visible in the GUI settings → Agent registry.
4. A real task completes end to end (see the reliability benchmark below).
5. Bad cases accumulate in `reporting/bad-cases.md` — this file is your
   optimization loop input.

## Reliability benchmark

```bash
npm run bench          # fixed task set against real pi (a few cents)
```

See [benchmark/README.md](../benchmark/README.md).
