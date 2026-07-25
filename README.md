# clone-ai

> **A local-first continuity runtime for your personal AI clone.**
>
> **Agents change. Your work continues.**

**English** · [简体中文](README.zh-CN.md)

> Status: pre-implementation architecture. **clone-ai is a working name** pending
> final trademark, domain, and package-registry clearance.

## What it is

clone-ai is a runtime that preserves a person's work across agents, sessions,
interruptions, and model upgrades.

It observes work on the user's computer, records material events in an append-only
journal, turns those events into resumable work state, dispatches replaceable AI
agents, verifies their outputs, and promotes only governed facts into durable memory.

The near-term product is a **personal work runtime for developers**. The long-term
direction is a **digital self runtime**: a user-owned continuity layer that can work
through Claude Code, Codex, Pi, and future independent agent runtimes without making
any one of them the owner of the user's identity or memory.

clone-ai is not another multi-agent launcher. Its core promise is:

> An agent session may disappear. The work, evidence, permissions, and memory do not.

clone-ai sits above independent agent runtimes. It does not fork, embed, or treat any
one runtime as a subordinate agent: clone-ai owns continuity and governance, while a
connected runtime supplies only a bounded execution capability.

Local-first means that authority and canonical state live on the user's computer. It
does not imply that every worker is offline: an adapter may call a hosted model, but
the context sent off-device is explicit, scoped, and governed by policy.

## Why this exists

Today's agents are capable but temporary:

- Every new session reconstructs context from chat history and scattered files.
- Switching agents means manually carrying decisions, constraints, and unfinished work.
- An agent can claim success without proving that the requested outcome exists.
- Long conversations mix transient work state with durable personal memory.
- Tool output, external content, and model assertions are often treated as equally trusted.
- A crashed process can lose the only usable representation of what should happen next.

The missing layer is not a smarter model. It is a durable runtime outside the model
that owns continuity, authority, evidence, and memory.

## Design principles

1. **Continuity belongs to the runtime.** Agents are replaceable workers, not the
   source of truth.
2. **The computer is the observation boundary.** Files, diffs, command results, tests,
   local tool state, and explicit approvals can be captured as observed facts.
3. **The journal is authoritative.** Material intents, decisions, actions, permissions,
   artifacts, and verification results are append-only events.
4. **Work state is not memory.** Open tasks and retries are rebuildable projections;
   durable memory is a separate, governed store.
5. **Claims are not evidence.** A worker may report completion, but only the runtime
   can accept it after verification.
6. **Context is compiled, not dumped.** Each worker receives the smallest authorized
   packet needed for its assignment.
7. **Authority stays outside agents.** Scheduling, budgets, permissions, verification,
   and memory commits remain runtime decisions.

## Overall architecture

```text
Human
  | intent, correction, approval
  v
+--------------------------------------------------------------------------+
| clone-ai Runtime                                                         |
|                                                                          |
|  Control Plane                                                           |
|  Scheduler | Policy & Budget | Permission Gate | Verifier | Memory Authority |
|       |                                      |                           |
|       | assignment + bounded context         | decisions                 |
|       v                                      v                           |
|  Context Compiler ---------------------> Agent Adapters                   |
|       ^                                  Claude Code | Codex | Pi         |
|       |                                      |                           |
|  Durable Memory                              | claims and actions         |
|       ^                                      v                           |
|  Memory Governance <--- Append-only Event Journal                        |
|                            |                     ^                       |
|                            v                     |                       |
|                    Work State Projections       |                       |
|                                                  |                       |
|  Observation Boundary: files, Git, shell, tests, artifacts, local tools |
+--------------------------------------------------------------------------+
```

All material activity enters the journal with provenance. Work state is derived from
that journal. Durable memory is promoted through a separate policy-controlled path.
Agents see only a scoped `ContextPacket`; they never receive implicit ownership of the
whole journal or memory store.

### Architectural layers

| Layer | Responsibility |
| --- | --- |
| **Observation Boundary** | Captures what happened on the computer: file changes, Git state, command output, tests, artifacts, tool results, and user approvals. |
| **Event Journal** | Stores immutable, ordered events for intent, observation, decision, action, permission, artifact, verification, and memory activity. |
| **Work State** | Builds resumable projections for sessions, work items, dependencies, retries, blockers, budgets, and ownership history. |
| **Durable Memory** | Stores reviewed preferences, project facts, and reusable procedures with provenance, scope, confidence, and retention policy. |
| **Control Plane** | Selects workers, compiles context, applies policy and budgets, requests approval, verifies results, and authorizes memory changes. |
| **Agent Adapters** | Normalize Claude Code, Codex, Pi, and future workers behind one replaceable lifecycle contract. |

## Core model

