# clone-ai

> **A local-first runtime for a personal digital twin.**
>
> **One person. Persistent context. Safe execution. Outcomes that can be proved.**

**English** · [简体中文](README.zh-CN.md)

`Status: initial runtime scaffold` · `License: MIT` · `Core: TypeScript + Node.js + Python`

---

## Why clone-ai?

Today's AI is capable, but it is mostly forgetful. Every new chat starts from a prompt;
the person becomes the system that carries context, remembers commitments, compares
options, coordinates tools, checks results, and decides what can safely happen next.

clone-ai is an attempt to move that durable work into a system the person owns. It is not
an avatar and not an assistant that only mimics a voice. It is a personal digital twin
that maintains continuity across projects, planning, communication, learning, personal
administration, and the digital parts of daily life.

> **A personal AI becomes useful when it carries a person's state forward—not when it
> merely imitates that person's tone.**

| A disposable AI session | A personal digital twin |
| --- | --- |
| Starts from a prompt | Starts from an owned, evolving personal state |
| Optimizes one response | Maintains goals, commitments, and consequences over time |
| May claim success | Produces evidence and requires verification |
| Has provider-owned memory | Has user-governed memory with provenance and deletion |
| Waits for commands | Finds opportunities, prepares options, and acts only within explicit authority |

## What it does

| Capability | What it means |
| --- | --- |
| **Personal continuity** | Keeps goals, commitments, preferences, current situations, and reviewed memory coherent across sessions and providers. |
| **Query to outcome** | Turns a request into options, a durable task graph, bounded execution, verification, and a readable work receipt. |
| **Opportunity detection** | Notices deadlines, conflicts, neglected goals, and useful time windows; proposes the next best action without silently taking it. |
| **Policy-governed autonomy** | Separates observation, inference, preparation, approval, execution, and verification. A prediction is never permission. |
| **Evidence-backed delivery** | Treats an artifact, external effect, test, receipt, or approval as evidence—not an agent's self-reported confidence. |
| **Replaceable execution** | Uses independent agent runtimes, connectors, and local automations without letting any one of them own the user's state or authority. |

## Where it sits

clone-ai sits above independent agent runtimes, applications, and tools. It does not
fork, embed, or treat any one runtime as a subordinate agent. clone-ai owns personal
continuity, policy, memory, planning, and verification; connected runtimes contribute
bounded execution capability only.

```text
You
  -> clone-ai: state, planning, policy, verification
       -> Claude Code / Codex / Pi / future runtimes
       -> calendar / files / mail / browser / apps / APIs
       -> local automation and specialized Python workers
```

## Execution providers

These are execution integrations, not sources of identity, memory, or authority. Every
provider is reached through the same `RuntimeAdapter` contract and receives only the
context and capability grant necessary for an assignment.

| Provider | Intended responsibility | Integration status |
| --- | --- | --- |
| **Claude Code** | Implementation, review, local tools, and artifact creation. | Black-box launch recipe |
| **Codex** | Coding, review, repository operations, and artifact creation. | Black-box launch recipe |
| **Pi** | A replaceable terminal Agent with its own Skills and MCPs. | Black-box launch recipe |
| **opencode** | An optional alternative coding Agent. | Black-box launch recipe |
| **Custom runtimes** | User- or organization-specific commands and local tools. | Add a `providers.json` recipe |
| **Python workers** | Extraction, ranking, forecasting, evaluation, and local ML proposals. | Future black-box recipe |

## Start here

clone-ai is an architecture-first open-source project with an initial developer runtime
scaffold and an early Windows desktop client. It is not production-ready yet, but the
client already starts the local daemon as a supervised child process and opens a native
work surface. Clone the repository to follow or contribute to the design:

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
```

Then read [Architecture](#architecture), [Roadmap](#roadmap), the planned
[command-line experience](#command-line-experience-planned), and the
[initial runtime scaffold](docs/initial-runtime.md). To run the developer runtime:

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run main
```

For the new, deliberately isolated model-and-tool learning vertical slice, read
[Minimal LLM loop](docs/minimal-llm-loop.md). It runs a real model -> function tool
-> tool result -> model cycle; its only filesystem write tool is intentionally mocked.
The next orchestration slice is documented in
[Work Orders and black-box workers](docs/work-orders-and-pi.md).

For the complete current path from a user request to verified completion, see
[Query execution flow](docs/query-execution-flow.md). The opt-in model planner
and its safety boundary are documented in [LLM Planner](docs/llm-planner.md).
The real Codex CLI and Claude Code provider boundary is documented in
[Supervised worker boundary](docs/coding-cli-adapters.md). The architecture, the
route already walked, and the next phase are in
[Runtime architecture and route](docs/runtime-architecture-and-route.md).

