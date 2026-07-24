# Knotwork

> **A durable runtime for heterogeneous AI agents.**
> **一个面向异构 AI Agent 的持久化编排运行时。**
>
> **One supervisor. Any agent. Work that converges.**
> **一个 Supervisor，任意 Agent，让工作最终收敛。**

**English** · [中文](README.zh-CN.md)

---

## English

Knotwork coordinates Hermes, Claude Code, Codex, Pi, and future custom agents into a system that can finish work: tasks are bounded, execution is traceable, failures are recoverable, handoffs carry evidence, and results are verified.

It is not a tool for launching several agents at once.

It is a runtime for making them work together—and finish.

```text
Knotwork Runtime
├── Supervisor           decides, delegates, and converges
├── Workers              execute through pluggable agent adapters
├── Work Orders          define bounded, accountable units of work
├── Threads              preserve session continuity across turns
├── Artifact Contracts   define what a deliverable must contain
├── Evidence             records why a result can be trusted
└── Convergence Engine   verifies, retries, escalates, or completes
```

### The problem

Current coding agents can research, plan, edit, test, and use tools. Multi-agent work still fails in familiar ways:

- One agent produces prose while the next needs a concrete artifact.
- A process exits, a session is lost, and the supervisor cannot reliably resume it.
- Work is “done” because an agent says so, rather than because its result was verified.
- Logs exist, but the decisions, failures, and handoffs behind a result cannot be reconstructed.
- Each CLI has a different lifecycle, event stream, capability model, and cancellation behavior.

Launching multiple agents is easy. Making heterogeneous work survive interruption and converge on an inspectable outcome is the hard part.

### The Knotwork model

Knotwork introduces a small, explicit control plane between a supervisor and any number of workers.

```text
User intent
    │
    ▼
Supervisor ── creates ──► Work Orders
    │                          │
    │ delegates                ▼
    ├────────────────────► Agent Adapters ──► Hermes / Claude Code / Codex / Pi
    │                                                │
    │                                         events + artifacts
    ▼                                                │
Convergence Engine ◄──── evidence + verification ────┘
    │
    ├── passed          → complete
    ├── retryable       → replan or retry
    ├── needs approval  → wait for a human
    └── unrecoverable   → fail with a durable trace
```

The runtime owns the work lifecycle. An agent owns only the work assigned to it.

### Principles

1. **Agent-neutral by design.** Integrations are adapters behind one lifecycle contract, rather than forks of a provider runtime.
2. **Artifacts over assertions.** A worker returns structured results, artifacts, evidence, and verification outcomes—not only a paragraph claiming success.
3. **Events are the source of truth.** Meaningful state transitions are append-only events, so a run can be replayed after a crash.
4. **Failure is first-class.** Timeout, cancellation, partial work, blocked dependencies, and failed verification all have explicit recovery or escalation paths.
5. **Convergence is the product.** Parallel work is valuable only when it reaches a verifiable result.

### Vocabulary

| Concept | Meaning |
| --- | --- |
| **Run** | One durable execution of a user objective. |
| **Work Order** | A bounded unit of work with inputs, acceptance criteria, and an owner. |
| **Supervisor** | The policy layer that plans, dispatches, reviews, and decides what happens next. |
| **Worker** | A concrete agent session executing a work order. |
| **Thread** | A resumable continuity record between Knotwork and an agent session. |
| **Artifact** | A tangible output: patch, document, dataset, report, command result, or URL. |
| **Evidence** | Facts supporting a result: test output, diff, trace, citation, or approval. |
| **Contract** | The schema and acceptance rules that make an artifact usable by the next worker. |
| **Convergence** | The decision that work has passed verification, needs another attempt, needs a human, or cannot continue. |

### Runtime contracts

Every provider-specific implementation is normalized behind one adapter interface:

```ts
interface AgentAdapter {
  readonly id: string;

  capabilities(): Promise<AgentCapabilities>;

  start(
    order: WorkOrder,
    context: RunContext,
  ): AsyncIterable<AgentEvent>;

  resume(
    sessionId: string,
    message: string,
  ): AsyncIterable<AgentEvent>;

  cancel(sessionId: string): Promise<void>;
}
```

Adapters translate SDKs, JSONL streams, subprocesses, and CLI sessions into one event vocabulary:

```ts
type AgentEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; tool: string; input: unknown }
  | { type: "tool.completed"; tool: string; output: unknown }
  | { type: "artifact.created"; artifact: Artifact }
  | { type: "worker.blocked"; reason: string }
  | { type: "worker.completed"; result: WorkerResult }
  | { type: "worker.failed"; error: AgentFailure };

interface WorkerResult {
  status: "completed" | "partial" | "blocked";
  summary: string;
  artifacts: Artifact[];
  evidence: Evidence[];
  verification: VerificationResult[];
  suggestedNextActions: string[];
}
```