| Concept | Meaning |
| --- | --- |
| **Goal** | A longer-lived direction that may produce many sessions and work items. |
| **Session** | One bounded episode beginning with user intent and ending in completion, pause, or abandonment. |
| **WorkItem** | The durable unit of continuity. It may span sessions and contains a goal, acceptance criteria, dependencies, status, and ownership history. |
| **AgentSession** | One disposable invocation of a concrete worker for a work item. |
| **JournalEvent** | An immutable event with actor, type, scope, payload, causality, sequence, and timestamp. |
| **Artifact** | A concrete output addressable by path, hash, or URI. |
| **Evidence** | An observed fact supporting or contradicting a claim, such as a diff, test result, command output, citation, or approval. |
| **VerificationRecord** | The runtime's pass, fail, or inconclusive decision against explicit acceptance criteria. |
| **MemoryCandidate** | A proposed durable fact that is not yet trusted or available for general recall. |
| **MemoryItem** | A governed memory entry with provenance, scope, confidence, sensitivity, retention, and review metadata. |
| **ContextPacket** | A minimal, authorized view compiled for one worker assignment. |
| **WorkReceipt** | The final inspectable record of what changed, what was verified, what remains open, and why. |

The important separation is:

```text
Session      = what is happening now
WorkItem     = what must survive until it is resolved
Journal      = what actually happened
Memory       = what is worth carrying into future work
AgentSession = who is temporarily helping
```

## Execution lifecycle

```text
CAPTURED
  -> READY
  -> RUNNING
  -> VERIFYING
       |-> PASSED ---------> COMPLETED
       |-> RETRYABLE ------> READY
       |-> NEEDS_CHANGE ---> REPLANNING
       |-> NEEDS_HUMAN ----> WAITING_APPROVAL
       `-> UNRECOVERABLE --> FAILED
```

For each request:

1. The runtime opens a `Session` and creates one or more `WorkItem`s with acceptance
   criteria.
2. The control plane selects a worker using capability, policy, budget, permission,
   and isolation requirements.
3. The context compiler builds a bounded `ContextPacket` from current work state,
   authorized memory, and relevant evidence.
4. The adapter streams worker activity and claims while the runtime captures observable
   effects at the computer boundary.
5. The verifier checks artifacts and evidence against acceptance criteria.
6. The runtime completes, retries, replans, reassigns, or pauses the work item for human
   approval.
7. The session may end, but unresolved work items remain durable and resumable.

`worker.completed` means only that a worker stopped and reported success. It does not
mean the work item is complete.

## Event journal and projections

The event journal is the recovery backbone:

```ts
interface JournalEvent<T = unknown> {
  id: string;
  sequence: number;
  type: string;
  actor: ActorRef;
  scope: ScopeRef;
  payload: T;
  causationId?: string;
  correlationId: string;
  observedAt: string;
}
```

Representative event families include:

```text
intent.*        work.*          agent.*
observation.*   artifact.*      verification.*
permission.*    budget.*        memory.*
```

Current state is a projection, never the source of truth. After a restart, clone-ai
replays the journal to rebuild sessions, work items, queues, budgets, retries, and
approval waits. Snapshots may accelerate replay but cannot replace the journal.

Append-only does not mean retaining every sensitive byte forever. Large or sensitive
content lives in an encrypted, policy-controlled content store; journal events keep
references, hashes, and lifecycle metadata. Deletion appends a tombstone and removes or
cryptographically erases the referenced content while preserving a non-sensitive audit
record.

## Governed memory

clone-ai deliberately separates remembering from merely storing a transcript.

### Write path

```text
Worker or runtime proposes MemoryCandidate
  -> quarantine
  -> verify supporting journal evidence
  -> apply scope, sensitivity, and retention policy
  -> deduplicate and detect conflicts
  -> promote, merge, reject, or request human review
  -> commit MemoryItem with provenance
```

Workers cannot directly mutate durable memory. Every committed memory item must point
back to the events or artifacts that justify it.

### Read path

```text
Session intent
  + relevant WorkItems
  + authorized MemoryItems
  + recent Evidence
  -> Context Compiler
  -> bounded ContextPacket
  -> selected AgentSession
```

The first release keeps memory intentionally narrow:

- user preferences,
- stable project facts,
- recurring procedures.

Memory inspection, correction, expiration, and deletion are product capabilities, not
database maintenance tasks. Corrections supersede earlier items without rewriting
history; forgetting erases the memory body according to policy while leaving only the
minimal audit tombstone described above.

## Trust and authority

| Actor or boundary | Trusted for | Not trusted for |
| --- | --- | --- |
| **Human** | Goals, corrections, approvals, and policy choices | Perfect recall or continuous supervision |
| **Runtime** | Scheduling, policy enforcement, journaling, verification decisions, and memory authority | Automatically knowing whether external content is true |
| **Worker agent** | Producing proposals, actions, artifacts, and structured claims | Declaring final completion, granting itself permissions, or committing memory |
| **Observation boundary** | Proving that a local effect or output was observed | Proving that the content itself is semantically correct |
| **External content** | Supplying data with provenance | Issuing instructions or changing runtime policy |

An approval event proves that the user authorized one scoped action; it does not prove
that the action is safe or correct. Policy enforcement and outcome verification still
apply.

Destructive actions, privilege changes, sensitive memory commits, and policy expansion
require explicit human approval. Permission, budget, and escalation decisions are
journaled.

## Agent adapter boundary

Provider integrations remain thin:

```ts
interface AgentAdapter {
  readonly id: string;

