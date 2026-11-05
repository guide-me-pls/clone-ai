# Reliability benchmark

**English** · [简体中文](README.zh-CN.md)

This benchmark measures the **harness**, not the model: whether the black-box
execution path (orchestration, dependency waves, evidence, verification,
recovery) reliably completes fixed tasks against a **real provider CLI**. It
is deliberately small and cheap so it can run before every upgrade.

## Run

Real CLIs have no OS sandbox enforced by Clone AI and are blocked by default. Only
after accepting that they can access the user's files, network, and credentials, run:

```bash
npm run bench -- --unsafe-host --provider pi --tasks summarize
```

Each task costs a few cents of real model calls and takes roughly 20-60
seconds. Results are recorded as JSON under `benchmark/results/<provider>-<timestamp>.json`
so successive upgrades can be compared.

## Task set (`benchmark/tasks.ts`)

| id | What it proves |
| --- | --- |
| `summarize` | Single read-only WorkOrder; artifact evidence from workspace diff |
| `two-step-chain` | Dependency wave: draft only starts after research is verified |
| `three-step-pipeline` | Two dependency edges; review uses both inputs |
| `code-tool` | Agent produces two code artifacts; this does not prove an independent trusted test run |
| `missing-input` | Expected failure: an absent file fails as `no_artifact`, not a hang |

## Reading results

- `passed` is true when the run reached `completed` with verification passed
  and the expected artifacts exist on disk.
- `expectedFailure` tasks (`missing-input`) count as green only for the expected
  `no_artifact` category, not an authorization or launch failure.
- `artifacts` lists every file the agent left in the workspace (excluding
  `.clone-ai`), with sizes.
- The runner exits non-zero when any unexpected failure occurs, so CI or a
  pre-upgrade check can gate on it.

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
- **Audit calibration** — `audit-cases.jsonl`, or any `clone-ai audit export`
  file passed with `--audit`, is compared with owner labels: agreement, false
  pass, false fail. The dataset hash is recorded, so held-out records cannot
  change silently.
- **Per-case baseline** — `benchmark/gate/baseline.json` records what each case
  currently does. Any change, including an improvement, fails until it is
  regenerated in the same change, so a verdict shift is reviewed rather than
  discovered later. The diff is the review.

The gate measures the rules around the model, not model quality. A live
trajectory eval would need recorded cassettes or a sandboxed provider; that is a
separate, non-CI suite.

## What this is not

- Not a model benchmark: pass/fail reflects orchestration + the provider's
  day-to-day behavior, and flaky models can produce flaky results. Look at the
  trend across runs, not a single number.
- Not a substitute for `npm test`: the deterministic suite stays the
  per-commit gate. This benchmark is the optional pre-upgrade reliability gate.
