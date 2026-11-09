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
