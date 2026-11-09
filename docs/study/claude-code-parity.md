# From Claude Code to Clone AI: a reverse-engineered parity plan

**English** · [简体中文](claude-code-parity.zh-CN.md)

This document answers one question: **what would it take for clone-ai's agent
framework to reach 95% of Claude Code's level?** It is based on a read-only
reverse engineering of Claude Code 2.1.317 and Claude Desktop 4.16336.0,
installed on the owner's machine, plus an audit of clone-ai's working tree on
2026-11-06.

The short answer: Claude Code's advantage is mostly **harness mechanics**, not a
secret model. clone-ai already has a stronger authority, verification, and
memory story than Claude Code. It is behind in the loop control plane, the
per-call tool surface, context engineering, extensibility, and desktop
feedback. Those are implementable, and this document gives the order and the
evals.

> This is an analysis and a plan, not a claim that parity is already achieved.
> The extracted source remains outside the repository; no proprietary source or
> prompt text is copied into clone-ai.

---

## 1. Method, artifacts, and what "95%" means

### 1.1 Artifacts

| Artifact | What was extracted | Evidence |
| --- | --- | --- |
| Claude Code 2.1.317 | 2,942 JavaScript modules from the Bun single-file executable's `__BUN` module graph | `cli` module: `// Version: 2.1.317`; module graph offsets and table |
| Claude Desktop 4.16336.0 | Electron main bundle (`app.asar`), renderer (`ion-dist.asar`), bundled skills, MCP servers, VM image | `package.json` (`@ant/desktop`, version 4.16336.0); SDK wrapper `0.3.317` |
| clone-ai working tree | Branch `codex/net-new`, 22 changed files, 2 untracked; `npm run gate` passes, `npm run typecheck` exits 0, `npm test` is 578/585 | audit report, `test.log` |

The extraction method is documented in the appendix. Every claim in this
document is anchored to a string constant, object key, or code path in those
artifacts; unverified reasoning is marked as an inference.

### 1.2 The 95% definition

**95% is a weighted harness-parity score, not identical model output.**

- 12 dimensions, weights sum to 100 (section 4).
- Each dimension is scored 0–100 against a maturity rubric with executable
  evidence. A dimension cannot claim a level it cannot prove.
- Overall parity requires **weighted score ≥ 95, every dimension ≥ 80**.
- Model quality is measured separately, on the same backbone model, and is
  never blended into the harness score. A weaker model must not be allowed to
  look like a harness failure, and a strong model must not hide one.
- The score is only valid with the eval suite in section 6; a checklist without
  a failing baseline is an opinion.

Why this definition: clone-ai supports arbitrary OpenAI-compatible endpoints,
so its model can be weaker or stronger than Claude Code's default. The harness
is the part clone-ai controls. Conflating the two would make the number
incomparable and easy to game.

---

## 2. What Claude Code actually is

### 2.1 The loop is a typed state machine

The query loop is an async generator that returns either the sentinel
`"next_round"` or a typed terminal object. It continues when the assistant
produced `tool_use` blocks, not because `stop_reason === "tool_use"`. Observed
terminal reasons include `completed`, `api_error`, `aborted_streaming`,
`aborted_tools`, `max_turns`, `stop_hook_prevented`, `hook_stopped`,
`blocking_limit`, `prompt_too_long`, `image_error`, `rapid_refill_breaker`, and
`malformed_tool_use_exhausted`.

This matters because every downstream feature — retries, fallback, telemetry,
budget reporting, UI — needs a reason. clone-ai's loop currently has one generic
error string.

### 2.2 Tools start during the stream, with a barrier for unsafe calls

Each tool declares `isConcurrencySafe(input)`. A safe tool can start while the
model is still streaming; a non-safe tool is a barrier: it waits for in-flight
tools, and later calls wait for it. Results are yielded in model call order,
not completion order. A schema parse failure downgrades a tool to serial. There
is no numeric parallelism cap in this path.

The canonical built-in tool set is 22 tools:

```text
Bash Read Write Edit Glob Grep NotebookEdit WebFetch WebSearch Task TodoWrite
TaskCreate TaskUpdate TaskGet TaskList TaskStop Skill REPL JavaScript
AskUserQuestion ToolSearch SendUserMessage
```

Plus deferred and specialized tools (`EnterPlanMode`, `ExitPlanMode`,
`Monitor`, `Workflow`, `CronCreate/List/Delete`, `ScheduleWakeup`, `TaskOutput`,
`EnterWorktree/ExitWorktree`, MCP resource tools, and others).

Tool definitions carry runtime-relevant metadata: `isConcurrencySafe`,
`isReadOnly`, `maxResultSizeChars`, `backgrounding`, `shouldDefer`,
`persistenceThresholdCeiling`, `strict`, `coerceInput`. Result ladders are part
of the tool contract: Bash spills to a file, Read defaults to 2,000 lines, Grep
caps at 20,000 characters, MCP output caps at 25,000 tokens.