The first implementation is a local, inspectable trust loop—not a broad autonomous
assistant. The CLI demo remains deterministic for repeatable learning and tests; the
configured desktop runtime routes bounded WorkOrders through a common black-box boundary.
Work orders carry inputs, capability requirements, artifact contracts, risk, budgets,
and an acyclic dependency graph. Claude Code, Codex, Pi, opencode, and future agents
start as fresh processes with no Clone AI-owned long-term memory. Kernel state, memory,
Workspace evidence, crash recovery, and final completion remain outside the provider.
A provider's own `--resume` behavior is optional and never the source of truth.

### Run the desktop client (Windows)

The native Tauri shell starts the daemon on an available loopback port, so it does not
depend on port `4317` or on a browser tab. With the Windows C++ Build Tools and Windows
SDK installed, build it with:

```bash
npm run desktop:build
```

Then double-click
`apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/clone-ai-desktop.exe`.
`npm run companion:debug` remains a developer-only browser preview for inspecting the
daemon boundary. See the [desktop client](apps/desktop/README.md).

## Safety commitments

These commitments shape the implementation before any model or connector is added:

1. **The person remains the principal.** The twin is a bounded delegate, never an
   independent owner of identity, money, relationships, or decisions.
2. **Prediction is not permission.** Signals and past behavior may justify a suggestion
   or a draft; they never create authority for a consequential action.
3. **The runtime owns the continuity.** Models, CLIs, and adapters can be replaced;
   user-governed state, policy, memory, and evidence cannot be delegated to them.
4. **Evidence beats assertion.** A worker can propose completion, but only observed
   results that satisfy acceptance criteria can close work.
5. **The user can inspect and revoke.** Important actions expose their rationale,
   policy basis, evidence, uncertainty, and available correction or rollback path.

## Design principles

1. **Observe broadly; infer cautiously; act only with authority.** Signals are not
   instructions, and a prediction is never permission.
2. **State outlives sessions and agents.** The runtime, not a model or adapter, is the
   source of continuity.
3. **Work, life state, and memory are different.** Current commitments are not stable
   beliefs; stable beliefs are not raw history.
4. **The smallest useful context wins.** Workers receive a scoped context packet rather
   than an unrestricted copy of a person's history.
5. **Every important action is explainable.** The user can see why an action was
   suggested, which policy permitted it, what changed, and how to correct it.
6. **Local-first means authority is local.** Hosted models may be used, but off-device
   context is explicit, minimized, and governed by policy.

## Architecture

### System overview

```text
                              User
                  goals · corrections · approvals
                                |
                                v
 +---------------------------------------------------------------------+
 |                         clone-ai Runtime                            |
 |                                                                     |
 |  Personal State Plane                                               |
 |  Self Model · Life/Work Graph · Commitments · Policies · Memory    |
 |                                |                                    |
 |  Cognitive & Planning Plane                                        |
 |  Signal Interpreter · Opportunity Engine · Scenario Planner        |
 |  Context Compiler · Task Graph Builder                             |
 |                                |                                    |
 |  Governance Plane                                                   |
 |  Authority Gate · Budget · Privacy · Risk · Approval · Verification|
 |                                |                                    |
 |  Execution Plane                                                    |
 |  Skills · Connectors · Agent Runtime Adapters · Local Automations  |
 |                                |                                    |
 |  Observation Boundary                                               |
 |  Files · Calendar · Tasks · Mail · Browser · Apps · APIs · Devices |
 |                                |                                    |
 |  Append-only Personal Journal -> State Projections -> Evidence     |
 +---------------------------------------------------------------------+
```

### The four planes

| Plane | What it owns |
| --- | --- |
| **Personal State** | The user-controlled model of preferences, goals, commitments, relationships, resources, current situations, and durable memory. |
| **Cognitive & Planning** | Interprets signals, finds opportunities, models constraints, compares options, builds task graphs, and compiles bounded context. |
| **Governance** | Authority, privacy, data residency, approval rules, budgets, risk classification, verification, audit, and revocation. |
| **Execution & Evidence** | Skills, agent runtimes, app connectors, local automation, artifacts, observed effects, and work receipts. |

Governance is not an afterthought around the execution plane. It constrains every read,
inference, proposal, and write.

## Personal state: the twin's durable center

The personal state plane must distinguish facts, preferences, plans, and uncertainty.

