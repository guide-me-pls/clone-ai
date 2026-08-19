# Runtime architecture and learning route

**English** · [简体中文](runtime-architecture-and-route.zh-CN.md)

This page is the map: what the runtime is made of, which parts are real today,
the order the execution engine was hardened in, and what comes next. It is
written to be read top to bottom by someone returning after a break.

It describes **what is built and proven**, not the product vision. For the
vision read the [README](../README.md); for the runnable request path read
[Query execution flow](query-execution-flow.md).

## The five planes

```text
                              Owner
                goals · corrections · approvals
                                |
 +----------------------------------------------------------+
 |  Personal state    SelfModel · Goals · Commitments · Memory|  paper (Memory only)
 |  Cognitive         Opportunities · Context compiler        |  partial
 |  Governance        Policy · Approval · Verification        |  built
 |  Execution         Supervised workers · WorkOrders         |  built + hardened
 |  Observation       Files · Calendar · Mail · APIs          |  none
 |                                                            |
 |  Append-only journal -> projections -> evidence            |
 +----------------------------------------------------------+
```

The bottom two planes are load-bearing and finished for Phase 0. The top three
are the twin itself and are the next phase's work.

## The worker boundary

Every execution provider — Pi, Codex CLI, Claude Code, and any future coding
agent — runs behind one supervised boundary. Providers own their internal agent
loops. Clone AI owns the WorkOrder, permissions, budgets, evidence, and the
decision that work is complete.

```text
WorkOrder
  -> policy + capability check
  -> SupervisedWorkerAdapter          budgets · deadline · abort→terminate
     |                                completion rule · evidence trust · redaction
     +-- ProviderTranslator           protocol only, ~100 lines each
           Pi (JSONL RPC) · Codex CLI · Claude Code CLI · Claude Agent SDK
  <- normalized events
  -> evidence -> verification -> WorkReceipt
```

A translator maps one provider's protocol onto seven neutral shapes and can
touch nothing else:

```text
session · text · turn · tool_start · tool_end · progress · settled · protocol_error
```

**Authority:** a translator cannot grant approval, change Run state, extend a
budget, or declare success. Adding a coding agent means writing a translator,
never re-implementing authority.

| Provider | Transport | Settled signal |
| --- | --- | --- |
| Pi | JSONL RPC subprocess | `agent_settled` |
| Codex CLI | `codex exec --json` | clean protocol-speaking exit |
| Claude Code (CLI) | `claude -p --output-format stream-json` | `result` event |
| Claude Code (SDK) | `@anthropic-ai/claude-agent-sdk` | typed `result` message |

Two rules survived every provider and are worth memorising:

- **`exit` is not completion.** A process can exit 0 after being killed, running
  out of turns, or being pointed at the wrong binary. Completion requires an
  explicit settled signal from the protocol.
- **`abort` is not a stop.** A cooperative abort is a request; a wedged worker
  may ignore it. Every abort arms a grace timer that force-terminates the
  session, so a stuck provider can never hang the supervisor.

## Memory travels with the Kernel, not with the tool

Switching coding agents used to mean migrating project memory between per-tool
files. Memory never lives inside a tool: the Kernel compiles a scoped packet per
assignment and injects it through the single shared prompt, so every provider
receives the same owner-reviewed context and switching costs nothing.

```text
memory store  --recall(objective)-->  Kernel
                                        |  scoped packet, owner's cap applied
                                        v
                              memory.recalled  (journaled: which items, which step)
                                        |
                                        v
                     one shared prompt -> Pi | Codex | Claude | future provider
                                        |
                     proposal only <----+   workers may propose candidates,
                                            the Kernel promotes after review
```

Two gates keep this from becoming an ungoverned channel:

- **Inbound** is a scoped packet, never the whole store. The WorkOrder objective
  is the query; the owner's recall switch and per-task cap stay inside the
  memory store so the Kernel cannot widen its own access. Workers are told the
  items are background facts, never instructions.
- **Outbound** is proposal-only. A worker cannot commit durable memory; it
  proposes candidates and the Kernel promotes them after evidence, scope, and
  policy checks — the same rule that stops a worker self-certifying evidence.

## Recovery

