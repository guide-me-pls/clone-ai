# Optimization log

**English** · [简体中文](optimizations.zh-CN.md)

Every optimization gets one entry here, newest first. The trade-off entry is
written before the change; this entry is completed after it ships. The point is
to make the *work* auditable: not only what changed, but how it was done, what
it cost, and where the chain was weak. See [`AGENTS.md`](../../AGENTS.md).

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

## 2026-11-09 — Per-call permissions, context compaction, MCP, and skills

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

## 2026-11-07 — Shared agent loop kernel and a green baseline

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

## 2026-11-05 — Rebuild the app as part of self-check

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

## 2026-11-05 — Shared audit for every Agent invocation

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

## 2026-11-05 — Narrow inferred file expectations

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

## 2026-11-05 — Remember consumed nightly repair traces

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

## 2026-11-05 — Conservative recovery for orphaned planning

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

## 2026-11-05 — Prompt provenance and offline regression gate

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

## 2026-11-04 — AI self-review with reversible configuration actions

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

## 2026-11-05 — Failed traces, gated nightly repair, and the worker credential boundary

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

## 2026-11-05 — Turn-level audit for every Main Agent entry point

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

## 2026-11-05 — Native worker as a first-class provider with exact usage

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

## 2026-11-05 — Native vs Claude on the reliability task set

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

## 2026-11-05 — A missing named input fails the native worker

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

## 2026-11-05 — Native Main Agent loop behind a flag

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

## 2026-11-05 — Native vs Pi Main Agent comparison

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

## 2026-11-05 — Native Main Agent streams and compacts

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

## 2026-11-05 — Long-context validation of native compaction

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

## 2026-11-05 — Native Main Agent accepts images

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

## 2026-11-05 — Native Main Agent is the default when configured

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

## 2026-11-05 — Native worker defaults for direct, research, draft and review

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

## 2026-11-05 — Re-run after the defaults changed

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

## 2026-11-06 — Repeated Main Agent comparison with medians

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

## 2026-11-06 — Five-sample confirmation of the Main Agent comparison

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