| Concept | Meaning |
| --- | --- |
| **SelfModel** | User-authored preferences, values, working style, standing rules, and explicit boundaries. |
| **Goal** | A desired long-horizon outcome, such as launching a product, improving health, or protecting time for learning. |
| **Commitment** | A promise, deadline, appointment, recurring responsibility, or dependency that creates an obligation. |
| **Situation** | A time-bounded view of the present: location in a project, available time, active constraints, blockers, and relevant signals. |
| **WorkItem** | A durable unit of work that can span sessions, agents, and days. |
| **PlanOption** | A proposed path with expected value, effort, risk, assumptions, confidence, and trade-offs. |
| **Policy** | A rule defining what the twin may read, infer, prepare, execute, disclose, retain, or forget. |
| **MemoryItem** | A reviewed fact, preference, procedure, or decision with provenance, scope, confidence, sensitivity, and retention metadata. |
| **Artifact** | A concrete output: patch, document, message draft, booking, spreadsheet, plan, report, or external record. |
| **Evidence** | An observed fact supporting or contradicting a claim: a diff, test result, receipt, response, approval, or citation. |

This gives the runtime a usable definition of the future: not a prediction of a single
destiny, but a set of commitments, choices, deadlines, opportunities, and constraints
that can be reasoned about explicitly.

## From query to outcome

A user can initiate work with a direct request:

```text
"Prepare the best launch plan for next week and complete the work I have already approved."
```

The runtime handles it as a controlled loop:

```text
Query
  -> intent and constraint extraction
  -> retrieve current situation, goals, commitments, and authorized memory
  -> generate one or more PlanOptions
  -> choose or ask the user to choose a plan
  -> build a task graph with acceptance criteria and authority requirements
  -> dispatch skills, applications, and agent runtimes
  -> observe artifacts and external effects
  -> verify, deliver a WorkReceipt, and update state
```

The output is not only prose. It can be a repository change, a calendar plan, a drafted
message, a research report, a booking request, a filled form, a completed workflow, or a
clear explanation of why the action should not be taken yet.

## Proactivity: predict opportunities, not permission

The twin should notice useful next steps. For example, it may see an approaching
deadline, an unprepared meeting, a recurring bill, a neglected goal, or free time that
fits a high-value task.

It must turn this into an **OpportunityCard**, not a hidden action:

```text
OpportunityCard
  why now          upcoming customer call in 36 hours
  observed basis   calendar event + open proposal + prior meeting notes
  proposed result  prepare a briefing, agenda, and follow-up draft
  expected value   high
  confidence       medium
  risk             low
  required authority  prepare automatically; send only after approval
```

The planning engine weighs goals, commitments, preferences, time, cost, risk, and
uncertainty. It should present the best *current* options and their trade-offs, not claim
to know the user's objectively best life.

## Autonomy ladder

Autonomy is a policy choice per domain, action, and context.

| Level | Twin behavior | Examples |
| --- | --- | --- |
| **0 — Observe** | Capture and organize only. | Index files, reconcile tasks, detect a deadline. |
| **1 — Suggest** | Explain an opportunity and recommend options. | Propose a weekly plan or flag a conflict. |
| **2 — Prepare** | Create reversible drafts and previews. | Draft an email, create a branch, prepare a booking request. |
| **3 — Execute by standing authority** | Perform explicitly pre-authorized, bounded, reversible actions. | File documents, create approved tasks, run tests, update a private note. |
| **4 — Confirm before commitment** | Stop for approval before a consequential external change. | Send a message, make a purchase, submit a form, publish, delete, or change access. |

Predicted intent may move work from Observe to Suggest or Prepare. It must never move
work into Execute without a matching policy and current authority check.

## Journal, state, and memory

The personal journal records what the runtime observed and decided. It is the durable
recovery backbone, not a raw surveillance archive.

### Current local desktop implementation

The desktop companion already exposes a small, inspectable Memory Center. Evidence-backed
candidates are synchronized into a local curated store; the owner can add a memory, edit it,
archive it, disable recall, or choose the maximum number recalled for a new task. Active items
are lexically matched against a task before planning, injected as bounded context, and recorded
in that task's audit trace with the matched terms. This is deliberately not yet a vector index or
a knowledge graph; those remain later upgrades rather than capabilities the current demo pretends
to have.

```text
JournalEvent
  intent | observation | inference | plan | policy | approval
  action | artifact | verification | memory-candidate | memory-commit

Append-only Personal Journal
  -> Current State Projections
  -> Evidence Index
  -> Memory Candidates
  -> governed promotion to Durable Memory
```

