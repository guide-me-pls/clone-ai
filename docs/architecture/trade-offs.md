# Architecture trade-offs

**English** · [简体中文](trade-offs.zh-CN.md)

A decision is only durable when its reason is written down. Each entry states
what was decided, the evidence behind it, and the condition under which a
future reader should reverse it.

## 2026-11-05 — Require explicit intent for root-level file names

**Decision.** Keep extracting ordinary paths with directory separators, but
exclude URLs, code expressions, and paths with constant-like uppercase directory
segments. Extract a root-level filename only when the same sentence or
assertion contains an explicit file-intent word and its extension belongs to a
conservative allowlist. Reject treating every dotted token as a file and reject
requiring intent words for paths that already have directory separators.

**Evidence.** The nightly repair trace reported a false failure when the
verifier interpreted `fs.rename`, `os.tmpdir`, `consumed-traces.json`, and
`REPORT_DIR/consumed-traces.json` as required workspace files. Source
inspection shows the previous extractor accepted dotted tokens without those
distinctions. The proposed coverage is a hypothesis pending the targeted
offline tests; no before-change eval was run under this work order.

**Cost and reversal condition.** Real root-level deliverables without an intent
word in the same sentence or assertion, or with an unlisted extension, will be
missed. Revisit the rule when representative real deliverables show those
misses matter, and only widen the vocabulary or allowlist with regression cases
that also preserve the exclusions.

## 2026-11-05 — Recover planning orphans only after a conservative grace period

**Decision.** Fail a planning Run only if it has no plan, no live claim, and
its last update is more than 15 minutes old. Acquire a recovery claim and
atomically reject the failure if the Run changed since the refreshed projection.
Leave stores that cannot make that conditional fenced write untouched. Do not
change recovery of running or verifying Runs.

**Evidence.** Recovery currently scans only `running` and `verifying`; a
planner that dies before producing a plan can leave a Run in `planning`
indefinitely. Assuming 15 minutes is sufficient for ordinary unclaimed
planning is conservative but not measured; an active planner without a lease
can still exceed it. Immediate failure or age alone would endanger fresh or
claimed work. Rechecking only in memory would allow a concurrent plan or
cancellation to be overwritten before the failure is written.

**Reversal condition.** If observed legitimate unclaimed planning takes more
than 15 minutes, replace the timeout with a reliable planner lease or adjust
the threshold based on measured durations before enabling this recovery.

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

## 2026-11-05 — Workers inherit model credentials only, never tool credentials

**Decision.** A provider declaration may name the credentials its model client
needs. Any tool credential (`GITHUB_TOKEN`, `AWS_*`,
`GOOGLE_APPLICATION_CREDENTIALS`, `*_SECRET`, …) is refused before launch, with
an error that points at the credential broker.

**Evidence.** A black-box worker with a shell and a token can do anything that
token allows; the model needs its API key to answer, but it does not need the
owner's source-host or cloud credentials. The check runs at build time, before a
process exists, so a bad declaration cannot leak into a running worker
(`test/worker-env.test.ts`).

**What it costs.** A worker that genuinely needs a tool credential cannot be
configured by inheritance; it must go through the broker.

**Reversal condition.** If a trusted, narrowly scoped operation needs a tool
credential, add per-call broker injection after Kernel authorization; do not
re-enable inheritance.

## 2026-11-04 — Failed traces and repair run only in a gated, draft-PR lane

**Decision.** Failed and cancelled runs become redacted, self-contained trace
documents, including implicit failures no error code records: a step retried
three or more times, a cancel, an "不合格" label, or an owner correction within
ten minutes. The nightly repair job runs in a fresh worktree, requires a
regression test that the script verifies is red before the fix, hashes the test
files across phases, blocks protected paths from the diff, and produces a draft
PR (or a patch file) only. It never merges, deploys, restarts, or edits its own
schedule.

**Evidence.** Unattended code generation is the highest-risk action in the
system. Each gate closes a specific failure mode: writing in the serving
checkout; a "fix" without a reproduction; a model making the suite green by
rewriting the test; a fix that edits the rules that judge it; and an automatic
merge. `scripts/nightly-rsi.mjs` implements all five, and its report states that
merging remains the owner's decision.

