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
- **Cons / next time:** non-streaming; no compaction; images refused;
  `search_history` searches the turn ledger, not Pi session files; native turns
  are not resumable as Pi sessions. The Pi-versus-native comparison is below.
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
