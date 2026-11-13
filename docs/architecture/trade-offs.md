# Architecture trade-offs

**English** · [简体中文](trade-offs.zh-CN.md)

A decision is only durable when its reason is written down. Each entry states
what was decided, the evidence behind it, and the condition under which a
future reader should reverse it.

## 2026-11-13 — The Main Agent reads project instruction files, labeled by trust class

**Decision.** The Main Agent loads `AGENTS.md` / `CLAUDE.md` from the workspace
(plus `.claude/CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md`), up to 64 KiB
in total, and appends them to its system prompt under a labeled heading that
says they are project instructions, not memories the owner approved. An
`@path` import expands to depth 3, only when the imported file stays inside the
workspace. The governor is `CLONE_AI_PROJECT_INSTRUCTIONS=0`, which turns the
whole layer off.

**Evidence.** Before this change nothing in `src/` read either file: the only
loader shipped is `src/skills/skill-loader.ts`, which accepts `SKILL.md` under
explicit skill roots. The consequence is visible in the repository itself —
`AGENTS.md` at the root of this checkout tells every agent to write a trade-off
before an optimization and to run `npm run gate`; clone-main never saw it. The
2026-11-13 memory comparison measured this as one of four gaps against Claude
Code 2.1.319, whose loader reads managed / user / project / local `CLAUDE.md`
with `@import` depth 5, a 4 MiB read cap, and injection labeled by trust class
(extracted from the installed 2.1.319 binary: the `Project` / `Local` /
`AutoMem` / `Managed` / `User` labels).

**What it costs.** The instruction layer is owner-editable text the runtime
cannot verify: a repository that ships a hostile `CLAUDE.md` now influences the
Main Agent's prompt. That is why it is capped, labeled, and switchable, and why
imports may not escape the workspace. Prompt-cache reuse also drops for the
static prefix whenever an instruction file changes, because the content sits in
the system prompt rather than after a cache boundary. The loader deliberately
does not read `~/.claude` or managed policy files: clone-ai has no equivalent
policy source, and reading another product's configuration would bind the twin
to its layout.

**Reversal condition.** If instruction files grow past the cap often enough that
the Main Agent loses project rules, raise the cap rather than add partial-file
inclusion — a half-read rules file is worse than a labeled truncation. If the
prompt-snapshot hash shows the instruction layer churning every turn (a tool
rewriting the file), move the layer to a cache-stable position or hash it out of
the system prompt.

## 2026-11-13 — Memory edits are versioned, and an undo restores the previous version

**Decision.** Every owner-visible change to a memory (author, update, archive,
restore) records a version snapshot — the fields before the change plus the
journal sequence that made it — in a `memory_versions` table. `MemoryGovernance
.undo(id)` restores the version before the latest change and journals a
`memory.updated` event whose payload says `source: "undo"`, `restoredVersion`.
The memory library's detail view shows the change list, and `PATCH
/api/memory/governed/:id` with `{ "undo": true }` performs the restore.

**Evidence.** The store's own recovery path (`stageMutation` / `memory_mutations`
/ `applyMutation`) already proves the design works one mutation at a time, but a
mutation row is deleted on commit: there is no record of what the memory said
before, so an edit made in the GUI or by `syncFromFiles` cannot be reverted once
it lands. The nearest analogue in Claude Code 2.1.319 is `rewind` removing a
memory write — the binary carries `rewind_removed_memory_write` as a wait
reason. Version snapshots are the narrower version of that idea: they cover memory
content only, not conversation state.

**What it costs.** One extra row per change, keeping at most 20 versions per
memory (older ones are trimmed). An owner who edits a memory 500 times holds 20
rows, not 500. The undo is per-change, not per-time-range: there is no "go back
to last Tuesday". The row is written in the same transaction as the entry, so a
failed change never leaves a version claiming a state that never existed.

**Reversal condition.** If memory files are edited by a script more often than a
person, per-change rows become noise; then snapshot on a time interval instead.
If an owner asks to compare two versions side by side, the table is already the
right shape — add a diff view rather than a second store.

## 2026-11-13 — Recall can synthesize a paragraph, but the paragraph is never a memory

**Decision.** `SynthesizedRecall` (`src/memory/synthesized-recall.ts`) takes the
top lexical matches and asks the configured endpoint for one paragraph that
answers the query from them, citing memory ids. The result is returned only
when every cited id was actually among the recalled set and every sentence
carries at least one citation (checked deterministically); otherwise the caller
falls back to the plain list. The synthesis is never written to memory, never
counted as a memory, and is journaled as `memory.recalled` with
`mode: "synthesize"` so the attribution loop sees exactly what the model was
fed.

**Evidence.** clone-ai's recall returns summaries, and the Main Agent's push
builder spends a 1,200-character budget across four memory classes. When many
small memories each match weakly, no single one survives the budget, yet their
union answers the question — the case Claude Code 2.1.319 handles with its
`memory_recall` attachment in `synthesize` mode ("a Sonnet-authored paragraph
distilled from many tiny memories", per the binary's protocol schema). clone-ai
had only the `select` half.

**What it costs.** One extra model call on the turn where synthesis is used, so
it is opt-in (`synthesize: true`) and only runs when at least three memories
match. A synthesis that cites a memory it was not given is discarded entirely
rather than partially trusted. The paragraph is fluent text, not a stored fact:
asking about the same thing twice may produce two different paragraphs. Because
the model wrote it, the paragraph is framed as background, never instructions,
and secret memories never enter the prompt that produces it.

**Reversal condition.** If synthesis turns out to change the model's answers in
ways the underlying memories do not support — measured by comparing answers with
and without it on the LongMemEval slice — delete it and keep the list. If it
proves useful, the next step is synthesizing on a timer and caching, not
synthesizing more often.

## 2026-11-13 — Background consolidation proposes merges; the owner still decides

**Decision.** `MemoryConsolidator` (`src/memory/consolidation.ts`) runs on the
same idle sweep as expiry and archives, and produces `merge` suggestions for
same-type active memories whose overlap coefficient is at or above 0.55.
Suggestions are journaled as `improvement.suggested` with `kind: "merge"` and
carry the merged summary plus the ids it would replace; approving one goes
through `ImprovementService.approve`, which authors the merged memory and
archives the sources as `retired`. The consolidator never writes memory itself.

**Evidence.** `src/memory/conflict.ts` already measures the right similarity
(`summarySimilarity`, thresholds 0.55 / 0.35, measured on rewording pairs
0.57–0.93 against unrelated pairs 0.0–0.4), but until now `findConflicts` had no
production caller — its only consumers were tests. Claude Code 2.1.319 runs
background memory consolidation (the `autoDreamEnabled` setting and a "Memory
consolidation" pass that reports `consolidated N memory files`). clone-ai's
governance forbids the model from writing memory, so the honest equivalent is a
suggestion, not an automatic merge.

**What it costs.** An idle sweep now does one O(n²) similarity pass over the
active library; at 200 memories that is 20k comparisons of cheap bigram sets,
which is why it runs on the idle sweep and not per turn. A merge is lossy by
construction: the merged summary is written by a model and may drop a qualifier
the two originals carried, which is why approval is required and the sources
are archived (recoverable) rather than deleted. A false "these are the same"
costs an owner click to dismiss; a false merge that was approved costs an undo.

**Reversal condition.** If approved merges are later undone more than they are
kept, the similarity signal is not good enough — require the model to quote both
summaries and explain what differs before suggesting. If the library stays small
the pass is free; if it grows past a few thousand active memories, bucket by
type and a shared rare term before comparing.


**Decision.** `read_file` returns a named window (default 400 lines) with the
file's total line count and the offset for the next page. `write_file` refuses
content that would discard most of an existing file, in every mode, not only in
the repair lane.

**Evidence.** In the 2026-11-11 repair run at `reasoning_effort=max`, the model
read `src/main-agent/native-runtime.ts` (771 lines), the shared loop capped the
tool result at 8,000 characters, and the model then wrote the prefix back as the
whole file: 391 lines deleted and replaced by placeholders such as
`// __HEADER_IMPORTS__`. The same run deleted the file's header comment and
imports. `read_file` had no offset, no limit and no total, so the truncation was
invisible from the model's side.

**What it costs.** A model that wants the whole file now needs one call per 400
lines; a large file costs several rounds instead of one. A legitimate large
rewrite has to go through `edit_file` or raise the size difference explicitly.

**Reversal condition.** If windowed reads make legitimate multi-file tasks
exceed their round budget, raise the default window rather than removing the
total. If fragment refusal blocks a legitimate regeneration, give the worker a
new-file mode instead of loosening the check.

## 2026-11-12 — Tokens are counted by the tokenizer, calibrated from usage

**Decision.** Replace the hand-written character-class ratio with a calibrator
that learns the provider's real characters-per-token from `usage.prompt_tokens`,
starting from the lowest measured bootstrap ratio (3.15) and smoothing each new
sample. Every estimate reports whether it is `bootstrap` or `calibrated` and how
many samples it has seen.

**Evidence.** Measured against this machine's gateway, the same Chinese sentence
costs 265 tokens on `kimi-k3.1-pro` and 346 on `gpt-6.1-terra` — 30% apart — and
a code sample costs 2.0–2.6 characters per token where Latin prose costs
3.2–4.4. The character-class estimate I wrote before this used one fixed
coefficient for CJK and four for Latin, so it was wrong for code by roughly 2×
and wrong for one of the two models by 30%. The provider already reports the
true number on every response, so guessing was never necessary.

**What it costs.** The first request of a process is still an estimate; it
converges after one response. Different providers on one clone home share the
calibrator, so a turn that switches models carries a ratio learned elsewhere
until the next report corrects it. A provider that reports a ratio outside 1–12
characters per token is ignored, which also ignores a request whose prompt was
mostly cached.

**Reversal condition.** If a provider exposes a token-count endpoint, call it
before sending instead of calibrating. If per-model calibration matters (a clone
home that rotates models every turn), key the calibrator by model id — the
current single instance is the simplification, not the requirement.

## 2026-11-12 — The token count is honest, and MCP is a real client

**Decision.** The loop estimates tokens by character class (CJK and full-width
punctuation one token each, Latin four characters per token), a fixed 1,568
tokens per image, and the tool schemas as part of every request. The native
runtime stops pre-truncating history once compaction is on. A compaction that
removes nothing ends the turn with `budget_exhausted` instead of being
journalled again. The HTTP MCP transport performs the `initialize` /
`notifications/initialized` handshake, reads a streamed SSE body event by event
until the response id arrives, and `mcpToolSpecs` can defer the declared table
behind one loader.

**Evidence.** Dividing raw length by four under-counted Chinese about four times
and charged one screenshot half a million tokens; the tool table was invisible
to the estimate. `buildHistory` capped each record at 4,000 characters and the
whole history at 12,000, so the transcript the loop measured never crossed the
token threshold — compaction had never run in production, which the 2026-11-11
repair confirmed by making the record reachable. The HTTP client skipped the
handshake (every conforming server rejects `tools/list` first) and returned the
first SSE event, which is usually progress rather than the result. Every
declared MCP tool was sent on every request.

**What it costs.** The estimate is still an approximation — a mixed-script
message can be off by a quarter — and it is deliberately conservative, so
compaction may fire slightly early. MCP over HTTP is now stateful per server, so
a server that restarts needs its session re-established (the client re-initialises
on the next call). Deferring tools needs a caller that activates the loaded
schema; until a caller passes `deferUntil`, the table is exposed directly.

**Reversal condition.** If a provider exposes a real tokenizer, replace the
estimate with it and keep this as the fallback. If deferral makes a model call
the loader on every turn instead of the tool, remove the option rather than
lengthening the prompt.

## 2026-11-11 — A decision is applied to the file it can see, and an approval names its step

**Decision.** The standing-policy store reads the file inside its write queue and
applies each change to that fresh value (read-modify-write, last writer wins on
real content). Approving a run through HTTP or WhatsApp carries the step the
approval was issued for, and a run waiting on a different step is refused with
409. The loop retries `TimeoutError` but not `AbortError`, refuses malformed tool
arguments instead of running the tool with `{}`, and treats `finish_reason:
length` as a failed turn. MCP servers receive only the environment they
declared, duplicate server and tool names are refused, framed output keeps its
formatting, and a server's process group is killed. Memory context caps each
item and the push carries the metadata the builder classifies by.

