# Local setup guide

**English** · [简体中文](local-setup.zh-CN.md)

Clone AI runs on your machine as a normal command-line tool, next to the other
coding agents you already have. Nothing leaves the device unless you configure
an external integration.

## 1. Install

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
npm install --ignore-scripts
npm link          # makes `clone-ai` available everywhere (npm i -g . also works)
```

Requirements: **Node.js 24+** (it runs TypeScript directly, no build step).

Verify:

```bash
clone-ai --version
clone-ai doctor
```

`doctor` prints your clone home, Node version, and which worker CLIs are
installed.

## 2. Use it

```bash
clone-ai "读一下 README 并总结三点"        # talk to the Main Agent
clone-ai "用 pi 调研这个项目并写份笔记"      # explicitly choose a worker
clone-ai app                              # open the native desktop app
clone-ai status                           # runs, workers, memory, bad cases
clone-ai workers                          # which worker CLIs are installed
clone-ai install codex-cli                # install a missing worker
clone-ai memory "发布流程"                  # search reviewed memories
clone-ai cases                            # the local bad-case log
clone-ai opportunities                    # open opportunity cards
clone-ai bench                            # reliability benchmark
```

The default subcommand is a conversation: `clone-ai "<request>"` behaves like
`pi "..."` or `claude -p "..."`, except the Main Agent routes the work to a
worker and the Kernel verifies the result.

## 3. The desktop app

```bash
clone-ai app                # open dist/Clone AI.app or /Applications/Clone AI.app
```

`clone-ai app` opens the built native application bundle. It never starts a
browser tab or a Chromium app window. Build the macOS application first with
`npm run desktop:mac:build`; the app owns its local runtime and uses the
persistent close/Quit behavior described in the desktop client README.

There is no separate download. If you want a single-file native executable
instead, the Tauri shell is optional and requires the Rust toolchain:

```bash
npm run desktop:build
# then run apps/desktop/src-tauri/target/.../clone-ai-desktop.exe
```

## 4. Workers (the agent that does the work)

Clone AI has one execution provider: the in-process native worker. It is not a
CLI; every tool call is checked against the step's scopes at the moment it is
made, and its token usage is recorded exactly.

| Worker | How it runs | Set up |
| --- | --- | --- |
| Native worker | In-process loop against an OpenAI-compatible endpoint | `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` |

Black-box CLI workers (Claude Code, Codex, the Pi CLI, opencode) were removed.
A CLI hides its tool calls and credentials from the Kernel, so the harness can
neither audit nor gate them. The `external` role has no provider until a
governed action connector exists; it is not routed to a CLI.

### Main Agent runtime

The native in-process runtime is the only Main Agent runtime. It needs
`CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL`; without them a turn fails
with a message naming the missing variables. The Pi runtime and its SDK are no
longer part of the product. To configure the runtime:

```bash
export CLONE_AI_NATIVE_MODEL=<model-id>
export CLONE_AI_NATIVE_BASE_URL=<openai-compatible-url>
export CLONE_AI_NATIVE_API_KEY=<key>   # optional
clone-ai "你好"
```

The native loop writes the same `main_agent.turn_*`, `agent.tool_*` and
`usage.recorded` events, uses the turn ledger as its transcript, and answers
`search_history` from that ledger. It streams tokens as they arrive and compacts
a long transcript deterministically: the newest turns stay verbatim within a
12,000-character budget, older turns become a bounded summary, and the full text
stays in the turn ledger. Image attachments are sent as OpenAI-style data URLs
in the current message; they are per-turn and not stored in the ledger.

## 5. Where your data lives

| Item | Location |
| --- | --- |
| Clone home | `~/.clone` (or `CLONE_AI_DATA_DIR`) |
| Journal | `<clone home>/journal.jsonl` (`CLONE_AI_JOURNAL=sqlite` for WAL) |
| Memory | `<clone home>/memory-index.db` + `<clone home>/memory/*.md` |
| Bad cases | `<clone home>/reporting/bad-cases.md` |
| Provider overrides | `<clone home>/providers.json` |
| Failure taxonomy | `<clone home>/outcomes/failures.json` |
| Isolated workspaces | `<clone home>/isolated-workspaces/` |
| Env template | `.env.example` in the repo (names only, never secret values) |

## 6. Platform notes

- **Windows**: `.cmd` shims are resolved to their real executables (no shell, so
  prompts cannot be injected as arguments); worker process trees are terminated
  with `taskkill /T` on timeout, so no orphaned agent processes remain.
- **macOS**: workers run in their own POSIX process group and are terminated as
  a group. Recipes use bare command names.

## 7. First-run checklist

1. `clone-ai doctor` → at least one worker installed.
2. `clone-ai "你好"` → the Main Agent replies.
3. `clone-ai app` → the native desktop application opens.
4. Run a real task, then `clone-ai status` shows it.
5. `clone-ai cases` accumulates failures — that file drives your optimization.