This lets a Codex worker hand off to Claude Code—or a research worker hand off to a coding worker—without reducing the handoff to unstructured chat.

### Durable state machine

Knotwork uses an event-driven persistent state machine instead of in-memory orchestration alone.

```text
CREATED
  → PLANNING
  → DISPATCHING
  → RUNNING
  → VERIFYING
      ├─ PASSED          → COMPLETED
      ├─ RETRYABLE       → REPLANNING
      ├─ NEEDS_HUMAN     → WAITING_APPROVAL
      └─ UNRECOVERABLE   → FAILED
```

Every transition is stored as an immutable event:

```text
run_events
├── event_id
├── run_id
├── work_order_id
├── agent_id
├── event_type
├── payload
├── sequence
└── created_at
```

After restart, the runtime replays its event stream, reconnects resumable threads where possible, and surfaces any work requiring intervention. Pause, resume, cancellation, retry, and postmortem inspection become product capabilities instead of best-effort behavior.

### v0.1 scope

**Included**

- Hermes supervisor adapter.
- Claude Code and Codex worker adapters.
- Work Order and Worker Result contracts.
- SQLite-backed append-only event storage.
- Supervisor-driven task decomposition with bounded parallel execution.
- Timeouts, explicit cancellation, and policy-driven retry.
- Artifact and evidence verification hooks.
- CLI views for runs, work orders, and event traces.

**Deferred**

- Vector or long-term memory systems.
- A marketplace of preset agents.
- Unbounded swarm topologies.
- Distributed queues, Redis, or multi-node coordination.
- A full web control plane.
- Agent personas or social simulation.

The first question is deliberately practical: can a user start a non-trivial task, interrupt it, resume it, inspect its evidence, and reach a verified outcome across multiple agent runtimes?

### Proposed architecture

The first implementation is a TypeScript control plane. Node.js is a strong fit for supervising CLI subprocesses and streaming events; TypeScript gives cross-provider contracts one type-safe language.

```text
packages/
├── core/                run state, scheduler, contracts, convergence policies
├── storage/             SQLite event store and projections
├── adapters/
│   ├── hermes/
│   ├── claude-code/
│   ├── codex/
│   └── custom/
├── cli/                 init, agent management, run, trace, resume, cancel
└── testkit/             fake agents, event fixtures, failure injection
```

Suggested foundations:

- **TypeScript (strict) + Node.js:** portable runtime and type-safe protocol.
- **pnpm workspaces:** clear boundaries between core, adapters, CLI, and test tools.
- **SQLite in WAL mode:** local-first and inspectable durability without operating dependencies.
- **Drizzle + Zod:** typed persistence and runtime validation at adapter boundaries.
- **Pino + OpenTelemetry:** structured logging and trace correlation across runs, workers, and tools.
- **Vitest:** deterministic fake agents, event replay, and failure-injection tests.
- **Git worktrees, with optional containers:** isolation for coding work before heavier sandboxing is justified.

Knotwork may use the current Model Context Protocol where it offers a stable integration boundary. MCP is not the runtime’s source of truth: work lifecycle, artifacts, and convergence remain Knotwork contracts.

### CLI shape

```bash
knotwork init
knotwork agent add codex
knotwork agent add claude
knotwork run "research and implement this requirement"
knotwork trace <run-id>
knotwork resume <run-id>
knotwork cancel <run-id>
```

A trace must answer: what was requested, who worked on it, what they produced, what was verified, what failed, and why the run is in its current state.

### Example run

```text
$ knotwork run "Add rate limiting to the API and prove it works"

Run rw_01J... created
  Supervisor: hermes
  Work order 1: inspect existing API boundaries          → codex
  Work order 2: research a compatible rate-limit strategy → claude-code

Both workers return artifacts and evidence.
  Supervisor creates work order 3: implement the agreed change → codex
  Verification runs tests and inspects the resulting diff.

Run rw_01J... completed
  3 work orders · 2 agent runtimes · 5 artifacts · 4 verification records
```

If a worker fails after editing code, the run does not disappear. Knotwork retains its partial artifacts and failure event, then resumes the thread, reassigns the work order, asks for approval, or terminates with an inspectable reason.

### What Knotwork is not

- Not a prompt wrapper around several model APIs.
- Not a dashboard that only displays agent logs.
- Not an agent framework requiring each worker to be rewritten.
- Not a replacement for Git, CI, or an agent’s own tool runtime.
- Not a promise that more agents automatically produce better work.

It is the durable coordination layer that gives independent agents accountable work, a common handoff language, and a route to a verifiable ending.

---

> **Knotwork is the runtime that makes agents work together and finish.**

*Status: pre-implementation design. The contracts in this document are intentional starting points, not yet a stable public API.*