**Evidence.** Each was reproduced against this repository's modules: two store
instances resurrected a revoked policy because each computed `next` from its own
copy before enqueuing; the approve route ignored the body, so a code issued for
step A approved whatever was active; `AbortSignal.timeout()` rejects with
`TimeoutError`, which the retry predicate did not recognise, so every timeout
failed on the first attempt; `parseArguments` returned `{}` for truncated JSON,
running the tool with no arguments; no caller read `finish_reason`, so a reply
cut mid-sentence was reported as complete; `env: { ...process.env }` handed an
MCP server the owner's API keys; `sanitizeObserved` collapsed every whitespace
run, making source code and JSON unreadable; `close()` killed only the direct
child; one long memory consumed the whole context budget and the push dropped
`type`/`createdAt`, so every memory landed in one class.

**What it costs.** Every policy edit now re-reads the file, so a large
`policies.json` is parsed per edit. Approvals need the step id in the body, which
is a wire-format change. A model that emits truncated tool arguments gets a tool
error instead of a silent empty call. A chatty MCP server no longer logs at the
owner's expense — its output is bounded and framed.

**Reversal condition.** If re-reading the policy file on every edit becomes
expensive, cache by mtime rather than trusting in-memory state. If a legitimate
workflow needs an approval to apply to a later step, add an explicit
"approve the next step" mode rather than removing the check.

## 2026-11-11 — The worker streams its activity, and the repair lane says when to stop

**Decision.** The native worker no longer awaits the shared loop and reports only
its outcome: the loop runs inside the adapter's generator and every `model_call`,
`tool_started` and `tool_completed` is pushed to the Kernel as it happens. The
repair plan now names the files the trace already names, forbids reading
`docs/`, and tells each phase to stop after its first write.

**Evidence.** Three repair runs on 2026-11-11 against DeepSeek V4.1 Flash at
`reasoning_effort=max`, captured through a logging proxy. A 24-round run and a
32-round run both ended at `budget-model-calls` having only written a regression
case; 12 of 31 rounds were spent re-reading the file the trace already named, and
`docs/` was read after the case existed. The Kernel's audit for each run showed
`execution.progress` once and nothing else, so `maxToolCalls` and `maxModelCalls`
could never fire for the only executor, and no tool activity could be reviewed.

**What it costs.** The worker keeps a small queue and a promise hand-off per
step, and the Kernel writes two journal events per tool call it did not write
before. A step that makes hundreds of tool calls now produces hundreds of audit
records.

**Reversal condition.** If the added journal volume dominates writes on a large
step, record only failures and count the rest in the usage block. If a model
overruns despite the stop instruction, replace the instruction with a hard rule
in the loop (stop after the first successful write in a test-writing phase)
rather than lengthening the prompt.

## 2026-11-10 — Scope checks compare resolved paths, and the repair lane's guards are real

**Decision.** The per-call path gate resolves both sides with `realpath` (following
symlinks, resolving a missing suffix against its nearest existing ancestor),
folds case on case-insensitive volumes, and checks read and write roots
separately: write implies read, never the reverse. A grant on a directory that
contains a protected root is refused, and a worker may not write inside a
repository's `.git`. The repair lane's `refuse-existing` mode is threaded into
`workerTools`, its worktree copies `node_modules` instead of symlinking it, and
a round limit is reported as a budget failure whether it came from the plan or
from the worker's default. Body caps clear the attachment cap, and the
capacity gate transfers a released slot to the waiter in the same synchronous
step that frees it.

**Evidence.** A six-dimension audit against Claude Code 2.1.319, with every
high finding verified adversarially and several reproduced against this
repository's own modules: a symlink inside the workspace pointing outside
returned `allowed: true` for reads and writes (Claude Code refuses that shape
outright: `Path contains '..' traversal after a directory segment, which may
follow a symlink outside the working directory`); a `files: read` grant
authorized a write; a grant on `~/Library` was accepted and handed over
`Library/Keychains`; `isRuntimeScratch` hid a write made through the worktree's
`node_modules` symlink; the `refuse-existing` guard never reached `fileTools`
because `workerTools` ignored it; `max_turns` fell through to `completed` when
the step had no work order; `Skill(name)` and `server.tool` are not legal
provider function names; compaction could keep a tool result without its call;
a 300 KB image produced HTTP 500 on the old 32 KB body cap; and a synchronous
acquire after `release()` put `limit + 1` executions in flight.

**What it costs.** Every path check now performs filesystem work (`realpath`),
so a step with many file tools pays a few syscalls per call; the capacity gate
counts a slot for a waiter before it resumes, so `active` includes queued
holders; a `node_modules` copy makes a repair worktree slower to prepare.

**Reversal condition.** If path resolution becomes a measurable cost on large
trees, cache resolved roots per step rather than reverting to lexical compare.
If copying `node_modules` makes a repair worktree too slow or too large, replace
the symlink with a read-only bind mount, not with a writable link into the
served checkout. Revert the `.git` refusal only if a legitimate workflow needs
a worker to write repository metadata.

## 2026-11-09 — The model can dispatch a task, but only the Kernel plans and finishes it

**Decision.** Add one model-invocable `dispatch_task` tool that turns an
objective and acceptance criteria into the same `runQuery` path the companion
uses. It is not a second execution surface: the Kernel still plans, applies
authority and budgets, verifies evidence and decides completion. A conversation
must still be answered directly, and a plan whose steps are already known still
goes through `propose_work_plan`.

