# Optimization log

**English** · [简体中文](optimizations.zh-CN.md)

Every optimization gets one entry here, newest first. The trade-off entry is
written before the change; this entry is completed after it ships. The point is
to make the *work* auditable: not only what changed, but how it was done, what
it cost, and where the chain was weak. See [`AGENTS.md`](../../AGENTS.md).

**Outcomes worth citing live in
[`optimization-results.md`](optimization-results.md)** — one short entry per
verified gain, and nothing for an optimization whose eval showed no gain. This
file keeps every attempt, including the ones that did not work.

## Template

```markdown
### YYYY-MM-DD — <title>

- **Goal / hypothesis:** what should improve, and why we believe it.
- **Trade-off:** link to the entry in `docs/architecture/trade-offs.md`.
- **Change:** one paragraph plus the main files or areas.
- **Eval:** command, dataset or case ids, result before and after.
- **Benchmark run:** command, provider/model, dataset or task ids, scoring
  parameters, and result file. Required whenever a benchmark was run; omit only
  for a deterministic test-only eval.
- **Execution chain:** steps, workers or tools, duration and cost, failures and
  retries.
- **Pros:** what the chain did well.
- **Cons / next time:** where it was slow, expensive, brittle, or incomplete.
- **Reversal condition:** copied from the trade-off entry.
```

### 2026-11-09 — Merging the repair line with the shared-loop line

- **Goal / hypothesis:** local `main` and `origin/main` had diverged from the
  same base: one carried the repair lane, self-check loop and settings surface,
  the other the shared agent loop, native-only workers, capacity gate, MCP host
  and skills. Both are wanted; the merge should keep both and drop only what
  the owner explicitly rejected.
- **Trade-off:** the merge itself follows the existing decisions; the two
  choices taken here (local MCP client over the remote host, accepting the CLI
  removal) were confirmed by the owner in this session.
- **Change:** fourteen conflicted paths. Docs (CHANGELOG, trade-offs both
  languages, optimization logs both languages) were unioned section by section
  so neither line's entries were lost. Code took the remote architecture
  (native-only, no Pi SDK, no CLI workers) plus the local MCP wiring
  (`workerTools` in the provider catalog). Restored after the merge: the
  credential-name policy `worker-env.ts` (the adversarial probe reads it), the
  owner-configured round budget on the shared loop, the write-before-answer
  rule in the worker prompt, and a repair-lane check that reports an unknown
  worker before provider construction can fail for its own reason. Client tests
  were converted to the single-completion contract; the MCP test's client stub
  now answers twice (request the tool, then summarise).
- **Eval:** `npm test` → **616 tests, 616 pass, 0 fail**; `npm run typecheck` →
  exit 0; `npm run gate` → PASS, baseline unchanged. No conflict markers remain.
- **Benchmark run:** none. This is a merge, not a behaviour change; the suite is
  the check.
- **Execution chain:** fetched, found an in-progress merge, listed unmerged
  paths, compared stage 1/2/3 per file, asked the owner the two genuine design
  questions (MCP implementation, CLI removal), resolved docs by union and code
  by architecture, then fixed the compile and test fallout in six passes.
- **Pros:** no side's history or entries were discarded; the merged tree is
  green and both feature lines still work.
- **Cons / next time:** the first merge attempt resolved code files to the
  remote side and lost this branch's loop integration, which cost a full
  re-application. A merge of two long diverged lines should resolve code
  file-by-file with an explicit "which side owns this file" note, not
  wholesale.
- **Reversal condition:** if the local MCP client's stricter model blocks a
  workflow the remote host supported, revisit that one decision; the rest of
  the merge is structural.

### 2026-11-12 — Calibrating tokens from the provider instead of guessing

- **Goal / hypothesis:** the previous entry replaced "length / 4" with a
  character-class estimate, which the owner correctly rejected: a token is a
  property of the tokenizer, and the classes I used were measured on one model
  only. The estimate must be calibrated from the provider's own
  `usage.prompt_tokens`.