### 2.3 Permission is decided per call, not per plan

Six modes form a ladder:

```text
plan < default = dontAsk < acceptEdits < auto < bypassPermissions
```

Rules use `Tool(pattern)` syntax (`Bash(git *)`, `Read(./src/**)`,
`Edit(...)`, `mcp__server__tool`). Deny wins; `ask` and `allow` follow. In
`auto`, a classifier decides allow/deny/ask per call. `bypassPermissions`
approves everything except explicit deny rules. A denied call is returned to
the model as a tool result and the turn continues.

The harness enforces the decision with `canUseTool` (or
`--permission-prompt-tool=stdio`). The Desktop wrapper uses the same path: the
CLI sends `can_use_tool` over a stream-json control channel, the app's
permission broker renders a card, and the app returns a correlated
`control_response`.

Implementation details worth copying, because they are where naive rule
engines fail:

- Rules are source-ordered: `userSettings`, `projectSettings`,
  `localSettings`, `flagSettings`, `policySettings`, then `cliArg`, `session`,
  `command`, `toolsNarrowing`, `mcpMount`, `mcpServerPolicy`, `hostCredential`.
  Deny is evaluated before ask/allow, and a weak-source deny still beats a
  strong-source allow.
- A hook `allow` cannot lift a deny (`Hook returned 'allow' … but deny rule
  overrides`); multiple hooks aggregate strictest-wins.
- `acceptEdits` is a narrow allowlist — `mkdir`, `touch`, `rm`, `rmdir`, `mv`,
  `cp`, `sed` — with argument-shape checks, not "edits are fine".
- `plan` mode forces a write floor: a non-read-only, non-exempt call becomes an
  ask with `plan mode holds the call`.
- Sandbox auto-allow is a conditional downgrade of ask→allow, only when the
  sandbox is actually running, the profile allows it, and the command is not a
  known-dangerous shape.
- Approval cards have integrity: an answer that changes a field the card showed
  is refused, and approvals may only add restrictions, never relax them.
- Unattended calls get an explicit "nobody answered; do not retry" policy
  instead of a retry storm.

### 2.4 Hooks are a 33-event extension surface

