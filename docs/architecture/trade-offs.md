# Architecture trade-offs

**English** · [简体中文](trade-offs.zh-CN.md)

A decision is only durable when its reason is written down. Each entry states
what was decided, the evidence behind it, and the condition under which a
future reader should reverse it.

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
infrastructure cost; the macOS Seatbelt profile already isolates CLI workers
(`authority/seatbelt.ts`), and Claude Desktop's VM is a 26 MB image plus
platform-specific hypervisor code. Deferring them avoids spending the parity
budget on infrastructure that does not move the harness score.

**What it costs.** Users cannot install third-party plugins or run remote/browser
tools until those phases; MCP adds an attack surface, and skills can inject
instructions.

**Reversal condition.** If the owner's real workflows depend on a specific
plugin/marketplace or remote MCP, promote that integration; if a red-team test
bypasses Seatbelt, promote the VM sandbox.

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

## 2026-11-05 — Self-check rebuilds the local macOS app

**Decision.** On macOS, `selfcheck:push` rebuilds and replaces
`dist/Clone AI.app` after tests, typecheck and gate pass, before pushing.

**Evidence.** The running app kept showing old UI after source edits because
the bundle is a packaged UI plus sidecar and does not hot reload. A stale app
made fresh audit and IME fixes invisible.

**Cost and reversal condition.** The check becomes slower and requires the
macOS build toolchain. If development moves to a live-reload runtime, remove
the bundle rebuild from this path.

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
