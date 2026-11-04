# Recursive self-improvement (RSI) design

**English** · [简体中文](recursive-self-improvement.zh-CN.md)

Status: the loop is implemented for L0 (memory); clustering uses failure
signatures only; the benchmark gate and supersession (§5.4) are not built. See
"Implementation" at the end.

## 1. Goal and non-goals

**Goal.** Make the twin measurably better at the owner's recurring work over
time, with every improvement visible, reversible and approved by the owner.

**Non-goals** (each with its reason):

- *No self-modification of code, prompts, authority policy or sandbox rules.*
  The Kernel's guarantees (approval, path gateway, verification) are only
  trustworthy because the thing being improved cannot edit them. A loop that
  could would let one bad lesson widen its own permissions.
- *No unattended promotion.* Mined text comes from worker output, which is
  untrusted input (the context builder already treats it that way). Owner
  review is the one control that does not depend on the miner being right.
- *No claim of causality.* Runs are few and tasks differ; the measurement below
  is observational. It can rank and suggest, not prove.

## 2. The loop

```
Observe -> Diagnose -> Propose -> Gate -> Apply -> Measure -> Reinforce / Retire
   ^                                                                |
   +----------------------------------------------------------------+
```

| Stage | Input | Output | Exists today |
| --- | --- | --- | --- |
| Observe | journal, `audit.labeled`, bad-case log | per-run outcome record | partly (`projectRunAudits`) |
| Diagnose | failed runs, `FailureReport.signature` | clusters of recurring failures | signature exists; clustering does not |
| Propose | a cluster or a single failed run | a lesson candidate or catalog suggestion | single-run lessons only |
| Gate | candidate | owner decision, PII scan, evidence check | yes (`MemoryGovernance`) |
| Apply | approved lesson | active memory with a default expiry | yes, expiry not defaulted |
| Measure | recalls joined with outcomes | per-memory usefulness stats | no |
| Reinforce / Retire | usefulness stats | confidence change, archive suggestion | no |

## 3. What may change (the change surface)

| Level | Artifact | Who approves | Why this level |
| --- | --- | --- | --- |
| L0 | memory lessons (`procedure`, `preference`) | owner, per item | already governed; smallest blast radius; recalled as quoted facts, never instructions |
| L1 | failure-catalog guidance entries | owner, per entry | the catalog is already owner-authored; a proposed entry is a diff the owner can read |
| L2 | routing hints (which worker suits which task shape), as memory the planner recalls | owner, per item | reuses L0 plumbing; no new code path into the planner |
| L3 | code, prompts, policy | humans only, outside the loop | would let the loop edit its own guardrails |

Only L0 is in the first release. L1 and L2 reuse the same candidate/approval
flow and add no new authority.

## 4. Measurement

The join key already exists: `memory.recalled` events carry `runId` and memory
ids; runs end in `completed`/`failed` and may carry an owner `audit.labeled`
verdict.

Per memory `m`, a projection (no new storage; recomputed from the journal)
keeps:

- `exposures`: runs that recalled `m` and reached a terminal status;
- `good` / `bad`: exposures whose final outcome was owner-labeled pass or
  verification passed, vs. owner-labeled fail or verification failed;
- `lastExposedAt`.

Outcome precedence: an owner label beats the system's verification, because the
label is the ground truth an eval compares against (see `audit.labeled`).

Honest limits, stated so the thresholds are not mistaken for proof:

- Recall correlates with task type, so a memory used only on hard tasks looks
  bad. Mitigation: compare against runs of the same intent class that did *not*
  recall `m` where enough exist; otherwise report "insufficient data".
- Small n. No automatic action below 5 exposures; use a Wilson lower bound
  rather than a raw rate when ranking. Both numbers are conservative guesses to
  be tuned on the owner's real history, not measured constants.

## 5. Lifecycle rules (all suggestions, applied only on owner approval)

1. **90-day lifetime** (decided; implemented). A promoted memory with no expiry
   of its own gets `expiresAt = now + 90 days`; the miner's own expiry wins.
   90 days is one project, one work cycle or one term. Separately, **any active
   memory not recalled, read or edited for 90 days is archived** (reason
   `idle`, reversible through restore; a restored memory counts as touched).
   Staleness is the main way an old lesson turns harmful. The sweep runs in the
   background maintenance loop next to the expiry sweep.