**What it costs.** Tests plus a diff check bound the damage but cannot prove a
fix is safe; a human must read the PR. No traces means no run, and a failure
keeps the worktree for inspection.

**Reversal condition.** Do not relax the draft-PR gate for a general fix. If a
sandboxed runner can prove the fix against the full suite and enforce the
protected-path rule mechanically, a separate trade-off may allow auto-merge for a
named allowlist of paths — never for broad changes.

## 2026-11-04 — Self-review may change configuration, never the rules

**Decision.** A review reads the audit digest and may propose at most four
actions, restricted to a worker's or the Main Agent's model and reasoning
effort. Each action is validated against what the machine declares it can do,
applied only on the owner's click, journaled as `recommendation.applied` with
the previous and new value, and reversible from the same row. Code, prompts,
policy, and evidence rules are not reachable, and nothing runs on its own.

**Evidence.** An agent that can widen its own authority is a risk, not an
improvement loop; authority and completion belong to the Kernel. The digest is
already a projection of the journal (`loadAudits` / `summarizeAudits`), so the
reviewer needs no new data path, and the model-failure path degrades to measured
facts (`test/self-review.test.ts`).

**What it costs.** The narrow surface cannot fix a code or prompt defect; the
review can only tune model and effort. That is deliberate.

**Reversal condition.** If the configuration surface proves unable to address a
real failure class, add a new action kind only through its own trade-off with
validation and rollback — never by widening this one to code, prompts, policy,
or evidence rules.

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

## 2026-11-05 — Consistency is measured, and the first run failed three of four

**Decided:** `npm run bench:consistency` runs four consistency scenarios and two
restraint scenarios against the real recall + context + attention path.

**What the first run measured.** 1/4 consistency scenarios passed and 100% of
irrelevant observations became interruptions. The three failures were real:

- a moved meeting and the old time both reached the context;
- a changed preference competed with the previous one;
- a stated preference was not recalled at all against a long question.

**What was changed in response.**

- Preferences may be recalled below the product floor (0.08 instead of 0.2),
  but only on a *distinctive* match — a term shared by at most a quarter of the
  library. Measured: without the distinctiveness check the lower floor made an
  idle memory look used and defeated idle archival. Function-word bigrams
  (必须, 应该, 时候) were added to the same exclusion the Latin stopword list
  already applied.
