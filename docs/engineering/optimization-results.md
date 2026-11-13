# Optimization results

**English** · [简体中文](optimization-results.zh-CN.md)

This file records **what actually worked**, one entry per verified improvement,
newest first. Each entry states the claim, the evidence that supports it (a
command, numbers, a result file), and where the work is described in full.

A negative optimization — one whose eval showed no gain, a regression, or that
was reverted — is **not** recorded here. Its trade-off entry remains in
[`docs/architecture/trade-offs.md`](../architecture/trade-offs.md) as the record
of the decision and its reversal. The reasoning and the execution chain stay in
[`optimizations.md`](optimizations.md); this file only keeps the outcomes worth
citing.

See [`AGENTS.md`](../../AGENTS.md) rule 6.

## 2026-11-13 — The Main Agent reads the repository's own rules

- **Claim:** clone-main now loads the workspace's `AGENTS.md` / `CLAUDE.md`,
  nested Claude files and `.claude/rules/*.md` into its system prompt, labeled as
  project instructions; imports cannot leave the workspace, and the layer is
  capped and switchable.
- **Evidence:** `test/project-instructions.test.ts` 7/7 (order, nested paths,
  in-workspace import expanded, outside import and symlink escape refused, cycle
  terminates, budget truncation stated, switch off). End-to-end on this
  repository: a live Main Agent turn's prompt material records
  `[{ path: "AGENTS.md", bytes: 11576 }]` and the compiled system prompt
  contains `npm run gate`; before the change, `grep -rn 'AGENTS.md' src/`
  returned nothing. Full suite 677/677; typecheck and `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-13--the-main-agent-reads-project-instruction-files-labeled-by-trust-class),
  [execution chain](optimizations.md#2026-11-13--the-four-gaps-the-memory-comparison-found).

## 2026-11-13 — A memory edit can be undone

- **Claim:** every owner-visible change to a memory records the state before it,
  and an undo restores that state as an auditable `memory.updated` reversal; a
  second undo walks one change further back.
- **Evidence:** `test/memory-versions.test.ts` 5/5 (edit undone back to the
  original summary and content, undo event carries `source: "undo"` and the
  restored version id, second undo returns the prior state, archive undone to
  `active`, no-op refused, history capped at 20). Full suite 677/677; typecheck
  and `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-13--memory-edits-are-versioned-and-an-undo-restores-the-previous-version),
  [execution chain](optimizations.md#2026-11-13--the-four-gaps-the-memory-comparison-found).

## 2026-11-13 — Consolidation proposes merges from a signal that finally has a caller

- **Claim:** the idle improvement sweep proposes merge suggestions for
  same-type memories at or above the measured overlap threshold, and approving
  one authors the merged memory and archives the sources as `retired`, so the
  merge is reversible.
- **Evidence:** `test/memory-consolidation.test.ts` 5/5 (reworded pair
  proposed with the newer statement kept, unrelated and cross-type ignored, an
  explicit revision excluded, secret excluded, approval leaves one active memory
  and two archived with reason `retired`). `findConflicts` had no production
  caller before this. Full suite 677/677; typecheck and `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-13--background-consolidation-proposes-merges-the-owner-still-decides),
  [execution chain](optimizations.md#2026-11-13--the-four-gaps-the-memory-comparison-found).

## 2026-11-11 — The repair lane produced a verified fix

- **Claim:** clone-ai's own repair lane produced the fix for token-aware
  compaction being unreachable, and the working agent verified it functionally
  rather than by rewriting it.
- **Evidence:** patch changes `src/main-agent/native-runtime.ts` so compaction is
  always enabled with a 128,000-token default. The regression case
  `test/regression/audit-ctx-1.test.ts` is **red on `8e9bbd4`** (no
  `main_agent.context_compacted` event) and **green with the patch**; full suite
  634/634, typecheck and `npm run gate` pass. Produced by DeepSeek V4.1 Flash at
  `reasoning_effort=max` through `clone-ai repair` (run `bd3451a6`), reviewed
  from the captured request/response transcript.
- **Where:** [worker streaming and stop
  instructions](../architecture/trade-offs.md#2026-11-11--the-worker-streams-its-activity-and-the-repair-lane-says-when-to-stop),
  [windowed reads and fragment
  refusal](../architecture/trade-offs.md#2026-11-11--reads-are-windowed-with-an-explicit-total-writes-refuse-fragments),
  [execution chain](optimizations.md#2026-11-11--making-the-repair-lane-reviewable).

## 2026-11-10 — The scope gate now refuses what it claimed to refuse

- **Claim:** the per-call path gate rejects a symlink inside the workspace that
  points outside it, a read grant cannot authorize a write, a grant on an
  ancestor of a protected root is refused, and writes into `.git` are refused.
- **Evidence:** `test/path-gate.test.ts` 4/4 covers all four; each was reproduced
  against the repository's own modules before the fix — `decideTool` returned
  `{allowed: true}` for `link/secret.txt` and `link/new.txt`, and a `~/Library`
  grant was accepted with `dropped: []`. Full suite 626/626; typecheck and
  `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-10--scope-checks-compare-resolved-paths-and-the-repair-lanes-guards-are-real),
  [execution chain](optimizations.md#2026-11-10--closing-the-audits-verified-defects).

## 2026-11-09 — A shared loop kernel with per-call authorization and recorded compaction


- **Claim:** the Main Agent and the native worker run one loop contract, every
  tool call is decided before it executes, long transcripts compact on token
  pressure and record what was dropped, and MCP and skills are opt-in without
  changing a turn that does not ask for them.
- **Evidence:** the deterministic suite went from 585 tests / 4 failures
  (migration fallout) to **560 tests, 560 pass, 0 fail** after the upstream
  native-only migration merged; `test/agent-loop.test.ts` 14/14 covers terminal
  reasons, the concurrency barrier, tool pairing, budgets, abort, retry,
  truncation and deny/ask/allow; `test/context-window.test.ts` 8/8;
  `test/mcp-host.test.ts` 5/5 against a real stdio child; `test/skill-loader.test.ts`
  5/5; native worker/client 17/17; an end-to-end Main Agent turn invokes both a
  skill and an MCP tool. `npm run typecheck` and `npm run gate` pass. No live
  model call was made, so the gain is a harness-contract gain, not a quality
  measurement.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-06--every-in-process-tool-call-goes-through-a-per-call-decision),
  [compaction trade-off](../architecture/trade-offs.md#2026-11-06--compaction-is-token-aware-and-recorded-deterministic-summaries-first),
  [MCP and skills trade-off](../architecture/trade-offs.md#2026-11-06--mcp-and-skills-first-plugins-cloud-vm-and-computer-use-deferred),
  [execution chain](optimizations.md#2026-11-09--per-call-permissions-context-compaction-mcp-and-skills).

## 2026-11-07 — Worker concurrency follows measured machine capacity

- **Claim:** dispatch concurrency is bounded by measured CPU, load and free
  memory, not by the plan's shape; the queue and every subagent wave share one
  budget, and the model can read the limit but not set it.
- **Evidence:** `test/capacity.test.ts` (6 tests: CPU-bound, memory-bound, load
  sensitive, owner pin capped by cores, gate never exceeds the limit and wakes
  waiters in order, cancelled waits release their slot). Full suite 525/525;
  typecheck and `npm run gate` pass. End-to-end throughput on a large host is not
  yet measured; the verified claim is that no execution can exceed the limit.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-06--worker-concurrency-follows-measured-machine-capacity-capped-by-the-kernel),
  [execution chain](optimizations.md#2026-11-06--worker-concurrency-follows-measured-machine-capacity).

## 2026-11-06 — One auditable execution path

- **Claim:** the Main Agent and every worker are our own in-process loops. The Pi
  SDK and all black-box CLI workers are gone, so every turn and every tool call
  is recorded and gated by the Kernel; no CLI can run with hidden tools or
  credentials.
- **Evidence:** `@earendil-works/pi-coding-agent` removed from `package.json`;
  `black-box-cli-worker`, `worker-registry`, `worker-env`, `providers.json` and
  their tests deleted; full suite 519/519 after the removal; typecheck,
  `npm run gate` and bilingual docs pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-06--the-harness-keeps-only-its-own-agents-no-pi-sdk-no-black-box-clis),
  [execution chain](optimizations.md#2026-11-06--removing-the-black-box-cli-workers-stage-2-of-2).

## 2026-11-06 — Native Main Agent matches Pi, with fewer tokens

- **Claim:** on the fixed Main Agent task set the native loop matches Pi's
  outcomes while using slightly fewer tokens.
- **Evidence:** five samples per cell, `360/deepseek/deepseek-v4.1-flash` via
  Magpie, result `benchmark/results/main-agent-2026-11-06T02-07-58-472Z.json`:
  both **15/15**; median duration summed **17.2 s native vs 20.0 s Pi**;
  median tokens **17,973 vs 19,081** (≈5.8% fewer); plan p90 **15.8 s vs 26.9 s**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--a-native-main-agent-loop-behind-a-flag-not-a-flag-day),
  [execution chain](optimizations.md#2026-11-06--five-sample-confirmation-of-the-main-agent-comparison).

## 2026-11-06 — Native Main Agent streams, compacts and accepts images

- **Claim:** the native loop delivers tokens as they arrive, keeps a long
  conversation within budget without losing the full text, and accepts image
  attachments.
- **Evidence:** live long-context run — 24 seeded turns, 4,000-char budget,
  2,121-char summary reached the endpoint, the oldest turn's needle survived, the
  reply was exactly `BLUE-FALCON`, 7,842 tokens, all five checks true
  (`benchmark/results/native-main-long-context-2026-11-05T09-43-52-438Z.json`).
  Live image run — 64×64 red PNG, reply `Red.`, 3,806 tokens
  (`benchmark/results/native-main-images-2026-11-05T10-01-47-161Z.json`).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--native-main-agent-streams-and-compacts-deterministically),
  [execution chain](optimizations.md#2026-11-06--long-context-validation-of-native-compaction).

## 2026-11-05 — The native worker completes the reliability set

- **Claim:** the in-process worker completes the fixed reliability tasks,
  reports exact token usage, and fails a declared-missing input cleanly instead
  of inventing an artifact.
- **Evidence:** `npm run bench -- --provider native` (before the CLI removal),
  model `360/moonshotai/kimi-k3.1-pro` via Magpie: **5/5** including
  `missing-input` as an expected failure; per-task usage recorded
  (summarize 2,252 tokens, three-step pipeline 12,420, total ≈27k)
  (`benchmark/results/native-2026-11-05T11-09-55-300Z.json`). After the
  missing-input guard, the task fails with `no_artifact` / `native-missing-input`
  and 1,397 tokens (`benchmark/results/native-2026-11-05T08-10-22-910Z.json`).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--a-missing-named-input-fails-the-native-worker-instead-of-allowing-invention),
  [execution chain](optimizations.md#2026-11-05--a-missing-named-input-fails-the-native-worker).

## 2026-11-05 — Every Main Agent turn is attributable

- **Claim:** every Main Agent turn, from CLI, `npm run main`, the desktop/server
  companion or WhatsApp, records its input, reply, tool calls, model, effort and
  exact usage in the journal; a turn without a run still leaves a record.
- **Evidence:** `test/main-agent-turn-audit.test.ts` (4 tests: redaction, tool
  events, failed turn, interruption idempotence, newest-first loading); full suite
  544/544 at the time; `clone-ai audit turns` and `GET /api/audit/turns` read the
  same records.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--every-main-agent-turn-is-a-journal-record-not-a-side-file),
  [execution chain](optimizations.md#2026-11-05--turn-level-audit-for-every-main-agent-entry-point).

## 2026-11-05 — The regression gate holds the judgment layers

- **Claim:** evidence verification, authority policy and audit calibration are
  re-run on every commit without a model, and any verdict change is a reviewable
  diff.
- **Evidence:** `npm run gate` — 11 verdict cases, 14 policy cases, 5 audit
  records; 100% agreement, 0 false passes, 0 unsafe allows; CI runs it after
  `npm test` and `npm run typecheck` (`benchmark/gate/baseline.json`).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--the-regression-gate-is-offline-per-case-and-behavior-only),
  [execution chain](optimizations.md#2026-11-05--prompt-provenance-and-offline-regression-gate).

## 2026-11-05 — A prompt revision is identifiable

- **Claim:** a failed turn can be attributed to the exact prompt it read: charter
  version, compiled briefing, registered tool table, model and effort are
  content-addressed and journaled per turn.
- **Evidence:** `test/prompt-snapshot.test.ts` (hash stability, reuse of
  identical material, briefing and tool changes moving different hashes, the
  journal event and locator, all registered tools visible, write failure logged
  not thrown); `GET /api/main-agent/prompt-snapshots` lists recent turns.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--prompt-provenance-is-a-content-addressed-file-plus-a-journal-event),
  [execution chain](optimizations.md#2026-11-05--prompt-provenance-and-offline-regression-gate).