2. **Reinforce**: a lesson with enough exposures and a good lower bound gets a
   "keep" suggestion that extends `expiresAt` and raises confidence.
3. **Retire**: a lesson whose exposures end badly more often than the
   no-recall baseline gets an "archive" suggestion with the numbers attached.
4. **Supersede**: a new candidate that overlaps an active lesson is shown next
   to it ("replace / keep both / reject"). Fingerprint dedup cannot catch
   paraphrases; the owner is the semantic judge.
5. **Budget**: at most N pending lesson candidates (proposal: 10). A flood of
   candidates trains the owner to approve blindly, which defeats the gate.

## 6. Failure diagnosis

Single-run lessons over-fit one incident. Clustering uses the existing
`FailureReport.signature` (volatile details already stripped) plus category:

- 1 failure: only a low-confidence, expiring candidate (current behaviour).
- 3 or more failures with the same signature across different runs: propose a
  higher-confidence lesson, or an L1 catalog entry, citing all the evidence ids.

The threshold of 3 is an assumption chosen to separate coincidence from
pattern; revisit it with real data.

## 7. Safety properties

- Every step is a journal event; `memory.archived` / `memory.restored` already
  make each change reversible.
- A lesson is recalled through `buildMemoryContext`: summary only, instruction
  phrasing stripped, secrets withheld. A poisoned lesson cannot command a worker
  or carry a credential.
- A lesson cannot change authority. Policy is decided before memory is
  consulted, and nothing in this design adds a path from memory to policy.
- Kill switch: one setting disables lesson mining and the loop; recall of
  already-approved memories is unaffected.
- The benchmark (`npm run bench`) is the regression gate: run it before and
  after enabling a batch of approved lessons; a drop is a reason to archive the
  batch. It is small and uses a real provider, so treat it as a smoke test, not
  a statistic.

## 8. Phasing

1. **Attribution (read-only).** Projection of §4 and `clone-ai memory stats`.
   Value: shows whether the idea is worth continuing before anything else is
   built. Needs no new events.
2. **Lifecycle suggestions.** §5 rules surfaced in the memory UI as owner
   decisions. Deferred until phase 1 shows enough exposures to be meaningful.
3. **Clustering and L1 proposals.** §6. Deferred: needs enough failure history,
   and a single owner's volume may never reach it.
4. **Benchmark gate.** Automate before/after runs. Deferred: costs real model
   calls on every change.

## 9. Open questions for the owner

- Should an owner `fail` label on a run automatically request lesson mining,
  even when the system's verification passed? (Likely yes: that is the
  strongest signal the system was wrong.)
- Is per-item approval sustainable at your run volume, or should low-risk
  lessons be batched?

## 10. Implementation

```
journal (memory.recalled, run.status_changed, audit.labeled, execution failures)
   |
   v
src/improvement/analysis.ts      pure: outcomes per memory, Wilson bounds,
   |                             lifecycle rules, failure clustering
   v
src/improvement/improvement-service.ts
   sweep()    -> improvement.suggested   (deterministic id, max 10 pending)
              -> requests lesson mining for runs the owner labeled "fail"
   approve()  -> MemoryGovernance (archive "retired" / update / author lesson)
              -> improvement.applied
   dismiss()  -> improvement.dismissed
   ^
   |  background maintenance loop (companion-server), before the idle sweep
   |  CLI: clone-ai improve [list|stats|sweep|approve|dismiss]
   |  API: GET /api/improvement, POST /api/improvement/suggestions/:id/(approve|dismiss)
```

Decisions and reasons:

- **Pure analysis, thin service.** Every rule is a function of the journal, so it
  is testable without storage and a lost projection is simply recomputed.
- **Mining is keyed by `runId:outcome`.** A run mined as completed must be minable
  again after the owner labels it failed; the old per-run key would have blocked it.
- **A lesson from a cluster is added through `author()`**, not as a mined
  candidate: a cluster spans several runs, while a candidate may only cite
  evidence from its own run. The owner's approval is the evidence.