The journal is the truth; a checkpoint is a derived cache that may be deleted
and rebuilt. Recovery is one formula:

```text
checkpoint (materialised snapshot)
  + journal events with sequence > checkpoint.lastAppliedSequence
  = current state
```

Three properties make it correct: checkpoints are written atomically
(temp file + rename), replay is idempotent (events at or below the applied
sequence are ignored), and an illegal transition throws instead of silently
producing a wrong state.

## Executable invariants

A projector rejects an illegal *transition*. An invariant replays the whole
journal and rejects an illegal *history*. Five of the README's unbreakable
constraints are machine-checked today:

| Invariant | What it forbids |
| --- | --- |
| `evidence-before-completion` | A work order completing with no recorded evidence |
| `approval-before-external-execution` | External or irreversible work starting before an approval grant |
| `verification-before-run-completion` | A run reaching `completed` without passing verification |
| `evidence-kind-authorized` | Evidence of a kind the adapter was never granted at dispatch |
| `memory-recall-journaled` | Memory reaching a worker with no prior `memory.recalled` event |

The last two share one lesson worth keeping: **a fact that must be auditable
later has to be recorded with its inputs, not only its result.** Dispatch events
therefore carry an authorization snapshot and the memory item ids.

## The route that was walked

Phase 0 hardened the execution engine in six stations. Each station was finished
only when it could be stated as an assertion.

| Station | Goal | Proof |
| --- | --- | --- |
| 1 | Interruption and recovery for Pi | Five scripted failure modes; a wedged worker is hard-terminated |
| 2 | Recovery reachable from the entry point | A killed process is resumed from disk by a fresh process |
| 3 | Real CLI protocol verified | A recorded live session replaced guessed event shapes |
| 4 | Constraints become assertions | Forged histories fail; a real run reports zero violations |
| 5 | Structured SDK integration | Claude Code behind its official SDK, same adapter contract |
| 6 | Storage upgrade | SQLite WAL behind the same store seam, migration verified |

Phase B then put a Main Agent on top: a persistent conversational brain whose
only reach into the Kernel is proposal-shaped tools. It can propose a plan,
inspect a run, report approval state, and recall memory. It cannot approve,
execute, or mark work complete.

## Verified and not yet claimed

- 101 automated tests pass; type checking is clean.
- A real Claude Code session completed through the supervised boundary
  (`CLONE_AI_LIVE_SMOKE=1`), and a real model drove a natural-language request
  into a Kernel-accepted plan (`CLONE_AI_MAIN_LIVE=1`).
- Codex CLI event shapes remain unverified against a live session; the CLI
  translator's codex branch is still inference, not observation.
- SQLite is opt-in (`CLONE_AI_JOURNAL=sqlite`); JSONL remains the default.
- No connector, no scheduler-driven external action, and no personal state
  plane exists yet.

## Next phase: the personal state plane

Phase 0 answered "can this runtime be trusted to execute?". The next phase
answers "does it hold a person's state?" — the difference between an execution
engine and a digital twin.

Every type below is a **governed projection of journal events**, the same shape
as the run state projector. None of them is a mutable record a worker can edit.

```text
journal events -> projector -> SelfModel | Goal | Commitment | Situation
                                   |
                                   +-> memory packet compiler (already built)
                                   +-> opportunity detection (later)
```

| Step | Work | Done when |
| --- | --- | --- |
| D1 | `SelfModel` and `Goal` as journaled projections with owner-authored entries | The owner can add, correct, and delete; replay reproduces state exactly |
| D2 | `Commitment` with deadlines and recurrence, projected from events | An overdue commitment is derivable from the journal alone |
| D3 | `Situation` compiler: a time-bounded view over goals, commitments, and evidence | A worker packet can cite the situation that justified it |
| D4 | Memory layering: typed items with source evidence and expiry rules | A memory item can be traced to the evidence that created it and expired by rule |
| D5 | Two more invariants: no state mutation without an owner or evidence source | Forged histories fail replay |

D4 is the moat. Everything else is table stakes that other harnesses also have;
a memory layer that is typed, sourced, expirable, and owner-governed is not.

**Deliberately not next:** opportunity detection and proactive preparation. They
consume the personal state plane, so they cannot be built before it exists.