| Store | Purpose | Mutability |
| --- | --- | --- |
| **Journal** | Ordered provenance and lifecycle events. | Append-only. |
| **State projections** | Rebuildable current view of goals, commitments, tasks, and permissions. | Derived. |
| **Durable memory** | Curated information worth carrying into future decisions. | Governed, correctable, expirable, deletable. |
| **Content store** | Encrypted bodies for sensitive or large payloads. | Policy-controlled retention and cryptographic erasure. |

A memory candidate can be proposed by an agent, but only the runtime may promote it after
evidence, policy, scope, conflict, and retention checks. Corrections supersede old items;
forgetting removes or cryptographically erases the sensitive body while retaining a
minimal non-sensitive audit tombstone.

## Trust, privacy, and safety

Personal life data raises the quality bar. clone-ai must make these boundaries explicit:

- Imported mail, webpages, documents, and messages are **data**, never instructions.
- A calendar entry or past habit is not permission to spend money, contact someone, or
  disclose information.
- High-impact domains—money, health, legal matters, relationships, access control,
  deletion, publishing, and external commitments—default to confirmation.
- Every connector has a scoped capability grant, a visible data boundary, and a
  revocation path.
- Users can inspect, correct, export, and delete their data and durable memory.
- A WorkReceipt records the plan, authority, actions, evidence, verification result,
  remaining uncertainty, and rollback path where applicable.

## Runtime adapters and skills

Agent runtimes are execution providers, not the product's brain or source of truth.

```ts
interface RuntimeAdapter {
  readonly id: string;
  readonly providerId: string;
  capabilities(): Promise<RuntimeCapabilities>;
  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent>;
  cancel?(sessionId: string): Promise<void>;
}
```

The runtime connects Claude Code, Codex, Pi, opencode, and future independent runtimes
through one black-box boundary. A **Skill** remains a provider-owned capability; Clone AI
only supplies a bounded prompt and workspace, then judges the result from observable facts.
Provider session memory, tool protocols, and completion prose are not Kernel authority.

The default black-box adapter snapshots the Workspace before and after execution, uses a
hard deadline, and exposes only an environment allowlist. A durable JSON checkpoint lets
the Kernel rerun a clean interruption, reconcile complete observed artifacts, or block when
side effects are ambiguous. Same-Workspace assignments use an exclusive lease so concurrent
workers cannot overwrite one another.

## Implementation architecture

### TypeScript, Node.js, and Python are enough

Yes. The first several product stages should use only these three:

| Technology | Role | Boundary |
| --- | --- | --- |
| **TypeScript (strict)** | Canonical domain contracts, policies, schemas, CLI, connectors, adapters, state projections, and tests. | The language of truth for runtime-owned state and decisions. |
| **Node.js LTS** | Local daemon, process supervision, streaming I/O, CLI, scheduling, connector execution, and agent-runtime adapters. | The always-on local control plane. |
| **Python** | Optional intelligent workers: local ML, multimodal extraction, OCR, forecasting, ranking, evaluation, and experimental retrieval. | It returns versioned proposals and evidence; it does not directly own personal state or permissions. |

Use a current Node.js LTS release for the daemon. At the time of writing, Node.js 24 is
the current LTS line. Use Python 3.13+ with a separate pinned virtual environment for
each worker; adopt Python 3.14 where the required libraries are compatible.

Keep Python behind a small, versioned local protocol—initially NDJSON over standard I/O
is enough. The Node control plane sends a bounded request, receives a `WorkerProposal`,
validates it, journals it, and decides whether to use it. This prevents Python
experiments from becoming an ungoverned second control plane.

Do not add Go, Rust, a distributed queue, or Kubernetes in the first version. Introduce
another systems language only when measurement shows a concrete need for stronger
isolation, native device integration, or a performance-critical component.

### Proposed repository layout

```text
apps/
|-- cli/                         query, inspect, approve, trace, resume
|-- daemon/                      local lifecycle and scheduling process
`-- desktop/                     installed local client, tray, approvals, activity trace

packages/
|-- contracts/                   versioned domain types and schemas
|-- journal/                     append-only events, replay, snapshots
|-- content-store/               encrypted blobs, retention, erasure
|-- twin-state/                  self, goals, commitments, situations
|-- memory/                      candidates, recall, review, audit
|-- planning/                    opportunities, options, task graphs
|-- context/                     scoped context packet compiler
|-- policy/                      authority, privacy, risk, approval, budget
|-- execution/                   scheduling, retries, work receipts
|-- verification/                evidence and acceptance checks
|-- connectors/                  calendar, mail, files, browser, APIs
|-- adapters/
|   |-- claude-code/
|   |-- codex/
|   `-- pi/
|-- observability/               traces, audit, metrics
`-- testkit/                     fake connectors, runtimes, failures

