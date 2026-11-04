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

---

## 2026-11-04 — Attempted and reverted: a persisted replay watermark

**Decided:** no watermark. A fresh process always replays the whole journal.

**What was tried.** Store the last applied sequence in the journal so a
restarted runtime resumes incrementally. Two tests failed immediately: a second,
independent runtime over the same journal resumed from the *first* runtime's
position and applied a mid-history `run.status_changed` for a run it had never
seen, and the JSONL-backed kernel view lost a run the same way.

**Why it cannot work as designed.** The projection lives only in memory. A
watermark records where *some* projection stopped; a new process has no
projection to continue, so the watermark can only tell it which events to skip —
exactly the events it needs. Persisting the watermark without persisting the
projection is the bug, not a shortcut.

**What this costs.** A restart pays one full replay: measured at 117 ms for
100,000 events. Acceptable, and it is the same order as the work the process is
about to do anyway.

**Reversal condition.** Persist the projection itself (a materialised snapshot
with its sequence), not just the sequence. Then a restart can load the snapshot
and apply the tail. Until then, this entry stands.

## 2026-11-04 — Tool and model budgets are enforced when the adapter reports them

**Decided:** the Kernel counts `tool_started` and a new `model_call` event per
execution attempt and fails the step with category `budget_exceeded` past the
work order's ceiling. The native worker also refuses further calls inside its
own loop, and reports `model_call` and `tool_completed`.

**What was given up.** For black-box CLI workers the ceilings remain
declarations: a CLI that does not report its calls cannot be counted. The
`sandbox` and duration budgets are what actually stop those. The contract
comment now says so instead of implying enforcement everywhere.

**Why not stricter.** Killing a CLI process on a call count the Kernel cannot
observe would require parsing the CLI's output protocol, which the black-box
adapter deliberately does not do.

**Reversal condition.** If a CLI grows a structured event stream, wire its
counts into the same counter; the Kernel side needs no change.

## 2026-11-04 — Background readers ask for the event types they need

**Decided:** `SqliteJournalStore.listTypesSince(types, sequence)` (using the
`(type, sequence)` index), and `src/core/journal-types.ts` with `readTypes`,
`readForRun`, `readSince` fallbacks for stores without the fast paths. Memory
governance, the memory pipeline, conversation mining, opportunity scan/list/
resolve/find, the daily report and the commitment reconciler now use them.

**Why it won.** Measured on a 100,000-event journal: `list()` takes 117 ms and
`listSince(tail)` / `listForRun` take 0–3 ms. Every 2-second queue tick and
every opportunity scan was paying the full-scan cost for a handful of rows.

**What was given up.** Each consumer now declares the event types it depends
on. A new event type that a consumer needs but does not list is silently
invisible to it — the reconciler's `RECONCILE_TYPES` is the risk. That trade
was accepted because the alternative (reading everything) is the cost this was
meant to remove; the list is beside the reader it belongs to, and the fallback
path keeps tests and the JSONL store correct.

**Reversal condition.** If a consumer is found missing an event type in
practice, the fix is to widen its list, not to drop the narrowing.

## 2026-11-04 — Journal reads are incremental, with a full-rebuild fallback

**Decided:** `SqliteJournalStore` gained `listSince(sequence)` and
`listForRun(runId)` plus indexes on `(run_id, sequence)` and `(type,
sequence)`. `CloneRuntime.refresh()` and `PersonalStateStore.hydrate()` apply
only the tail and advance a remembered applied sequence.

**Alternatives:** keep replaying the whole journal on every refresh; add a
separate incremental event log alongside the journal; paginate the projection.

**Why it won.** `list()` was an unindexed full scan and every refresh called it,
so the cost of each queue tick grew with total history — a structural problem
that gets worse the longer the twin lives, not a tuning issue.

**What was given up.** A correctness case has to be handled explicitly: if an
event arrives with a sequence at or below the applied one, the journal was
replaced, truncated or reordered, and the projection is rebuilt from zero. The
first implementation missed the second half of this — events applied by orphan
recovery advanced the projection without advancing the applied sequence, so the
next refresh replayed a `running -> queued` transition the state machine
refuses. All event application now goes through one `#applyEvent`, and the
kill-restart test caught it.

**Reversal condition.** If projection rebuilds from a replaced journal become
common (a migration that rewrites history, say), the applied sequence should be
stored rather than held in memory, or `refresh` should verify a journal identity
instead of inferring replacement from ordering.

**Status:** the indexing and incremental path are covered by
`test/journal-incremental.test.ts`; no timing benchmark was run, so the size of
the win is inferred from the query shape, not measured.

---

## 2026-11-04 — Removed the hashed-ngram "semantic" recall term

**Decided:** remove it. `MdMemoryStore.recall` keeps the bigram ratio, the
IDF-weighted cosine, the preference prior, and the stopword floor.

**Alternatives:** keep it behind `CLONE_AI_RECALL_SEMANTIC`; replace it with a
real embedding service.

**Why it lost.** Ablation on LongMemEval-s (470 scored questions, full haystack,
maxResults=10):

| metric | semantic on | semantic off |
| --- | --- | --- |
| any@1 | 77.9% | 76.6% |
| any@5 | 91.3% | 91.7% |
| any@10 | 95.5% | 94.9% |
| ndcg@10 | 82.0% | 81.5% |
| context hit rate | 92.6% | 92.8% |

The deltas run in both directions and are inside noise for n=470. A ranking
term that cannot be shown to help is a per-query cost (an extra SQL fetch per
candidate, a 2048-bucket table, and ~40 lines of hashing) for nothing.