- **The loop only changes memories**, via the governed path, so archive/restore
  keep every change reversible. It has no route to code, prompts or policy.
- **Kill switch:** `CLONE_AI_IMPROVEMENT=0` stops sweeps; approved memories still work.
- **Not built:** a desktop UI for suggestions (use the CLI or API for now),
  supersession of overlapping memories, and the automated benchmark gate.

## 11. What changed after the first loop shipped

Phase 1 (read-only attribution) is now implemented, together with three pieces
the analysis depends on:

- **Conversation mining** (`src/memory/conversation-memory-worker.ts`,
  `conversation-memory-pipeline.ts`). Each owner turn journals a
  `memory.conversation.requested` event plus the owner's text as evidence; the
  maintenance loop drains them oldest-first into ordinary review candidates.
  Assistant text is never cited. Opt-in via `CLONE_AI_MEMORY_MINING=1`, like
  task mining, because it costs a model call per turn.
- **Memory push** (`src/main-agent/memory-push.ts`). Reviewed memories matching
  the owner's message are compiled into the Main Agent's system prompt for that
  turn (same boundary as worker dispatch: summaries only, bounded, secrets
  withheld, instruction text stripped) and journaled as `memory.recalled` with
  run id `main-agent`, so §4 attribution sees conversation turns too.
- **Context-boundary evaluation** (`benchmark/long-memory-eval.ts --context`).
  Retrieval success and context success are now measured separately: the
  second asks whether an evidence memory survived the character and item caps
  of `buildMemoryContextFromCandidates`.
- **Hybrid recall** (`MdMemoryStore.recall`). A per-memory sparse term vector
  (stored in `memory_term_weights`, IDF applied at query time) is scored by
  cosine alongside the bigram ratio, plus a small preference prior. Cosine can
  only promote a memory that already shared a term, so it cannot introduce an
  unrelated one.

A **native worker** (`src/workers/native-agent-worker.ts`) moves the tool
boundary inside the loop: it offers only tools whose risk the step's scopes
grant, and re-checks every call's path at the moment it is made, returning a
refusal to the model instead of killing the run. The model client is injected,
so the gating is testable without a network call; no vendor SDK ships in this
change.

## 12. Measurement (LongMemEval-s, 470 scored questions)

Retrieval at maxResults=10 on the full haystack, and the context boundary the
worker actually receives:

| slice | any@1 | any@5 | any@10 | all@5 | ndcg@10 |
| --- | --- | --- | --- | --- | --- |
| overall | 77.9% | 91.3% | 95.5% | 73.8% | 82.0% |
| single-session-preference | 20.0% | 53.3% | 70.0% | 53.3% | 47.3% |

Context boundary: 92.6% of questions had an evidence memory inside the compiled
context (1200-character / 6-item caps); preference questions only 56.7%.

Semantic-term ablation (same data, `CLONE_AI_RECALL_SEMANTIC=0` for the off run):
any@1 77.9% on vs 76.6% off; context hit rate 92.6% on vs 92.8% off. The
semantic term therefore does **not** demonstrably help on this benchmark —
differences are within noise for n=470. It stays behind the switch rather than
being called a win.

What the numbers say about priorities: preference questions remain the weak
spot (the correct evidence is a session where the owner mentions a tool, not a
sentence sharing words with the question), and the context cap is a real second
loss — 7.4% of questions retrieved the evidence but could not fit it.

## 13. Native worker

`src/workers/native-agent-worker.ts` (loop + gate), `openai-compatible-client.ts`
(client speaking the OpenAI-compatible chat-completions protocol), and
`native-worker-factory.ts` (configuration and filesystem tools). Opt in with:

```
CLONE_AI_NATIVE_MODEL=<model id as the endpoint names it>
CLONE_AI_NATIVE_BASE_URL=<http://host:port>
CLONE_AI_NATIVE_API_KEY=<optional>
```

With no model configured the factory returns nothing and the registry keeps
using the sandboxed CLI workers. Verified end to end against a local
OpenAI-compatible gateway: the worker listed the empty workspace, wrote
`out/hello.txt`, read it back, and stopped — every call passing the scope gate.