workers/python/
|-- extraction/                  structured and multimodal extraction
|-- ranking/                     opportunity and option scoring
|-- forecasting/                 time and workload predictions
`-- evaluation/                  replay and decision-quality evaluation
```

### Local storage and process model

- **SQLite in WAL mode** holds the journal, projections, policy metadata, and queue.
- **Encrypted local content storage** holds sensitive payloads and large artifacts.
- **OS keychain integration** protects local encryption keys and connector credentials.
- **Node child processes** supervise CLI agents and Python workers with explicit timeout,
  cancellation, and structured streams.
- **Zod** validates all untrusted adapter, connector, and worker input at runtime.
- **Drizzle** provides typed persistence; **Pino** and **OpenTelemetry** provide traceable
  operations; **Vitest** provides deterministic replay and policy tests.

## Roadmap

| Horizon | Focus | Status |
| --- | --- | --- |
| **Now** | Trusted local state and query-to-verified-delivery | Architecture & design |
| **Next** | Personal planning and proactive preparation | Planned |
| **Later** | Bounded delegated autonomy and cross-domain life support | Research |

### Phase 0 — Trusted personal state

Build the local journal, `SelfModel`, goals, commitments, WorkItems, policies, evidence,
memory review, and an inspectable timeline. No autonomous external writes.

**Proof:** restart the daemon, switch agent runtimes, and recover exactly what was
planned, attempted, verified, blocked, or awaiting approval.

### Phase 1 — Query to verified delivery

Start with a developer and knowledge-work wedge. A query can produce research, code,
documents, plans, task updates, and evidence-backed results. The twin connects to local
files, Git, calendar, and a narrow task source.

**Proof:** a user can ask for a non-trivial outcome, interrupt the process, replace an
agent, and return to a verified work receipt without reconstructing context manually.

### Phase 2 — Personal planning and proactive preparation

Add calendar, tasks, mail, recurring obligations, and user-selected life signals.
Generate OpportunityCards, scenario plans, daily briefings, and reversible preparation.

**Proof:** users accept proactive preparation because its timing, rationale, and scope are
useful and understandable.

### Phase 3 — Bounded delegated autonomy

Enable standing authority for narrow, reversible actions. Add policy templates, per-skill
limits, rollback, and continuous evaluation of false positives, stale memory, and failed
verification.

**Proof:** repetitive actions happen safely without reducing the user's awareness or
ability to stop and correct the twin.

### Phase 4 — Cross-domain personal digital twin

Expand from work and planning into carefully chosen life domains. The system evaluates
future options against the user's evolving goals and constraints, while keeping sensitive
actions approval-gated.

**Proof:** the twin improves a person's available options and execution capacity without
quietly narrowing that person's agency.

## First release

The first release should not attempt to automate an entire life. It should establish trust
with a narrow but meaningful loop:

1. Capture a user query plus selected local project and calendar context.
2. Create a durable plan and explicit WorkItems.
3. Use agent runtimes to research, build, test, and produce artifacts.
4. Verify results and show an evidence-backed WorkReceipt.
5. Preserve only reviewed preferences, project facts, and procedures for the next task.

Defer voice cloning, avatars, social simulation, financial execution, health decisions,
relationship automation, broad inbox access, and unconstrained proactive behavior.

## Command-line experience (planned)

```bash
clone-ai init
clone-ai connect calendar
clone-ai ask "prepare my best plan for next week"
clone-ai today
clone-ai opportunity list
clone-ai plan show <plan-id>
clone-ai approve <approval-id>
clone-ai trace <session-or-work-id>
clone-ai memory inspect
clone-ai memory forget <memory-id>
```

The most important command is not `run`. It is the ability to inspect why the twin thinks
something matters, what it is allowed to do, and what evidence proves the outcome.

## Invariants

1. The person is the authority; the twin is a bounded delegate.
2. Observation, inference, permission, action, and verification are separate event types.
3. A prediction is never permission.
4. Personal state, current work, durable memory, and raw history remain distinct.
5. No agent runtime can directly mark work complete or commit memory.
6. Every consequential action has a policy decision, evidence trail, and revocation path.
7. External content is data, never runtime authority.
8. The user can inspect, correct, export, and delete personal state and memory.
9. Connected runtimes are replaceable; clone-ai's personal state and governance are not.

---

> **clone-ai is not an AI that imitates a person. It is a personal digital twin that
> helps a person see, decide, and safely accomplish more over time.**
