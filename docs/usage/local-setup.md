# Local setup guide

**English** · [简体中文](local-setup.zh-CN.md)

Clone AI is a macOS desktop application. The window is served by a resident
local runtime (`src/desktop-sidecar.ts`) over loopback; the runtime owns the
journal, memory, scheduling, approvals and the Main Agent. Nothing leaves the
device unless you configure an external model or integration.

## 1. Requirements

- macOS (Apple Silicon or Intel), with Xcode Command Line Tools (`swiftc`,
  `codesign`).
- Node.js 24+ — the runtime runs TypeScript directly, with no build step.
- Git.

## 2. Build and launch

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
npm install --ignore-scripts
npm run desktop:mac:build
open "dist/Clone AI.app"
```

`npm run desktop:dev` builds the native shell on demand and launches the live
source; use it while changing the UI or the runtime.

## 3. The resident runtime

The window is not the runtime. Install the per-user LaunchAgent once:

```bash
node scripts/install-daemon.mjs            # installs and loads ai.clone.companion
node scripts/install-daemon.mjs --uninstall
```

After that the twin starts at login, restarts after a crash, and keeps running
when you close the window — the app attaches to the endpoint the daemon
publishes (`~/.clone/companion-endpoint.json`). Re-run the installer after a
node upgrade, because the plist pins an absolute node path.

## 4. Configure the model

Open **设置 → Agent**. Apply a model exposed by the local Magpie gateway, or set
the endpoint and key there. The key is write-only: after saving, the app shows
only that it is stored. `CLONE_AI_NATIVE_MODEL`, `CLONE_AI_NATIVE_BASE_URL` and
`CLONE_AI_NATIVE_API_KEY` remain available for development.

### Main Agent runtime

The native in-process runtime is the only Main Agent runtime. It writes the same
`main_agent.turn_*`, `agent.tool_*` and `usage.recorded` events, uses the turn
ledger as its transcript, and answers `search_history` from that ledger. It
streams tokens as they arrive and compacts a long transcript deterministically:
the newest turns stay verbatim within a 12,000-character budget, older turns
become a bounded summary, and the full text stays in the turn ledger. Image
attachments are sent as OpenAI-style data URLs in the current message; they are
per-turn and not stored in the ledger.

## 5. Owner controls in the app

- **对话** — ask, approve or reject an external action, and accept or reject a
  result that needs review.
- **设置 → 权限与安全** — per-domain autonomy and owner-written standing
  policies. Every change is journaled.
- **设置 → 记忆与数据** — the memory library, governed changes and undo, and
  **导出全部数据**: pick a folder and the runtime writes a timestamped archive
  (manifest + copied data) outside the clone home.
- **设置 → 上下文** — compactions and full-history search.
- **设置 → 手机通道** — WhatsApp binding and the public webhook tunnel.
- **设置 → 审计与评估** — runs, Main Agent turns, Agent invocations, bad cases,
  self-check rounds, improvement suggestions, and cancellation of an active run.

## 6. Workers

Clone AI has one execution provider: the in-process native worker. It is not a
CLI; every tool call is checked against the step's scopes at the moment it is
made, and its token usage is recorded exactly.

| Worker | How it runs | Set up |
| --- | --- | --- |
| Native worker | In-process loop against an OpenAI-compatible endpoint | Configure it in 设置 → Agent |

Black-box CLI workers (Claude Code, Codex, the Pi CLI, opencode) were removed.
A CLI hides its tool calls and credentials from the Kernel, so the harness can
neither audit nor gate them. The `external` role has no provider until a
governed action connector exists.

### Worker concurrency

The Kernel decides how many workers may run at once from measured machine
capacity: CPU cores, the 1-minute load average, and free memory. You do not
configure that, and neither does the Main Agent — it can only read it
(`get_capacity`) to size a plan.

To pin a ceiling yourself, set `maxConcurrentWorkers` in `config.json`. `0` or
unset means auto. The pin is capped at the core count, and it is re-read on
every dispatch, so a change applies without a restart.

## 7. Where your data lives

| Item | Location |
| --- | --- |
| Clone home | `~/.clone` (or `CLONE_AI_DATA_DIR`) |
| Journal | `<clone home>/journal.jsonl` (`CLONE_AI_JOURNAL=sqlite` for WAL) |
| Memory | `<clone home>/memory-index.db` + `<clone home>/memory/*.md` |
| Bad cases | `<clone home>/reporting/bad-cases.md` |
| Authority | `<clone home>/policies.json` |
| Failure taxonomy | `<clone home>/outcomes/failures.json` |
| Isolated workspaces | `<clone home>/isolated-workspaces/` |
| Owner export | The folder you choose in 设置 → 记忆与数据 |
| Env template | `.env.example` in the repo (names only, never secret values) |

## 8. Platform notes

- **macOS**: worker processes run in their own POSIX process group and are
  terminated as a group. The app requires Xcode Command Line Tools to build.
- **Windows**: the Tauri shell is still buildable with
  `npm run desktop:build`; `.cmd` shims are resolved to their real executables,
  and worker process trees are terminated with `taskkill /T` on timeout.

## 9. First-run checklist

1. `npm run desktop:mac:build` then `open "dist/Clone AI.app"` → the window opens.
2. 设置 → Agent: configure a model, then send one message → the Main Agent replies.
3. 审计与评估 → 运行记录 shows the run.
4. 设置 → 权限与安全: confirm every domain is `observe`; raise only what you need.
5. 设置 → 记忆与数据 → 导出全部数据: export once, inspect `manifest.json`, then
   move the folder somewhere you can keep.
6. 审计与评估 → 坏案例 starts accumulating failures — that file drives your
   optimization loop.

## 10. Maintenance entry points

These are automation scripts, not a product CLI. The desktop app remains the
owner interface.

```bash
npm run traces -- list | export | show <runId> | clear --yes
npm run selfcheck -- [--full] [--repair]
npm run repair -- [--dry-run] [--keep] [--max-traces N] [--agent <id>] [--base <ref>]
npm run audit:export -- [--out <file>]
npm run bench
```