The event catalogue includes `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PostToolBatch`, `PermissionRequest`, `PermissionDenied`, `UserPromptSubmit`,
`UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`,
`SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PreModelSwitch`,
`PostModelSwitch`, `TaskCreated`, `TaskCompleted`, `Elicitation`,
`ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`,
`InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, and
`MessageDisplay`.

The contract is shell-friendly: JSON on stdin; exit 0 continues, exit 2 blocks
and feeds stderr to the model, any other exit shows stderr to the user and
continues; `hookSpecificOutput` can add context. Per-event timeouts are
enforced (tool hooks 15 s, prompt hooks 30 s, Stop/StopFailure/SubagentStop
120 s). A timed-out hook is skipped with a note, not allowed to hang the turn.
Kinds are `command` (shell or argv), `http`, `prompt`, and `callback`/SDK;
options include `if` (a rule matcher), `onFailure` (`continue`/`block`),
`async`, `asyncRewake`, `once`, and a timeout. Project hooks are themselves
sandboxed and pinned by script SHA-256, and they do not load until workspace
trust is accepted.

### 2.5 Context is engineered in three layers

1. **Prompt composer.** Static sections (`intro`, `system`, `doing_tasks`,
   `actions`, `tools`, `tone`) are separated from dynamic session sections by
   `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`. Cache scopes are derived from the
   boundary: static → global, identity → org, dynamic → org or null. The
   `__SYSTEM_PROMPT_STATIC_BREAKPOINT__` marker can split one static block into
   more cache segments. Section answers are memoized per session and
   invalidated by explicit events, so prompt diffs are explainable.
2. **Memory loader.** A managed `CLAUDE.md`, user `CLAUDE.md`, project walk
   (`CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md`),
   additional working directories, and auto-memory (`MEMORY.md`, 200 lines /
   25 KB index). `@import` expands depth 5, skips code spans, allows text
   extensions only, and caps reads at 4 MiB. Injection is labeled by trust
   class (managed, user, project, local, auto-memory), not silently merged.
3. **Window manager.** Token estimate, then:
   `effective = contextWindow - min(maxOutputTokens, 20000)`;
   `threshold = min(floor(effective * (1 - 0.2)), effective - 13000)`;
   warning at `threshold - 20000`; blocked at `effective - 3000`.
   Compaction writes a `compact_boundary` with
   `preservedMessages.uuids`, a nine-section summary, a kept tail, and restored
   attachments. Microcompaction clears old tool results (keep last 12 tool
   uses, only if it saves ≥ 20,000 tokens). Tool results have a ladder: inline →
   persist to file → middle-truncate → clear old results, with per-tool caps.

### 2.6 Extensibility is the product's on-ramp

- **MCP**: stdio, HTTP, streamable HTTP, SSE, WebSocket, SDK, IDE, and proxy
  transports; tools named `mcp__<server>__<tool>`; resources; OAuth; per-server
  timeouts; output cap 25,000 tokens.
- **Skills**: `skills/<name>/SKILL.md` with frontmatter (`name`,
  `description`, `allowed-tools`, `disable-model-invocation`, `user-invocable`,
  `paths`, `context`, `agent`, `hooks`, …); progressive disclosure via a skill
  listing and body injection on invocation.
- **Plugins/marketplaces**: `plugin.json`, `commands/`, `agents/`,
  `hooks/hooks.json`, `.mcp.json`; a manifest is optional for a skills tree.
- **Subagents**: `Task`/`Agent` with `subagent_type`, model/effort overrides,
  `isolation: "worktree"`, `run_in_background: true`, resume via `SendMessage`,
  and results delivered as user-role `<task-notification>` messages.
- **Deferred tools**: `shouldDefer` + `ToolSearch` keeps the tool table small
  until a deferred tool is actually needed.

### 2.7 Claude Desktop is a GUI over the same CLI

The Code tab does not embed a separate agent. It runs the pinned `claude` CLI
with `--output-format stream-json --input-format stream-json` and speaks a
control protocol: `initialize`, `can_use_tool`, `hook_callback`,
`request_user_dialog`, `oauth_token_refresh`, `interrupt`,
`session_state_changed`, `transcript_mirror`, `keep_alive`, `compact_boundary`.
The app owns the permission broker, session store, file checkpointing, rewind,
resume/fork, and the VM for Cowork. The renderer is sandboxed with
`contextIsolation`, no Node integration, a typed service registry, and a strict
CSP-equivalent scheme policy.

This is the key architectural lesson for clone-ai: **the desktop is a control
surface over an agent runtime, not a second agent.** clone-ai already has the
same split (Swift/WKWebView + Node sidecar); it lacks the control protocol's
permission, session, checkpoint, and feedback surfaces.

---

## 3. Where clone-ai stands today

The audit verified the working tree, not the docs. At audit time, `npm run
gate` passed, `npm run typecheck` exited 0, and `npm test` was 585 tests, 578
pass, 4 fail, 3 skipped. The four failures were migration fallout from removing
Pi from `providers.json` and were reproducible; they were not a reason to stop,
but they were a reason the tree was not releasable as-is. Phase 0 repaired them.
After Phase 0/1 (2026-11-07), the suite is **609 tests, 606 pass, 0 fail, 3
skipped**, and the shared loop kernel is wired into both the Main Agent and the native worker. The matrix
below still reports the pre-implementation audit baseline; re-score after the
remaining phases.

### 3.1 Strengths to preserve

- **Authority boundary.** The Main Agent proposes; the Kernel validates,
  approves, verifies, and completes. This is a better security story than an
  agent that can self-certify.
- **Journal-first durability.** SQLite WAL, append-only events, claim lease,
  orphan recovery, kill-restart tests.
- **Evidence-based verification.** File/test/diff verifiers and an offline gate
  with a per-case baseline.
- **Governed memory.** Provenance, candidates, conflicts, sensitivity, expiry,
  PII redaction, hybrid lexical recall. Stronger than a naive vector store for
  a personal agent.
- **Scope and sandbox primitives.** Path gateway, forbidden roots, autonomy
  ladder, macOS Seatbelt profiles.
- **Loopback hardening.** Per-boot bearer, Host/Origin checks, 0600 files.
- **Provider abstraction.** Black-box recipes plus an in-process native worker.

### 3.2 The gaps, in plain terms

| # | Gap | Why it matters |
| --- | --- | --- |
| 1 | The Main Agent cannot touch the workspace | It can propose but not read/edit/run; Claude Code's loop is exactly that |
| 2 | Permission is plan-time only; no per-call gate or hooks | Cannot refuse one call and continue; no audited extension surface |
| 3 | Compaction is character-based and unrecorded | Long sessions lose detail; the desktop context panel reads legacy Pi JSONL |
| 4 | No MCP host | Every third-party integration arrives through MCP |
| 5 | No skills | Reusable workflows must be hard-coded |
| 6 | No model-invocable subagents or background tasks | Work orders are Kernel-declared, not chosen at runtime |
| 7 | No mid-turn cancellation | A runaway turn cannot be stopped; the UI aborts only its own fetch |
| 8 | No retry/backoff/fallback | One 429/5xx becomes a user-visible failure |
| 9 | Split session state; no resume/fork/rewind | Continuity across restarts is a core agent property |
| 10 | Desktop feedback and observability below bar | Plain-text streaming, no tool timeline, no stop button, no OTel spans |

### 3.3 Stale claims to fix

The September `harness-gap-analysis.html` is no longer current in either
direction. It still says the Main Agent runs on Pi; it also claims no
`/health`, no bearer/Origin, and no reject/cancel, while the tree now has all
three. `benchmark/main-agent.ts` still sets `CLONE_AI_MAIN_RUNTIME=pi`, which
now throws. `native-runtime.ts`'s header says "no compaction" while the file
compacts. These are documentation bugs that will mislead the next agent; fix
them in the same change that touches the area.

---

## 4. The parity matrix

Weights follow blast radius on "acts like Claude Code", not ease of
implementation. Scores are the audit's evidence-backed maturity levels,
converted to 0–100.

| # | Dimension | Weight | Baseline | Gap | Decision |
| --- | --- | ---: | ---: | --- | --- |
| 1 | Agent-loop control (bounded, budget, cancel, single-flight) | 12 | 55 | Typed terminal reasons, turn/token budgets, abort propagation, retry/fallback, parallel-safe scheduling | **Adopt** the state machine and scheduler |
| 2 | Tool layer & gating (governed tools, truncation, deferred loading) | 10 | 55 | No Edit/Glob/Grep/Bash for the agent that executes work; no result ladder; no ToolSearch | **Adopt** the metadata + result ladder; **adapt** tools into role/capability profiles (coding is one profile) |
| 3 | Permission & authority (modes, rule scopes, per-call ask) | 12 | 65 | Plan-time only; no modes; no hooks | **Adopt** the six-mode ladder, rule syntax, `ask` path; **adapt** to Kernel policy |
| 4 | Verification & evidence | 10 | 85 | Receipts for external actions are structurally hard; connector evidence is thin | **Keep**, then close receipt/connector gaps |
| 5 | Memory & context management (compaction, briefing, recall) | 10 | 55 | Character compaction; no token threshold, boundary record, microcompact, post-compact restore | **Adopt** the threshold math and boundary record; **adapt** the summary prompt |
| 6 | Subagent orchestration (isolation, background, handback) | 8 | 65 | Work orders have dependencies/resume/verification but are not model-invocable | **Adapt** the WorkOrder system into a `Task` tool |
| 7 | Extension points (hooks, skills, MCP, plugins) | 8 | 10 | None | **Adopt** hooks, skills, MCP; **defer** plugins/marketplace |
| 8 | Observability & telemetry | 6 | 65 | Journal/usage/audit/health; no spans, metrics, or tool-decision events | **Adopt** a stable event schema and OTel export |
| 9 | Reliability & ops (crash recovery, queue, health) | 6 | 75 | Strong journal/recovery; no retry/watchdog; four red tests | **Keep**, add retry/watchdog, repair baseline |
| 10 | Security (loopback auth, secrets, sandbox) | 8 | 65 | Bearer/Host/Origin and Seatbelt, but no OS sandbox for in-process tools, no keychain, CSP null | **Keep**, add in-process sandbox/keychain/CSP |
| 11 | Model layer (routing, fallback, usage ledger) | 5 | 55 | No retry/fallback, no per-model cost ledger, no prompt-cache accounting | **Adopt** retry/fallback and cache-aware usage |
| 12 | Product/UX & distribution | 5 | 45 | Plain-text streaming, no tool timeline/stop button, no resume/rewind, ad-hoc signing | **Adopt** the Desktop control-surface patterns |

**Baseline weighted score (estimate): 58.5 / 100.** The minimum dimension is
extensibility (10); the next lowest are product/UX (45), agent loop (55), tools
(55), and context (55). The score is deliberately harsh: a dimension earns its
level only when an executable check proves it.

### 4.1 What we adopt, adapt, skip, and defer

**Adopt (mechanism, not code):**

- Typed loop terminal reasons and a bounded recovery ladder — *reason: every
  retry, fallback, budget report, and UI state needs a "why it ended" answer;
  clone-ai currently has one generic error string.*
- Streaming tool execution with per-tool `isConcurrencySafe` / `isReadOnly`
  and a barrier for unsafe calls — *reason: read-heavy turns currently wait for
  each tool serially; the scheduler cuts wall-clock without changing the tool
  API.*
- Per-call permission decisions with allow/deny/ask, rule scopes, and an
  `updatedInput` path — *reason: plan-time approval cannot refuse one bad call
  and continue; it is the missing safety layer for every new tool.*
- A hook surface with the exit-code contract and per-event deadlines — *reason:
  it buys audited extensibility without granting authority, and the contract is
  cheap to implement.*
- Token-aware compaction with a persisted boundary and preserved message ids —
  *reason: character budgets do not track the model window, and the desktop
  context panel cannot show what happened without a record.*
- Tool-result ladder: inline → persist → middle-truncate → clear old results —
  *reason: an 8,000-character hard cut loses the tail of large outputs and
  gives the model no signal that data was removed.*
- MCP host with `mcp__server__tool` naming, output caps, and deferred tools —
  *reason: it is the ecosystem on-ramp; without it every integration is a
  bespoke connector.*
- `SKILL.md` with progressive disclosure and per-skill tool grants — *reason:
  it adds reusable procedural knowledge without inflating every prompt.*
- A `Task` tool with background, isolation, and handback semantics — *reason:
  the Kernel can dispatch work orders, but the model cannot choose to
  parallelize or delegate at runtime.*
- Session transcript + record split, resume/fork, file checkpoints — *reason:
  continuity across restarts and undo are core agent properties; a turn ledger
  alone cannot restore a session or a file.*
- Desktop permission cards, tool timeline, diffs, context meter, stop button —
  *reason: users judge parity by what they can see and stop; the current UI
  renders streaming text but no tool activity.*

**Adapt:**

- `CLAUDE.md` hierarchy → clone-ai's governed memory plus project context
  files, injected with trust labels — *reason: ungoverned auto-discovery is an
  injection channel clone-ai deliberately closed.*
- Permission rules → Kernel policy + ToolAuthority; deny wins, hooks cannot
  widen authority — *reason: the Kernel must remain the only authority; a
  second rule engine would let two stories diverge.*
- Subagents → existing WorkOrder subagents; the `Task` tool creates a governed
  work order, not a second authority — *reason: clone-ai already has dependency,
  resume, and evidence verification for work orders; duplicating it would
  create two completion paths.*
- Compaction summary prompt → clone-ai's own nine-section summary, with
  deterministic first and model-written optional — *reason: deterministic
  summaries are private, cheap, and testable; a model summary is an
  optimization, not a prerequisite.*
- Hooks → owner-configured commands, sandboxed, audited, with a trust bit —
  *reason: hooks execute owner code; without a trust bit and sandbox they
  become an ungoverned execution surface.*

**Skip (with reasons):**

- **Claude Code's exact prompts and source.** Proprietary; tuned for a coding
  CLI; would replace clone-ai's personal-twin charter. We copy the contract,
  not the text.
- **Anthropic auth/OAuth/keychain, model catalog, GrowthBook flags, telemetry,
  A/B experiments.** Provider-specific and not part of the harness contract;
  clone-ai supports arbitrary OpenAI-compatible endpoints.
- **Cloud sessions, remote control, SSH, IDE, Chrome, computer-use.** Product
  surfaces with infrastructure cost; not needed for the harness score.
- **Plugin marketplace and plugin supply chain.** Deferred until MCP/skills are
  stable and a real workflow requires it.
- **The Windows/Linux VM (`smol-bin`, hypervisor backends).** Seatbelt already
  isolates CLI workers on macOS; a VM is a platform-specific, 26 MB image plus
  hypervisor code. Defer until a red-team test bypasses Seatbelt.
- **The exact UI design, colors, and marketing copy.** Not a functional gap.

**Defer (with trigger):**

- MCP resources/prompts beyond tools: after the stdio tools path is stable.
- Plugin marketplace: after skills + MCP have a permission model.
- Cloud/remote sessions: when the owner needs a second machine.
- VM sandbox: when a red-team test shows Seatbelt is insufficient, or when
  external untrusted code must run.
- Computer-use/Chrome: when a real personal workflow requires it.

---

## 5. Roadmap to 95

The order is dependency-driven: the loop kernel first, because every other
feature needs a place to attach; then per-call permission, because new tools are
unsafe without it; then tools and context; then extensibility; then desktop
and operations. Each phase has a deterministic eval; live benchmarks are
marked.

### Phase 0 — Repair the baseline (½ day)

- Fix the four red tests by aligning them with the native-only provider
  catalog, or restore Pi deliberately. Update `bench:main` so it no longer
  forces a removed runtime.
- Correct the stale docs (`harness-gap-analysis`, `native-runtime` header,
  README Pi references, `benchmark/README`).
- Add a `parity` section to `benchmark/README` that records the metric and the
  evidence tiers.

**Acceptance:** `npm test`, `npm run typecheck`, `npm run gate` pass; no doc
claims a runtime that cannot start.

### Phase 1 — Agent loop kernel (P0)

- `src/agent/loop.ts`: one async state machine with typed terminal reasons
  (`completed`, `max_turns`, `budget_exhausted`, `aborted_streaming`,
  `aborted_tools`, `api_error`, `prompt_too_long`, `malformed_tool_use`,
  `hook_stopped`).
- Streaming tool scheduler: safe tools run concurrently, unsafe tools are a
  barrier, results are returned in model call order.
- Per-turn token/tool/duration budgets and a visible usage ledger.
- Abort propagation to the model stream and every in-flight tool; a
  `cancel` endpoint for the Main Agent stream.
- Retry/backoff with `Retry-After`, a first-byte/idle watchdog, and a bounded
  recovery ladder (output limit, truncated stream, malformed tool call, empty
  completion).
- A structured `tool_result` envelope (`tool_use_id`, `is_error`,
  `denialKind`, `truncated`).

**Eval:** `test/agent-loop.test.ts` with a fake model: max-turns terminal
reason, parallel read-only timing, serial barrier, abort, 429 retry, budget
exhaustion, malformed tool recovery, deterministic result order.

**Projected:** loop 55→90, model layer 55→75, reliability 75→85.

**Status (2026-11-09):** Phase 1 and 2 are implemented. `src/agent/loop.ts`
carries the typed terminal reasons, per-call `authorize`, pre/post hooks, budgets,
and abort; the Main Agent and the native worker both run on it. Phase 3 is
partial: the worker's tool set is a profile (coding is one), but the additional
coding tools are not written yet. Phase 4 is implemented as
`src/main-agent/context-window.ts` plus `main_agent.context_compacted`. Phase 5
is implemented as `src/mcp/mcp-host.ts` and `src/skills/skill-loader.ts`; both
are opt-in per Main Agent turn.

### Phase 2 — Per-call permission and hooks (P0)

- `ToolAuthority` becomes the single in-process gate: `allow / deny / ask`,
  reason, `updatedInput`, operation id, timeout, reconcile.
- Six-mode ladder (`plan`, `default`, `dontAsk`, `acceptEdits`, `auto`,
  `bypassPermissions`) with monotonic escalation guards.
- Rule syntax (`Bash(git *)`, `Read(./src/**)`, `Edit(...)`,
  `mcp__server__tool`); deny wins; protected paths cannot be opened by any
  approval.
- Hook events for the core subset: `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `UserPromptSubmit`, `SessionStart`, `Stop`,
  `PreCompact`, `PostCompact`; exit-code contract and per-event timeout.
- Desktop/CLI `ask` path with an approval card; denial returns a structured
  tool result and the turn continues.

**Eval:** extend `benchmark/gate/policy-cases.json` with mode/rule precedence
cases; `test/tool-authority.test.ts` covers allow/deny/ask, updatedInput,
timeout, abort, and hook block; a desktop test asserts a denied call does not
kill the turn.

**Projected:** permission 65→95, extensibility 10→50, security 65→75.

### Phase 3 — Execution worker tool profiles and isolation (P1)

- Define role/capability tool profiles. Workers already accept a
  `NativeToolSpec[]`; a coding profile can add `edit_file`, `multi_edit`,
  `glob`, `grep`, `bash`, `todo_write`, and `task`, while research, review,
  drafting, and external roles get their own profiles. Coding is one profile,
  not the worker's identity.
- Every profile is checked per call by `decideTool`: a profile never widens
  risk, path, or network authority, and an unknown tool is refused while the
  turn continues.
- Bash runs under a per-step Sandbox: Seatbelt on macOS, worktree/temp copy
  first, network only with a scope. No shell string is passed through a
  shell; use argv.
- Worktree isolation for risky steps; restorable checkpoint (not only hashes).
- Tool result ladder and spill-to-file for large outputs.

**Eval:** a deterministic tool-contract suite (path escape, symlink, command
classification, truncation, spill, worktree cleanup); a live coding task
(read → edit → test) that must leave an artifact and pass the test.

**Projected:** tools 55→95, security 75→85.

### Phase 4 — Context engineering (P1)

- Token estimator and window config; implement the Claude Code-derived
  thresholds (effective window, threshold, warning, blocked).
- Auto-compaction at loop top and a reactive pass on `prompt_too_long`.
- `compaction` record with preserved message ids, nine-section summary, kept
  tail, restored files (last 5, ≤5,000 tokens each, ≤50,000 chars).
- Microcompaction: keep the last 12 tool uses; clear only if ≥20,000 tokens
  are saved.
- Tool-result ladder and a `context` view driven by the new records.
- Prompt sections with stable ids and a static/dynamic boundary; cache-aware
  usage accounting.

**Eval:** `test/compaction.test.ts` with seeded turns and a fake model;
`benchmark/native-main-long-context.ts` extended to assert boundary metadata
and fact recall; a token-budget test that fails the turn at the blocked level.

**Projected:** context 55→95, observability 65→80.

### Phase 5 — MCP and skills (P2)

- In-process MCP host: stdio first, then HTTP/SSE; tool naming
  `mcp__server__tool`; output cap; per-server timeout; OAuth where needed.
- Deferred tool loading and a `ToolSearch`-like loader.
- `SKILL.md` discovery in project/user/plugin directories, frontmatter
  (`name`, `description`, `allowed-tools`, `disable-model-invocation`,
  `user-invocable`), progressive body injection.
- Permission integration: MCP tools and skills inherit the per-call gate;
  server policy can force `ask`.

**Eval:** a fake stdio MCP server with two tools; a skill fixture with
`allowed-tools`; tests for naming, schema, output cap, deferred loading,
unauthorized skill activation, and server failure isolation.

**Projected:** extensibility 50→95, tools 95→100.

### Phase 6 — Subagents, background work, sessions (P2)

- `Task` tool creates a governed work order (role, capabilities, budget,
  workspace, expected evidence) and returns a `<task-notification>`-style
  result. Background tasks are visible and cancellable.
- Worktree isolation and a per-session concurrency cap.
- Session transcript + record split: append-only JSONL for messages/tool
  events, a small mutable record (cwd, model, permission mode, checkpoints).
- Resume/fork/rewind: file checkpoints with an undo path; `resume` and
  `fork` semantics that never write the parent transcript.

**Eval:** a fake subagent test for handback/pairing/cap; a session test for
resume/fork/rewind; a live two-subagent task with dependency ordering.

**Projected:** subagents 65→95, loop 90→100, context 95→100.

### Phase 7 — Desktop control surface and observability (P2)

- Tool timeline with tool cards, diffs, plan/todo cards, context meter, and a
  stop button that actually aborts the server turn.
- Permission cards with "always allow" scoped rules, scroll-gated destructive
  approvals, and a visible denial reason.
- Session resume/fork/rewind in the sidebar; a record vs transcript split.
- Typed RPC between WebView and sidecar; CSP and renderer sandboxing; no
  Node in the renderer.
- JSON event schema + OTel spans/metrics; redaction and bounded tails.

**Eval:** UI e2e for cancel/approve/deny/resume; a screenshot/DOM check for
tool timeline and context meter; a trace export test for tool decisions and
compaction events.

**Projected:** product/UX 45→90, observability 80→95.

### Phase 8 — Reliability, security, and model layer (P3)

- Retry/fallback already in Phase 1; add per-model cost ledger, prompt-cache
  accounting, and a budget reminder to the model.
- Streaming watchdog (first byte, idle, total) and a run-end ceiling.
- Keychain/secret storage, CSP, in-process sandbox for native tools, rate
  limits, and audit for hook/MCP configuration.
- Memory: optional embeddings as a rerank (never replacing the testable
  lexical path); project context files with trust labels.

**Eval:** fault-injection tests (429, 500, stalled stream, killed process,
corrupt transcript); a security test for CSP/keychain; a cost-ledger test that
survives resume.

**Projected:** security 85→95, reliability 85→95, model layer 75→95.

### Phase 9 — Verification and the headline parity run (P3)

- Close the external-action receipt gap with a governed connector that emits
  Kernel-observed receipts.
- Expand the gate with the deterministic cases from the metric report (D1–D13).
- Run the live suite against the same backbone model as a Claude Code
  reference; record command, model, tasks, seeds, samples, and result paths.
- Publish the weighted score, min dimension, and any dimension below 80.

**Projected:** verification 85→100, product/UX 90→95; weighted score ~95.

> Projections are estimates. The phase acceptance criteria, not the projected
> number, decide whether a phase is done.

---

## 6. The eval suite

### 6.1 Deterministic (free, CI)

Extend `benchmark/gate/` with:

| ID | Case | Dimension |
| --- | --- | --- |
| D1 | promised file exists with content → pass | verification |
| D2 | missing/empty file → fail, no false pass | verification |
| D3 | local reversible write → allowed | permission |
| D4 | external action → approval_required | permission |
| D5 | forbidden path / traversal / symlink → denied | permission, security |
| D6 | audit calibration vs owner labels → agreement 1, falsePass 0 | observability |
| D7 | max turns emits `max_turns` with count | loop |
| D8 | compaction at threshold writes boundary + preserved ids | context |
| D9 | hook exit 2 blocks; exit 0 allows; other continues | hooks |
| D10 | subagent handback pairing + concurrency cap | subagents |
| D11 | concurrent Main Agent prompt → 409/queue | loop |
| D12 | MCP output truncated at cap | tools |
| D13 | no bearer → 401; non-loopback Host rejected | security |

These are offline and must run on every change. The gate's per-case baseline
means any behavior change is reviewed, including improvements.

### 6.2 Live (provider, recorded)

Use the existing `benchmark/main-agent.ts`, `native-main-long-context.ts`,
`native-main-images.ts`, and `benchmark/run.ts` patterns:

| ID | Task | Pass criteria |
| --- | --- | --- |
| L1 | summarize a read-only file | artifact exists with expected content |
| L2 | two-step chain (notes → brief) | both artifacts, dependency respected |
| L3 | three-step pipeline; review must not modify brief | brief hash unchanged |
| L4 | code task: edit + run test | test exits 0 |
| L5 | missing input → `no_artifact`, no hang | failure category set |
| L6 | direct answer → zero runs | expectation `direct` |
| L7 | authority query → `get_authority` called | tool call present |
| L8 | plan proposal → run created, not executed | runs > 0, no artifacts |
| L9 | long-memory recall (LongMemEval slice) | recall@k ≥ floor |
| L10 | long-context compaction keeps a seeded fact | answer contains it |
| L11 | image understood | expected answer |
| L12 | 429/500/refusal classified, not crash | category recorded |

Record every run in the optimization log with the exact command, provider,
model/effort, task ids, dataset/version, split/seed, scoring parameters,
machine notes, result file, and before/after. A number without that block is an
anecdote.

### 6.3 Manual/UX

- Cancel/deny/approve closes `waiting_approval` in GUI and CLI.
- `/health` reports journal, queue, sidecar.
- Tool timeline, diff, context meter, resume/rewind visible.
- Onboarding, tray, notifications, and a signed build.

### 6.4 Anti-self-deception

- Adversarial cases: prompt injection in a file; path traversal; symlink
  escape; malformed hook JSON; classifier unavailable; context overflow
  mid-tool; truncated MCP output.
- Held-out tasks: keep ~20% private and rotate them; never tune prompts on the
  headline set.
- Same-model reference: run the same prompts through Claude Code and clone-ai
  on the same backbone; report both.
- No dimension below 80; report the min dimension next to the weighted score.
- Mark any SDK-owned behavior as a gap, not as a feature.

---

## 7. Risks and honesty

| Risk | Why it is real | Detection |
| --- | --- | --- |
| Model quality is mistaken for harness quality | clone-ai's endpoint may be weaker/stronger | Same-model reference run; separate model score |
| The score is gamed by weights or checklist levels | A checklist can be satisfied without behavior | Executable evidence per level; gate cases; held-out tasks |
| The baseline stays red | Four tests already fail; more migration may follow | Phase 0 acceptance; CI must run `npm test` |
| Hooks/MCP widen the attack surface | They execute owner code and remote servers | Sandbox, trust bit, per-call gate, audit |
| Compaction loses task-critical facts | Summaries are lossy | Seeded-needle long-context eval; deterministic first |
| Desktop work lags the harness | The UI is where users see parity | Phase 7 e2e; screenshots; cancel/approve/resume tests |
| Maintenance of two loops | Main Agent and worker diverge | Shared kernel; drift test comparing behavior |
| Proprietary contamination | Extracted source is copyrighted | Keep it in `/tmp`; reimplement, don't copy |

---

## 8. Appendix

### 8.1 Extraction method

The Claude Code executable is a Bun single-file binary. Its `__BUN` Mach-O
section starts with an 8-byte graph length, followed by the module graph:
source contents, names, a module table of fixed 52-byte records, source hashes,
optional records, the `Offsets` struct, and the trailer `\n---- Bun! ----\n`.
The extractor reads `Offsets { byte_count, modules_ptr, entry_point_id,
compile_exec_argv_ptr, flags }`, iterates the module table, and writes each
module's `contents` (Latin-1 or UTF-16) to a file. The Claude Desktop bundle was
extracted with `@electron/asar`.

Commands are deliberately not run from the repository; the extracted tree is
kept outside it and is not committed.

### 8.2 Evidence index

| Claim | Evidence |
| --- | --- |
| 22 built-in tools | `BUILTIN_TOOL_NAMES=[...]` in `chunk-eat7r0am.js` |
| Six permission modes | `["default","acceptEdits","plan","auto","bypassPermissions","dontAsk"]` in `chunk-3z9szvkj.js` |
| Streaming tool scheduler | `isConcurrencySafe` / `canExecuteTool` in `chunk-8ntpzya9.js` |
| Retry/backoff | `Kbr=10`, `Vbr=300`, `FZe=15`, `HF(base=500, cap=32000, jitter=0.25)` |
| Compaction math | `effectiveWindow`, `13000`, `0.2`, `3000` in `chunk-vrwkjdrd.js` |
| Compact boundary | `compact_boundary`, `preservedMessages.uuids` |
| Microcompaction | keep 12 tool uses, `clear_tool_uses_20250919` |
| CLAUDE.md import depth | `d4r=5`, 4 MiB cap |
| Hook events | 31 event names in `chunk-83mgbqxd.js` / `chunk-djayrv3w.js` |
| MCP naming | `mcp__<server>__<tool>` |
| Desktop control protocol | `--output-format stream-json`, `can_use_tool`, `control_response` |
| Desktop permission ladder | `{plan:0,default:1,dontAsk:1,acceptEdits:2,auto:3,bypassPermissions:4}` |
| Desktop session/rewind | `claude-code-sessions`, `enableFileCheckpointing`, `rewindMarks` |
| clone-ai gaps | audit report, `src/main-agent/native-runtime.ts`, `src/workers/*`, `src/companion-server.ts` |

### 8.3 Baseline test record

```text
command: npm test
result: 585 tests, 578 pass, 4 fail, 3 skipped
failures:
  - test/companion-control-plane.test.ts:213 (unknown run reject/cancel expects 404, got 500)
  - test/local-preferences.test.ts:29 (unknown execution provider "pi")
  - test/provider-registry.test.ts:46 (unknown execution provider "pi")
  - test/worker-defaults.test.ts:27 (default provider expected "pi", got "native")
command: npm run gate -> PASS
command: npm run typecheck -> exit 0
```

The four failures were working-tree migration fallout, not a green baseline.
Phase 0 repaired them; the post-Phase 0/1 record is:

```text
command: npm test
result: 609 tests, 606 pass, 0 fail, 3 skipped
command: npm run gate -> PASS
command: npm run typecheck -> exit 0
```
