# Reliability benchmark

**English** · [简体中文](README.zh-CN.md)

This benchmark measures the **harness**, not the model: whether the black-box
execution path (orchestration, dependency waves, evidence, verification,
recovery) reliably completes fixed tasks against a **real provider CLI**. It
is deliberately small and cheap so it can run before every upgrade.

## Run

The benchmark runs through the in-process native worker; there is no CLI to
sandbox or consent to.

```bash
CLONE_AI_NATIVE_MODEL=<model-id> CLONE_AI_NATIVE_BASE_URL=<openai-compatible-url> \
  npm run bench -- --tasks summarize
```

Each task costs a few real model calls and takes roughly 20-60 seconds. Results
are recorded as JSON under `benchmark/results/native-<timestamp>.json` and
include exact `usage` (tokens and model calls), `verification`, and
`failureReason`.

## Main Agent comparison (`npm run bench:main`)

Runs three fixed prompts through the Pi runtime and the native loop with the
same model and an isolated clone home per task: a direct answer, an authority
read, and a plan proposal. Each task/runtime cell runs `--repeat N` times
(default 5); the report gives median and p90 duration, median tokens and the
pass rate, and keeps every individual run.

```bash
CLONE_AI_BENCH_MAIN_MODEL=<model-id> npm run bench:main -- --repeat 5
```

The native endpoint comes from `CLONE_AI_NATIVE_BASE_URL` (default
`http://127.0.0.1:3425`). The model id is required: `CLONE_AI_BENCH_MAIN_MODEL`
falls back to `CLONE_AI_NATIVE_MODEL`, and a run without either fails before the
first request. A single sample cannot rank latency: in two one-shot
passes the same native plan cell was 45.2s and 11.1s. Prefer the median; use
`--repeat 1` only for a quick smoke.

## Long-context validation (`npm run bench:long`)

Seeds 24 completed turns with a needle in the oldest, runs one real native turn
with `historyChars=4000`, captures the outgoing request, and checks: the summary
is present, the needle is in it, the newest turn stayed verbatim, the reply
contains the needle, and there was no error. The model comes from
`CLONE_AI_BENCH_MAIN_MODEL` (fallback `CLONE_AI_NATIVE_MODEL`). The report lands under
`benchmark/results/`.

## Image validation (`npm run bench:images`)

Generates a solid red PNG, sends it as a data URL through the native Main Agent,
and checks that the image part reached the endpoint and the model answered red.
The model comes from `CLONE_AI_BENCH_MAIN_MODEL` (fallback
`CLONE_AI_NATIVE_MODEL`). The report lands under `benchmark/results/`.

## Regression gate (`npm run gate`)

The offline gate runs on every commit in CI and costs nothing: it re-runs the
judgment layers against held-out fixtures under `benchmark/gate/`, never a
model.

```bash
npm run gate
npm run gate -- --audit ~/clone-audit.jsonl
npm run gate -- --write-baseline
```

- **Verdict suite** — `verdict-cases.json` names files, evidence, and what the
  owner would say. The current verifier must reproduce those verdicts. A system
  "pass" on an owner "fail" is a false pass and fails the gate.
- **Policy suite** — `policy-cases.json` covers risk classes, autonomy levels,
  standing policies, protected paths, and approvals. An "allowed" where the
  fixture expects a gate is an unsafe allow.
- **Audit calibration** — `audit-cases.jsonl`, or any file produced by
  `npm run audit:export -- --out <file>` and passed with `--audit`, is compared
  with owner labels: agreement, false pass, false fail. The dataset hash is
  recorded, so held-out records cannot change silently.
- **Per-case baseline** — `benchmark/gate/baseline.json` records what each case
  currently does. Any change, including an improvement, fails until it is
  regenerated in the same change, so a verdict shift is reviewed rather than
  discovered later. The diff is the review.

The gate measures the rules around the model, not model quality. A live
trajectory eval would need recorded cassettes or a sandboxed provider; that is a
separate, non-CI suite.


## Capability benchmark: one-query FPS (`benchmark/capability/shadowport-fps`)

The reliability benchmark above asks whether the harness completes fixed tasks.
The capability benchmark asks a different question: from a **clean workspace**,
can one user message produce a playable tactical FPS that the agent verifies
itself with a browser? The prompt is one paragraph; the workspace rules,
preview server and Playwright MCP tools carry the rest. An independent checker
drives the page's public `window.__game` hook and records 17 checks (files,
classic-script runtime, hook, start, movement, shot damage, three relays,
extraction, debrief, console errors, external requests).

See [`capability/shadowport-fps/README.md`](capability/shadowport-fps/README.md)
and its [`ANALYSIS.md`](capability/shadowport-fps/ANALYSIS.md).

## What this is not

- Not a model benchmark: pass/fail reflects orchestration + the provider's
  day-to-day behavior, and flaky models can produce flaky results. Look at the
  trend across runs, not a single number.
- Not a substitute for `npm test`: the deterministic suite stays the
  per-commit gate. This benchmark is the optional pre-upgrade reliability gate.
