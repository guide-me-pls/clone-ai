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
  invisible (a structural boundary); native-worker model usage still has no
  usage record; `scripts/run-pi-task.mjs` and `nightly-rsi` remain outside the
  journal; turn events are not yet merged into the per-run trace view.
- **Reversal condition:** see the trade-off entry.