- A newer memory using an explicit replacement verb (改到, 改用, 不再, "changed
  to") retires an older memory of the same type that shares a substantive term,
  **in the context only**. Similarity alone does not do it: "周五下午三点开会" and
  "周五的会改到周四下午" share two tokens of a dozen, so the verb is the signal.
- Observations earn an interruption only when their text asks for a decision
  (截止, 确认, due, invoice …). Everything else is background.

**What was given up.** A memory that supersedes another without saying so
("会改期了" with no verb) still leaves both in the context. An urgent-looking
message with none of the signal words is missed. Both are recorded, not hidden.

**Reversal condition.** Any of the three scenarios regressing is the signal to
revisit its fix; a semantic comparator would let the supersede rule drop the
verb requirement.

## 2026-11-05 — In-step resume: deliberately not built

**Decided:** a worker that dies mid-step is restarted whole (when replay-safe)
or failed; no adapter resumes inside a step.

**Why.** The two boundaries that matter are already enforceable — the step and
the run. Resuming *inside* a step means trusting a worker's claim about how far
it got, which a black-box CLI cannot make and a native worker would have to
commit to a checkpoint protocol before every side effect. The current policy
(re-queue only when replay-safe; fail when the work was external or
mid-verification) is the conservative reading of the same facts.

**What was given up.** A long step that dies at 90% is paid for again. For the
native worker this is bounded by its duration budget, not by correctness.

**Reversal condition.** If long steps become common and re-running them is
expensive, add an explicit checkpoint to `NativeModelClient` — a resumable
conversation state the worker itself wrote and can validate — never a guess
from workspace state.

## 2026-11-05 — Calendar and email arrive as read-only connectors

**Decided:** `CalendarConnector` reads ICS from a file or an https URL;
`EmailConnector` reads an IMAP INBOX. Neither can write, accept an invite or
send mail. Credentials are named (`env`) and read from the process environment
at build time; a missing variable leaves the connector disabled and says why.

**Why ICS and IMAP rather than vendor APIs.** One reader covers Apple, Google,
Outlook and Nextcloud exports without OAuth, a vendor SDK, or storing a token
refresh flow. IMAP is the one protocol every mailbox speaks.

**What was given up.** No push: both poll on the maintenance sweep, so a
calendar change is seen within one interval, not immediately. No thread bodies
beyond a snippet, and no attachments. Mail is read-only, so "reply for me"
remains a separate work order the owner must approve — deliberate, but it means
the twin cannot yet answer an email end to end.

**Reversal condition.** If replies become a product requirement, add an action
connector with receipts; do not add a write method to this observation
connector.

## 2026-11-05 — The memory context budget is spent per class

**Decided:** preferences may claim 50% of the remaining budget, task outcomes
25%, project facts 20%, agent outcomes 5%, filled in that order, with unused
capacity rolling forward.

**Why.** A flat 1200-character cap let a week of finished-task logs crowd out
the one preference that would change an answer; preference questions were the
worst slice on LongMemEval, at 56.7% context hit rate against 92-99% elsewhere.

**What was given up.** Ranking is no longer purely by relevance score: a
high-scoring task memory can be dropped for a lower-scoring preference. That is
the intended trade, but it means a debugging question about a recent task may
see less of that task than before.

**Reversal condition.** If the context-boundary benchmark shows a regression on
task-shaped questions, raise the task-outcome share or make the weights depend
on the intent.

## 2026-11-05 — Conflict detection is token overlap, and says so

**Decided:** `findConflicts` compares token overlap (overlap coefficient) among
active memories of the same type; ≥0.55 is a near-duplicate, ≥0.35 a subject
worth reviewing. Matched restatements are dropped from the recalled set before
the context is built.

**Measured limits.** Reworded statements score 0.57-0.93; unrelated ones 0.0-0.4.
A *changed value* in Chinese ("蓝色" -> "绿色") scores only 0.29 and is therefore
**not reliably caught** — the differing value replaces a bigram at both ends.
The tests assert the cases that work and say so in the comment; they do not
assert the case that does not.

**What was given up.** Contradictions phrased differently remain undetected, and
may both be recalled. Mitigation: only one is dropped when they *are* detected,
and the owner sees conflicts as review suggestions rather than automatic
deletion.

**Reversal condition.** An embedding-based comparison, measured on the same
pairs, that catches the value-change case above.

## 2026-11-05 — Supersedes: conversation mining defaults to a cheap local filter

**Decided:** `CLONE_AI_MEMORY_MINING` is now a three-way switch.
Unset = `filtered`: a turn is mined when it contains a durable-statement
signal (`src/memory/mining-policy.ts`), `off` silences both conversation and
task mining, `all` mines every turn. Task mining keeps the deterministic worker
unless the mode is `all`.

**Why the earlier entry changed.** "Opt-in" meant the feature a personal agent
needs most — learning without being asked — was off out of the box. The filter
is local, has no model call, and errs toward mining: a missed statement is a
memory never learned, an extra call is a few cents.

**What was given up.** Turns without a signal are never mined, so a fact stated
plainly but without any of the matched patterns ("杭州今天下雨" followed later by
a request) can be missed. `all` is the escape hatch.

**Reversal condition.** If the filter's miss rate is visible in practice, widen
the signal list or make `all` the default.

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

## 2026-11-05 — Consume repaired traces by runId and file fingerprint

**Decided.** Store the latest successful batch outcome for each runId alongside
the SHA-256 of the exact input file, and skip only a matching pair. Mark only
`fixed`, `pr-created`, or `patch-only`; an error remains eligible. Persist via
a same-directory rename; an unreadable or malformed state falls back to empty.

**Evidence and alternatives.** The current `loadTraces` reads the first files
without a record of earlier outcomes, so unchanged failures are sent to repair
again; this follows from code inspection, not a measured production incident.
Always retrying wastes repair work; recording runId alone would suppress new
content. The effectiveness of the complete model-dependent workflow remains
**assumed**, since it is outside this offline work order. Lost or corrupt state
can cause repeat work, and a later failure after a successful outcome does not
roll that outcome back.

**Reversal condition.** Replace this file-based scheme if a durable shared
ledger is needed across machines, or if trace exports change bytes without
changing actionable evidence often enough to cause repeated repairs.