  capabilities(): Promise<AgentCapabilities>;

  start(input: AgentSessionInput): AsyncIterable<AgentEvent>;

  resume(
    agentSessionId: string,
    input: AgentResumeInput,
  ): AsyncIterable<AgentEvent>;

  cancel(agentSessionId: string): Promise<void>;
}
```

Adapters translate SDK streams, JSONL, subprocesses, and CLI sessions. They do not own
work state, durable memory, permissions, or completion policy.

## A representative run

```text
$ clone-ai session start "Add API rate limiting and prove it works"

Session ssn_01... opened
  WorkItem 1: inspect API boundaries             -> Codex
  WorkItem 2: compare compatible strategies      -> Claude Code

Observed:
  repository snapshot, worktree diffs, command output, test results

Runtime:
  creates WorkItem 3 from accepted findings
  dispatches implementation in an isolated worktree
  verifies the diff and required tests
  records one project-fact memory candidate

Session ssn_01... completed
  3 work items | 2 agent types | 4 artifacts | 5 verification records
  WorkReceipt: receipts/ssn_01.json
```

If a worker exits halfway through, the partial artifacts and failure remain visible.
The runtime can resume the same agent session, assign a new worker, replan, request
approval, or stop with an inspectable reason.

## v0.1

### Included

- Single user, single computer, local-first operation.
- SQLite WAL event journal and rebuildable projections.
- `Session`, `WorkItem`, `AgentSession`, `Artifact`, `Evidence`, and `WorkReceipt`.
- Claude Code, Codex, and Pi adapters.
- Git worktree isolation for coding tasks.
- Verification hooks for file changes, commands, tests, and citations.
- Narrow governed memory for preferences, project facts, and procedures.
- Timeouts, cancellation, retry, approval waits, and crash recovery.
- CLI views for work, traces, evidence, memory, and resumability.

### Deferred

- Vector-first or autonomous memory ingestion.
- Multi-device synchronization.
- Distributed queues or multi-node execution.
- Open-ended swarms and agent social systems.
- A marketplace of preset agents.
- A full web control plane.
- An autonomous digital clone acting without scoped authority.

The v0.1 proof is simple:

> Start non-trivial work, interrupt it, replace an agent, resume later, inspect the
> evidence, and still reach a verified result without reconstructing the task by hand.

## Proposed TypeScript layout

```text
packages/
|-- contracts/              shared domain types and schemas
|-- journal/                append-only events, snapshots, replay
|-- content-store/          encrypted blobs, retention, erasure
|-- work-state/             session and work-item projections
|-- memory/                 candidates, governance, recall, audit
|-- context/                scoped ContextPacket compiler
|-- runtime/                scheduler and lifecycle coordination
|-- policy/                 permissions, budgets, escalation rules
|-- verifier/               artifact and evidence verification
|-- adapters/
|   |-- claude-code/
|   |-- codex/
|   `-- pi/
|-- cli/                    local command-line interface
`-- testkit/                fake agents, fixtures, failure injection
```

Suggested foundations:

- **TypeScript strict + Node.js 22+** for contracts, subprocesses, and streaming.
- **pnpm workspaces** for clear package boundaries.
- **SQLite WAL + Drizzle** for local, inspectable durability.
- **Zod** for validation at every adapter and storage boundary.
- **Pino + OpenTelemetry** for correlated logs and traces.
- **Vitest** for event replay, fake-agent, crash, and policy tests.
- **Git worktrees**, with optional containers later, for isolated coding work.

## CLI direction

```bash
clone-ai init
clone-ai agent add codex
clone-ai agent add claude-code
clone-ai session start "research and implement this requirement"
clone-ai work list
clone-ai trace <session-id>
clone-ai resume <work-item-id>
clone-ai memory inspect
clone-ai memory audit
clone-ai memory forget <memory-id>
```

A trace must answer: what was requested, what the runtime decided, which worker acted,
what changed on the computer, what evidence was captured, what was verified, what
requires approval, and why the work is in its current state.

## Non-negotiable invariants

1. The journal is append-only.
2. Work state is derived and rebuildable.
3. Work state and durable memory remain separate.
4. Every durable memory item has provenance.
5. Workers cannot mark work complete.
6. Completion requires acceptance criteria and verification evidence.
7. Permissions, budgets, policy decisions, and escalations are journaled.
8. External content is data, never runtime authority.
9. Adapters are replaceable; runtime authority is not.
10. The user can inspect, correct, export, and delete durable memory.

## Naming note

`Knotwork` described the earlier idea of weaving multiple agents together, but it placed
the metaphor on the adapters rather than the enduring product value. It also collides
with existing software and AI-facing uses.

`clone-ai` is the adopted repository and project name. It makes the long-term direction
explicit: a user-owned personal AI clone, rather than a collection of disposable chats.
The phrase **Clone AI** is descriptive and already used by active products, so treat
`clone-ai` as a project name and working brand, not as a cleared commercial trademark.
Before a paid public launch, complete a formal trademark, domain, and package-registry
check and introduce a more distinctive product brand if needed.

---

> **clone-ai lets a personal AI clone carry work forward with evidence, permission, and memory.**
