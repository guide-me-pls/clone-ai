# Trade-off log

**English** · [简体中文](trade-offs.zh-CN.md)

Every design decision here was a choice between real alternatives, and the
reason it lost or won is worth more than the code that resulted. This file is
the record: what was decided, what was given up, what evidence there was, and
what would reopen the decision.

Rules for entries:

- One entry per decision, newest first.
- **Evidence, not guesswork.** State the measurement or the code fact that
  decided it. If nothing was measured, say "assumed" explicitly.
- **Reversal condition.** Every entry says what would make us revisit it; a
  decision nobody can reopen quietly becomes folklore.
- When an entry is superseded or reversed, do not delete it — mark it and add
  the new entry that replaced it.

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