**What was given up.** The specific case it was meant to catch — a paraphrase
sharing no exact term, e.g. "周五要交周报了" vs "每周五提交工作汇报" — is no longer
covered. It was never demonstrated to matter on the benchmark either.

**Reversal condition.** Any of:

- a real embedding endpoint becomes available (local model, gateway feature) and
  beats the lexical path on the preference slice, which is the weak spot:
  any@1 20.0%, any@10 70.0%;
- a product-level question type appears where exact-term overlap is structurally
  absent (cross-language, heavy abbreviation);
- a rerun at a larger sample (LongMemEval-m) reverses the sign.

## 2026-11-04 — Kept the IDF-weighted cosine term

**Decided:** keep it inside `recall`.

**Why it won.** It never admits a memory that shared no term, so its worst case
is reordering memories that already matched; the stopword floor added in the
same change removed the failure mode it did have (a single "the" passing the
0.2 ratio floor).

**What was given up.** One SQL query per candidate per recall.

**Reversal condition.** It is worth re-measuring on its own; if it shows no
gain either, remove it by the same standard as the semantic term.

**Status:** assumed for now — not yet measured in isolation.

## 2026-11-04 — Memory is pushed into the Main Agent prompt, not left to pull

**Decided:** `before_agent_start` recompiles matching memories into the system
prompt on every turn.

**Alternatives:** keep `recall_memory` as the only path; inject a user-role
message instead.

**Why it won.** Pull-only memory meant the owner could approve a memory and
still be answered as if it did not exist. The system-prompt route reuses the
same 1200-character / 6-item boundary the workers already get and leaves the
conversation history untouched (a user-role injection would appear in the
transcript and in `readConversation`).

**What was given up.** One recall per turn (a short-lived SQLite handle), and
the system prompt changes between turns, which weakens prompt caching.

**Reversal condition.** If per-turn latency becomes visible, or if prompt
caching savings outweigh push accuracy.

## 2026-11-04 — Conversation mining is opt-in (`CLONE_AI_MEMORY_MINING=1`)

**Decided:** off by default, same as task mining.

**Why it won.** One model call per owner turn. A default-on miner would spend
the owner's budget on conversations that produced nothing worth remembering.

**What was given up.** Out of the box, the twin does not learn from
conversation — the largest functional gap against companion products.

**Reversal condition.** Once a cheap or heuristic pre-filter can reject turns
that obviously contain no durable statement, the miner can default on.

## 2026-11-04 — Lessons from failure clusters are authored, not mined

**Decided:** a failure signature seen in 3+ runs produces a `procedure` memory
via `MemoryGovernance.author()` after owner approval, not a mined candidate.

**Why it won.** A mined candidate may only cite evidence from its own run; a
cluster spans several runs, so no single run can justify it. The owner's
approval is the evidence.

**What was given up.** The lesson text is template-built (`category`, count,
signature, catalog guidance) rather than model-written.

**Reversal condition.** If lesson quality proves to matter more than citation
purity, allow multi-run candidates with an explicit evidence set.

## 2026-11-04 — Native worker is configured by environment, not enabled by default

**Decided:** `CLONE_AI_NATIVE_MODEL` + `CLONE_AI_NATIVE_BASE_URL` opt in;
otherwise the registry keeps using sandboxed CLI workers.

**Alternatives:** make it the default; register it always but fail at dispatch.

**Why it won.** The CLI workers have an OS-enforced boundary. The native worker's
boundary is enforced by our own code, and until it has production mileage, the
safer default should be the one with the sandbox.

**What was given up.** Two worker types to reason about; the native path is
untested at scale.

**Reversal condition.** After the native worker has run real owner tasks with
no boundary regressions, it can become the default for non-coding work.

## 2026-11-04 — Archived memories, not deleted

**Decided:** expiry, idleness and retirement all archive; nothing is destroyed.

**Why it won.** `memory.restored` makes every decision reversible, and the
journal remains an honest record of what the twin once knew.

**What was given up.** Disk grows without bound in principle.

**Reversal condition.** Add a purge of memories archived for N years, with the
owner's explicit consent and a journaled reason.

## 2026-11-04 — 90-day lifetime and 90-day idleness

**Decided:** promoted memories default to a 90-day expiry; any active memory
unused for 90 days is archived.

**Why it won.** 90 days matches one project, one work cycle or one term — the
owner's own framing.

**What was given up.** A still-true fact that simply was not retrieved for 90
days disappears from recall. It is recoverable, but the owner has to notice.

**Reversal condition.** If the improvement loop's usage data shows restored
memories were in fact still useful, lengthen the window or exclude authored
memories.

**Status:** the 90-day figure is assumed from the owner's description, not
measured.

## 2026-11-04 — Owner labels outrank system verification

**Decided:** in outcome attribution, `audit.labeled` decides good/bad; system
verification is the fallback.

**Why it won.** The label is the ground truth an eval compares the system's
verdict against. Where they disagree, the system was by definition wrong.

**What was given up.** A single careless label pollutes the attribution for
every memory exposed to that run.

**Reversal condition.** If labels prove noisy, require a note or a second
confirmation for `fail` labels on completed runs.

## 2026-11-04 — Improvement suggestions are deterministic and capped at 10

**Decided:** suggestion ids are derived from the basis (`retire:<id>@<bucket>`),
and at most 10 are pending at once.

**Why it won.** Recomputing on every tick must not create duplicates; and a
flood of approvals trains the owner to approve blindly, which defeats the gate.

**What was given up.** A genuinely new suggestion can be delayed until older
ones are decided.

**Status:** the bucket size and the cap of 10 are assumed, not tuned.
