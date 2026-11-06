# Optimization log

**English** · [简体中文](optimizations.zh-CN.md)

Every optimization gets one entry here, newest first. The trade-off entry is
written before the change; this entry is completed after it ships. The point is
to make the *work* auditable: not only what changed, but how it was done, what
it cost, and where the chain was weak. See [`AGENTS.md`](../../AGENTS.md).

### 2026-11-06 — Desktop defects handed to the repair lane with a Magpie worker

- **Goal / hypothesis:** five observable defects in the desktop app's operating logic can be fixed through `clone-ai repair` with the native worker pointed at Magpie `360/deepseek/deepseek-v4.1-flash`, each with a failing regression case and a verified patch.
- **Trade-off:** the per-bug entries in [trade-offs.md](../architecture/trade-offs.md) (memory-library refresh, archive/restore TypeError, audit dispatch block, sidebar restore control, plain-preview underscores, effort select).
- **Change / attempts:** worker configured by `CLONE_AI_NATIVE_MODEL=360/deepseek/deepseek-v4.1-flash`, `CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425`, `CLONE_AI_NATIVE_MAX_ROUNDS=32`, `CLONE_AI_NATIVE_MAX_TOKENS=50000`, `CLONE_AI_NATIVE_TIMEOUT_MS=900000`, isolated clone homes (`~/.clone-repair{,-2,-3}`) with `draft-maker` bound to `native`; each attempt is one crafted trace under `failed-traces/`. Results (gates as the lane reported them, plus the working agent's own check): the memory-refresh trace reached a valid red case (382-line vm test, 2 failing assertions) but its fix phase (32 rounds, 971k input tokens) wrote nothing; the lane still said fixed because it does not re-run the regression cases after the fix, and the case remained red — not merged. The archive/restore trace's first case was red because the vm lacked an `Element` global, and after that fact was added the next case still missed the PATCH in its DOM stub; no patch. The audit-dispatch trace produced two valid red cases ("步骤 —" and "blocked run says no record"), but the fix phase held one provider call past the step and the rerun's cases crashed without an assertion (the lane's `not-red` gate refused). The plain-preview trace reached a red case, then the fix phase replaced the 118 KB `apps/desktop/ui/app.js` with an 8 KB fragment containing only the functions the case slices; the suite and typecheck do not load that file, so the lane would have reported fixed — the attempt was stopped before committing. The effort-select and hidden-restore traces were still running at the report deadline.
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