- **Trade-off:** [tokens are counted by the tokenizer, calibrated from
  usage](../architecture/trade-offs.md#2026-11-12--tokens-are-counted-by-the-tokenizer-calibrated-from-usage).
- **Change:** added `src/agent/token-estimate.ts` (`TokenCalibrator`,
  `countCharacters`, `estimateTokens`); the loop feeds every response's
  `inputTokens` into the calibrator before the next compaction check, and
  `estimateMessages` delegates to it. `TokenCalibrator` starts at 3.15
  characters/token — the lowest measured value — and smooths each new sample at
  0.3, ignoring reports outside 1–12 characters per token.
- **Eval:** measured the real ratios against the local gateway for three models
  and four text shapes. Latin: 3.15–4.35 chars/token; Chinese: 0.87–1.29; mixed:
  1.35–2.30; code: 2.03–2.59. The same Chinese sentence differed by 30% between
  `kimi-k3.1-pro` and `gpt-6.1-terra`, and code cost ~2× what the old
  four-per-token rule gave. `npm test` → **649 tests, 649 pass, 0 fail**;
  typecheck and `gate` pass. The regression case now reports a realistic
  `prompt_tokens` and asserts the compaction record still appears.
- **Benchmark run:** the measurement above is the benchmark — three models
  (`360/deepseek/deepseek-v4.1-flash`, `360/moonshotai/kimi-k3.1-pro`,
  `360/openai/gpt-6.1-terra`) through `http://127.0.0.1:3425/v1/chat/completions`,
  four fixed samples, `max_tokens: 1`, reading `usage.prompt_tokens`. No sampling
  or temperature parameter; the number is the provider's own report.
- **Execution chain:** wrote the measurement first, then the calibrator, then
  wired it into the loop; two existing tests needed updating because the
  estimator's numeric behaviour changed and one fixture reported an implausible
  10 tokens for a 288k-character prompt.
- **Pros:** the estimate now converges to whatever the model actually charges,
  and it says so (`source: "calibrated"`) instead of presenting a guess.
- **Cons / next time:** the first request of a process is still a guess;
  providers sharing one clone home share one calibrator. I should have measured
  before writing the character-class version rather than after.
- **Reversal condition:** copied from the trade-off entry.

### 2026-11-12 — Honest token accounting and a real MCP client

- **Goal / hypothesis:** the audit's remaining loop and MCP findings are one
  theme: the harness under-measured what it sent and under-implemented the
  protocol it claimed. A CJK-heavy transcript never compacted, and the MCP
  client could not talk to a conforming HTTP server.
- **Trade-off:** [the token count is honest, and MCP is a real
  client](../architecture/trade-offs.md#2026-11-12--the-token-count-is-honest-and-mcp-is-a-real-client).
- **Change:** `estimateMessages` counts CJK by code point, charges 1,568 tokens
  per image and includes the tool schemas; `buildHistory` no longer truncates
  each record to 4,000 characters or the history to 12,000; `compactIfNeeded`
  returns whether it made progress and the loop stops with `budget_exhausted`
  when two compactions remove nothing; `compact` events carry `afterTokens`. The
  HTTP MCP transport performs the `initialize` / `notifications/initialized`
  handshake and `readRpcResponse` reads a streamed SSE body until the response id
  arrives; `mcpToolSpecs` accepts `deferUntil`/`loaderName` and exposes a
  `ToolSearch`-style loader instead of the whole table.
- **Eval:** `npm test` → **648 tests, 648 pass, 0 fail** (before this batch:
  646). New deterministic coverage: CJK/image/tool-schema estimation
  (`test/agent-loop.test.ts`), a production turn over a long history journals
  `main_agent.context_compacted`
  (`test/regression/audit-ctx-1.test.ts`), deferred MCP loading
  (`test/mcp.test.ts`), and a hand-run HTTP MCP server confirming the sequence
  `initialize → notifications/initialized → tools/list` and a streamed
  progress-then-result body. `npm run typecheck` → exit 0; `npm run gate` →
  PASS.
- **Benchmark run:** none. The estimator is deterministic and the HTTP test uses
  a local server; a live model run would not distinguish either.
- **Execution chain:** read the loop and both MCP clients, wrote the estimator
  with a character-class scan, then followed the compaction chain backwards from
  the journal record to `buildHistory` and found two separate truncations. For
  MCP, a local server exposed both the missing handshake and the SSE
  first-event bug; the first fix recursed without bound because the flag was set
  after the recursive call returned, which the local server caught immediately.
- **Pros:** compaction now fires for a Chinese conversation; an HTTP MCP server
  works; a large tool table can be deferred.
- **Cons / next time:** the estimate is conservative and still an
  approximation; the HTTP transport re-initialises after a server restart rather
  than resuming a session; no caller passes `deferUntil` yet, so the deferral
  path exists but is not used in production.
- **Reversal condition:** copied from the trade-off entry.

### 2026-11-11 — Closing the audit's remaining high and medium defects

- **Goal / hypothesis:** after the first repair batch, eleven confirmed findings
  remained: a policy write that could resurrect a revoked rule, an approval that
  applied to the wrong step, four loop defects, five MCP defects, and two memory
  defects. Each has a reproduction that fails before the change.
- **Trade-off:** [a decision is applied to the file it can see, and an approval
  names its step](../architecture/trade-offs.md#2026-11-11--a-decision-is-applied-to-the-file-it-can-see-and-an-approval-names-its-step).
- **Change:** `StandingPolicyStore` mutates inside its write queue
  (`#mutate`); `approveQueryRun` and the companion route carry `stepId` and
  refuse a mismatch with 409, and the WhatsApp bridge sends the step its code
  names; `runQuery` accepts a `CancellationToken`; `dispatchTaskTool` threads it;
  `isRetryableModelError` recognises `TimeoutError`; `parseArguments` refuses
  malformed JSON and the loop turns that into a tool result; the loop reads
  `finishReason` from both providers and fails a truncated answer; MCP servers
  get `environmentFor(...)` instead of the owner's environment, duplicate
  server/tool names are refused, `sanitizeObserved` preserves newlines and
  indentation, and both clients signal the process group; memory context caps
  each item at 400 characters and `recall` returns the full entry so `type`,
  `status` and `createdAt` survive.
- **Eval:** `npm test` → **646 tests, 646 pass, 0 fail** (before this batch:
  634). New deterministic coverage: two-store resurrection
  (`test/authority.test.ts`), step-mismatch approval
  (`test/companion-control-plane.test.ts`), caller-cancels-run
  (`test/run-query-routing.test.ts`), malformed arguments and truncated answers
  (`test/agent-loop.test.ts`), stopped-turn dispatch (`test/dispatch-task.test.ts`),
  environment narrowing, duplicate names, formatting preservation
  (`test/mcp-host.test.ts`, `test/mcp.test.ts`), per-item memory cap and metadata
  (`test/memory-context.test.ts`). `npm run typecheck` → exit 0;
  `npm run gate` → PASS, baseline unchanged.
- **Benchmark run:** none. These are contract and correctness fixes; a live
  model run would not distinguish them.
- **Execution chain:** worked through the audit's verified list in four groups
  (authority, loop, MCP, memory), one reproduction per fix. Failures fixed in
  place: `#mutate` had to tolerate a missing `policies.json`; the environment
  helper had to accept both the name-array and value-object config shapes; three
  test expectations needed the real event names (`run.status_changed`, not
  `execution.completed`) and the real JSON error text.
- **Pros:** every fix has a failing-first reproduction, so the suite now pins
  the behaviour the audit described.
- **Cons / next time:** the remaining medium findings (`ctx-*`, `T8`, `T13`,
  `REL-07`, `REL-10`, `F9`, `F13`) are still open; `dispatch_task` remains
  synchronous even though it is now cancellable; MCP has no HTTP handshake.
- **Reversal condition:** copied from the trade-off entry.

### 2026-11-11 — Making the repair lane reviewable

- **Goal / hypothesis:** the repair lane could not be reviewed. Its runs reached
  the round limit without a fix, its audit showed no tool activity, and a model
  that read a truncated file wrote the prefix back over the whole file. Making
  the lane report what it does, tell the model where the defect is, and refuse
  fragment writes turns "clone-ai repaired it" into a claim an owner can check.
- **Trade-off:** [the worker streams its activity, and the repair lane says when
  to stop](../architecture/trade-offs.md#2026-11-11--the-worker-streams-its-activity-and-the-repair-lane-says-when-to-stop)
  and [reads are windowed with an explicit total; writes refuse
  fragments](../architecture/trade-offs.md#2026-11-11--reads-are-windowed-with-an-explicit-total-writes-refuse-fragments).
- **Change:** `NativeAgentWorker.execute` now runs the shared loop inside its
  generator and forwards `model_call` / `tool_started` / `tool_completed`, so
  the Kernel's `maxModelCalls` and `maxToolCalls` count real activity and the
  audit shows every call. `repairPlan` extracts the files a trace names
  (`traceLocations`), forbids reading `docs/`, and tells each phase to stop
  after its first write; the fix phase receives only the case this repair
  created (`newRegressionTests` + `withCaseNames`). `read_file` returns a
  windowed view with the total line count and a continuation offset, and
  `write_file` refuses content that would discard most of an existing file.
  `CLONE_AI_NATIVE_REASONING_EFFORT` reaches the provider as
  `reasoning_effort`.
- **Eval:** `npm test` → **633 tests, 633 pass, 0 fail**. New deterministic
  coverage: `test/native-agent-worker.test.ts` asserts one `model_call` per
  round trip and paired `tool_started`/`tool_completed`; `test/repair.test.ts`
  asserts the prompts name the trace's files and the scoped case;
  `test/native-worker-tools.test.ts` covers windowed reads, the continuation
  offset, fragment refusal, and the repair lane's `refuse-existing` mode.
  `npm run typecheck` → exit 0; `npm run gate` → PASS.
- **Benchmark run (live repair lane):**
  - Command: `CLONE_HOME=~/.clone-audit-run5
    CLONE_AI_NATIVE_MODEL=360/deepseek/deepseek-v4.1-flash
    CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:4399
    CLONE_AI_NATIVE_REASONING_EFFORT=max CLONE_AI_NATIVE_MAX_ROUNDS=28
    node --experimental-strip-types src/cli/clone-ai.ts repair --max-traces 1 --keep`
  - Provider/model/effort: Magpie gateway → DeepSeek V4.1 Flash, `max`
    (verified against `/v1/models`: `reasoning_levels: ["low","high","max"]`).
  - Inputs: five trace documents written from the 2.1.319 audit
    (`~/.clone-audit-run5/failed-traces/*.json`), `--max-traces 1` so the run
    works one defect (`audit-ctx-1`, token-aware compaction unreachable).
  - Scoring: the lane's own gates (red before, green after, hashes unchanged,
    protected paths untouched); no sampling or temperature parameter is
    exposed.
  - Results: earlier runs in the same series — `24501bb3` (24 rounds, wrong
    defect), `960b941d` (16 rounds, red case written), `3bc0aef5` (32 rounds,
    case written, no fix), `d03a4e2a` (24 rounds, case written, file
    destroyed), `8f6f35c5` (24 rounds, case written). Each result file is
    `~/.clone-audit-run*/rsi/last-run.json`; transcripts are in
    `/tmp/llm-transcript.jsonl` per run.
- **Execution chain:** audit → trace documents → five live repair runs, each
  reviewed by reading the request/response transcript through a logging proxy.
  Failures found and fixed in order: the worker reported no events (fixed),
  the prompts did not say where the defect was (fixed), the prompts did not say
  to stop (fixed), the fix phase read every case in the directory (fixed), and
  a truncated read let the model overwrite a file (fixed). Total live cost
  across the five runs: roughly 670k + 791k + 745k + 519k + 518k = **3.24M
  tokens**; wall time about 30 minutes.
- **Pros:** every subsequent repair run is reviewable call by call, and the
  three ways the lane wasted rounds are now contract, not luck.
- **Cons / next time:** the live run still ended at its round limit; the prompts
  improved the first rounds but did not yet produce a green fix. The agent
  should have run one defect end to end before writing five traces.
- **Reversal condition:** see both trade-off entries.

### 2026-11-10 — Closing the audit's verified defects

- **Goal / hypothesis:** a six-dimension audit against Claude Code 2.1.319 found
  78 confirmed defects. The security ones were not hypothetical: several were
  reproduced against this repository's own modules. Closing the high-severity
  set makes the boundary the code claims match the boundary it enforces.
- **Trade-off:** [scope checks compare resolved paths, and the repair lane's
  guards are real](../architecture/trade-offs.md#2026-11-10--scope-checks-compare-resolved-paths-and-the-repair-lanes-guards-are-real).
- **Change:** `src/authority/path-contains.ts` (new: `realTarget`,
  `containsPath`, `samePath`); `isCaseSensitive` and a case-folded
  `isForbiddenPath` in `src/authority/scope.ts`; ancestor-grant refusal in
  `src/authority/path-gateway.ts`; `decideTool` now resolves both sides, splits
  read/write roots, refuses writes into `.git`, and refusal when a path tool
  yields no readable path; a step's declared risk caps its offered tools;
  `workerTools` takes `writeFileMode` and `provider-catalog` threads the repair
  lane's value through; `linkDependencies` copies instead of symlinking;
  `max_turns` is always a failure with one `effectiveRoundLimit`;
  `toProviderToolName` maps names at both client boundaries; compaction keeps
  tool pairs together; the body cap is above the attachment cap and reports
  413; the capacity gate transfers the released slot synchronously; the worker
  implements `cancel(sessionId)`; both MCP clients listen for stdin errors;
  shutdown destroys live connections.
- **Eval:** `npm test` → **626 tests, 626 pass, 0 fail** (before: 616 pass).
  New deterministic coverage: `test/path-gate.test.ts` 4/4 (symlink escape,
  read-vs-write roots, ancestor grant, case folding), a round-limit regression
  in `test/native-agent-worker.test.ts`, a worker-cancel test, a capacity
  transfer test, an EPIPE test, a realistic-image body-cap test, and a
  shutdown-with-open-stream test. `npm run typecheck` → exit 0;
  `npm run gate` → PASS, baseline unchanged. Every security case was also
  reproduced by hand before the fix (`/tmp/sym-test`, `/tmp/ancestor-check.ts`,
  `/tmp/repair-guard.ts`, `/tmp/gate-race2.ts`, `/tmp/attach-body.ts`).
- **Benchmark run:** none. These are contract and correctness fixes; a live
  model run would not distinguish the gate's behaviour.
- **Execution chain:** audit workflow (6 dimension readers, 74 findings
  adversarially verified) → manual reproduction of each high finding → fixes in
  four groups (security, correctness, reliability, honesty) → one test per
  fixed defect. Failures along the way: three existing tests assumed a
  `read_only` step could write (updated to `reversible_write`), the case probe
  needed a listing-based test rather than a `realpath` comparison, and one
  attachment test used a PNG the signature check rejected (replaced with a
  genuinely valid one).
- **Pros:** the same code path now enforces what the docs claimed; each fix has
  a deterministic test, so a regression fails loudly.
- **Cons / next time:** the honesty items (the 58.5 baseline, "Phase 2
  implemented", Seatbelt evidence, MCP/skills reachability) are still open;
  `contextWindow` is still never passed in production, so token compaction
  remains unreachable; `dispatch_task` is still uncancellable because
  `runQuery` takes no signal; the repair lane still executes without a claim.
  Those need their own change.
- **Reversal condition:** copied from the trade-off entry.

### 2026-11-09 — Stop a running answer

- **Goal / hypothesis:** the server could already cancel a turn, but the UI had
  no way to ask. Making the send slot a stop control while a turn runs turns an
  existing capability into something the owner can reach in one click.
- **Trade-off:** [every in-process tool call goes through a per-call
  decision](../architecture/trade-offs.md#2026-11-06--every-in-process-tool-call-goes-through-a-per-call-decision)
  is the gate that makes a mid-turn cancellation meaningful; the UI change is
  the desktop control-surface decision.
- **Change:** the composer renders a `stop-turn` control in the same slot as
  send; clicking it or pressing Escape aborts the fetch, which closes the SSE
  connection and triggers the server-side abort that was added earlier. A user
  stop is labelled separately from the stall timeout, the send button returns
  when the turn ends, and the typed text is restored when no answer arrived.
- **Eval:** `test/ui-structure.test.ts` checks the control, its hidden state,
  the Escape binding and the distinct stop copy. `npm test` → **566 tests, 566
  pass, 0 fail**; typecheck and gate pass. In the browser preview the control
  renders in the send slot with its own styling.
- **Benchmark run:** none. This is a UI affordance over an existing endpoint.
- **Execution chain:** markup → stylesheet → send path → locale → structure
  test; the browser preview showed the stop control 2 px taller than send, so
  both now share the same fixed box in one slot. The preview was stopped and
  restarted once to confirm the stylesheet reload.
- **Pros:** the owner can end a runaway turn; the visible label distinguishes a
  deliberate stop from a network stall.
- **Cons / next time:** the two controls shared a slot but not a box until the
  shared-size rule was added; the preview caught the 38 px vs 30 px difference.
  Keep one shared size rule for anything that can occupy that slot.
- **Reversal condition:** if owners prefer a persistent send button beside a
  separate stop, split the controls again but keep the same abort path.

### 2026-11-09 — A live tool timeline in the chat

- **Goal / hypothesis:** the desktop streamed the answer but showed nothing
  about what the agent was doing. A tool timeline that arrives over the same
  SSE stream makes refusals and slow tools visible while the answer is still
  forming.
- **Trade-off:** [the model can dispatch a task, but only the Kernel plans and
  finishes it](../architecture/trade-offs.md#2026-11-09--the-model-can-dispatch-a-task-but-only-the-kernel-plans-and-finishes-it)
  covers the tool this timeline surfaces; the UI change itself follows the
  desktop control-surface decision.
- **Change:** `NativeMainAgentOptions.onToolEvent` emits `started`/`completed`
  with tool name, error/denied and duration; `runMainAgentQuery` passes it
  through; the companion stream sends it as a `tool` event; the chat renders a
  `tool-timeline` with running/done/error/refused states, a right-aligned
  duration, and a reduced-motion fallback. Locale strings are bilingual.
- **Eval:** `test/companion-main-agent.test.ts` asserts the stream carries
  `event: tool` with `"phase":"started"` and the tool name;
  `test/ui-structure.test.ts` asserts the handler, the timeline element and the
  styles (including the reduced-motion rule). `npm test` → **565 tests, 565
  pass, 0 fail**; typecheck and gate pass. Rendered in the browser preview: four
  rows showed done/error/refused/running with the expected colors and layout.
- **Benchmark run:** none. This is a UI and event-wiring change.
- **Execution chain:** runtime event → query option → SSE frame → renderer;
  verified first by a structural test, then by injecting the same markup into
  the live preview and reading computed styles and a screenshot. Two
  corrections along the way: the preview launch config pointed at a script that
  did not exist, and the dev server ignored the `PORT` variable.
- **Pros:** the owner can see refusals and slow tools without opening the audit;
  the same events already reach the turn audit, so the two views cannot disagree.
- **Cons / next time:** identical tool names collapse into one row, so a
  repeated call updates the previous row rather than adding a new one; a stop
  button is still absent.
- **Reversal condition:** if the timeline crowds the answer, make it collapsed
  by default behind a summary line.

### 2026-11-09 — A model-invocable dispatch_task tool

- **Goal / hypothesis:** the Main Agent could describe work but could not start
  it. One tool that takes an objective and acceptance criteria and calls the
  existing `runQuery` path closes that gap without creating a second authority.
- **Trade-off:** [the model can dispatch a task, but only the Kernel plans and
  finishes it](../architecture/trade-offs.md#2026-11-09--the-model-can-dispatch-a-task-but-only-the-kernel-plans-and-finishes-it).
- **Change:** added `src/main-agent/tools/dispatch-task.ts` and registered it in
  `nativeTools`; the charter now tells the model when to use it instead of
  `propose_work_plan`. Validation runs before any planning round: a non-empty
  objective, 1–12 trimmed criteria, and a 4,000-character cap.
- **Eval:** `test/dispatch-task.test.ts` → 3/3. `npm test` → **563 tests, 563
  pass, 0 fail**. `npm run typecheck` → exit 0. `npm run gate` → PASS.
- **Benchmark run:** none. The tool is a wiring change over `runQuery`; a live
  run would exercise the planner and worker, not this binding.
- **Execution chain:** read the audit gap and `runQuery`; write the tool; fix
  two relative imports and drop an unsupported `signal` option rather than cast
  it away; register it; add the charter line; write the validation tests; record
  the trade-off and this entry.
- **Pros:** the model now has a governed way to start work, and the completion
  path stays single.
- **Cons / next time:** dispatch is synchronous, so a long task holds the turn;
  the model cannot set per-step scopes through this tool; background dispatch,
  cancellation propagation and a completion notification are still ahead.
- **Reversal condition:** see the trade-off entry.

### 2026-11-09 — Per-call permissions, context compaction, MCP, and skills

- **Goal / hypothesis:** close the four Claude Code gaps that decide whether a
  harness feels complete: every tool call is authorized instead of every plan
  step; long sessions compact by token pressure and record it; third-party tools
  arrive through MCP; and reusable procedures arrive as skills instead of
  hard-coded prompts.
- **Trade-off:** [every in-process tool call goes through a per-call
  decision](../architecture/trade-offs.md#2026-11-06--every-in-process-tool-call-goes-through-a-per-call-decision),
  [compaction is token-aware and recorded](../architecture/trade-offs.md#2026-11-06--compaction-is-token-aware-and-recorded-deterministic-summaries-first),
  [MCP and skills first](../architecture/trade-offs.md#2026-11-06--mcp-and-skills-first-plugins-cloud-vm-and-computer-use-deferred),
  and [execution workers are general](../architecture/trade-offs.md#2026-11-06--execution-workers-are-general-coding-is-one-tool-profile).
- **Change:**
  - `src/agent/loop.ts` gained `authorize`, `requestApproval`, `hooks.preToolUse`
    / `postToolUse`, and a `tool_decision` event. Deny beats ask beats allow,
    a hook may rewrite input but cannot widen authority, and a denied call is a
    paired tool result that the turn survives.
  - `src/workers/native-agent-worker.ts` now runs on `runAgentLoop`: its client
    is one completion, `decideTool` is the `authorize` callback, read tools are
    parallel-safe, and budget failures carry a comparable signature.
  - `src/main-agent/context-window.ts` derives compact/warn/blocked levels,
    estimates tokens, and compacts deterministically; `main_agent.context_compacted`
    records each compaction on the turn and in the journal.
  - `src/mcp/mcp-host.ts` is a stdio MCP host with namespaced tools; a failed
    server is recorded and contributes nothing.
  - `src/skills/skill-loader.ts` loads `SKILL.md` with progressive disclosure;
    the Main Agent turn accepts `skillRoots` and `mcpServers` and exposes
    `Skill(<name>)` plus `mcp__server__tool` tools.
  - `apps/desktop/src-tauri/tauri.conf.json` now sets a restrictive CSP instead
    of `null`.
- **Eval:** `npm test` → **622 tests, 619 pass, 0 fail, 3 skipped** (before this
  batch: 601/598/0/3). `npm run typecheck` → exit 0. `npm run gate` → PASS,
  baseline unchanged. Kernel suite 14/14; context suite 8/8; MCP 5/5; skills
  5/5; native worker/client 17/17; an end-to-end Main Agent turn exercises both
  a skill and an MCP tool. No live model call was made.
- **Benchmark run:** none. The changes are contract-level; a live benchmark
  would not distinguish the authorization, compaction, or loader logic.
- **Execution chain:** kernel permission path → native worker migration →
  context module and record → MCP host with a fake stdio server → skill loader
  with fixtures → end-to-end turn → CSP. Failures fixed in place: TypeScript
  parameter properties (strip-only mode), the worker class closing brace, two
  test helper signatures, a char-count assertion, and one flaky WhatsApp test
  that passes in isolation and on rerun.
- **Pros:** permission is now per call and reason-bearing; compaction is
  recorded and visible; MCP and skills are opt-in without changing existing
  turns; the worker and Main Agent share one loop contract.
- **Cons / next time:** MCP has no HTTP transport, resources, prompts, or OAuth;
  skills do not yet narrow the tool table themselves (the Kernel gate still
  governs), and plugins/deferred tool search are absent. The extra coding tools
  (edit/glob/grep/bash) are still a profile without implementations.
- **Reversal condition:** see each trade-off entry; for MCP/skills, reverse if
  the attack surface grows faster than the capability, or if a real workflow
  needs a transport this host does not have.

### 2026-11-09 — Close the three review findings from the desktop repair round

- **Goal / hypothesis:** the two merged desktop fixes are correct, but the review found three gaps that would let the same class of failure return: the regression cases never ran in CI, the memory fix only covered unchanged polls, and `write_file` refusing existing paths removed a normal capability.
- **Trade-off:** [regression cases in the default suite](../architecture/trade-offs.md#2026-11-09--regression-cases-run-in-the-default-suite); [background repaint yields to a focused editor](../architecture/trade-offs.md#2026-11-09--a-background-repaint-yields-to-a-focused-editor); [write_file mode per worker](../architecture/trade-offs.md#2026-11-09--write_files-overwrite-mode-is-per-worker-and-only-the-repair-lane-refuses).
- **Change:** (a) `package.json` `test` includes `test/regression/*.test.ts`, so the two merged cases and every later one run in `npm test` and therefore in CI; (b) the memory panel's poll path calls `render({ background: true })`, which skips the paint when focus is inside an `INPUT`/`TEXTAREA` under `#memory-root` — the markup cache alone could not cover a changed payload; (c) `fileTools()` takes `writeFileMode`, defaults to `overwrite`, and the repair lane sets `CLONE_AI_NATIVE_WRITE_FILE=refuse-existing` for its own process.
- **Eval:** `npm test` 633 pass / 3 skipped / 0 fail (up from 626; the two regression files and the new overwrite case are now included); `npx tsc --noEmit` pass; `npm run gate` PASS, baseline unchanged. A probe against the memory-panel sandbox that failed before the change (textarea detached on an unrelated `updatedAt` change) now passes and is part of `test/regression/memory-refresh-focus.test.ts`.
- **Benchmark run:** none — this entry changes tool defaults and test wiring, not model behavior; no provider was invoked.
- **Execution chain:** reviewed the two merged patches against their parent commits (both reproduced red), wrote a probe that exposed the changed-payload case, then made the three changes in one pass on main, added the probe as a permanent case, and updated the trade-off pair. No repair-lane run: these are corrections to the lane itself, not product bugs the lane should produce.
- **Pros:** the review findings are now enforced rather than remembered; the residual focus bug cannot silently return; ordinary tasks can regenerate files again.
- **Cons / next time:** the focus guard trades freshness while typing for edit safety; a detail that finishes loading during typing appears late. The `write_file` mode is an environment variable read in the repair process — if a future entry point builds the registry elsewhere, it must set the same variable.
- **Reversal condition:** stated in each trade-off entry above.

### 2026-11-07 — Shared agent loop kernel and a green baseline

- **Goal / hypothesis:** the Main Agent needs the harness mechanics Claude Code
  proves matter: a typed terminal reason, safe tools scheduled together with
  unsafe tools as barriers, abort propagation, round/tool/token/duration
  budgets, bounded retries, and structured tool results. A single kernel also
  stops the Main Agent and execution workers from growing two different loops.
- **Trade-off:** [one shared agent loop kernel](../architecture/trade-offs.md#2026-11-06--one-shared-agent-loop-kernel-serves-the-main-agent-and-the-native-worker)
  and [execution workers are general](../architecture/trade-offs.md#2026-11-06--execution-workers-are-general-coding-is-one-tool-profile).
- **Change:** added `src/agent/loop.ts` and `test/agent-loop.test.ts`, then
  wired `src/main-agent/native-runtime.ts` through it. The Kernel tool table is
  adapted to the loop; read-only tools are parallel-safe and proposals stay
  serial. Tool start/completion events still feed the turn audit, and the
  companion stream aborts the turn when the client disconnects. Phase 0 also
  removed the last `pi` default (`evidence-reviewer` now uses `claude-code`),
  updated the stale Pi tests, made the Main Agent benchmark native-only, and
  removed Pi from the benchmark recipes and docs.
- **Eval:** `node --experimental-strip-types --test test/agent-loop.test.ts` →
  **10/10 pass**; `test/native-main-agent.test.ts` → **6/6 pass**; the
  client-disconnect path is covered in `test/companion-main-agent.test.ts`. `npm test` →
  **609 tests, 606 pass, 0 fail, 3 skipped**
  (before: 585 tests, 578 pass, 4 fail, 3 skipped). `npm run typecheck` → exit
  0. `npm run gate` → **PASS**, baseline unchanged. No live model call was made
  for this change; the eval is deterministic.
- **Benchmark run:** none. The change is judged by the deterministic loop
  contract and the existing suite; a live Main Agent run would add cost without
  distinguishing the kernel's scheduling and budget logic.
- **Execution chain:** eight parallel analysis readers (seven reports used;
  the tool-catalog reader was stopped after it kept re-scanning), direct source
  checks for the tool list, Phase 0 test repair, kernel implementation, adapter
  wiring, then the full suite. Failures along the way: one unsupported
  TypeScript parameter property in strip-only mode, two type errors in the
  tests, and one benchmark-safety test that assumed the default provider was a
  CLI. Each was fixed in place. Duration and cost were not separately measured;
  no provider was called.
- **Pros:** the Main Agent now has a typed terminal reason, parallel-safe tool
  scheduling, abort propagation, retries, budgets, and middle truncation without
  changing its public entry point. The baseline is green again, and the loop is
  reusable by the native worker.
- **Cons / next time:** the first kernel still lacks a token-aware live
  compaction path, a per-call permission check, and a total-token billing
  ledger; those are Phase 2–4. A retry after a partially streamed response can
  replay deltas to the UI; Phase 2 should emit a model-call retry/reset event.
  The tool-catalog reader should have had a hard call/time budget from the
  start.
- **Reversal condition:** if the Main Agent and worker diverge in transport or
  streaming requirements, keep separate model adapters but share the scheduler,
  budget, and tool-result layers; if the kernel adds more complexity than it
  removes, restore a single-purpose Main Agent loop.

### 2026-11-06 — Repeated Main Agent comparison with medians

- **Goal / hypothesis:** make the Pi-versus-native comparison able to rank
  latency, after two single-run passes disagreed and one native plan cell took
  45.2s.
- **Trade-off:** [repeated cells](../architecture/trade-offs.md#2026-11-06--the-main-agent-comparison-repeats-each-cell-and-reports-medians).
- **Change:** `benchmark/main-agent.ts` runs each cell `--repeat N` times
  (default 5), reports median and p90 duration, median tokens and pass rate, and
  keeps every sample in the JSON. `benchmark/stats.ts` holds the median and
  nearest-rank percentile. A cell that throws is recorded as a failed sample
  instead of aborting the report.
- **Eval:** `test/benchmark-stats.test.ts` covers odd, even and empty medians and
  nearest-rank percentiles. Repeated run:
  `CLONE_AI_BENCH_MAIN_MODEL=360/deepseek/deepseek-v4.1-flash npm run bench:main -- --repeat 3`;
  model `360/deepseek/deepseek-v4.1-flash` via Magpie at
  `http://127.0.0.1:3425`; three samples per cell; result file
  `benchmark/results/main-agent-2026-11-06T01-41-51-266Z.json`.
- **Results (median / p90 / median tokens):** direct Pi 1.2s / 1.3s / 2,620 vs
  native 1.5s / 1.7s / 2,560; authority Pi 4.5s / 6.2s / 5,721 vs native
  4.4s / 5.6s / 5,449; plan Pi 11.5s / 15.8s / 14,145 vs native 12.2s / 19.9s /
  12,994. Both runtimes pass 9/9.
- **What it shows:** with three samples the picture is stable. Latency is close —
  native is slightly faster on authority, Pi on direct and plan — and native uses
  about 6.6% fewer tokens overall (21,003 vs 22,486 median sums). Every cell met
  its expectation.
- **Model note:** the earlier Sonnet 5.5 id was no longer in the Pi catalog in
  this environment; the first repeated attempt failed before any model call and
  is recorded as a finding. DeepSeek v4.1 Flash exists in both catalogs and
  supports tool calls.
- **Next:** five samples is the default; three were used here to fit the run
  window. Use `--repeat 5` when p90 matters.
- **Reversal condition:** see the trade-off entry.

### 2026-11-06 — Five-sample confirmation of the Main Agent comparison

- **Goal / hypothesis:** replace the three-sample picture with the default five
  samples, so p90 is a real tail measure rather than nearly the maximum.
- **Trade-off:** [repeated cells](../architecture/trade-offs.md#2026-11-06--the-main-agent-comparison-repeats-each-cell-and-reports-medians).
- **Benchmark run:** `CLONE_AI_BENCH_MAIN_MODEL=360/deepseek/deepseek-v4.1-flash npm run bench:main -- --repeat 5`;
  model `360/deepseek/deepseek-v4.1-flash` via Magpie at
  `http://127.0.0.1:3425`; five samples per cell; result
  `benchmark/results/main-agent-2026-11-06T02-07-58-472Z.json`.
- **Results (median / p90 / median tokens):** direct Pi 1.4s / 1.9s / 2,621 vs
  native 1.1s / 2.1s / 2,563; authority Pi 4.8s / 5.5s / 5,583 vs native
  4.7s / 5.4s / 5,488; plan Pi 13.8s / 26.9s / 10,877 vs native 11.4s / 15.8s /
  9,922. Both runtimes pass 15/15.
- **What changed from the three-sample run:** native now looks faster at the
  median on every cell (17.2s vs 20.0s summed) and much better on the plan tail
  (p90 15.8s vs 26.9s). Native uses about 5.8% fewer tokens. The plan cell still
  varies in tool calls (Pi 1–3, native 2–4), which is model behavior rather than
  a runtime difference.
- **Caveat:** one model, one machine, one hour, shared gateway. Treat this as a
  stable local comparison, not a universal ranking.
- **Reversal condition:** see the trade-off entry.

### 2026-11-06 — Removing the Pi SDK from the Main Agent (stage 1 of 2)

- **Goal / hypothesis:** make the Main Agent's loop, context assembly and tool
  surface ours, with no SDK and no fallback, as decided in the removal
  trade-off.
- **Trade-off:** [keep only our own agents](../architecture/trade-offs.md#2026-11-06--the-harness-keeps-only-its-own-agents-no-pi-sdk-no-black-box-clis).
- **Change:** deleted `session.ts` (the Pi session factory); rewrote
  `run-main-query`, `clone-main` and the CLI conversation path on the native
  runtime; moved the SDK-free pointer and legacy-session listing into
  `conversation-store.ts`; moved the model/effort preferences into
  `model-preferences.ts`; replaced self-review's Pi session with a plain
  completion against the configured endpoint; replaced the Pi model catalog with
  the gateway's own list; removed the Pi types from the Kernel tool host; the
  turn ledger now feeds `search_history` and the conversation view; removed the
  `@earendil-works/pi-coding-agent` dependency and the Pi-only live tests.
- **Eval:** full suite 578 tests / 578 pass; typecheck, gate and bilingual docs
  pass. The removed live tests were Pi-only and could not run after the SDK was
  gone; their deterministic equivalents remain.
- **Execution chain:** trade-off first, then the runtime, then self-review and
  the catalog, then tests. The compiler guided each removal. Two test seeds that
  used Pi's `SessionManager` were rewritten to ledger turns.
- **Pros / cons:** the Main Agent no longer depends on an SDK, and every input,
  tool call and usage record is ours. The endpoint is now mandatory; the
  settings model picker lists the gateway's models and the chosen id is used
  when only the base URL is configured.
- **Not done (stage 2):** the black-box CLI workers (Claude Code, Codex, Pi CLI,
  opencode), their provider catalog, install commands and the `install_agent`
  tool are still present. Removing them is the next stage of the same trade-off;
  external actions will have no provider until a governed connector exists.
- **Reversal condition:** see the trade-off entry.

### 2026-11-06 — Removing the black-box CLI workers (stage 2 of 2)

- **Goal / hypothesis:** finish the removal: no CLI worker, no provider recipe,
  no install path, as decided in the same trade-off.
- **Trade-off:** [keep only our own agents](../architecture/trade-offs.md#2026-11-06--the-harness-keeps-only-its-own-agents-no-pi-sdk-no-black-box-clis).
- **Change:** deleted `black-box-cli-worker`, `worker-registry`,
  `executable-resolver` usage for workers, `worker-env`, `fresh-session-policy`,
  `provider-config-store` and `providers.json`; the provider catalog is the
  native definition only; default agents are native and the `external` profile is
  gone (no governed connector); `install` is refused, `install_agent` removed,
  provider settings endpoints return 409; memory mining now calls the native
  endpoint with an injected completion; the worker benchmark runs native only;
  routing treats configured agents as available; docs, locale strings and
  failure copy updated.
- **Eval:** full suite 520 tests / 520 pass; typecheck, gate and bilingual docs
  pass. Removed tests covered only the deleted CLI surfaces (CLI recipes,
  installers, seatbelt, worker env, provider registry); the deterministic
  equivalents for routing, memory mining and review remain.
- **Execution chain:** deletions first, then the compiler drove every reference
  fix: run-query, CLI, companion, self-review, memory worker, benchmark, tests.
  Two bulk test edits were reverted after they produced invalid files and redone
  with targeted removals.
- **Pros / cons:** the only execution path is now per-call gated and auditable;
  no CLI can run with hidden tools or credentials. The cost is explicit:
  external actions have no provider, CLI-only capabilities are gone, and an
  install command can no longer help.
- **Reversal condition:** see the trade-off entry.

### 2026-11-06 — Worker concurrency follows measured machine capacity

- **Goal / hypothesis:** let dispatch use the machine fully instead of the
  plan's shape, while keeping the hard limit with the Kernel rather than a
  sampled model token.
- **Trade-off:** [capacity](../architecture/trade-offs.md#2026-11-06--worker-concurrency-follows-measured-machine-capacity-capped-by-the-kernel).
- **Change:** `src/core/capacity.ts` samples cores, 1-minute load and free
  memory, computes a limit (auto: min of cores, a load-aware CPU budget and a
  memory budget, ceiling 16), and exposes a counting `CapacityGate`. The runtime
  acquires a slot around every single-agent execution and every subagent
  dispatch; the assembly owns one gate so the queue and every wave share the
  budget. `config.json` `maxConcurrentWorkers` pins a ceiling (0 = auto),
  re-read on each acquire and exposed through `PATCH /api/config`. A read-only
  `get_capacity` tool lets the Main Agent size a plan; the charter tells it to
  call it.
- **Eval:** `test/capacity.test.ts` — CPU-bound, memory-bound, load-sensitive,
  owner pin capped by cores, gate never exceeds the limit and wakes waiters in
  order, cancelled waits release their slot. Tool provenance includes
  `get_capacity`. Full suite 525 tests / 525 pass; typecheck, gate and bilingual
  docs pass.
- **Execution chain:** trade-off first; pure function and gate; runtime
  acquire/release at both execution entry points; factory-owned gate with a
  live pin; settings endpoint; tool and charter; tests; docs.
- **Pros / cons:** a 16-core idle host and a 2-core busy laptop now behave
  differently, which is the point. Same-workspace write steps are still
  serialized by the workspace lock, so capacity is a ceiling, not a promise of
  parallelism for dependent or conflicting work. The formula is a heuristic,
  not a measurement of the model endpoint's own concurrency limit.
- **Not verified:** no load test on a large host, and the endpoint's own
  concurrency/rate limits are unknown; a wide plan may queue at the provider
  rather than at the Kernel.
- **Reversal condition:** see the trade-off entry.

### 2026-11-06 — Second pass: the lane runs the five desktop traces again

- **Goal / hypothesis:** with the three holes closed, the same five traces can produce patches whose case is green after the fix, and the lane refuses anything that is not.
- **Trade-off:** [post-fix case check](../architecture/trade-offs.md#2026-11-06--the-repair-lane-re-runs-the-hashed-regression-cases-after-the-fix); [bounded staging](../architecture/trade-offs.md#2026-11-06--repair-staging-removes-known-runtime-scratch-not-arbitrary-files); [targeted edits (now including write_file refusing an existing path)](../architecture/trade-offs.md#2026-11-06--the-native-worker-gets-a-targeted-edit-tool).
- **Change:** the fourth hole found by this pass — `write_file` now refuses a path that already exists, so an existing file can only be changed through `edit_file`. A retry of the refused traces then exposed the fifth: `edit_file` could still replace most of a file (127 lines from `memory.js`, 315 from `audit.js`) while the narrow case went green, so the lane now counts staged deletions and refuses more than 40 production lines (`fix-too-large`). Tests: `write_file` creates a new file and refuses to replace it; a 100-line rewrite is refused and case lines are excluded from the count; phase-2 wording updated.
- **Eval:** `node --experimental-strip-types --test test/native-client.test.ts test/repair.test.ts` — 32 cases pass. Full suite 626 pass / 3 skipped / 0 fail after the two merged fixes; `npx tsc --noEmit` pass; `npm run gate` PASS. The lane runs are the behavioural eval, per trace below.
- **Benchmark run:** five repair runs with the native worker on Magpie `360/deepseek/deepseek-v4.1-flash`, `CLONE_AI_NATIVE_MAX_ROUNDS=32`, `CLONE_AI_NATIVE_MAX_TOKENS=50000`, `CLONE_AI_NATIVE_TIMEOUT_MS=900000`, isolated clone homes `~/.clone-repair-r1`…`r5`, reports in each home's `rsi/last-run.json`. Results: memory-refresh (r1) — phase 1 red (2 failing assertions), post-fix case green, refused by `typecheck` because the generated case had two TS2554 errors; sidebar (r4) — phase 1 red, post-fix case green, refused by `suite` (the generated case's English-only comment failed the bilingual test) and `typecheck` (never[] inference); archive (r2) — red only for a harness reason, post-fix case still red, refused by `regression-still-red`; audit (r3) — phase 2 replaced 127 lines of `audit.js` with `write_file`, the cases still failed, refused by `regression-still-red`; a second audit run (r6) crashed before any assertion and was refused by `not-red`; gateway (r5) reached a valid red case but the fix phase called a helper it never defined, so the case stayed red and `regression-still-red` refused it. The two refused-by-repo-checks fixes were merged after the working agent made mechanical adjustments to the generated cases (an optional parameter; bilingual comments and `any[]` annotations) and re-ran the cases, tsc and the suite.
- **Execution chain:** ran memory and archive concurrently, then audit and sidebar; inspected each fix's diff before accepting; kept the lane's production patches and its case logic, changing only what the repository's typecheck and bilingual rules required; stopped no lane early except by its own gate. No new model tokens beyond the five runs.
- **Pros:** the post-fix check converted the earlier false-fixed run into a refusal, caught a case that was red only because its harness crashed, and caught a destructive whole-file rewrite; two real fixes came through the lane.
- **Cons / next time:** the model cannot see `tsc` or the bilingual rule while writing the case, so a correct fix can still be refused by repo checks; the case needs either a pre-write lint in phase 1 or the working agent's mechanical pass. `write_file` refusing existing paths may block a legitimate full rewrite; that must go through `edit_file` with the full old content. A second retry of the three refused traces produced no mergeable patch either: archive and audit rewrote most of their UI file (127 and 315 deleted lines) while the case went green, and were stopped before committing — the new deletion gate now refuses both; gateway crashed before any assertion (`not-red`). The gateway and audit traces still have no patch; a further attempt should first require the model to define any helper it calls.
- **Reversal condition:** see the edit-tool trade-off; if refusing existing paths blocks legitimate repairs, allow `write_file` for files under a size threshold instead, not for large UI scripts.

### 2026-11-06 — Close the three repair-lane holes found on the desktop attempts

- **Goal / hypothesis:** the desktop-repair attempts exposed three ways the lane can report or commit something that is not a verified fix: it never re-ran the regression cases after the fix, staging carried runtime scratch, and whole-file `write_file` let a model replace a large UI script with a fragment. Close all three so `fixed` means the recorded failure is gone and the commit carries only the fix and its case.
- **Trade-off:** [re-run the hashed cases](../architecture/trade-offs.md#2026-11-06--the-repair-lane-re-runs-the-hashed-regression-cases-after-the-fix); [stage only known runtime scratch](../architecture/trade-offs.md#2026-11-06--repair-staging-removes-known-runtime-scratch-not-arbitrary-files); [a targeted edit tool](../architecture/trade-offs.md#2026-11-06--the-native-worker-gets-a-targeted-edit-tool).
- **Change:** `src/repair/gates.ts` (`verifyRegressionGreen`, `stageRepair`, `isRuntimeScratch`); `src/repair/repair-lane.ts` (run the cases after the fix and stop with `regression-still-red`, record `regressionAfter`, use `stageRepair`, prefer `edit_file` in phase 2); `src/workers/native-worker-factory.ts` (`edit_file`: one exact occurrence, refuse missing/ambiguous, refuse a shrink below one tenth); `src/cli/clone-ai.ts` prints the post-fix regression result; `test/repair.test.ts`, `test/native-client.test.ts`, `test/mcp.test.ts`.
- **Eval:** `node --experimental-strip-types --test test/repair.test.ts test/native-client.test.ts` — 31 cases pass. Before this change the no-op-fix case would reach the suite and be reported fixed in a repository whose suite excludes `test/regression/`; the new case expects `regression-still-red`. The staging case fails against `git add -A` (it stages `node_modules` and `.probe/junk.txt`), and the first "stage only tracked + regression files" implementation failed the existing protected-path test by silently dropping a new protected file. The `edit_file` case fails against a file-tools list without the tool and against an unguarded replacement (the 8 KB fragment accepted). `test/mcp.test.ts`'s built-in-only list now includes `edit_file`. Full suite: 624 pass / 3 skipped / 0 fail (one unrelated WhatsApp test was flaky on the first run, passed alone and on the rerun); `npx tsc --noEmit` pass; `npm run gate` PASS with `baseline unchanged`.
- **Benchmark run:** none — deterministic, offline; no provider, model, or dataset.
- **Execution chain:** read the false-fixed report (`d8c54037` / `4accee4b`) and the 8 KB `app.js` from the stopped preview attempt; implemented the green re-run first; implemented staging as "tracked plus `test/regression/`", which the existing protected-path test caught as a hole (a new protected file would be silently dropped), then replaced it with `git add -A` plus an explicit scratch deny-list; added `edit_file` with the single-occurrence and 10× shrink guards; wired phase-2 wording and the CLI report; ran the targeted tests (two failures: the no-op fix ended at `kernel` until the fake phase wrote an unrelated file, and the staging fix itself), then the full suite (one flaky unrelated test, green on rerun), typecheck and gate. Cost: no model tokens; about 40 minutes of local work.
- **Pros:** `fixed` now requires the hashed case to pass after the fix; the commit cannot carry `node_modules` or the known scratch; a small fix to a large file has a tool that cannot turn it into a fragment.
- **Cons / next time:** a scratch file with an unlisted name can still enter the diff (visible in `changed`); the deny-list is repository-shaped and should move to a manifest if scratch names grow; `edit_file` requires an exact excerpt, so a model that has not read the file cannot use it; the lane still does not re-run the case against the **served** checkout, only the worktree (the cherry-pick is the working agent's step).
- **Reversal condition:** see the three trade-off entries.

### 2026-11-06 — Desktop defects handed to the repair lane with a Magpie worker

- **Goal / hypothesis:** five observable defects in the desktop app's operating logic can be fixed through `clone-ai repair` with the native worker pointed at Magpie `360/deepseek/deepseek-v4.1-flash`, each with a failing regression case and a verified patch.
- **Trade-off:** the per-bug entries in [trade-offs.md](../architecture/trade-offs.md) (memory-library refresh, archive/restore TypeError, audit dispatch block, sidebar restore control, plain-preview underscores, effort select).
- **Change / attempts:** worker configured by `CLONE_AI_NATIVE_MODEL=360/deepseek/deepseek-v4.1-flash`, `CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425`, `CLONE_AI_NATIVE_MAX_ROUNDS=32`, `CLONE_AI_NATIVE_MAX_TOKENS=50000`, `CLONE_AI_NATIVE_TIMEOUT_MS=900000`, isolated clone homes (`~/.clone-repair{,-2,-3}`) with `draft-maker` bound to `native`; each attempt is one crafted trace under `failed-traces/`. Results (gates as the lane reported them, plus the working agent's own check): the memory-refresh trace reached a valid red case (382-line vm test, 2 failing assertions) but its fix phase (32 rounds, 971k input tokens) wrote nothing; the lane still said fixed because it does not re-run the regression cases after the fix, and the case remained red — not merged. The archive/restore trace's first case was red because the vm lacked an `Element` global, and after that fact was added the next case still missed the PATCH in its DOM stub; no patch. The audit-dispatch trace produced two valid red cases ("步骤 —" and "blocked run says no record"), but the fix phase held one provider call past the step and the rerun's cases crashed without an assertion (the lane's `not-red` gate refused). The plain-preview trace reached a red case, then the fix phase replaced the 118 KB `apps/desktop/ui/app.js` with an 8 KB fragment containing only the functions the case slices; the suite and typecheck do not load that file, so the lane would have reported fixed — the attempt was stopped before committing. The effort-select and hidden-restore traces reached valid red cases (the effort case named the exact generic list; the sidebar case showed the empty-state markup with no restore control), but their fix phases were still in one provider call at the report deadline and were stopped without a production write.
- **Eval:** per attempt, the lane's red check and the working agent's own run of the case in the repair worktree; full suite and `npm run typecheck` on the working tree. No benchmark run: no dataset or scoring parameters are involved.
- **Execution chain:** the repair lane's implementation branch was merged into `main` first (it was not on `main`); the native worker needed a round budget, then a completion cap, then a "write before you answer" system-prompt rule, then phase-specific early-write rules; the completion cap was raised from 16k to 50k after `write_file` proved unable to rewrite large UI files. Roughly 1 h of the 2 h window went to those harness changes. Total model spend across attempts is on the order of 4M input / 300k output tokens; exact per-run usage is in the run audits under each clone home.
- **Pros:** the lane can now produce genuine red reproductions for UI code (`test/regression/` cases that run the real scripts in `node:vm`), and the failure reports name the exact gate.
- **Cons / next time:** three holes block trusting the lane for desktop code: (1) after the fix it re-runs only `npm test` (which excludes `test/regression/`) and the typecheck, never the regression cases — a no-op or scratch-only change is reported as fixed; (2) `git add -A` stages `node_modules` (the ignore rule is `node_modules/`, which does not match the symlink) and any scratch files; (3) `write_file` is whole-file only, so a model fixing one line in a 118 KB script can replace it with a fragment, and neither the suite nor the typecheck notices. Fix those before the lane is used on UI files: re-run the hashed cases after the fix, stage only tracked paths plus `test/regression/`, and give the worker a search/replace edit tool with a size guard.
- **Reversal condition:** see the per-bug trade-offs; the lane's own gate/write fixes are tracked in the two entries above.

### 2026-11-06 — The native worker takes an explicit round budget

- **Goal / hypothesis:** a repair phase must be able to read the failing code and then write a case and a patch in one step. The native client's hard-coded 12-round limit stopped the first real repair run before it wrote anything.
- **Trade-off:** [2026-11-06 — The native worker takes an explicit round budget](../architecture/trade-offs.md#2026-11-06--the-native-worker-takes-an-explicit-round-budget).
- **Change:** `readNativeWorkerEnvironment` reads `CLONE_AI_NATIVE_MAX_ROUNDS` and `CLONE_AI_NATIVE_MAX_TOKENS` (positive integers; an unset or malformed value keeps the client default), and `createConfiguredNativeWorker` passes both to `OpenAiCompatibleClient` (`maxRounds`, and `max_tokens` in the request). `test/native-client.test.ts` gained the parsing assertions, a client case that stops at the configured number of model calls, and a case asserting the token cap reaches the request body.
- **Eval:** `node --experimental-strip-types --test test/native-client.test.ts` — 11 cases, all pass. Before the change the option did not exist and the client always stopped at 12; the new case would fail against the old code because `maxRounds` was not read from the environment.
- **Benchmark run:** no benchmark; the eval is the repair lane against Magpie `360/deepseek/deepseek-v4.1-flash` (no dataset or scoring parameters). Run records: phase-1 trace `ui-memory-refresh-1`, lane report `~/.clone-repair/rsi/last-run.json`, provider `native`, model `360/deepseek/deepseek-v4.1-flash`, effort unspecified (gateway default), worker round budget 24 then 32, `CLONE_AI_NATIVE_TIMEOUT_MS=900000`.
- **Execution chain:** read `openai-compatible-client.ts` and `native-worker-factory.ts`; edited the environment reader and the client construction; ran the targeted tests and `tsc --noEmit`; started the lane with 24 rounds. That run (`426f3d3a`, 24 calls, 423,163 input tokens, 150 s) wrote only a passing probe test, so the round budget alone did not produce a patch. The budget was raised to 32 for the next try; the wording change below addresses the actual failure mode.
- **Pros:** the budget is explicit and owner-controlled; malformed values cannot create a zero-round loop.
- **Cons / next time:** a bigger budget lets a model explore more without writing, so it must be paired with plan wording that makes the deliverable explicit. The eval does not measure a real repair, only the client's stopping behavior.
- **Reversal condition:** see the trade-off entry — if native steps routinely finish within 12 rounds, remove the knob rather than keeping a misconfiguration surface.

### 2026-11-06 — The repair plan tells the worker how its step is judged

- **Goal / hypothesis:** the same trace produced no reproduction at 12 rounds and a passing probe at 24. The worker was reading the repository as the goal instead of treating the reproduction file as the goal.
- **Trade-off:** [2026-11-06 — The repair plan tells the worker how its step is judged](../architecture/trade-offs.md#2026-11-06--the-repair-plan-tells-the-worker-how-its-step-is-judged).
- **Change:** `repairPlan`'s phase-1 instructions now say to write the reproduction before broad exploration, read only the files it needs, and leave no diagnostic/probe files under `test/regression/`; the acceptance criterion states that every file there must be a reproduction. `test/repair.test.ts` asserts the wording.
- **Eval:** `node --experimental-strip-types --test test/repair.test.ts` — 16 cases, all pass. Before the change the new assertions fail against the old instruction text; the lane run itself is the behavioral eval.
- **Benchmark run:** the repair-lane run with the same trace and model; command, model, budget and report path are recorded in the entry above. Result: see the lane outcome recorded in the final report of this work.
- **Execution chain:** read the two failed run audits (`1dddd6b4`, `426f3d3a`), wrote the trade-off entry, edited the plan text and the acceptance criterion, added the structural assertion, ran the targeted test, committed, and re-ran the lane. Run `d8c54037` finally produced a red case (`test/regression/ui-memory-refresh.test.ts`, 2 failing assertions) at 32 rounds / 688 s. Its phase 2 (`4accee4b`) then spent all 32 rounds / 375 s reading README, `.work-orders`, `.verification-baseline`, `node_modules` and `memory.js` twice, produced no artifact, and the lane still reported **fixed**: `git add -A` staged only `.probe/*`, the `node_modules` symlink and the test, and `evalAfter` re-ran `npm test` (which does not include `test/regression`) plus the typecheck. Running the regression case afterwards still failed. The fix phase was therefore tightened: read only the failing case and the production file, no scratch files, no trade-off entry, no shell commands, plus a smaller-case instruction for phase 1. That run was not cherry-picked; its worktree and branch were deleted. The next run (`f7e07553`, 28 rounds, 574,129 input / 74,641 output tokens) read 20 files and ended `completed` with no artifact at all, so the native system prompt now refuses a summary that claims work no write performed and phase 1 must write within three tool calls.
- **Pros:** the instruction now states the deliverable and forbids the failure mode observed twice, without raising the budget again; the criterion change is testable.
- **Cons / next time:** wording is a soft control — a model can still ignore it, and the lane only learns that after spending the budget. This run exposed a **gate hole**: the lane never re-runs the regression case after the fix, so a no-op (or scratch-only) change is reported as fixed when the top-level suite happens to pass. That must be fixed in the lane (re-run the hashed cases and require them green before the protected-path check) before its "fixed" status can be trusted; until then the working agent runs the case itself. A second hole: `git add -A` staged the `node_modules` symlink and `.probe/` scratch files, so the staging step needs an explicit ignore list. A stronger design would reject the Run's evidence (a probe file that passes) before the red check; that requires a definition of "reproduction" the lane can evaluate.
- **Reversal condition:** see the trade-off entry.

### 2026-11-06 — The repair lane becomes a clone-ai Run (AGENTS.md §4 made executable)

- **Goal / hypothesis:** AGENTS.md §4 says a bug in clone-ai is fixed through clone-ai's own repair lane. Until now the lane was `scripts/nightly-rsi.mjs` building prompts and spawning `claude -p`, so clone-ai never performed the repair and the rule described something the system did not do. Make the repair a Kernel Run executed by a configured worker, keeping every existing gate.
- **Trade-off:** [2026-11-06 — The repair lane is a clone-ai Run](../architecture/trade-offs.md#2026-11-06--the-repair-lane-is-a-clone-ai-run-not-a-script-driving-another-cli); [MCP tools are opted in per server](../architecture/trade-offs.md#2026-11-06--mcp-tools-are-opted-in-per-server-and-pass-the-same-gate-as-built-ins).
- **Change:** `src/repair/repair-lane.ts` (trace selection, two Kernel Runs, gates, report), `src/repair/worktree.ts` (isolated linked worktree, dependency link, removal), `src/repair/gates.ts` (red verification, per-path hashing, staged-path inspection, commit), `clone-ai repair [--dry-run] [--keep] [--max-traces N] [--agent id] [--base ref]`, `selfcheck --repair` now calls the lane instead of spawning the script. `scripts/nightly-rsi-policy.mjs` and `scripts/nightly-rsi-state.mjs` are imported, not copied, so the protected-path list and the consumed-trace ledger are single-sourced. Two seams were added to existing code: `createRuntimeAssembly({ evidenceKinds, knownAgentIds })` (a black-box worker cannot report `test` evidence, and an explicit registry must be the Kernel's list of executors) and `NativeToolSpec.close` (an MCP child process must not outlive its step).
- **Eval:** `node --experimental-strip-types --test test/repair.test.ts` — 16 cases. Unit: failing-assertion counting, crash-not-a-reproduction, green-suite refusal, per-path hashing with add/remove/change, worktree isolation (the served checkout's `git status` stays empty), pre-flight refusals (existing path, non-git-root), staged protected-path detection, the plan's step order and acceptance wording, and worktree retention (a failed run keeps its tree, a fixed one does not, `--keep` overrides both). End to end with a fake adapter: a full repair (two Runs dispatched in order, red verified before the fix, commit on a branch, trace not committed, trace consumed only on success); a case that already passes stops before phase 2 (one dispatch only); an edited regression case is rejected by the hash gate; a protected edit is refused before the commit; a failed step ends the lane with no commit and the trace left eligible. Before this change there was no in-process repair lane to test; `test/nightly-rsi.test.ts` still covers the script's protected-path refusal. Full suite: `npm test` 617 tests / 613 pass / 1 fail / 3 skipped on the first run — the fail was this slice's English-only comment in `test/mcp.test.ts`, fixed; the final run is 618 tests / 615 pass / 3 skipped / 0 fail. `npm run typecheck` pass; `npm run gate` PASS with `baseline unchanged`.
- **Benchmark run:** none — this is a deterministic, offline eval with a fake adapter. No provider, model, dataset, or scoring parameters are involved.
- **Execution chain:** read the script lane, the Kernel plan/execute path, the verifier plugins and the worker adapters; wrote the trade-off entries first; implemented worktree + gates + lane; iterated five times on real failures — (1) the red check accepted an import-time crash because `node:test` counts it as one failing case, so it now requires a `node:test` assertion error in the output; (2) the first design put both phases in one Run, which made the disabled fake worker take the "fix" branch and silently produce a green case, so each phase is now its own Run with the red check between them; (3) a smoke run against `~/.clone` picked `direct-responder` by role and the Kernel then rejected it for lacking `filesystem_write`, so worker selection is now by declared capability; (4) runtime scratch (`.clone/workspace-execution.sqlite3`) was being staged, so `.rsi/` and `.clone/` are removed before staging; (5) the final `finally` deleted the worktree the CLI had just promised to keep, so retention now follows the outcome. Final state: `npm test` 618 tests / 615 pass / 3 skipped / 0 fail, `npm run typecheck` pass, `npm run gate` PASS with `baseline unchanged`. No model calls were made.
- **Pros:** every gate now runs inside the process under test, so it is proven by deterministic tests rather than by a live model; the protected-path list and the consumed-trace ledger have one owner; the report carries the eval before and after plus the trade-off heading the fix added.
- **Cons / next time:** the lane has not run end to end against a real model here — the automated smoke run stopped at phase 1 because the configured worker could not write files in that home, and no model patch was produced. The fallback suite command (no `package.json` `test` script) runs every `test/**/*.test.ts`; it was exercised only on a small fixture repository. `tsc --noEmit` in a worktree needs `node_modules`, which is symlinked from the served checkout — a checkout without installed dependencies falls back to the `npx tsc` path that prints a misleading banner (observable in the debug fixture, not in this repository).
- **Reversal condition:** see the trade-off entry — if the Kernel path cannot express a repair, return the phases to a script while keeping the shared policy and trace modules.

### 2026-11-06 — MCP as a second tool source behind the existing gate

- **Goal / hypothesis:** clone-ai's tool surface came only from `kernel-tools.ts` and `native-worker-factory.ts`. The owner asked for missing capabilities to be added through MCP without widening what a step may do.
- **Trade-off:** [MCP tools are opted in per server](../architecture/trade-offs.md#2026-11-06--mcp-tools-are-opted-in-per-server-and-pass-the-same-gate-as-built-ins).
- **Change:** `src/workers/mcp-client.ts` (config parse, disabled-by-default, risk declaration, per-step server filtering for CLI providers, observation framing, dependency-free stdio and streamable-HTTP JSON-RPC client), `workerTools()` in `native-worker-factory.ts` (built-ins plus enabled servers' declared tools), `NativeToolSpec.close` so the child process is released when the step ends, `mcpConfigArgs` in `providers.json`/`provider-catalog.ts` for providers that accept `--mcp-config` (Claude Code), and a fallback to built-in tools for every provider that does not.
- **Eval:** `node --experimental-strip-types --test test/mcp.test.ts` — 11 cases: disabled by default (including `"enabled": "yes"` not counting as consent), malformed config reported rather than treated as empty, built-in-only tool table with no enabled server, output framed and sanitized as an observation, undeclared risk treated as external and refused, a read tool offered to a read-only step while a network tool is not offered without a network grant, per-call path checks for a path-taking tool, a disabled server refused by the client, a real stdio child process answering `tools/list` and `tools/call`, CLI server filtering (only servers whose every declared risk is granted), and `workerTools` wiring from `mcp.json`. Before this change there was no MCP code path at all, so the "before" is the built-in-only table asserted in the third case.
- **Benchmark run:** none — deterministic, offline; the stdio test uses a local child process, not a provider.
- **Execution chain:** read the worker adapters and the connector framing module; wrote the trade-off entry first; implemented the config, gate mapping, framing and client; ran the tests and fixed one assertion that expected a different error prefix. No new dependency was added; the trade-off entry records why and the condition for replacing this client with an SDK. Final state: `npm test` 618 / 615 pass / 3 skipped / 0 fail; `npm run typecheck` pass; `npm run gate` PASS.
- **Pros:** zero new dependencies; the risk authority is the owner's config, not the server's self-description; a provider without `--mcp-config` keeps working with built-in tools instead of failing the run.
- **Cons / next time:** the CLI path hands the whole server to the provider when all of its declared tools pass the gate — the CLI cannot enforce per-call path checks, and the trade-off entry states that. Real third-party servers were not exercised; the only server used was the local fixture.
- **Reversal condition:** see the trade-off entry — adopt a maintained SDK if resources, prompts, sampling or OAuth enter scope.

### 2026-11-06 — Settings speak in workers, and dispatch is visible

- **Goal / hypothesis:** the settings dialog felt abrupt (tab switches with no state, no keyboard flow, a second "providers" list duplicating the worker list), and nothing in the UI explained *why* a step went to a particular worker.
- **Trade-off:** [2026-11-06 — Settings speak in workers, and dispatch is visible](../architecture/trade-offs.md).
- **Change:** settings navigation is a real tablist (`role=tablist/tab/tabpanel`, `aria-selected`, arrow/Home/End keys, per-panel scroll memory, a 160 ms fade/slide honouring `prefers-reduced-motion`). The legacy provider registry is removed; each worker row now carries its provider's installed state, command, execution boundary, effort select, install action and host-access action. The audit run detail gained "Worker 派发": chosen agent, provider, step, routing source and reason from `dispatch.decided`. Plan rows name the worker that runs the step.
- **Eval:** `node --experimental-strip-types --test test/ui-structure.test.ts` (new assertions: no `provider-registry`, seven tabs with tab semantics, `state.settingsScroll`, dispatch block and source labels present). Browser check against a seeded home: arrow keys move the selection (agents → mobile), Home/End jump to first/last, the provider registry is absent, worker rows show provider state and five effort selects, and the dispatch block renders two seeded decisions with translated sources. `npm test`: 591 pass; `npm run gate`: PASS.
- **Benchmark run:** none — deterministic UI/structural eval only; no provider or dataset involved.
- **Execution chain:** inspected the settings/audit UI and `dispatch.decided` payload; the repair lane could not run (headless `claude` reported Not logged in, and spawning `pi` with write access was blocked by the session classifier), so the working agent wrote the change by hand at the owner's direction. First HTML edit dropped the closing `>` on every settings section and the app stalled at startup; found via the startup tip (`Cannot set properties of null`), fixed, and re-verified in the browser. Cost: no model tokens for the patch (local edits), ~25 minutes.
- **Pros:** one list instead of two, keyboard and semantics work, dispatch is answerable without reading raw payloads, and every panel keeps its place.
- **Cons / next time:** the hand-written route skipped the repair-lane evidence; tab transitions cannot be verified headlessly beyond class toggles; scroll memory is asserted structurally but the demo home's panels were not tall enough to exercise it in the browser.
- **Reversal condition:** see the trade-off entry.

## Template

```markdown
### YYYY-MM-DD — <title>

- **Goal / hypothesis:** what should improve, and why we believe it.
- **Trade-off:** link to the entry in `docs/architecture/trade-offs.md`.
- **Change:** one paragraph plus the main files or areas.
- **Eval:** command, dataset or case ids, result before and after.
- **Benchmark run:** command, provider/model, dataset or task ids, scoring
  parameters, and result file. Required whenever a benchmark was run; omit only
  for a deterministic test-only eval.
- **Execution chain:** steps, workers or tools, duration and cost, failures and
  retries.
- **Pros:** what the chain did well.
- **Cons / next time:** where it was slow, expensive, brittle, or incomplete.
- **Reversal condition:** copied from the trade-off entry.
```

### 2026-11-05 — Rebuild the app as part of self-check

- **Goal / hypothesis:** ensure the app the owner launches contains the exact
  source revision that passed tests and is about to be pushed.
- **Trade-off:** [self-check rebuilds the local app](../architecture/trade-offs.md#2026-11-05--self-check-rebuilds-the-local-macos-app).
- **Change:** `scripts/selfcheck-push.mjs` runs the macOS app build with
  `--replace` after tests, typecheck and gate pass.
- **Eval:** the next selfcheck run must produce a fresh `dist/Clone AI.app`, and
  launch verification must show the new UI. Full test/typecheck/gate results are
  recorded by the script itself.
- **Execution chain:** implemented after stale app bundles made completed source
  edits appear absent.
- **Pros:** the launched app cannot silently lag the verified source.
- **Cons / next time:** macOS selfcheck is slower.
- **Reversal condition:** remove the rebuild when a hot-reload runtime replaces
  the packaged app.

### 2026-11-05 — Shared audit for every Agent invocation

- **Goal / hypothesis:** make every Main Agent call visible in the owner's
  audit even when an integrating agent uses an isolated `CLONE_HOME`.
- **Trade-off:** [invocations audited outside CLONE_HOME](../architecture/trade-offs.md#2026-11-05--every-agent-invocation-is-audited-outside-clone_home).
- **Change:** `src/audit/invocation-ledger.ts` records caller, request, visible
  reply, error, model, effort, workspace, session file, Run ids and duration in
  `~/.clone/audit/invocations.jsonl`. CLI, desktop companion, WhatsApp and the
  standalone Main Agent entry all write through the same ledger. The audit page
  gained an **Agent invocations** tab and `clone-ai invocations` exposes the
  same records.
- **Eval:** `test/invocation-ledger.test.ts` and the companion API test cover
  isolated-home visibility, redaction, failed turns, interrupted starts and
  detail output. A real turn run with a temporary `CLONE_HOME` appeared in the
  default ledger with caller `codex`, model
  `360/deepseek/deepseek-v4.1-flash`, effort `high`, and reply `OK`
  (invocation `7cb576ee`). Full suite: 568 tests, 565 passed, 3 skipped, 0
  failed; `npm run gate` passed.
- **Execution chain:** implemented and tested in this working tree after the
  self-fix runs exposed that temporary homes hid their audit. The same change
  also keeps the verifier's file-expectation regression coverage.
- **Pros:** the owner can now answer who called Clone AI, what they asked, what
  came back and which Run was created without depending on the caller's data
  directory.
- **Cons / next time:** the ledger is a second plaintext store; retention and
  encryption are not yet configurable.
- **Reversal condition:** move to an encrypted owner-scoped audit store if the
  plaintext JSONL no longer meets the threat model.

### 2026-11-05 — Narrow inferred file expectations

- **Goal / hypothesis:** prevent implementation identifiers from producing
  missing-file failures while retaining ordinary paths and explicitly requested
  root-level deliverables.
- **Trade-off:** [explicit intent for root-level names](../architecture/trade-offs.md#2026-11-05--require-explicit-intent-for-root-level-file-names).
- **Change:** `src/core/verification.ts` filters URLs, code expressions and
  uppercase constant directory segments, and requires same-sentence file
  intent plus an allowed extension for root-level names. The regression cases
  are in `test/verification.test.ts`; bilingual JSDoc and changelog describe
  the behavior.
- **Eval:** Before: the documented offline reproduction in
  `docs/engineering/verification-repair-blocked-2026-11-05.md` extracted all
  four implementation identifiers and produced a missing-file failure. No
  before-change test was run in this work order. After:
  `node --experimental-strip-types --test test/verification.test.ts test/golden-path.test.ts`
  passed 16/16 tests, and `npm run typecheck` exited 0.
- **Execution chain:** an owner-authorized interactive worker inspected the
  existing reproduction and workspace, recorded the trade-off before editing,
  then implemented the filter and deterministic regression cases. No live model
  test, network operation, or benchmark was used; elapsed time and worker cost
  were not measured.
- **Workspace observation:** while this worker was running, the initially
  unmerged changelog and other pre-existing changes disappeared from the short
  status. The current HEAD is merge commit `ba1fe4a`, which already contains
  this work's verification tests and changelog entry. This worker ran no commit
  or push. After verification, `git status --short` reported:

  ```text
   M docs/architecture/trade-offs.md
   M docs/architecture/trade-offs.zh-CN.md
   M docs/engineering/optimizations.md
   M src/core/verification.ts
  ```

- **Pros:** the documented false-failure scenario and both path forms have
  targeted coverage without model calls.
- **Cons / next time:** the whitelist and explicit-intent rule can miss real
  deliverables; the full suite and gate are outside this work order. Collect
  representative missed cases before widening either rule.
- **Reversal condition:** revisit when representative real deliverables show
  misses matter; widen vocabulary or extensions only with regression cases
  preserving the exclusions.

### 2026-11-05 — Remember consumed nightly repair traces

- **Goal / hypothesis:** avoid repeating successful repairs for unchanged failed
  trace files while allowing new bytes for the same runId to be repaired.
- **Trade-off:** [runId and file fingerprint](../architecture/trade-offs.md#2026-11-05--consume-repaired-traces-by-runid-and-file-fingerprint).
- **Change:** `scripts/nightly-rsi-state.mjs` stores fingerprints and outcome
  metadata with atomic replacement; `scripts/nightly-rsi.mjs` filters the batch
  and records only successful outcomes. The matching declaration,
  `test/nightly-rsi-state.test.ts`, `docs/nightly-rsi.md`, and the bilingual
  changelog document and cover the contract.
- **Eval:** Before: source inspection showed no consumption state; running
  `node --experimental-strip-types --test test/nightly-rsi-state.test.ts`
  failed on the missing new module, so there was no behavioral baseline run.
  After: the same command passed 6/6 deterministic tests; both
  `node --check scripts/nightly-rsi-state.mjs` and
  `node --check scripts/nightly-rsi.mjs` passed; `npm run typecheck` passed.
- **Execution chain:** the Main Agent ran on DeepSeek V4.1 Flash at `high`
  effort, proposed one coding step, and `draft-maker`/`codex-cli` implemented
  the state module, wiring, tests, and documentation. The Runtime then reported
  the step failed because the file verifier treated quoted identifiers such as
  `fs.rename`, `os.tmpdir`, and `consumed-traces.json` as files that must exist
  in the workspace. The supervisor independently ran the targeted tests and
  typecheck; they passed. This false-negative is tracked as a separate verifier
  defect. Approximate elapsed time: 3.5 minutes; live model calls were used and
  their cost was not measured.
- **Pros:** the result decision is shared with the runner; invalid state,
  failed replacement cleanup, and changed-content retry are covered offline.
- **Cons / next time:** no end-to-end repair or dry-run process was executed
  under this work order; the complete model-dependent behavior remains assumed.
  `npm test` and `npm run gate` were explicitly outside the allowed commands.
- **Reversal condition:** replace the file scheme if a durable shared ledger is
  required across machines, or byte changes without actionable evidence
  repeatedly trigger repairs.

### 2026-11-05 — Conservative recovery for orphaned planning

- **Goal / hypothesis:** close abandoned planning Runs without reclaiming fresh,
  claimed, or already planned work. A 15-minute grace period is an unmeasured
  assumption, not a guarantee that an unclaimed planner has stopped.
- **Trade-off:** [planning orphan grace period](../architecture/trade-offs.md#2026-11-05--recover-planning-orphans-only-after-a-conservative-grace-period).
- **Change:** `src/core/runtime.ts` checks the grace period and claims; the
  journal contract and SQLite store add a conditional fenced write that refuses
  concurrent Run changes. `test/claim-fencing.test.ts` covers the lifecycle,
  threshold, competing claims, concurrent plan, and unsupported stores.
- **Eval:** Before implementation, the targeted orphan-recovery cases were red.
  Afterward, `node --experimental-strip-types --test
  test/claim-fencing.test.ts` passed all 15 tests, `npm run typecheck` passed,
  and `npm run gate` passed. With live-model tests disabled, the full suite
  passed 545 tests with 3 skips and 0 failures. The first full run failed only
  because a leaked WhatsApp bridge process held port 4318; after clearing it,
  the suite was clean.
- **Execution chain:** the Main Agent ran on the user-authorized Magpie
  DeepSeek V4.1 Flash endpoint at `high` effort, proposed the plan,
  `claude-code` investigated, and `codex-cli` implemented and documented it.
  The self-run took about 17 minutes. Its verification step incorrectly ran
  the full suite with live tests enabled and hung; the supervisor cancelled
  that run, kept the completed edits, and independently ran the targeted and
  full deterministic suites. Model cost was not measured.
- **Pros:** the failure is reproduced before the fix; the transaction protects
  against a plan arriving after the snapshot, and the tests need no live model.
- **Cons / next time:** the timeout does not establish planner liveness, and
  the full suite could not pass in this environment. Use planner leases and
  duration measurements, and isolate the workspace and ports before testing.
- **Reversal condition:** if legitimate unclaimed planning exceeds 15 minutes,
  replace the timeout with a reliable planner lease or adjust it using measured
  durations before enabling this recovery.

### 2026-11-05 — Prompt provenance and offline regression gate

- **Goal / hypothesis:** make a Main Agent turn attributable to the prompt it
  actually read, and make the harness's judgment layers regression-testable
  without a live model.
- **Trade-off:** [prompt provenance](../architecture/trade-offs.md#2026-11-05--prompt-provenance-is-a-content-addressed-file-plus-a-journal-event),
  [regression gate](../architecture/trade-offs.md#2026-11-05--the-regression-gate-is-offline-per-case-and-behavior-only).
- **Change:** per-turn `main_agent.prompt_snapshot` events with charter,
  briefing, and tool-table hashes plus model/effort; content-addressed material
  under `prompt-snapshots/`; a listing endpoint; `npm run gate` with 11 verdict
  cases, 14 policy cases, 5 audit records, a per-case baseline, and a CI step.
- **Eval:** `npm run gate` — PASS (100% agreement, 0 false passes); `npm test` —
  451 tests, 448 pass, 3 skipped; `npm run typecheck` — pass. Before the gate
  there was no behavioral eval; the baseline generated in this change is the
  "before" for every later optimization.
- **Execution chain:** implemented in one session, then verified three times
  (feature commit, gate commit, post-merge). PR creation was blocked twice by
  the permission classifier and the PR was opened by hand; the base merge had a
  single `CHANGELOG.md` conflict, resolved by keeping both sides. No model calls
  and no provider time; CI is about 40 seconds per job.
- **Pros:** the gate is zero-cost, deterministic, and runs on every commit; the
  per-case baseline turns every later judgment shift into a reviewable diff.
  Prompt provenance needed no new store — the journal plus content-addressed
  files were already the right shape.
- **Cons / next time:** the first baseline encodes current behavior, so it
  cannot prove correctness — only detect change. The prompt-snapshot wiring into
  a real Pi session is covered by the tool-registration test and typecheck, not
  by an end-to-end session test (running one was blocked in the session). The
  PR/branch ceremony added two permission blocks and a conflict; the standing
  rule is now to merge to `main` directly and summarize the merge.
- **Reversal condition:** see the two trade-off entries above.

### 2026-11-05 — Failed traces, gated nightly repair, and the worker credential boundary

- **Goal / hypothesis:** give the repair loop honest material — redacted failure
  documents, including implicit failures — and a process that cannot merge or
  touch the rules, while removing tool credentials from the worker environment.
- **Trade-off:** [gated draft-PR lane](../architecture/trade-offs.md#2026-11-04--failed-traces-and-repair-run-only-in-a-gated-draft-pr-lane),
  [worker credentials](../architecture/trade-offs.md#2026-11-05--workers-inherit-model-credentials-only-never-tool-credentials).
- **Change:** `src/audit/failed-traces.ts`, `src/workers/worker-env.ts`,
  `scripts/nightly-rsi.mjs`, the launchd example, and the `traces` CLI command.
- **Eval:** four test files, 16 tests: failed traces (3), nightly gates (7),
  self-review (4), worker env (2). Integration verification: `npm test` 540
  tests / 537 pass / 3 skipped; `npm run typecheck` and `npm run gate` pass.
- **Execution chain:** implemented in the `dreamy-ritchie-b0f526` worktree; this
  entry records the shipped state and the integration verification. The nightly
  job itself was not run end to end during integration — it needs a real failing
  trace and a headless model — so that path is marked **assumed**.
- **Pros:** each of the five gates maps to a known failure mode; traces are
  redacted before a model can read them; credential refusal happens before spawn.
- **Cons / next time:** the end-to-end repair run is not exercised in CI (cost
  and a model dependency), and it produces draft PRs, a deliberate exception to
  the direct-to-main rule for routine work. The original chain was not captured.
- **Reversal condition:** see both trade-off entries.

### 2026-11-05 — Turn-level audit for every Main Agent entry point

- **Goal / hypothesis:** make a Main Agent turn auditable from the journal
  regardless of how it was started — CLI, `npm run main`, companion/server, or
  WhatsApp — including input, reply, tool calls, model/effort, usage and status.
- **Trade-off:** [every turn is a journal record](../architecture/trade-offs.md#2026-11-05--every-main-agent-turn-is-a-journal-record-not-a-side-file).
- **Change:** new `src/main-agent/turn-audit.ts` (shared begin/observe/finish
  plus the ledger), new `src/audit/turn-audit.ts` (projection), the two journal
  event types, `clone-ai audit turns`, `GET /api/audit/turns`, the audit-page
  tab, `turnId` on usage records, CLI usage recording, and self-review usage.
- **Eval:** `test/main-agent-turn-audit.test.ts` — 4 tests covering redaction,
  tool events, a failed turn, interruption idempotence, and newest-first loading.
  Full suite: 544 tests / 541 pass / 3 skipped; `npm run typecheck` and
  `npm run gate` pass; `node --check` on the audit UI.
- **Execution chain:** the gaps were found by reading each entry point and the
  audit projection; the trade-off was written first; one shared module was wired
  into four entry points; the tests and the full suite followed. Landed directly
  on `main`, no branch or PR. This change touches `src/core/contracts.ts` and
  several modules, which the nightly repair lane's protected-path gate forbids,
  so it was implemented here under the owner's direct instruction — the lane
  remains the default for trace-reproducible bugs.
- **Pros:** the same code writes the turn on every entry point, so the ledger and
  the journal cannot drift; tool calls and usage are finally attributable to a
  turn; redaction and caps bound the added journal size.
- **Cons / next time:** black-box CLI workers' internal tool calls remain
  invisible (a structural boundary); native-worker model usage was not recorded
  at the time (superseded by the native-provider entry below);
  `scripts/run-pi-task.mjs` and `nightly-rsi` remain outside the journal; turn
  events are not yet merged into the per-run trace view.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Native worker as a first-class provider with exact usage

- **Goal / hypothesis:** let an owner select the in-process worker per agent like
  any CLI, and make its model usage exact and attributable, so a
  CLI-versus-native comparison has data instead of impressions.
- **Trade-off:** [native provider](../architecture/trade-offs.md#2026-11-05--the-native-worker-becomes-a-provider-with-exact-usage-still-opt-in).
- **Change:** `native` registered in the provider catalog with agent identity and
  role capabilities; the native adapter reports usage; the OpenAI-compatible
  client parses both usage shapes; the runtime journals `usage.recorded` with
  runId/stepId; the audit exposes exact usage per execution; the audit UI shows
  it next to the gateway estimate.
- **Eval:** `test/native-client.test.ts` (usage parsing for both shapes, honest
  counting without tokens, provider identity/roles), `test/native-agent-worker.test.ts`
  (the completed event carries usage), `test/audit.test.ts` (the runtime journals
  usage and the audit projects it). Full suite: 549 tests / 546 pass / 3 skipped;
  `npm run typecheck` and `npm run gate` pass.
- **Execution chain:** trade-off first; provider, client, worker, runtime, audit
  and UI in that order; tests after each layer; full suite and gate at the end.
  A live native-versus-CLI benchmark was not run in that change; it ran later —
  see the benchmark entry below.
- **Pros:** the native worker is selectable and identifiable per agent; exact
  tokens are attributable to one step; a provider that omits usage is counted but
  not priced instead of looking free.
- **Cons / next time:** no live endpoint test; the native worker still has only
  filesystem tools; the default agents still point at CLIs; selecting `native`
  without the two env vars fails at registry build with a clear message.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Native vs Claude on the reliability task set

- **Goal / hypothesis:** measure whether the in-process worker completes the
  same fixed tasks as the Claude Code CLI, with exact usage, and find where they
  differ.
- **Trade-off:** [native provider](../architecture/trade-offs.md#2026-11-05--the-native-worker-becomes-a-provider-with-exact-usage-still-opt-in).
- **Change:** `benchmark/run.ts` accepts `--provider native` (no
  `--unsafe-host` needed), records verification, failure reason and exact usage,
  and gives the verifier the benchmark workspace. The missing workspace was a
  real harness bug: every relative artifact looked absent, so even `summarize`
  failed on the first run (`native-2026-11-05T07-23-30-609Z.json` keeps that
  evidence).
- **Benchmark run — native:** command
  `CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 npm run bench -- --provider native --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`;
  provider/model: `native` via the local Magpie gateway, model
  `360/moonshotai/kimi-k3.1-pro`; dataset: the five tasks in `benchmark/tasks.ts`;
  parameters: native `maxRounds` 12, work-order budget 12 model calls / 20 tool
  calls, per-task duration from `tasks.ts`; environment: macOS, Magpie at
  `127.0.0.1:3425`, no API key; result file
  `benchmark/results/native-2026-11-05T07-36-54-051Z.json`. **4/5**:
  summarize 15.9s / 2,112 tokens; two-step-chain 55.1s / 5,022;
  three-step-pipeline 131.1s / 10,973; code-tool 45.6s / 4,891;
  missing-input 20.5s / 2,002 — **completed with an invented `out/summary.md`**,
  so the expected failure did not behave. Total: 25,000 tokens.
- **Benchmark run — Claude:** command
  `npm run bench -- --unsafe-host --provider claude --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`;
  provider/model: `claude` with its configured default model; same dataset and
  parameters; result file
  `benchmark/results/claude-2026-11-05T07-48-06-889Z.json`. **4/5**:
  summarize 15.7s; two-step-chain 30.6s; three-step-pipeline 82.2s;
  code-tool 60.8s; missing-input 58.6s — **failed at verification** because
  `out/summary.md` was absent, but the benchmark's expected-failure check
  requires execution-stage `no_artifact`, so it counts as unexpected. The CLI
  reports no token usage to the runner.
- **Benchmark run — Pi:** command
  `npm run bench -- --unsafe-host --provider pi --tasks summarize`;
  result file `benchmark/results/pi-2026-11-05T07-41-52-338Z.json`; the simplest
  task hit the 180s work-order timeout. A real reliability data point, not a
  model comparison.
- **What the numbers say:** on the four solvable tasks both workers pass. Native
  is faster on code-tool (45.6s vs 60.8s) and slower on the two chained tasks
  (55.1s vs 30.6s; 131.1s vs 82.2s). Native reports exact usage (~25k tokens
  total); the CLIs report none to the runner. Neither meets the `missing-input`
  expectation, for opposite reasons: native invents the artifact, Claude fails
  cleanly at verification.
- **Findings / next:** harden the native prompt so a missing required input stops
  the turn instead of inventing content; decide whether a verification-stage
  missing artifact should count as `no_artifact` in the benchmark (it is the
  same event in substance). Until both are decided, treat the native worker as
  equal on solvable tasks but weaker on missing-input honesty. (Fixed in the
  entry below.)
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — A missing named input fails the native worker

- **Goal / hypothesis:** stop the native worker from inventing content when a
  file named in its work order or step instructions is missing; the benchmark
  showed it completing with a fabricated artifact.
- **Trade-off:** [missing input](../architecture/trade-offs.md#2026-11-05--a-missing-named-input-fails-the-native-worker-instead-of-allowing-invention).
- **Change:** a failed read of a path named in the work-order objective or step
  instructions ends the turn as `no_artifact` / `native-missing-input`; the
  prompt tells the model not to invent missing inputs; usage from a failed
  adapter is now journaled too.
- **Eval:** `test/native-agent-worker.test.ts` — a missing named input fails
  with the category and signature, an unnamed failed read still completes, and
  failed usage is carried. Benchmark: the native set is 5/5
  (`native-2026-11-05T08-07-23-864Z.json`); the final code re-ran `missing-input`
  as an expected failure with 1,397 tokens
  (`native-2026-11-05T08-10-22-910Z.json`). Full suite: 552 tests / 549 pass /
  3 skipped; typecheck, gate and bilingual docs pass.
- **Execution chain:** finding from the benchmark; trade-off; guard and prompt;
  tests; benchmark re-run; then usage-on-failure so failed runs are not silent.
- **Pros:** fabrication after a declared missing input is no longer accepted;
  failed runs now report tokens.
- **Cons / next time:** a legitimately optional path named in the instructions
  now fails; the benchmark's Claude `missing-input` still counts as unexpected
  because it fails at verification, not execution. Decide the `no_artifact`
  classification separately.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Native Main Agent loop behind a flag

- **Goal / hypothesis:** remove Pi from the Main Agent's critical path without
  changing behavior, by running the same prompt, tools and audit through an
  in-process OpenAI-compatible loop.
- **Trade-off:** [native main](../architecture/trade-offs.md#2026-11-05--a-native-main-agent-loop-behind-a-flag-not-a-flag-day).
- **Change:** `src/main-agent/prompt.ts` (SDK-free prompt compiler),
  `src/main-agent/native-runtime.ts` (chat loop, tool execution, ledger
  transcript, `search_history` over the ledger), `kernelToolDefinitions` in
  kernel-tools, and flag branches in `run-main-query`, the CLI and
  `npm run main`. Pi remains the default.
- **Eval:** `test/native-main-agent.test.ts` — 3 tests: a scripted tool call plus
  a final answer (reply, tool messages, and the turn/tool/usage/snapshot journal
  events), prior turns from the ledger, and explicit flag/endpoint handling.
  Full suite: 576 tests / 573 pass / 3 skipped; typecheck, gate and bilingual
  docs pass.
- **Live smoke:** `CLONE_AI_MAIN_RUNTIME=native
  CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro
  CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 clone-ai "请只回复：native 主 Agent 已就绪"`
  returned that exact reply; `clone-ai audit turns` shows the completed turn with
  3,393 tokens; `clone-ai invocations` shows caller `claude-code:<session>`,
  surface `cli`.
- **Pros:** the native path writes the same audit and usage records; the tool
  table is captured from the Pi extension so the two runtimes cannot drift; the
  shared invocation ledger identifies the caller.
- **Cons / next time:** at that point non-streaming and without compaction;
  both were added next (see the entry below). Images were refused at that point
  and are supported now; `search_history`
  searches the turn ledger, not Pi session files; native turns are not
  resumable as Pi sessions.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Native vs Pi Main Agent comparison

- **Goal / hypothesis:** check whether the native loop matches Pi on the same
  Main Agent tasks — direct answer, an authority read, and a plan proposal —
  before changing any default.
- **Trade-off:** [native main](../architecture/trade-offs.md#2026-11-05--a-native-main-agent-loop-behind-a-flag-not-a-flag-day).
- **Change:** new `benchmark/main-agent.ts` and `npm run bench:main`: three fixed
  prompts, an isolated clone home per task, the same model and endpoint for both
  runtimes, and a report with duration, tokens, tool calls, created runs, turn
  status and whether the expectation held.
- **Benchmark run — failed attempt:** command
  `CLONE_AI_BENCH_MAIN_MODEL=360/google/gemini-4-argon npm run bench:main`;
  both runtimes failed every task with a 400 from Magpie's upstream ("could not
  connect to stream"). The endpoint, not the harness, was broken
  (`main-agent-2026-11-05T09-01-57-162Z.json`).
- **Benchmark run — working:** command
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`;
  model: `360/anthropic/claude-sonnet-5-5` through Magpie at
  `http://127.0.0.1:3425`; tasks: direct-answer, authority-read, plan-proposal;
  one run per runtime per task; isolated clone home; result file
  `benchmark/results/main-agent-2026-11-05T09-06-13-005Z.json`. **Both 3/3**:
  - direct-answer: Pi 3.3s / 3,865 tokens, native 5.9s / 3,795 tokens; no tools,
    no runs.
  - authority-read: Pi 7.6s / 8,197, native 9.5s / 7,958; both called
    `get_authority` once; no runs.
  - plan-proposal: Pi 12.1s / 9,452, native 9.5s / 9,407; both called
    `propose_work_plan` once and created one run.
- **What the numbers say:** same task outcomes, same tool choice and same
  run creation. Tokens are nearly identical (Pi 21,514; native 21,160, about
  1.6% fewer). Pi is slightly faster overall (23.0s vs 24.9s summed), but native
  is faster on plan-proposal (9.5s vs 12.1s). One run per cell; treat this as a
  parity check, not a statistical benchmark.
- **Findings / next:** the native loop is behaviorally comparable on these
  tasks. It still lacks streaming and compaction, so the next comparison should
  include a long conversation and a multi-turn tool task; those are the likely
  divergence points.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Native Main Agent streams and compacts

- **Goal / hypothesis:** remove the two remaining gaps before any default
  change: stream tokens as they arrive, and keep a long conversation from
  silently losing early detail.
- **Trade-off:** [streaming and compaction](../architecture/trade-offs.md#2026-11-05--native-main-agent-streams-and-compacts-deterministically).
- **Change:** the native runtime requests SSE (`stream: true`,
  `stream_options.include_usage`), forwards content deltas, assembles tool-call
  fragments by index and parses the final usage chunk. `buildHistory` keeps the
  newest turns verbatim within two thirds of `historyChars` (12,000 default) and
  replaces older turns with a bounded deterministic summary; the full text
  remains in the turn ledger.
- **Eval:** `test/native-main-agent.test.ts` drives SSE directly: deltas arrive
  individually, tool-call fragments assemble, usage survives streaming, and a
  20-turn transcript compacts to a summary plus the newest turn. Full suite: 579
  tests / 576 pass / 3 skipped; typecheck, gate and bilingual docs pass.
- **Benchmark:** `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`
  → both 3/3; direct 2.5s / 3,795 vs 2.5s / 3,864; authority 7.8s / 8,013 vs
  9.2s / 8,141; plan 14.2s / 9,138 vs 11.2s / 8,929; same tool choices and one
  run each; result file
  `benchmark/results/main-agent-2026-11-05T09-26-57-563Z.json`. Compared with
  the pre-streaming run, no behavior change and no lost usage.
- **Live validation:** the summary was sent to the real endpoint in the
  long-context run below; all five checks passed. The earlier assumption is
  resolved.
- **Pros / cons:** streaming removes the frozen-interface effect; deterministic
  compaction is cheap and auditable but less faithful than a model-written
  summary; long-conversation quality was validated on one seeded transcript
  below.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Long-context validation of native compaction

- **Goal / hypothesis:** verify against the real endpoint that the deterministic
  summary is accepted, that the newest turns stay verbatim, and that a fact from
  the oldest turn survives compaction well enough for the model to answer.
- **Trade-off:** [streaming and compaction](../architecture/trade-offs.md#2026-11-05--native-main-agent-streams-and-compacts-deterministically).
- **Benchmark run:** command
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:long`;
  model `360/anthropic/claude-sonnet-5-5` via Magpie at
  `http://127.0.0.1:3425`; 24 seeded completed turns (one needle in the oldest),
  `historyChars` 4,000, one real turn; result file
  `benchmark/results/native-main-long-context-2026-11-05T09-43-52-438Z.json`.
- **Result:** 9 messages (4 user), a 2,121-character deterministic summary; the
  endpoint accepted it; the newest turn stayed verbatim; the reply was exactly
  `BLUE-FALCON`; 7,842 tokens, 1 model call; all five checks true.
- **What it proves / does not:** multiple system messages are accepted in
  practice, and a fact placed at the start of an old turn survives the summary.
  It does not prove that a fact buried later in an old turn survives: the
  summary truncates each old turn to 160 characters and the whole summary to
  2,000. That remains the known weakness of deterministic compaction.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Native Main Agent accepts images

- **Goal / hypothesis:** close the last capability gap between the Pi and native
  Main Agents: image attachments.
- **Trade-off:** [image attachments](../architecture/trade-offs.md#2026-11-05--native-main-agent-accepts-image-attachments).
- **Change:** the native user message becomes OpenAI-style content parts when
  images are present (`text` plus `image_url` data URLs); `run-main-query` passes
  the attachments instead of refusing them. Images are per-turn and are not
  persisted in the turn ledger.
- **Eval:** `test/native-main-agent.test.ts` asserts the image part and data URL
  in the captured request. Live validation: a 64×64 solid red PNG was sent and
  the reply was `Red.`; image part present, no error, 3,806 tokens, 1 model call;
  result `benchmark/results/native-main-images-2026-11-05T10-01-47-161Z.json`.
- **Pros / cons:** the native flag no longer removes a capability; base64 inflates
  the request, there is no downscaling, and the image cannot be recovered from
  the ledger later.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Native Main Agent is the default when configured

- **Goal / hypothesis:** make the validated native loop the default without
  breaking installations that have no OpenAI-compatible endpoint.
- **Trade-off:** [default runtime](../architecture/trade-offs.md#2026-11-05--native-main-agent-is-the-default-when-configured).
- **Change:** `readMainAgentRuntime` replaces the boolean switch. Unset → native
  when `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` are present, Pi
  otherwise; `pi`/`legacy` force Pi; `native` forces native and fails clearly if
  the endpoint is missing; unknown values throw. The comparison benchmark pins
  `CLONE_AI_MAIN_RUNTIME=pi` for its Pi cells.
- **Eval:** selection-matrix tests (unset with and without an endpoint, explicit
  pi, explicit native, unknown value) in `test/native-main-agent.test.ts`; full
  suite 580 tests / 577 pass / 3 skipped; typecheck, gate and bilingual docs.
  Live smoke without the flag:
  `CLONE_AI_NATIVE_MODEL=360/anthropic/claude-sonnet-5-5 CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 clone-ai "请只回复：默认运行时已生效"`
  → exact reply; `clone-ai audit turns --json --limit 1` reports
  `provider: "native"`.
- **Pros / cons:** configured deployments now use the validated native loop by
  default; installations without an endpoint keep working on Pi. The unset case
  is environment-dependent, so the active runtime is visible in the turn record
  (`provider`) rather than implied by a flag.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Native worker defaults for direct, research, draft and review

- **Goal / hypothesis:** use the validated in-process worker by default, without
  forcing it on the external role or overriding an owner's saved choice.
- **Trade-off:** [worker defaults](../architecture/trade-offs.md#2026-11-05--native-worker-is-the-default-for-eligible-roles-when-configured).
- **Change:** `defaultWorkerProfiles(environment)` and
  `WorkerSettingsStore`'s `normalize` choose `native` for every role except
  `external` when `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` are set;
  a saved provider id still wins, and an unknown or role-incompatible saved id
  still falls back to the default.
- **Eval:** `test/worker-defaults.test.ts` — the role matrix with and without the
  endpoint, a missing settings file, and a saved `pi` choice surviving. Full
  suite: 582 tests / 579 pass / 3 skipped; typecheck, gate and bilingual docs.
  Manual check with the endpoint set printed `native` for direct/research/draft/
  review and `codex-cli` for external.
- **Pros / cons:** configured deployments stop depending on which CLI happens to
  be installed; `external` stays on the governed CLI path. The native worker has
  file tools only, so a role that later needs network or external actions must
  change provider.
- **Reversal condition:** see the trade-off entry.

### 2026-11-05 — Re-run after the defaults changed

- **Goal / hypothesis:** confirm the default switch did not break the real
  pipeline (routing, tools, audit), and re-measure with the new defaults.
- **Trade-off:** [worker defaults](../architecture/trade-offs.md#2026-11-05--native-worker-is-the-default-for-eligible-roles-when-configured)
  and [main agent default](../architecture/trade-offs.md#2026-11-05--native-main-agent-is-the-default-when-configured).
- **Benchmark run — worker set:** command
  `CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 npm run bench -- --provider native --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`;
  model `360/moonshotai/kimi-k3.1-pro` via Magpie; result
  `benchmark/results/native-2026-11-05T11-09-55-300Z.json`. **5/5**: summarize
  12.4s / 2,252 tok / 3 calls; two-step-chain 38.7s / 5,146 / 6; three-step
  pipeline 111.2s / 12,420 / 11; code-tool 46.5s / 4,922 / 5; missing-input
  19.1s / 1,673 / 2, an expected failure.
- **Benchmark run — Main Agent, two passes:** command
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`;
  result files `main-agent-2026-11-05T11-05-57-652Z.json` and
  `main-agent-2026-11-05T11-12-52-700Z.json`. **Both passes 3/3 for both
  runtimes.**
- **Variance, not regression:** the two passes disagree on which runtime is
  faster, which is the useful finding. Pass 1: direct Pi 3.0s vs native 2.2s;
  authority 15.9s vs 11.7s; plan 6.6s vs 45.2s (one native outlier).
  Pass 2: direct 2.9s vs 1.2s; authority 5.9s vs 8.4s; plan 10.4s vs 11.1s
  (Pi called `get_authority` before proposing in this pass, so its plan tokens
  rose to 13,174). Tokens stay close (native 3,795–3,796 vs Pi 3,864 on direct).
- **What this run changed:** nothing in code. It confirmed the defaults work
  end to end — tools were called, exactly one run was created per plan task, and
  every turn completed — and it showed that a one-run-per-cell comparison cannot
  rank the runtimes on latency.
- **Next:** to compare latency meaningfully, run each cell N times and report the
  median; the current script runs once by design and says so.
- **Reversal condition:** see both trade-off entries.

### 2026-11-05 — Self-check loop: adversarial probes, gate, recorded rounds

- **Goal / hypothesis:** the agent should attack its own boundaries on a schedule, record every round, and hand a red round to the repair lane — instead of waiting for the owner to notice a regression.
- **Trade-off:** [2026-11-05 — The agent runs its own adversarial suite and repair loop](../architecture/trade-offs.md).
- **Change:** `src/eval/adversarial-probes.ts` (15 deterministic probes: untrusted wrapping, forwarded approval refusal, approval replay/expiry/re-issue, rate limit, protected paths, symlink escape, worker env credentials, trace redaction, digest tamper, trace assembly, path containment, probe isolation); `src/eval/self-check.ts` (runs probes + `npm run gate` + optional `npm test`, journals `selfcheck.completed`, writes a round report, exports traces when red); `clone-ai selfcheck [--full] [--repair] [list]`; `GET/POST /api/audit/selfcheck`; audit → 评估 shows the round, failures, gate tail, and history.
- **Eval:** `node --experimental-strip-types --test test/self-check.test.ts` (3 cases: all probes green, green round journaled and saved, red gate makes the round red and attempts export) and `test/adversarial-probes` coverage inside the same file. `clone-ai selfcheck` against `/tmp/audit-demo3`: `绿色 · 探针 15/15 · gate ok`, round `round-20261105T081911`.
- **Benchmark run:** none — this is a deterministic, offline eval; no provider, model, dataset, or scoring parameters are involved.
- **Execution chain:** read the current gate and test harness; wrote probes against shipped modules; added the round runner, CLI, API and UI; ran the suite twice (one red on a missing bilingual comment, fixed); ran `npm test` (568 pass) and `npm run typecheck`; ran one real round through the CLI against the demo home (~2 s, CPU only, 0 model tokens).
- **Pros:** cheap enough to run on every round; every probe names the boundary and the attack; the loop's output is a first-class audit object and its repair hand-off reuses the existing gated lane.
- **Cons / next time:** the probes are deterministic and therefore repeatable but not creative — a model-driven red team (schema-constrained, budget-capped) is the next layer, and the suite must grow whenever an incident reveals a class it missed.
- **Reversal condition:** see the trade-off entry — extend the suite rather than loosen it.

### 2026-11-04 — AI self-review with reversible configuration actions

- **Goal / hypothesis:** turn the audit digest into a small, safe improvement
  loop — findings plus configuration actions the owner can apply and undo —
  without giving the model authority over code, prompts, or policy.
- **Trade-off:** [self-review is configuration-only](../architecture/trade-offs.md#2026-11-04--self-review-may-change-configuration-never-the-rules).
- **Change:** `src/audit/self-review.ts`, `src/audit/apply-review.ts`, the audit
  tab's review surface, and the `recommendation.applied` journal event.
- **Eval:** `test/self-review.test.ts` — 4 tests covering action validation,
  facts-only degradation when the model is unavailable, and apply/revert for a
  worker effort and for the Main Agent effort. Integration verification:
  `npm test` 540 tests / 537 pass / 3 skipped, `npm run typecheck` pass.
- **Execution chain:** implemented in the `dreamy-ritchie-b0f526` worktree. This
  entry records the shipped state and the integration verification; the original
  session's internal steps are not available here. No model calls were made
  during integration.
- **Pros:** the surface is deliberately narrow, and every application journals
  the previous value first, so the owner can always undo and the journal can
  answer who changed what and from which review.
- **Cons / next time:** the review cannot fix a code or prompt defect, only tune
  model and effort. The original chain was not captured while it ran — the gap
  this log now closes.
- **Reversal condition:** see the trade-off entry.
