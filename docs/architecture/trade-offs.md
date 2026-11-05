# Architecture trade-offs

**English** · [简体中文](trade-offs.zh-CN.md)

A decision is only durable when its reason is written down. Each entry states
what was decided, the evidence behind it, and the condition under which a
future reader should reverse it.

## 2026-11-05 — Prompt provenance is a content-addressed file plus a journal event

**Decision.** Every Main Agent turn records the charter version, the compiled
briefing, the exact registered tool table, the model id, and the reasoning
effort. Full material goes to `<clone home>/prompt-snapshots/<materialHash>.json`;
the journal receives one `main_agent.prompt_snapshot` event carrying the hashes,
the locator, and (for desktop turns) the turn id.

**Evidence.** Before this change the journal could say what the agent did and
what it recalled, but not what it was told: `MAIN_AGENT_CHARTER` is a constant,
the situation briefing existed only in memory for the life of a session, and
the tool table existed only inside the Pi session. A failed turn therefore could
not be attributed to a prompt revision, and two "improvements" could not be
compared against a baseline. The journal is already the append-only truth
([`state-projector.ts`](../../src/state/state-projector.ts) rebuilds state from
it), so provenance belongs there rather than in a second log.

**Reversal condition.** If the journal becomes the wrong home for turn-level
telemetry (for example, retention rules require runs and turns to expire on
different schedules), move the events to a dedicated store keyed by the same
`materialHash`; the hash scheme and the file layout do not depend on the journal.

## 2026-11-05 — Tool provenance is captured at registration, not maintained as a list

**Decision.** `createKernelToolsExtension` reports every tool through an
`onRegister` callback at the moment it registers it. The hash covers the names,
descriptions, and parameter schemas the model actually received.

**Evidence.** A hand-maintained list of tool names is a second source of truth
that drifts silently the first time a tool is renamed or added — exactly the
kind of invisible change provenance exists to expose. The callback sees the
registered object itself, so it cannot disagree with the session.

**Reversal condition.** If tools can be registered outside
`createKernelToolsExtension` (a second extension factory, or MCP-hosted tools),
the registration choke point no longer covers the whole table; the snapshot must
then read the tool list from the session rather than from the callback.

## 2026-11-05 — The regression gate is offline, per-case, and behavior-only

**Decision.** `npm run gate` re-runs evidence verification and authority policy
over held-out fixtures, calibrates audit records against owner labels, and
compares every case with a recorded baseline. It calls no model and is a
required CI step.

**Evidence.** This repository's guarantees live in the rules around the model:
completion comes from evidence, authority from scopes, and owner labels from
`audit.labeled`. Those layers are deterministic, so a zero-cost gate can cover
them on every commit. A provider-dependent eval would be skipped precisely when
CI is under pressure.

**Reversal condition.** If recorded trajectory cassettes can be replayed without
network access, add a trajectory suite beside the deterministic one. The
per-case baseline remains valid for the judgment layers regardless.

## 2026-11-05 — A verdict change fails the gate even when it is an improvement

**Decision.** `baseline.json` stores each case's current outcome; any difference —
pass to fail or fail to pass — fails until `--write-baseline` is run in the same
change.

**Evidence.** An improvement that arrives without its diff being reviewed is
indistinguishable from a regression that happens to look better on the fixture
set. Requiring the baseline update forces the reviewer to see the behavior delta
and its rationale.

**Reversal condition.** If baseline churn starts to dominate review, split it by
suite or add an explicit per-case intent note; do not switch to silent
auto-update.