**Evidence.** The audit found the Main Agent could propose plans but could not
start work on its own (`docs/study/claude-code-parity.md`, gap #6). `runQuery`
already owns trigger → recall → plan → execute → verify, so reusing it keeps one
completion path. The alternative — letting the Main Agent spawn workers
directly — would create a second authority and a second place where a task can
be declared finished.

**What it costs.** The first dispatch is synchronous from the model's point of
view, so a long task holds the turn; background dispatch and a completion
notification are the next step, not this one. The tool also accepts only an
objective and criteria, so the model cannot express per-step scopes; it must use
`propose_work_plan` when it needs that precision.

**Reversal condition.** If real tasks routinely need per-step authority or
background completion, extend `dispatch_task` with a background option and
return a run id immediately; if the synchronous call proves to be the source of
timeouts, make background the default.

## 2026-11-09 — Regression cases run in the default suite

**Decision.** `npm test` now runs `test/*.test.ts` **and** `test/regression/*.test.ts`.

**Evidence.** The two desktop fixes merged on 2026-11-06 shipped with cases the
lane ran, but neither `npm test` nor `npm run gate` nor CI ever ran them again:
the glob was `test/*.test.ts`, which does not match the subdirectory. A future
change could reintroduce either defect and every automatic check would stay
green.

**What was given up.** `npm test` is slightly slower (two more files) and a
regression case that is intentionally red cannot be merged without failing the
default suite. That is the point.

**Reversal condition.** If the regression directory grows large enough to slow
the default loop, move it to a second script that CI runs alongside `npm test`,
never out of CI.

## 2026-11-09 — A background repaint yields to a focused editor

**Decision.** `render()` in the memory panel takes `{ background: true }`, used
only by the poll wrapper; when the focused element is an `INPUT` or `TEXTAREA`
inside `#memory-root`, a background repaint is skipped.

**Evidence.** The 2026-11-06 fix compared the whole markup and skipped only when
nothing changed. A probe against the same sandbox showed that any real change
(another memory's `updatedAt`, or an `accessCount` bumped by a recall) rebuilt
the DOM and detached the unsaved editor. Since every recall changes counts, the
original bug would still fire in normal use, just less often.

**What was given up.** While the owner types, the panel's own content does not
update (a detail that finished loading appears after focus leaves). That matches
`renderLibrary`'s guard in `app.js` and is preferable to losing an edit.

**Reversal condition.** If stale content while typing becomes a complaint, the
fix is to preserve the focused node across repaint (patch in place), not to
remove the guard.

## 2026-11-09 — write_file's overwrite mode is per worker, and only the repair lane refuses

**Decision.** `fileTools({ writeFileMode })` defaults to `overwrite`;
`createConfiguredNativeWorker` reads `CLONE_AI_NATIVE_WRITE_FILE`, and the repair
lane sets it to `refuse-existing` for its own process.

**Evidence.** The 2026-11-06 change made `write_file` refuse existing paths in
`fileTools()` unconditionally. That protected the repair lane, which only ever
needs excerpt edits, but it also removed the ability to regenerate an existing
file from every ordinary task — and there is no delete tool, so the task had no
way to recover.

**What was given up.** Two modes to reason about, and an environment variable in
the repair process. A repair can no longer legitimately replace a file wholesale;
that is the intended restriction.

**Reversal condition.** If repairs frequently need a full-file replacement, add
an explicit `replace_file` tool gated to the repair lane with its own size check,
rather than loosening `write_file` for everyone.

## 2026-11-06 — Adopt Claude Code's harness mechanics, not its source or prompts

**Decision.** Use the reverse-engineered Claude Code 2.1.317 mechanisms as a
reference specification for clone-ai's own agent loop: typed terminal reasons,
streaming tool scheduling with per-tool concurrency flags, a per-call
permission pipeline, token-aware compaction, hooks, MCP, and skills. Do not copy
source code, prompt text, or Anthropic-internal configuration into this
repository.

**Evidence.** The extracted Bun module graph contains 2,942 modules and a
copyright notice (`cli`: "(c) Anthropic PBC. All rights reserved."). The
mechanisms are visible as string constants and control flow
(`BUILTIN_TOOL_NAMES`, the six-mode permission enum, 33 hook event names, the
`effectiveWindow - 13000` compaction math). clone-ai's README states that it
does not embed another runtime and that Claude Code is a black-box worker.
Copying the prompt would also replace the personal-twin charter with a
coding-CLI identity.

**What it costs.** Reimplementation is slower than embedding
`@anthropic-ai/claude-agent-sdk`; parity must be proved by clone-ai's own evals
rather than inherited from Anthropic.

**Reversal condition.** If the owner explicitly chooses time-to-parity over
independence and accepts an Anthropic-only credential and provider path, add the
Agent SDK as a temporary reference/benchmark path, not as the product
architecture.

## 2026-11-06 — Execution workers are general; coding is one tool profile

**Decision.** Keep the Main Agent's proposal/authority boundary and add a
model-invocable `Task`/subagent path plus read-only inspection tools. Treat
workers as general execution surfaces: their tool set is selected by role and
capability profile, not hardwired to coding. A coding profile (Read, Write,
Edit, Glob, Grep, Bash) is one profile; research, review, drafting, and external
connectors get their own. Do not give the Main Agent Bash/Edit/Write directly.

**Evidence.** `src/workers/native-agent-worker.ts` already takes an arbitrary
`NativeToolSpec[]` and a `workCapabilities` list; `fileTools()` is only the
current default profile, not a type-level constraint. `decideTool` gates every
call by risk, path, and network scope, so a larger or different profile does not
widen authority. The README's invariant is "the Main Agent is the brain, never
the authority." Claude Code's coordinator prompt also separates a coordinator
from workers (`chunk-mas5an83.js`), which matches clone-ai's split.

**What it costs.** Profiles need ownership, versioning, and tests; a role that
gets the wrong profile can be over- or under-powered. The Main Agent cannot
inspect files itself without a new read-only tool set.

**Reversal condition.** If a single universal tool set proves simpler and every
role needs the same tools, collapse the profiles — but keep the per-call gate
and the capability declaration. If a same-model benchmark shows the orchestrator
round-trip loses more than 20% task success or doubles median latency, allow the
Main Agent to execute read-only tools directly under the same gate.

## 2026-11-06 — One shared agent loop kernel serves the Main Agent and the native worker

**Decision.** Extract one `src/agent/loop.ts` state machine with typed terminal
reasons, tool scheduling, budget checks, abort propagation, retry policy, and
compaction hooks. `runNativeMainAgentTurn` and `OpenAiCompatibleClient` become
adapters over it.

**Evidence.** Both current loops duplicate SSE/non-streaming request handling,
usage accounting, and an 8,000-character tool-result cut
(`native-runtime.ts:270-315`, `openai-compatible-client.ts:74-96`); both lack the
same features. The native-runtime header says "no compaction" while the file
compacts at `:515-558`, which is the kind of drift duplication produces. Claude
Code has one query loop for its terminal, SDK, and desktop surfaces
(`chunk-8ntpzya9.js`).

**What it costs.** A refactor of two hot paths and a period where behavior must
be pinned by tests; the loop must not grow provider-specific branches.

**Reversal condition.** If the Main Agent and worker diverge in transport or
streaming requirements (for example, a provider that cannot stream tool calls),
keep separate model adapters but share the scheduler, budget, and tool-result
layers.

## 2026-11-06 — Every in-process tool call goes through a per-call decision

**Decision.** Route every in-process tool call through `ToolAuthority` (or a
successor policy broker) that returns
`{behavior: allow | deny | ask, reason, updatedInput?}`. Plan-time policy
remains the outer gate; hooks may add context or deny, but may not silently
widen authority.

**Evidence.** `src/core/tool-authority.ts` exists and is referenced only by
`test/tool-authority.test.ts`; `runNativeMainAgentTurn` executes any tool the
model names (`native-runtime.ts:292-308`). Claude Code decides each call through
rules, mode, and `canUseTool`, and a denied call is returned to the model while
the turn continues (`chunk-q8qwkppc.js`). The audit ranks this as gap #2.

**What it costs.** More events and latency per call; the desktop and CLI need an
`ask` path, and every tool needs a risk classification.

**Reversal condition.** If per-call gating adds more than 10% latency on
read-only batches and no real incident is prevented in a red-team exercise,
allow read-only batches under one plan-time grant while keeping the gate for
writes, shell, network, and external actions.

## 2026-11-06 — Compaction is token-aware and recorded; deterministic summaries first

**Decision.** Estimate tokens against a configured context window, compact at
the Claude Code-derived threshold (`effective = window - min(maxOutputTokens,
20000)`, threshold `min(floor(effective * (1 - 0.2)), effective - 13000)`,
warning at `threshold - 20000`, blocked at `effective - 3000`), write a
`compaction` record with preserved message ids, and default to a deterministic
summary. Add a model-written summary only after an eval shows it preserves
task-critical facts better.

**Evidence.** The native loop compacts history by characters
(`historyChars ?? 12000`, newest 66% verbatim) and never writes a `compaction`
record (`native-runtime.ts:238-241,515-558`); the desktop context panel reads
legacy Pi JSONL (`conversation-history.ts:241`). Claude Code records a
`compact_boundary` with `preservedMessages.uuids`, a nine-section summary, and a
restored tail. Deterministic summaries are private, cheap, and testable; model
summaries add cost and nondeterminism.

**What it costs.** Token estimation is approximate; deterministic summaries can
lose nuance; a compaction record adds a new persisted event type.

**Reversal condition.** If the long-context benchmark shows deterministic
summaries lose a fact that a model summary preserves in at least 20% of seeded
cases, make model summaries the default for sessions above the threshold.

## 2026-11-06 — MCP and skills first; plugins, cloud, VM, and computer-use deferred

**Decision.** Implement an in-process MCP host (stdio first, then HTTP/SSE) and a
`SKILL.md` loader with progressive disclosure as P1. Defer plugin marketplaces,
cloud sessions, VM sandboxes, Chrome integration, and computer-use until the
weighted harness score is at least 90 and a concrete workflow requires them.

**Evidence.** clone-ai has no MCP or skills code (audit: extensibility 10/100).
MCP and skills are Claude Code's extension on-ramps; every third-party
integration arrives through them. Plugins and cloud/VM are product surfaces with
infrastructure cost. The macOS Seatbelt profile in `authority/seatbelt.ts` was
written for the black-box CLI workers, which no longer exist, so it is currently
unused; the in-process native worker has no OS sandbox. Claude Desktop's VM is a
26 MB image plus platform-specific hypervisor code. Deferring the VM is
therefore a deliberate bet that per-call path gating plus a single trusted worker
is enough for now — not a claim that an OS sandbox is already in place. Deferring them avoids spending the parity
budget on infrastructure that does not move the harness score.

**What it costs.** Users cannot install third-party plugins or run remote/browser
tools until those phases; MCP adds an attack surface, and skills can inject
instructions.

**Reversal condition.** If the owner's real workflows depend on a specific
plugin/marketplace or remote MCP, promote that integration; if a red-team test
shows that per-call path gating is insufficient for a workflow, promote the VM sandbox.

## 2026-11-06 — The 95% target is a weighted harness-parity score

**Decision.** Define parity as the 12-dimension weighted score ≥ 95, every
dimension ≥ 80, and a same-model live benchmark that does not regress against a
Claude Code reference run. Model quality is measured and reported separately; it
is never blended into the harness score.

**Evidence.** clone-ai supports arbitrary OpenAI-compatible endpoints; the model
behind it may be weaker or stronger than Claude Code's default. Conflating model
quality with harness quality makes the score incomparable and lets a weak model
be blamed on the loop. The extracted harness mechanisms are the controllable
variable.

**What it costs.** The score needs a maintained eval suite and a live reference
run; weights can be gamed, so the rubric requires executable evidence per level
and a minimum per dimension.

**Reversal condition.** If a same-model head-to-head shows clone-ai passes at
least 95% of tasks while scoring below 85 on the checklist, reweight toward task
success; the checklist is then measuring things users do not value.

## 2026-11-06 — Worker concurrency follows measured machine capacity, capped by the Kernel

**Decision.** The Kernel samples CPU parallelism, load average and free memory,
computes a concurrent-worker limit, and gates every worker execution through a
shared limiter. The Main Agent can read the same snapshot through a read-only
`get_capacity` tool so it can size a plan, but it cannot raise the limit. An
owner may pin a ceiling with `maxConcurrentWorkers`; `0` or unset means auto.

**Why.** The owner asked for dispatch concurrency to follow memory and CPU so the
machine is used fully. Letting the model choose the number directly would make
concurrency depend on a sampled token rather than on the machine: it could
oversubscribe a laptop into swap or serialize a large workstation by mistake.
Measured capacity is deterministic, testable, and the same answer for every
caller; the model's role stays what it already is — deciding how much work to
propose.

**Evidence.** Before this change, `executeSubagents` ran every ready work order
with `Promise.all` and the queue started every queued Run in a tick, so the
degree of parallelism came from the plan shape alone. A 16-core host and a
2-core host behaved the same.

**What it costs.** A limiter adds queueing: a run can sit waiting for a slot
instead of starting immediately. Read-only subagents in one workspace still
share the workspace lock for writes, so same-workspace write steps stay serial
even when capacity is available.

**Reversal condition.** If runtime measurement proves wrong on the owner's
hardware (cgroups, container limits, or a noisy neighbour), let the owner pin
`maxConcurrentWorkers` and treat auto as advisory; or replace the formula with
an observed-throughput feedback loop. Never let the model set the hard cap.

## 2026-11-06 — The harness keeps only its own agents: no Pi SDK, no black-box CLIs

**Decision.** Remove the Pi Agent SDK and every black-box CLI worker (Claude
Code, Codex, the Pi CLI, opencode) from the code path. The Main Agent runs only
on the in-process native loop; every executing role runs only on the native
worker. The external role has no provider until a governed action connector
exists, instead of falling back to a CLI.

**Why — the owner's reasoning.** A sub-agent behind a CLI is not controllable:
its tool calls are invisible to the Kernel, its credentials live in that
process, and its safety rules are prompt text rather than gates. The Main Agent
is special: it must only dispatch tasks and assemble context, never execute, so
its loop, context assembly and tool surface must be ours and auditable rather
than delegated to an SDK. Keeping the CLI path as a fallback would preserve
exactly the behavior this change exists to remove.

**Alternatives rejected.** (1) Keep Pi as a fallback: the fallback becomes the
de facto path whenever the native endpoint is down, and the uncontrolled
behavior returns. (2) Keep CLIs only for external actions: external effects
would run with no receipt and no per-call gate, the highest-risk path. (3) Wrap
the CLIs in a policy proxy: still no per-call tool visibility.

**Evidence.** The native worker passes the full 5/5 reliability set with exact
usage; the native Main Agent matched Pi 15/15 across five samples and used fewer
tokens; both native paths stream, compact and record turn/tool/usage events. The
black-box path's audit stops at the process boundary.

**What it costs.** The Main Agent requires an OpenAI-compatible endpoint
(`CLONE_AI_NATIVE_*`); without it, turns fail clearly instead of degrading to
Pi. External actions are unavailable until a governed connector exists. CLI-only
capabilities (a coding agent's own tools, network access) are gone. Existing Pi
sessions and CLI worker settings are no longer usable; the turn ledger becomes
the conversation record.

**Reversal condition.** Add a replacement adapter only when it provides per-call
tool visibility, Kernel-gated execution and trusted receipts; a raw CLI, or an
SDK that owns the loop, is not a valid reversal. If the native endpoint cannot
be made reliable, the product is blocked rather than silently degraded.

## 2026-11-06 — The Main Agent comparison repeats each cell and reports medians

**Decision.** `npm run bench:main` runs each task/runtime cell N times (default
5), reports median and p90 duration, median tokens and pass rate, and writes
every individual run plus the aggregates to the result JSON. `--repeat 1`
restores the old single-sample shape.

**Evidence.** Two single-run passes on 2026-11-05 disagreed on which runtime was
faster: the native plan cell was 45.2s in one pass and 11.1s in the other, and
Pi's plan tokens were 8,977 vs 13,174. A one-sample cell cannot rank latency;
the median over repeats is the cheapest way to make the comparison meaningful,
and keeping every sample exposes the spread.

**What it costs.** N times the model calls and wall time (five repeats is about
five times the cost of one pass). The median can still mislead if the endpoint
is under load, so the report keeps every sample and a p90 alongside it.

**Reversal condition.** If recorded cassettes can replay the same prompts
deterministically, use them for latency and keep this only as a real-endpoint
sanity check.

## 2026-11-06 — The repair plan tells the worker how its step is judged

**Decision.** The phase-1 instructions now say the reproduction file must be
written before broad exploration, that the worker should read only the files
the case needs, and that every file left under `test/regression/` must be a
failing reproduction — diagnostic or probe files are not accepted. The
acceptance criterion states the same rule, so a passing probe cannot satisfy it.
Phase 2 is told the same: read the failing case and the production file it
exercises, make its first production write within four tool calls, leave no
scratch files, do not explore READMEs or repository directories, and do not
write a trade-off entry (the working agent did that before the run). Both phases are told they have no shell tool, because telling a
worker to "run npm test" it cannot run invites exploration instead of the edit.
The native worker's system prompt now states that a step requiring a file is not
complete until a write tool has succeeded, and that a summary claiming work that
never reached the workspace is a failure; phase 1 must make its first write
within three tool calls.

**Alternatives rejected.** (a) Raise the round budget again — the 24-round run
showed the model using the extra rounds to read more files, not to write;
another increase would buy more exploration, not a patch. (b) Leave only the
acceptance criterion — the model reads instructions, not the criteria list, in
practice. (c) Reject probe files in the lane after the fact — the lane cannot
tell a probe from a poor reproduction without running it, and the model can
still spend the whole budget before the lane sees anything.

**Evidence.** Two runs of the same trace with Magpie `360/deepseek/deepseek-v4.1-flash`:
`1dddd6b4` spent 12 rounds reading and wrote nothing; `426f3d3a` spent all 24
rounds reading (423,163 input tokens) and then wrote `probe-tmp.test.ts`, a file
that printed the tail of `memory.js` and passed. Both stopped at gates
(`regression-missing`, `not-red`). A third run (`f7e07553`) read 20 files, spent
28 rounds and 74,641 output tokens, and ended `completed` without a single
artifact, so the system prompt now refuses a summary that claims work no write
performed. The eval is the next lane run: the same trace should produce a
failing reproduction. Whether the wording is sufficient is measured there, not
assumed.

**Cost and reversal condition.** No runtime cost; the instructions are longer by
two lines. Reverse if workers start writing shallow tests that pass and the
"write early" pressure is the cause — in that case restore exploration guidance
and make the acceptance check stronger instead.

## 2026-11-06 — The native worker takes an explicit round budget

**Decision.** `CLONE_AI_NATIVE_MAX_ROUNDS` sets how many model round trips one
native step may spend before the client returns its "round limit" summary; an
unset or malformed value keeps the built-in default of 12. `CLONE_AI_NATIVE_MAX_TOKENS`
does the same for one completion's token count. The repair lane sets the round
budget to 32 through the worker environment, so a repair can read the failing
code and still write the case and the patch in the same step. The token cap was
first set to 16,000 after a single call held a step for over ten minutes; that
proved too low for the native worker's full-file `write_file`, because
`audit.js` (44 KB) and `app.js` (118 KB) cannot be rewritten inside it, so the
lane now uses 50,000.

**Alternatives rejected.** (a) Raise the hard-coded default to 24 for every
native call — a normal chat turn would then be allowed twice the tool calls,
widening the blast radius of a looping model for no measured benefit.
(b) Let the lane retry the step after a limit — the Kernel already ends a step
at its budget, and a retry would double the model spend without teaching the
worker anything. (c) Put "be brief" in the plan — an instruction cannot make a
12-round budget sufficient when the model legitimately needs to read five files.

**Evidence.** Repair run `1dddd6b4-a6dd-42b4-bc18-65b795b62148` (2026-11-06):
phase 1 spent all 12 rounds on `list_directory`/`read_file`
(89,845 input / 2,366 output tokens, 33 s) and wrote no file, so the lane
stopped at `regression-missing`. A later run on the same trace held a single
provider call open for more than ten minutes while a two-token request to the
same gateway answered in 1.9 s, which is why one completion now has a ceiling as
well. The evals are `test/native-client.test.ts` (the client stops at the
configured round count; the configured token cap reaches the request body;
malformed values are ignored) and the lane runs that follow each entry.

**Cost and reversal condition.** Each extra round is one provider call; the
budget is per step, not per run, so a repair's worst case doubles. Reverse
this if native steps routinely finish within 12 rounds (the knob then hides a
prompt problem), or if a 24-round step is observed looping without producing a
file — in that case the plan, not the budget, is the thing to fix.

## 2026-11-06 — Archiving a memory uses the cache the memory module actually owns

**Decision.** The memory library's archive/restore handler stops writing
`state.signatures.library` on a state object that has no `signatures` field; the
success path runs `refresh()` and the success message instead. The global
signature cache in `app.js` is invalidated by the refreshed data itself, not by
an assignment the module cannot make.

**Alternatives rejected.** (a) Add a `signatures` object to the module's own
state — it would silence the exception but leave a second cache that
`renderLibrary` never reads. (b) Delete the handler's success path — the list
would keep showing the old status. (c) Rely on the next 3-second poll — the
owner would see a raw JS error and a stale row for at least one cycle.

**Evidence.** `memory.js` declares its own `state` without `signatures`; the
`[data-mem-status]` handler assigns `state.signatures.library` after a
successful PATCH, so the TypeError is caught by the handler's catch, which
announces the raw message and skips `refresh()`. A vm run of the real module
with a stubbed `api` reproduces it: refresh count 0, announcement
`Cannot set properties of undefined (setting 'library')`.

**Cost and reversal condition.** The archive/restore path refreshes immediately
instead of waiting for the poll; no extra request beyond the existing refresh.
Reverse if the module grows its own signature cache for a reason (then assign
to the field that exists and document why two caches are needed).

## 2026-11-06 — The repair lane re-runs the hashed regression cases after the fix

**Decision.** After the fix phase and the hash comparison, `clone-ai repair` runs
the same hashed cases once more and requires them to pass. A failing run stops
the lane with the new `regression-still-red` gate; the result is recorded as
`regressionAfter` in the report. The full suite and the typecheck still run
afterwards.

**Alternatives rejected.** (a) Trust the full suite — in this repository
`npm test` is `node --test test/*.test.ts` and does not include
`test/regression/`, so the false-fixed run passed without touching production
code. (b) Trust the hash comparison — it proves the case was not edited, not
that it passes. (c) Rely on the case being in the suite — that is a
repository-specific accident, not a lane invariant.

**Evidence.** Run `d8c54037` / fix run `4accee4b` (2026-11-06): phase 2 wrote no
artifact, the staged diff held only `.probe/*`, `node_modules` and the
regression case, and the lane reported fixed; running the case afterwards still
failed. The lane's own `npm test` output in that report was green because the
new case is outside its glob. `test/repair.test.ts` now has a no-op-fix case
that expects `regression-still-red`, and a unit case for the green check.

**Cost and reversal condition.** One extra invocation of the new cases (a
fraction of a second in this repository) and a clearer failure. Reverse if the
cases become part of the suite **and** the suite can report them separately, or
if a regression case is too slow to run twice — then run the case once after the
fix and drop the duplicate suite run, not the check.

## 2026-11-06 — Repair staging removes known runtime scratch, not arbitrary files

**Decision.** `stageRepair` stages everything, then unstages a fixed list of
runtime scratch: `node_modules` (including the symlink), `.probe/`, `.rsi/`,
`.clone/`, `.work-orders/`, `.verification-baseline*`, `*.log`, `*.tmp`. The
protected-path gate then sees every other change, including new files.

**Alternatives rejected.** (a) `git add -A` alone — it staged the `node_modules`
symlink and `.probe/` in run `d8c54037`. (b) Stage only tracked files plus new
`test/regression/` files — the first implementation of this fix; it silently
dropped a new protected file, and the existing protected-path regression test
caught it. (c) Extend the repository's `.gitignore` — a lane that depends on the
target repository's ignore file fails on another repository, and a `node_modules/`
entry still does not match a symlink.

**Evidence.** `d8c54037`'s commit carried `.probe/lines.txt`, `.probe/measure.txt`,
`.probe/one.txt`, `.probe/ten.txt`, `node_modules` and the case. The
protected-path test in `test/repair.test.ts` fails against the "regression files
only" variant and passes with the deny-list. A second case asserts that
`node_modules` and `.probe/junk.txt` never appear in the staged diff.

**Cost and reversal condition.** A stray scratch file under another name would
enter the diff; it is visible in `changed` and in the owner's review, which is
why the list is deliberately short. Reverse if scratch names proliferate: move
the list into a shared manifest or give the worker a scratch directory outside
the workspace, rather than widening this function.

## 2026-11-06 — The native worker gets a targeted edit tool

**Decision.** `fileTools()` adds `edit_file`: replace exactly one occurrence of
`old_text` with `new_text`, refusing empty, missing or ambiguous excerpts, and
refusing an edit that shrinks the file to less than a tenth of its size. Phase 2
is told to prefer it for an existing file. `write_file` now refuses a path that
already exists, so the only way to change an existing file is a named excerpt;
it still creates new files.

**Alternatives rejected.** (a) Keep whole-file `write_file` only — a repair of
one line in the 118 KB `apps/desktop/ui/app.js` replaced it with an 8 KB
fragment (observed 2026-11-06). (b) A unified-diff or patch parser — more input
to validate, and a malformed patch fails less legibly than one exact excerpt.
(c) Line-number replacement — line numbers drift as the worker reads; an exact
excerpt is self-checking. (d) Let `write_file` replace existing files and rely
on the size guard — the guard's 10% floor allowed a 127-line deletion from
`audit.js` (36 KB) in the 2026-11-06 rerun; the patch was refused by the red
check, but the file in the worktree had already lost functions the case never
loaded.

**Evidence.** In the plain-preview attempt, phase 2 wrote an 8 KB `app.js`
containing only the functions the case slices; `npm test` and `tsc` do not load
that browser script, so the lane was ready to call it fixed. In the audit rerun,
`write_file` replaced 127 lines of `audit.js`; the post-fix case still failed, so
the lane refused the patch, but the worktree file was already damaged. The size
guard and single-occurrence requirement would have refused the first; refusing
existing paths refuses both. `test/native-client.test.ts` covers replacement,
missing text, ambiguity, the shrink guard, and `write_file` refusing an existing
path.

**Cost and reversal condition.** One more tool entry and one read of the target
file per edit; a legitimate edit that removes more than 90% of a file is
refused (a full-file replacement must use `write_file`). Reverse if exact-excerpt
edits fail often on large files (add a diff-apply tool), or if the shrink guard
blocks a legitimate rewrite (raise the threshold, do not remove the check).

## 2026-11-06 — Sidebar previews keep identifier underscores

**Decision.** `plainPreview` treats underscores as emphasis only at word
boundaries, so `some_variable_name` survives in the sidebar and session header;
asterisk emphasis is unchanged.

**Alternatives rejected.** (a) Drop underscore emphasis entirely — `_text_` is
a normal way to write emphasis, and dropping it would stop rendering it.
(b) Render the previews as Markdown — the sidebar is one line; full Markdown
there costs a parser and re-introduces the wrapping the preview exists to avoid.

**Evidence.** `plainPreview` applies `/(\*|_)([^*_\n]+)\1/g` to the whole string
(`apps/desktop/ui/app.js`), so `check some_variable_name first` becomes
`check somevariablename first`. Agent replies about code routinely contain
identifiers.

**Cost and reversal condition.** One more boundary condition in an existing
regex; no new dependency. Reverse if the stricter rule leaves legitimate
emphasis unrendered in a way owners notice, or if previews move to rich text.

## 2026-11-06 — A hidden conversation keeps its restore control

**Decision.** `renderSessions` renders the "已隐藏" group (with its restore
button) even when the visible session list is empty, instead of returning early
to the empty state.

**Alternatives rejected.** (a) Keep the early return and rely on the audit view
— the audit view knows deleted run ids, not the conversation entry in
`deletedConversations`, so it cannot restore the conversation. (b) Show the
empty state and the hidden group side by side — the empty state's text says
there is nothing, which is false when a hidden conversation exists; the hidden
group replaces it.

**Evidence.** `renderSessions` returns after painting `empty-sessions` when
`sessions.length === 0`, while the hidden block is built afterwards
(`apps/desktop/ui/app.js`). Hiding the only conversation leaves no
`data-restore-conversation` in the sidebar. A vm run with an empty list and one
deleted conversation reproduces it.

**Cost and reversal condition.** One branch moved; no request. Reverse if the
product decision changes to offering hidden conversations only in the audit
view (then remove the sidebar control entirely rather than leaving it
unreachable).

## 2026-11-06 — The audit dispatch block reads the events that carry steps

**Decision.** The audit view's "Worker 派发" block renders `dispatch.steps_assigned`
payload assignments (stepId, agentId, reason) as one row per step, keeps the
task-level `dispatch.decided` row as the authorization summary, and shows
`dispatch.blocked` with its code and reason instead of the "no dispatch record"
message.

**Alternatives rejected.** (a) Keep reading only `dispatch.decided` and accept
"步骤 —" — a multi-worker plan then has no view that answers which worker ran
which step. (b) Read the raw trace payload only — the block exists to answer the
question without opening raw JSON.

**Evidence.** `JournalDispatchRecorder` writes a task-level decision with no
`stepId`, a separate `dispatch.steps_assigned` with `assignments`, and
`dispatch.blocked` with `code`/`reason` (`src/main-agent/dispatch-recorder.ts`).
The UI's `dispatchBlock` only filtered `dispatch.decided` and read
`payload.stepId` (`apps/desktop/ui/audit.js`). The regression cases run the real
audit view in a vm with those payloads and fail on the old code with "步骤 —"
and "这次运行没有派发记录".

**Cost and reversal condition.** The block now reads up to three event types
from the trace it already fetched; no new request. Reverse if the trace API
stops returning `dispatch.steps_assigned` (the block would then be empty for
multi-step plans) or if a future router records per-step assignments on
`dispatch.decided` itself.

## 2026-11-06 — The effort select reads the gateway list that exists

**Decision.** `renderMainAgentEffort()` resolves the gateway from
`state.gateways` (the array the client actually writes) and re-renders after
`refreshGateways()`, so the reasoning levels offered are the ones the Magpie
model declares.

**Alternatives rejected.** (a) Keep the generic level list — it offers levels
the gateway does not serve and hides the ones it does. (b) Add a second
`state.gateway` field written alongside `state.gateways` — two names for one
value drift, and the array is what every other view uses.

**Evidence.** `state.gateway?.models` was read in `renderMainAgentEffort`,
while the client state declares only `gateways: []` and every writer uses it
(`apps/desktop/ui/app.js`). A vm test with `state.gateways` set and
`reasoningLevels: ["low","high"]` shows the old select rendering
off/minimal/low/medium/high/xhigh/max.

**Cost and reversal condition.** One lookup instead of a field read; no new
request. Reverse if the gateway data moves to a single object (then use that
object) or if a model's declared levels are wrong more often than the generic
list is useful — the fallback list must stay for models the gateway does not
describe.

## 2026-11-06 — A repair may not delete more than forty production lines

**Decision.** After staging, the lane counts the deleted lines per path and
refuses a fix that removes more than 40 lines outside `test/regression/`
(`fix-too-large`). A small fix removes a few lines; a rewrite removes dozens.

**Alternatives rejected.** (a) Raise `edit_file`'s shrink floor — a 56% and a
90% rewrite both passed it; a floor high enough to catch them would also block
legitimate small rewrites. (b) Restrict the size of `old_text` — a 17% block
(audit's 127 lines) still passes, and a legitimate change can span a large
block. (c) Trust the case and the suite — the case only exercises the functions
the model kept, and the suite and typecheck do not load browser scripts.

**Evidence.** On the 2026-11-06 rerun, `memory.js` was replaced with 2 added and
127 deleted lines, and `audit.js` with 4 added and 315 deleted lines; the cases
for the remaining functions went green, and nothing else in the repository
loads those scripts. The merged memory and sidebar fixes delete 2 and 1 line.
`test/repair.test.ts` covers a 100-line rewrite refused as `fix-too-large` and
confirms test-case lines are excluded from the count.

**Cost and reversal condition.** A legitimate repair that removes more than 40
production lines is refused and must be applied by the owner or split into
smaller edits. Reverse if real repairs routinely exceed 40 deletions: raise the
threshold or let a trace declare a larger allowance, rather than dropping the
count.

## 2026-11-06 — The memory library keeps a focused editor across background refreshes

**Decision.** The memory library (`apps/desktop/ui/memory.js`) must not rebuild
`#memory-root` when the periodic 3-second dashboard refresh hands it a library
that has not changed, and must never discard a focused search field or an
unsaved editor while the owner is typing. The background poll may update data,
but it may not replace the DOM under the owner's caret.

**Alternatives rejected.** (a) Slow the poll for this panel — the refresh is
shared with the rest of the dashboard, and a slower poll only widens the window
in which a keystroke is lost. (b) Remove the search/edit controls — they are the
reason the layered view exists. (c) Keep the rebuild and restore focus after it —
a restored caret still loses the keystroke that arrived during the rebuild and
cannot recover unsaved textarea content.

**Evidence.** `refresh()` in `apps/desktop/ui/app.js` runs every 3000 ms and
calls `renderLibrary(library)`; the wrapper added at the end of `memory.js` calls
`render()` unconditionally, and `render()` assigns `root.innerHTML` on every call
(`memory.js:178`). The existing "do not redraw while typing" guard in
`app.js:renderLibrary` only covers `#library-list`, `#library-new-*` and
`.memory-tools`, not the newer `#memory-root`. Reproduction: open Settings →
Memory, type in `[data-mem-query]`; within three seconds the input is replaced
and loses focus. The same rebuild replaces an open editor's textarea with the
stored content. This is **observed by code inspection**; the regression case is
produced by the repair lane and run before the fix.

**Cost and reversal condition.** Skipping an unchanged render costs one JSON
comparison per poll (the same signature check `app.js:renderLibrary` already
uses). If the panel later needs a live view that changes without a library
change (a clock, a running job), that view must update through its own explicit
render rather than by rebuilding the whole root — reverse this entry if the
signature check starts hiding real updates.

## 2026-11-06 — Settings speak in workers, and dispatch is visible

**Decision.** Remove the legacy "local providers" registry from the Agent settings page and fold its facts (installed, command, execution boundary, install action) into each worker row. Make the settings navigation a real tab list — `role=tablist/tab/tabpanel`, `aria-selected`, arrow/Home/End keys, focus follows selection, per-panel scroll memory, a 120 ms fade/slide that honours `prefers-reduced-motion`. Add a "Worker 派发" block to a run's audit detail showing, per step, the chosen worker, its provider, the routing source (explicit / rule / memory / description) and the reason, read from the journal's `dispatch.decided` events.

**Alternatives rejected.** (a) Keep the provider list and rename it "runtime" — two lists of the same machine, and the owner still has to translate between them. (b) Move provider controls to a separate settings page — hides the install and execution-boundary facts from the worker they govern. (c) Show dispatch only in the raw trace — it exists there, but "why did this step go to that worker?" is a first-class question, not debug detail.

**Evidence.** Owner feedback that the settings interactions feel abrupt and that the provider list is historical; the dispatch decision already journals `selectedAgentId`, `providerId`, `source` and `reason` (`src/main-agent/dispatch-recorder.ts`), so the new block adds no data. Deterministic checks: `test/ui-structure.test.ts` asserts there is no `provider-registry` section, that settings tabs expose tab semantics, and that the audit view renders a dispatch block.

**Cost and reversal condition.** The worker row grows by one line of metadata; removing the provider section removes the only place listing a provider that has no worker bound to it. Reverse if an owner needs to manage a provider before binding any worker, or if the tab semantics break in the packaged WebKit build.

## 2026-11-06 — The repair lane is a clone-ai Run, not a script driving another CLI

**Decision.** `clone-ai repair` performs the repair as a real Run inside the
Kernel: it accepts a trigger, attaches a two-phase plan, and executes it with
the workers the owner has configured (a black-box CLI worker, or any other
registered adapter). The lane keeps the existing gates from `scripts/nightly-rsi.mjs`
(the regression test is verified red before the fix, test files are hashed, the
staged diff may not touch protected paths) by importing
`scripts/nightly-rsi-policy.mjs` and `scripts/nightly-rsi-state.mjs` rather than
forking them, and it adds the worktree isolation, red-verification and hashing
as deterministic gates the application applies around/after the Run.

**Alternatives rejected.** (a) Keeping `claude -p` as the executor — AGENTS.md
§4 then describes a rule the system cannot satisfy, and the repair is performed
by a product that is not clone-ai. (b) A native (in-process, OpenAI-compatible)
repair worker as the mandatory executor — it would make the lane cheap to test
but bind the repair loop to one provider and to `CLONE_AI_NATIVE_*` configuration
that is absent on most machines; it remains available as a configured worker.
(c) A new, self-contained policy module for the lane — a second copy of the
protected-path list would drift from the one the nightly script enforces.

**Evidence.** Code inspection: `scripts/nightly-rsi.mjs` builds prompts and spawns
a binary, so neither the Kernel's approval, verification nor journal participates
in the repair. Its safety gates are imported here unchanged and covered by the
existing `test/nightly-rsi.test.ts` assertions. Deterministic tests prove each
lane gate with fake adapters (`test/repair.test.ts`). A real two-phase repair
needs a configured worker and an authorized failing trace; whether a configured
model produces an acceptable patch remains **assumed**, not measured here.

**What was given up.** The lane now inherits the Kernel's worker configuration
and its adapter contract, so a machine with no installed worker CLI cannot
repair, whereas the old script only needed `claude` on PATH. Black-box workers
never report `test` evidence, so a red-verification step that *checks* the tests
must be performed by the application around the Run, not by the verifier — the
Run's own steps are scoped to writing files.

**Reversal condition.** If the Kernel path proves unable to express a repair
(needs far more steps than a plan, or the adapter contract cannot carry the
hashes), return the two phases to a script but keep the trace export and the
policy module shared. If measurements show the configured worker cannot repair
real traces at an acceptable rate while a direct native client can, make the
native adapter the default executor instead of the fallback.

## 2026-11-06 — MCP tools are opted in per server and pass the same gate as built-ins

**Decision.** Add a small MCP client (stdio, plus streamable HTTP) that reads
`<clone home>/mcp.json`. Every server is disabled unless the owner writes
`"enabled": true` for it. MCP tools are converted to `NativeToolSpec`s carrying
an explicit risk (`read`, `write`, `network`, `external`) and are offered to a
worker only when `decideTool` accepts that risk against the step's grants; a
tool call that names a path is checked per call exactly like `read_file`. MCP
output crosses the observation boundary (`sanitizeObserved`, the same sanitizer
`renderObservationsAsFacts` uses) and reaches the model as quoted data.
Providers that cannot take `--mcp-config` (the native in-process worker, codex,
pi) simply receive built-in tools only.

**Alternatives rejected.** (a) An SDK dependency (`@modelcontextprotocol/sdk`)
— the protocol we need is one JSON-RPC request per tool (`initialize`,
`tools/list`, `tools/call`) over stdio or HTTP; a dependency would be justified
only once resources, prompts, sampling, or OAuth are in scope. (b) Enabling
every configured server by default — an MCP server is a tool surface the owner
did not write; enabled-by-default would silently widen what a model can do.
(c) Granting MCP tools network access by default because the transport is
network — the risk belongs to the tool's declared behavior, and the owner's
config states it per tool.

**Evidence.** Code inspection: today's tool table is built only from
`src/main-agent/tools/kernel-tools.ts` and `src/workers/native-worker-factory.ts`,
and the native worker already refuses ungranted risk (`decideTool`). Tests cover
disabled-by-default, refusal when a granted scope does not exist, offering when
it does, and output framing (`test/mcp.test.ts`). Whether a real third-party MCP
server's tools are useful under these risks is **assumed**.

**What was given up.** A server must declare each tool's risk in `mcp.json`
(the lane never guesses: an undeclared tool is treated as `external` and
refused). Tool results are text only — images and structured content are
stringified. A crashed server is reported as a tool error, not retried.

**Reversal condition.** Revisit if a real MCP server needs resources or prompts
(use a maintained SDK rather than extending this client), or if owners routinely
mark every tool `read` to avoid configuring risks — then risk must come from a
signed server manifest, not from owner config.

## 2026-11-05 — Self-check rebuilds the local macOS app

**Decision.** On macOS, `selfcheck:push` rebuilds and replaces
`dist/Clone AI.app` after tests, typecheck and gate pass, before pushing.

**Evidence.** The running app kept showing old UI after source edits because
the bundle is a packaged UI plus sidecar and does not hot reload. A stale app
made fresh audit and IME fixes invisible.

**Cost and reversal condition.** The check becomes slower and requires the
macOS build toolchain. If development moves to a live-reload runtime, remove
the bundle rebuild from this path.

## 2026-11-05 — Native worker is the default for eligible roles when configured

**Decision.** When `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` are
set, the default agent catalog uses `providerId: "native"` for direct, research,
draft and review. `external` keeps the CLI default because the native worker has
no governed action connector. Without the endpoint, the CLI defaults remain. A
provider id the owner has saved in settings always wins over the default.

**Evidence.** The native worker passed the 5/5 reliability benchmark (including
the expected `no_artifact` failure), enforces scopes at each tool call and
reports exact usage. The default catalog is used only when no settings file
exists or for agents the owner has not changed; saved choices are preserved.

**What it costs.** Default agents now depend on the native endpoint being up;
the native worker has file tools only (no network or external actions); an owner
who relied on the implicit Claude/Codex/Pi default for these roles will see a
different worker unless they save a choice.

**Reversal condition.** If the native worker regresses on the benchmark, or a
role needs a tool it does not have, restore the CLI default for that role.

## 2026-11-05 — Native Main Agent is the default when configured

**Decision.** With `CLONE_AI_MAIN_RUNTIME` unset, the Main Agent uses the native
loop when `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` are present, and
Pi otherwise. `CLONE_AI_MAIN_RUNTIME=pi` forces Pi; `=native` forces the native
loop and fails clearly if the endpoint is unconfigured. An explicit `native`
never silently falls back to Pi.

**Evidence.** The native loop now matches Pi on the short-task comparison (3/3
both, tokens within ~1.6%), and passed live long-context compaction and image
validation. It has streaming, deterministic compaction and image attachments.
The endpoint is an explicit owner configuration, so using it when present is not
a guess; using Pi when it is absent keeps existing installations working.

**What it costs.** Two runtimes remain to maintain, and the unset case is a
soft, environment-dependent default rather than a hard switch. An owner without
an OpenAI-compatible endpoint stays on Pi until they configure one.

**Reversal condition.** If the native loop regresses on the benchmark or the
turn audit, restore Pi as the default and keep native strictly opt-in.

## 2026-11-05 — Native Main Agent accepts image attachments

**Decision.** The native Main Agent sends image attachments as OpenAI-style
`image_url` data URLs in the current user message, alongside the text part. The
Pi-versus-native switch therefore no longer removes a capability. Images are
per-turn: they are not persisted in the turn ledger, so `search_history` finds
the text, not the pixels. No downscaling is done in this version; an endpoint
that rejects a large payload fails the turn with its own error.

**Evidence.** The main branch added media attachments to the Main Agent, while
the native branch explicitly refused images; switching `CLONE_AI_MAIN_RUNTIME`
silently removed a feature. Magpie's catalog advertises image input for the
models used here, and the OpenAI-compatible content-parts format is what the
native client already speaks.

**What it costs.** Base64 images inflate the request and the prompt token count;
a very large image can exceed an endpoint's body limit. The full image is not
recoverable from the ledger later.

**Reversal condition.** If payload size becomes a practical limit, store
attachments as content-addressed files under the clone home and send file URLs
when the endpoint supports them, or downscale before encoding. If image history
must be searchable, persist attachment locators in the turn event.

## 2026-11-05 — Native Main Agent streams and compacts deterministically

**Decision.** The native Main Agent requests SSE streaming with
`stream_options.include_usage`, forwards content deltas to `onDelta`, assembles
tool-call deltas by index, and parses the final usage chunk. When the transcript
exceeds `historyChars` (default 12,000), older turns are replaced by a bounded
deterministic summary; the newest turns stay verbatim. Full text remains in the
turn ledger and is reachable through `search_history`.

**Evidence.** The flag-gated native loop was non-streaming, so the interface
looked frozen until a whole round finished, and it kept only the last 12 turns
with no compaction. Magpie returns OpenAI-style SSE chunks and a final usage
chunk when `include_usage` is set, so both fit the existing client.

**What it costs.** The summary is extractive and truncated rather than
model-written, so it preserves topics and decisions less well than Pi's
generated summary. Streaming tool-call fragments add parser complexity, and a
malformed stream fails the turn with a clear error instead of guessing.

**Reversal condition.** If long-conversation quality suffers, replace the
deterministic summary with a model-written compaction step (one extra call) and
keep the deterministic one as the fallback when that call fails.

## 2026-11-05 — A native Main Agent loop behind a flag, not a flag day

**Decision.** Add an in-process Main Agent runtime selected by
`CLONE_AI_MAIN_RUNTIME=native`. It compiles the same charter, situation
briefing, executor list and memory push; offers the same Kernel tools through a
plain descriptor list; talks to an OpenAI-compatible endpoint named by
`CLONE_AI_NATIVE_*`; uses the turn ledger as its transcript; and writes the same
prompt snapshot, turn events, tool events and usage records. Pi remains the
default and the fallback. The first native loop is non-streaming and keeps the
last N turns without compaction.

**Evidence.** Pi is the Main Agent's last hard SDK dependency: it owns the loop,
the session file, compaction and `search_history`, while the Kernel already owns
tools, policy and completion. The native worker proved the same in-process,
per-call scope model works. A flag lets the two runtimes be compared on the
benchmark and through the turn records before any default changes.

**What it costs.** No streaming or compaction in the first phase; images are
refused under the native flag; the transcript is the turn ledger, so
`search_history` searches the ledger instead of Pi session files; the model must
be an OpenAI-compatible endpoint; native turns are not resumable as Pi sessions.

**Reversal condition.** If the native loop cannot match Pi on the benchmark and
the turn audit, keep Pi as the default and remove the native path. If streaming
or compaction is the blocker, add it before flipping the default.

## 2026-11-05 — A missing named input fails the native worker instead of allowing invention

**Decision.** If a read tool fails on a path named in the work order's objective
or the step's instructions, the worker ends the turn as `no_artifact` with
signature `native-missing-input`; artifacts produced after that read are not
accepted. A failed read on a path the instructions do not name is still returned
to the model so it can retry. The worker's prompt also tells the model to stop
and report a missing required input instead of inventing its contents.

**Evidence.** The `missing-input` benchmark task asks the worker to read
`docs/absent.md` and write `out/summary.md`. On 2026-11-05 the native worker read
the absent file, received ENOENT, then wrote an invented 90-byte summary and
passed verification; Claude failed cleanly at verification. The loop's
resilience to one bad call is right for a retry, but wrong for an input the task
declared as required.

**What it costs.** A task that names a path that is legitimately optional and
absent now fails. Instructions must name required inputs; the model may still
spend tokens before the guard fires.

**Reversal condition.** If real tasks routinely name optional paths, narrow the
rule to declared work-order inputs or an explicit `requiredInputs` field; do not
remove the failure on a required input.

## 2026-11-05 — The native worker becomes a provider with exact usage, still opt-in


## 2026-11-05 — Every Agent invocation is audited outside CLONE_HOME

**Decision.** Every Main Agent invocation writes a shared append-only record
under `~/.clone/audit/invocations.jsonl`, independent of the invocation's
`CLONE_HOME`. The record carries caller, surface, visible request and reply,
error, workspace, data directory, model, effort, session file, Run ids and
duration. An explicit `CLONE_AI_AUDIT_HOME` can relocate it for controlled
deployments and tests.

**Evidence.** Self-fix runs used a temporary `CLONE_HOME`; their journals were
correct but invisible to the desktop audit, which reads the owner's normal
home. After this change, a real DeepSeek V4.1 Flash `high` turn launched with
an isolated home appeared in the shared default ledger with caller `codex` and
reply `OK` (invocation `7cb576ee`).

**Cost and reversal condition.** This is a second storage location and the
visible reply is sensitive data; it is PII/token-redacted, truncated, and
excludes private reasoning. Replace it with an encrypted owner-scoped store if
the plaintext JSONL no longer meets the threat model.

## 2026-11-05 — Require explicit intent for root-level file names

**Decision.** `native` is registered in the provider catalog, so an owner can
select it per agent like any CLI. The adapter's id is the configured agent id
and its `providerId` is `native`; its capabilities come from the agent role,
with external effects excluded. Its model client reports exact token usage per
model call, which the Kernel journals as `usage.recorded` with runId and stepId.
It still requires `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL`; it does
not become the default.

**Evidence.** The worker already existed and enforced scopes at each tool call,
but it was invisible to settings (only a special case in the agent registry),
reported no usage, and its adapter identity was literally `native` rather than
the configured agent. The turn/run audit can now carry exact usage; leaving the
native path unmeasured would make any CLI-versus-native comparison impossible.
**Evidence.** The nightly repair trace reported a false failure when the
verifier interpreted `fs.rename`, `os.tmpdir`, `consumed-traces.json`, and
`REPORT_DIR/consumed-traces.json` as required workspace files. Source
inspection shows the previous extractor accepted dotted tokens without those
distinctions. The targeted offline regression tests pass after the change;
broader coverage remains a hypothesis. No before-change eval was run under
this work order.

**What it costs.** The owner must configure an OpenAI-compatible endpoint; the
worker has no external-action tools, so `external` stays with governed
connectors; token counts depend on the endpoint returning a usage block.

**Reversal condition.** If endpoints rarely report usage, keep the gateway's
time-window inference as the fallback and mark exact usage unavailable. If the
native loop proves less reliable than a CLI on the benchmark, keep the CLI as
the default and native as opt-in.

## 2026-11-05 — Every Main Agent turn is a journal record, not a side file

**Decision.** Every entry point — CLI, `npm run main`, the companion/server, and
WhatsApp — writes the same two journal events for a turn:
`main_agent.turn_started` and `main_agent.turn_completed`. Each tool the Main
Agent calls also writes `agent.tool_started` / `agent.tool_completed`. The turn
record carries the input and reply (PII-redacted and capped), model, provider,
reasoning effort, token usage, prompt material hash, tool calls with redacted
argument summaries, and the terminal status. The existing
`main-agent-turns.jsonl` ledger is written by the same module, so the UI and the
journal cannot disagree.

**Evidence.** Before this change, CLI and `npm run main` wrote only a prompt
snapshot; the companion wrote a side JSONL that the audit never read; the Pi
`tool_execution_*` events were never subscribed to; and `usage.recorded` had no
turn id. A task an agent ran through `clone-ai "..."` could therefore leave no
auditable input, reply, tool call, or model usage. The journal is the
append-only truth, so turn data belongs there rather than in a second log.

**What it costs.** Input and reply text increase journal size. They are redacted
and capped, and the full transcript remains in the Pi session file named by the
event. Tool arguments are stored as a redacted summary, not verbatim.

**Reversal condition.** If journal growth becomes material, move the text to a
content-addressed turn file (the prompt-snapshot pattern) and keep only its hash
and locator in the event. If redaction proves insufficient for tool arguments,
store the tool name and a hash only.

## 2026-11-05 — Recover planning orphans only after a conservative grace period

**Decision.** Fail a planning Run only if it has no plan, no live claim, and
its last update is more than 15 minutes old. Acquire a recovery claim and
atomically reject the failure if the Run changed since the refreshed projection.
Leave stores that cannot make that conditional fenced write untouched. Do not
change recovery of running or verifying Runs.

**Evidence.** Recovery currently scans only `running` and `verifying`; a
planner that dies before producing a plan can leave a Run in `planning`
indefinitely. Assuming 15 minutes is sufficient for ordinary unclaimed
planning is conservative but not measured; an active planner without a lease
can still exceed it. Immediate failure or age alone would endanger fresh or
claimed work. Rechecking only in memory would allow a concurrent plan or
cancellation to be overwritten before the failure is written.

**Reversal condition.** If observed legitimate unclaimed planning takes more
than 15 minutes, replace the timeout with a reliable planner lease or adjust
the threshold based on measured durations before enabling this recovery.

## 2026-11-05 — Prompt provenance is a content-addressed file plus a journal event

**Decision.** Every Main Agent turn records the charter version, the compiled
briefing, the exact registered tool table, the model id, and the reasoning
effort. Full material goes to `<clone home>/prompt-snapshots/<materialHash>.json`;
the journal receives one `main_agent.prompt_snapshot` event carrying the hashes,
the locator, and (for desktop turns) the turn id.

**Evidence.** Before this change the journal could say what the agent did and
what it recalled, but not what it was told: `MAIN_AGENT_CHARTER` is a constant,
the situation briefing existed only in memory for the life of a session, and
the tool table existed only inside the Pi session. A failed turn therefore could
not be attributed to a prompt revision, and two "improvements" could not be
compared against a baseline. The journal is already the append-only truth
([`state-projector.ts`](../../src/state/state-projector.ts) rebuilds state from
it), so provenance belongs there rather than in a second log.

**Reversal condition.** If the journal becomes the wrong home for turn-level
telemetry (for example, retention rules require runs and turns to expire on
different schedules), move the events to a dedicated store keyed by the same
`materialHash`; the hash scheme and the file layout do not depend on the journal.

## 2026-11-05 — Tool provenance is captured at registration, not maintained as a list

**Decision.** `createKernelToolsExtension` reports every tool through an
`onRegister` callback at the moment it registers it. The hash covers the names,
descriptions, and parameter schemas the model actually received.

**Evidence.** A hand-maintained list of tool names is a second source of truth
that drifts silently the first time a tool is renamed or added — exactly the
kind of invisible change provenance exists to expose. The callback sees the
registered object itself, so it cannot disagree with the session.

**Reversal condition.** If tools can be registered outside
`createKernelToolsExtension` (a second extension factory, or MCP-hosted tools),
the registration choke point no longer covers the whole table; the snapshot must
then read the tool list from the session rather than from the callback.

## 2026-11-05 — The regression gate is offline, per-case, and behavior-only

**Decision.** `npm run gate` re-runs evidence verification and authority policy
over held-out fixtures, calibrates audit records against owner labels, and
compares every case with a recorded baseline. It calls no model and is a
required CI step.

**Evidence.** This repository's guarantees live in the rules around the model:
completion comes from evidence, authority from scopes, and owner labels from
`audit.labeled`. Those layers are deterministic, so a zero-cost gate can cover
them on every commit. A provider-dependent eval would be skipped precisely when
CI is under pressure.

**Reversal condition.** If recorded trajectory cassettes can be replayed without
network access, add a trajectory suite beside the deterministic one. The
per-case baseline remains valid for the judgment layers regardless.

## 2026-11-05 — A verdict change fails the gate even when it is an improvement

**Decision.** `baseline.json` stores each case's current outcome; any difference —
pass to fail or fail to pass — fails until `--write-baseline` is run in the same
change.

**Evidence.** An improvement that arrives without its diff being reviewed is
indistinguishable from a regression that happens to look better on the fixture
set. Requiring the baseline update forces the reviewer to see the behavior delta
and its rationale.

**Reversal condition.** If baseline churn starts to dominate review, split it by
suite or add an explicit per-case intent note; do not switch to silent
auto-update.

## 2026-11-05 — Workers inherit model credentials only, never tool credentials

**Decision.** A provider declaration may name the credentials its model client
needs. Any tool credential (`GITHUB_TOKEN`, `AWS_*`,
`GOOGLE_APPLICATION_CREDENTIALS`, `*_SECRET`, …) is refused before launch, with
an error that points at the credential broker.

**Evidence.** A black-box worker with a shell and a token can do anything that
token allows; the model needs its API key to answer, but it does not need the
owner's source-host or cloud credentials. The check runs at build time, before a
process exists, so a bad declaration cannot leak into a running worker
(`test/worker-env.test.ts`).

**What it costs.** A worker that genuinely needs a tool credential cannot be
configured by inheritance; it must go through the broker.

**Reversal condition.** If a trusted, narrowly scoped operation needs a tool
credential, add per-call broker injection after Kernel authorization; do not
re-enable inheritance.

## 2026-11-05 — Consistency is measured, and the first run failed three of four

**Decided:** `npm run bench:consistency` runs four consistency scenarios and two
restraint scenarios against the real recall + context + attention path.

**What the first run measured.** 1/4 consistency scenarios passed and 100% of
irrelevant observations became interruptions. The three failures were real:

- a moved meeting and the old time both reached the context;
- a changed preference competed with the previous one;
- a stated preference was not recalled at all against a long question.

**What was changed in response.**

- Preferences may be recalled below the product floor (0.08 instead of 0.2),
  but only on a *distinctive* match — a term shared by at most a quarter of the
  library. Measured: without the distinctiveness check the lower floor made an
  idle memory look used and defeated idle archival. Function-word bigrams
  (必须, 应该, 时候) were added to the same exclusion the Latin stopword list
  already applied.
- A newer memory using an explicit replacement verb (改到, 改用, 不再, "changed
  to") retires an older memory of the same type that shares a substantive term,
  **in the context only**. Similarity alone does not do it: "周五下午三点开会" and
  "周五的会改到周四下午" share two tokens of a dozen, so the verb is the signal.
- Observations earn an interruption only when their text asks for a decision
  (截止, 确认, due, invoice …). Everything else is background.

**What was given up.** A memory that supersedes another without saying so
("会改期了" with no verb) still leaves both in the context. An urgent-looking
message with none of the signal words is missed. Both are recorded, not hidden.

**Reversal condition.** Any of the three scenarios regressing is the signal to
revisit its fix; a semantic comparator would let the supersede rule drop the
verb requirement.

## 2026-11-05 — In-step resume: deliberately not built

**Decided:** a worker that dies mid-step is restarted whole (when replay-safe)
or failed; no adapter resumes inside a step.

**Why.** The two boundaries that matter are already enforceable — the step and
the run. Resuming *inside* a step means trusting a worker's claim about how far
it got, which a black-box CLI cannot make and a native worker would have to
commit to a checkpoint protocol before every side effect. The current policy
(re-queue only when replay-safe; fail when the work was external or
mid-verification) is the conservative reading of the same facts.

**What was given up.** A long step that dies at 90% is paid for again. For the
native worker this is bounded by its duration budget, not by correctness.

**Reversal condition.** If long steps become common and re-running them is
expensive, add an explicit checkpoint to `NativeModelClient` — a resumable
conversation state the worker itself wrote and can validate — never a guess
from workspace state.

## 2026-11-05 — Calendar and email arrive as read-only connectors

**Decided:** `CalendarConnector` reads ICS from a file or an https URL;
`EmailConnector` reads an IMAP INBOX. Neither can write, accept an invite or
send mail. Credentials are named (`env`) and read from the process environment
at build time; a missing variable leaves the connector disabled and says why.

**Why ICS and IMAP rather than vendor APIs.** One reader covers Apple, Google,
Outlook and Nextcloud exports without OAuth, a vendor SDK, or storing a token
refresh flow. IMAP is the one protocol every mailbox speaks.

**What was given up.** No push: both poll on the maintenance sweep, so a
calendar change is seen within one interval, not immediately. No thread bodies
beyond a snippet, and no attachments. Mail is read-only, so "reply for me"
remains a separate work order the owner must approve — deliberate, but it means
the twin cannot yet answer an email end to end.

**Reversal condition.** If replies become a product requirement, add an action
connector with receipts; do not add a write method to this observation
connector.

## 2026-11-05 — The memory context budget is spent per class

**Decided:** preferences may claim 50% of the remaining budget, task outcomes
25%, project facts 20%, agent outcomes 5%, filled in that order, with unused
capacity rolling forward.

**Why.** A flat 1200-character cap let a week of finished-task logs crowd out
the one preference that would change an answer; preference questions were the
worst slice on LongMemEval, at 56.7% context hit rate against 92-99% elsewhere.

**What was given up.** Ranking is no longer purely by relevance score: a
high-scoring task memory can be dropped for a lower-scoring preference. That is
the intended trade, but it means a debugging question about a recent task may
see less of that task than before.

**Reversal condition.** If the context-boundary benchmark shows a regression on
task-shaped questions, raise the task-outcome share or make the weights depend
on the intent.

## 2026-11-05 — Conflict detection is token overlap, and says so

**Decided:** `findConflicts` compares token overlap (overlap coefficient) among
active memories of the same type; ≥0.55 is a near-duplicate, ≥0.35 a subject
worth reviewing. Matched restatements are dropped from the recalled set before
the context is built.

**Measured limits.** Reworded statements score 0.57-0.93; unrelated ones 0.0-0.4.
A *changed value* in Chinese ("蓝色" -> "绿色") scores only 0.29 and is therefore
**not reliably caught** — the differing value replaces a bigram at both ends.
The tests assert the cases that work and say so in the comment; they do not
assert the case that does not.

**What was given up.** Contradictions phrased differently remain undetected, and
may both be recalled. Mitigation: only one is dropped when they *are* detected,
and the owner sees conflicts as review suggestions rather than automatic
deletion.

**Reversal condition.** An embedding-based comparison, measured on the same
pairs, that catches the value-change case above.

## 2026-11-05 — Supersedes: conversation mining defaults to a cheap local filter

**Decided:** `CLONE_AI_MEMORY_MINING` is now a three-way switch.
Unset = `filtered`: a turn is mined when it contains a durable-statement
signal (`src/memory/mining-policy.ts`), `off` silences both conversation and
task mining, `all` mines every turn. Task mining keeps the deterministic worker
unless the mode is `all`.

**Why the earlier entry changed.** "Opt-in" meant the feature a personal agent
needs most — learning without being asked — was off out of the box. The filter
is local, has no model call, and errs toward mining: a missed statement is a
memory never learned, an extra call is a few cents.

**What was given up.** Turns without a signal are never mined, so a fact stated
plainly but without any of the matched patterns ("杭州今天下雨" followed later by
a request) can be missed. `all` is the escape hatch.

**Reversal condition.** If the filter's miss rate is visible in practice, widen
the signal list or make `all` the default.

## 2026-11-05 — Consume repaired traces by runId and file fingerprint

**Decided.** Store the latest successful batch outcome for each runId alongside
the SHA-256 of the exact input file, and skip only a matching pair. Mark only
`fixed`, `pr-created`, or `patch-only`; an error remains eligible. Persist via
a same-directory rename; an unreadable or malformed state falls back to empty.

**Evidence and alternatives.** The current `loadTraces` reads the first files
without a record of earlier outcomes, so unchanged failures are sent to repair
again; this follows from code inspection, not a measured production incident.
Always retrying wastes repair work; recording runId alone would suppress new
content. The effectiveness of the complete model-dependent workflow remains
**assumed**, since it is outside this offline work order. Lost or corrupt state
can cause repeat work, and a later failure after a successful outcome does not
roll that outcome back.

**Reversal condition.** Replace this file-based scheme if a durable shared
ledger is needed across machines, or if trace exports change bytes without
changing actionable evidence often enough to cause repeated repairs.

## 2026-11-05 — The agent runs its own adversarial suite and repair loop

**Decision.** Add a deterministic, offline adversarial suite (injection wrapping, approval replay/expiry/forwarding, protected paths and symlink escapes, tool credentials in worker env, secret-memory recall, trace redaction, rate limits) plus a self-check loop that records every round in the journal and, on a red probe, exports the failure as a trace for the existing gated repair lane. A round runs the suite, `npm run gate`, and (optionally) `npm test`; repairs still produce a draft PR and merging stays with the owner.

**Alternatives rejected.** (a) Model-driven red teaming as the primary loop — nondeterministic, costs tokens per round, and cannot be compared across runs; kept as a later layer. (b) Letting the loop edit code directly — violates the existing repair gates and makes "did it improve?" unanswerable. (c) A separate test runner — the repository already has `npm run gate` and `node --test`; a second runner would drift.

**Evidence.** Every probe corresponds to a boundary that already exists in code and has a unit test or prior incident: forwarded WhatsApp content (shipped with `forwarded` + `<untrusted_data>`), approval codes (one-time, hashed, TTL), `forbiddenRoots`, `assertWorkerEnvName`, secret-memory exclusion, `digestEvents`. The suite turns those into one measured, recorded signal instead of scattered assumptions. Deterministic probes pass on this revision; the loop's repair branch is exercised with `--dry-run`.

**Cost and reversal condition.** Each round is CPU-only and adds one journal event plus a report file; repairs cost model tokens only when a probe is red and `--repair` is passed. Reverse this if the suite stops distinguishing a regression from noise (probes start passing regardless of code), or if a real incident shows the probe set missing the class that failed — extend the suite rather than loosening it.

## 2026-11-04 — Failed traces and repair run only in a gated, draft-PR lane

**Decision.** Failed and cancelled runs become redacted, self-contained trace
documents, including implicit failures no error code records: a step retried
three or more times, a cancel, an "不合格" label, or an owner correction within
ten minutes. The nightly repair job runs in a fresh worktree, requires a
regression test that the script verifies is red before the fix, hashes the test
files across phases, blocks protected paths from the diff, and produces a draft
PR (or a patch file) only. It never merges, deploys, restarts, or edits its own
schedule.

**Evidence.** Unattended code generation is the highest-risk action in the
system. Each gate closes a specific failure mode: writing in the serving
checkout; a "fix" without a reproduction; a model making the suite green by
rewriting the test; a fix that edits the rules that judge it; and an automatic
merge. `scripts/nightly-rsi.mjs` implements all five, and its report states that
merging remains the owner's decision.

**What it costs.** Tests plus a diff check bound the damage but cannot prove a
fix is safe; a human must read the PR. No traces means no run, and a failure
keeps the worktree for inspection.

**Reversal condition.** Do not relax the draft-PR gate for a general fix. If a
sandboxed runner can prove the fix against the full suite and enforce the
protected-path rule mechanically, a separate trade-off may allow auto-merge for a
named allowlist of paths — never for broad changes.

## 2026-11-04 — Self-review may change configuration, never the rules

**Decision.** A review reads the audit digest and may propose at most four
actions, restricted to a worker's or the Main Agent's model and reasoning
effort. Each action is validated against what the machine declares it can do,
applied only on the owner's click, journaled as `recommendation.applied` with
the previous and new value, and reversible from the same row. Code, prompts,
policy, and evidence rules are not reachable, and nothing runs on its own.

**Evidence.** An agent that can widen its own authority is a risk, not an
improvement loop; authority and completion belong to the Kernel. The digest is
already a projection of the journal (`loadAudits` / `summarizeAudits`), so the
reviewer needs no new data path, and the model-failure path degrades to measured
facts (`test/self-review.test.ts`).

**What it costs.** The narrow surface cannot fix a code or prompt defect; the
review can only tune model and effort. That is deliberate.

**Reversal condition.** If the configuration surface proves unable to address a
real failure class, add a new action kind only through its own trade-off with
validation and rollback — never by widening this one to code, prompts, policy,
or evidence rules.

---

## 2026-11-04 — Attempted and reverted: a persisted replay watermark

**Decided:** no watermark. A fresh process always replays the whole journal.

**What was tried.** Store the last applied sequence in the journal so a
restarted runtime resumes incrementally. Two tests failed immediately: a second,
independent runtime over the same journal resumed from the *first* runtime's
position and applied a mid-history `run.status_changed` for a run it had never
seen, and the JSONL-backed kernel view lost a run the same way.

**Why it cannot work as designed.** The projection lives only in memory. A
watermark records where *some* projection stopped; a new process has no
projection to continue, so the watermark can only tell it which events to skip —
exactly the events it needs. Persisting the watermark without persisting the
projection is the bug, not a shortcut.

**What this costs.** A restart pays one full replay: measured at 117 ms for
100,000 events. Acceptable, and it is the same order as the work the process is
about to do anyway.

**Reversal condition.** Persist the projection itself (a materialised snapshot
with its sequence), not just the sequence. Then a restart can load the snapshot
and apply the tail. Until then, this entry stands.

## 2026-11-04 — Tool and model budgets are enforced when the adapter reports them

**Decided:** the Kernel counts `tool_started` and a new `model_call` event per
execution attempt and fails the step with category `budget_exceeded` past the
work order's ceiling. The native worker also refuses further calls inside its
own loop, and reports `model_call` and `tool_completed`.

**What was given up.** For black-box CLI workers the ceilings remain
declarations: a CLI that does not report its calls cannot be counted. The
`sandbox` and duration budgets are what actually stop those. The contract
comment now says so instead of implying enforcement everywhere.

**Why not stricter.** Killing a CLI process on a call count the Kernel cannot
observe would require parsing the CLI's output protocol, which the black-box
adapter deliberately does not do.

**Reversal condition.** If a CLI grows a structured event stream, wire its
counts into the same counter; the Kernel side needs no change.

## 2026-11-04 — Background readers ask for the event types they need

**Decided:** `SqliteJournalStore.listTypesSince(types, sequence)` (using the
`(type, sequence)` index), and `src/core/journal-types.ts` with `readTypes`,
`readForRun`, `readSince` fallbacks for stores without the fast paths. Memory
governance, the memory pipeline, conversation mining, opportunity scan/list/
resolve/find, the daily report and the commitment reconciler now use them.

**Why it won.** Measured on a 100,000-event journal: `list()` takes 117 ms and
`listSince(tail)` / `listForRun` take 0–3 ms. Every 2-second queue tick and
every opportunity scan was paying the full-scan cost for a handful of rows.

**What was given up.** Each consumer now declares the event types it depends
on. A new event type that a consumer needs but does not list is silently
invisible to it — the reconciler's `RECONCILE_TYPES` is the risk. That trade
was accepted because the alternative (reading everything) is the cost this was
meant to remove; the list is beside the reader it belongs to, and the fallback
path keeps tests and the JSONL store correct.

**Reversal condition.** If a consumer is found missing an event type in
practice, the fix is to widen its list, not to drop the narrowing.

## 2026-11-04 — Journal reads are incremental, with a full-rebuild fallback

**Decided:** `SqliteJournalStore` gained `listSince(sequence)` and
`listForRun(runId)` plus indexes on `(run_id, sequence)` and `(type,
sequence)`. `CloneRuntime.refresh()` and `PersonalStateStore.hydrate()` apply
only the tail and advance a remembered applied sequence.

**Alternatives:** keep replaying the whole journal on every refresh; add a
separate incremental event log alongside the journal; paginate the projection.

**Why it won.** `list()` was an unindexed full scan and every refresh called it,
so the cost of each queue tick grew with total history — a structural problem
that gets worse the longer the twin lives, not a tuning issue.

**What was given up.** A correctness case has to be handled explicitly: if an
event arrives with a sequence at or below the applied one, the journal was
replaced, truncated or reordered, and the projection is rebuilt from zero. The
first implementation missed the second half of this — events applied by orphan
recovery advanced the projection without advancing the applied sequence, so the
next refresh replayed a `running -> queued` transition the state machine
refuses. All event application now goes through one `#applyEvent`, and the
kill-restart test caught it.

**Reversal condition.** If projection rebuilds from a replaced journal become
common (a migration that rewrites history, say), the applied sequence should be
stored rather than held in memory, or `refresh` should verify a journal identity
instead of inferring replacement from ordering.

**Status:** the indexing and incremental path are covered by
`test/journal-incremental.test.ts`; no timing benchmark was run, so the size of
the win is inferred from the query shape, not measured.

---

## 2026-11-04 — Removed the hashed-ngram "semantic" recall term

**Decided:** remove it. `MdMemoryStore.recall` keeps the bigram ratio, the
IDF-weighted cosine, the preference prior, and the stopword floor.

**Alternatives:** keep it behind `CLONE_AI_RECALL_SEMANTIC`; replace it with a
real embedding service.

**Why it lost.** Ablation on LongMemEval-s (470 scored questions, full haystack,
maxResults=10):

| metric | semantic on | semantic off |
| --- | --- | --- |
| any@1 | 77.9% | 76.6% |
| any@5 | 91.3% | 91.7% |
| any@10 | 95.5% | 94.9% |
| ndcg@10 | 82.0% | 81.5% |
| context hit rate | 92.6% | 92.8% |

The deltas run in both directions and are inside noise for n=470. A ranking
term that cannot be shown to help is a per-query cost (an extra SQL fetch per
candidate, a 2048-bucket table, and ~40 lines of hashing) for nothing.

**What was given up.** The specific case it was meant to catch — a paraphrase
sharing no exact term, e.g. "周五要交周报了" vs "每周五提交工作汇报" — is no longer
covered. It was never demonstrated to matter on the benchmark either.

**Reversal condition.** Any of:

- a real embedding endpoint becomes available (local model, gateway feature) and
  beats the lexical path on the preference slice, which is the weak spot:
  any@1 20.0%, any@10 70.0%;
- a product-level question type appears where exact-term overlap is structurally
  absent (cross-language, heavy abbreviation);
- a rerun at a larger sample (LongMemEval-m) reverses the sign.

## 2026-11-04 — Kept the IDF-weighted cosine term

**Decided:** keep it inside `recall`.

**Why it won.** It never admits a memory that shared no term, so its worst case
is reordering memories that already matched; the stopword floor added in the
same change removed the failure mode it did have (a single "the" passing the
0.2 ratio floor).

**What was given up.** One SQL query per candidate per recall.

**Reversal condition.** It is worth re-measuring on its own; if it shows no
gain either, remove it by the same standard as the semantic term.

**Status:** assumed for now — not yet measured in isolation.

## 2026-11-04 — Memory is pushed into the Main Agent prompt, not left to pull

**Decided:** `before_agent_start` recompiles matching memories into the system
prompt on every turn.

**Alternatives:** keep `recall_memory` as the only path; inject a user-role
message instead.

**Why it won.** Pull-only memory meant the owner could approve a memory and
still be answered as if it did not exist. The system-prompt route reuses the
same 1200-character / 6-item boundary the workers already get and leaves the
conversation history untouched (a user-role injection would appear in the
transcript and in `readConversation`).

**What was given up.** One recall per turn (a short-lived SQLite handle), and
the system prompt changes between turns, which weakens prompt caching.

**Reversal condition.** If per-turn latency becomes visible, or if prompt
caching savings outweigh push accuracy.

## 2026-11-04 — Conversation mining is opt-in (`CLONE_AI_MEMORY_MINING=1`)

**Decided:** off by default, same as task mining.

**Why it won.** One model call per owner turn. A default-on miner would spend
the owner's budget on conversations that produced nothing worth remembering.

**What was given up.** Out of the box, the twin does not learn from
conversation — the largest functional gap against companion products.

**Reversal condition.** Once a cheap or heuristic pre-filter can reject turns
that obviously contain no durable statement, the miner can default on.

## 2026-11-04 — Lessons from failure clusters are authored, not mined

**Decided:** a failure signature seen in 3+ runs produces a `procedure` memory
via `MemoryGovernance.author()` after owner approval, not a mined candidate.

**Why it won.** A mined candidate may only cite evidence from its own run; a
cluster spans several runs, so no single run can justify it. The owner's
approval is the evidence.

**What was given up.** The lesson text is template-built (`category`, count,
signature, catalog guidance) rather than model-written.

**Reversal condition.** If lesson quality proves to matter more than citation
purity, allow multi-run candidates with an explicit evidence set.

## 2026-11-04 — Native worker is configured by environment, not enabled by default

**Decided:** `CLONE_AI_NATIVE_MODEL` + `CLONE_AI_NATIVE_BASE_URL` opt in;
otherwise the registry keeps using sandboxed CLI workers.

**Alternatives:** make it the default; register it always but fail at dispatch.

**Why it won.** The CLI workers have an OS-enforced boundary. The native worker's
boundary is enforced by our own code, and until it has production mileage, the
safer default should be the one with the sandbox.

**What was given up.** Two worker types to reason about; the native path is
untested at scale.

**Reversal condition.** After the native worker has run real owner tasks with
no boundary regressions, it can become the default for non-coding work.

## 2026-11-04 — Archived memories, not deleted

**Decided:** expiry, idleness and retirement all archive; nothing is destroyed.

**Why it won.** `memory.restored` makes every decision reversible, and the
journal remains an honest record of what the twin once knew.

**What was given up.** Disk grows without bound in principle.

**Reversal condition.** Add a purge of memories archived for N years, with the
owner's explicit consent and a journaled reason.

## 2026-11-04 — 90-day lifetime and 90-day idleness

**Decided:** promoted memories default to a 90-day expiry; any active memory
unused for 90 days is archived.

**Why it won.** 90 days matches one project, one work cycle or one term — the
owner's own framing.

**What was given up.** A still-true fact that simply was not retrieved for 90
days disappears from recall. It is recoverable, but the owner has to notice.

**Reversal condition.** If the improvement loop's usage data shows restored
memories were in fact still useful, lengthen the window or exclude authored
memories.

**Status:** the 90-day figure is assumed from the owner's description, not
measured.

## 2026-11-04 — Owner labels outrank system verification

**Decided:** in outcome attribution, `audit.labeled` decides good/bad; system
verification is the fallback.

**Why it won.** The label is the ground truth an eval compares the system's
verdict against. Where they disagree, the system was by definition wrong.

**What was given up.** A single careless label pollutes the attribution for
every memory exposed to that run.

**Reversal condition.** If labels prove noisy, require a note or a second
confirmation for `fail` labels on completed runs.

## 2026-11-04 — Improvement suggestions are deterministic and capped at 10

**Decided:** suggestion ids are derived from the basis (`retire:<id>@<bucket>`),
and at most 10 are pending at once.

**Why it won.** Recomputing on every tick must not create duplicates; and a
flood of approvals trains the owner to approve blindly, which defeats the gate.

**What was given up.** A genuinely new suggestion can be delayed until older
ones are decided.

**Status:** the bucket size and the cap of 10 are assumed, not tuned.
