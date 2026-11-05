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
