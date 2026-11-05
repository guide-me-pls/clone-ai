# Verification false-failure repair: blocked preflight

Date: 2026-11-05. This is a record of an incomplete work order; no fix or new
regression test was produced.

## Reproduction

An offline invocation of `extractFileExpectations` and `EvidenceVerifier` used
the criterion `Use \`fs.rename\`, \`os.tmpdir\`, \`consumed-traces.json\`, and
\`REPORT_DIR/consumed-traces.json\` as implementation identifiers.` The extractor
returned all four strings as file expectations, and the verifier returned
`passed: false`, with each identifier reported as unlocatable. This confirms
the false-failure class; this reproduction is not the original failed Run's
exported trace.

The existing optimization log, `docs/engineering/optimizations.md`, records
the nightly RSI incident and identifies the same false-failure category.

## Repair lane preflight

`AGENTS.md` requires bug fixes to be produced by Clone AI's gated repair lane
and requires its protected paths and test gates to remain effective. The
requested production file, `src/core/verification.ts`, and the requested
existing test file, `test/verification.test.ts`, are protected by
`scripts/nightly-rsi-policy.mjs`. The lane only permits new tests under
`test/regression/`; it cannot produce the requested patch without violating
those gates.

The standard `scripts/nightly-rsi.mjs` flow also runs `npm test`, commits,
and attempts to push and create a draft PR. The work order explicitly forbids
the full test suite, commits, pushes, network access, and modifying policy or
task state. The lane was therefore not started, and no failure trace was
exported. No repair-model output is available for functional review. This is a
preflight block, not a claim that the repair lane was executed and failed.

## Baseline validation

The following commands were run from the repository root against the unchanged
implementation, with `TMPDIR` set to a temporary directory inside the
workspace and `CLONE_AI_MEMORY_MINING=off` for the test run:

- `node --experimental-strip-types --test test/verification.test.ts test/golden-path.test.ts`:
  exit 0; 14 passed, 0 failed. These existing tests do not cover the reproduced
  false failure.
- `npm run typecheck`: exit 0.

No benchmark or live-model test was run. The requested extraction heuristic,
regression tests, and bilingual JSDoc remain unimplemented. The supervisor
must resolve the conflicting repair-lane and work-order constraints before the
requested change can be produced.
