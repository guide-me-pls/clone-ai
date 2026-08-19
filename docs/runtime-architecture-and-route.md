# Runtime architecture and learning route

**English** · [简体中文](runtime-architecture-and-route.zh-CN.md)

This page describes the current execution boundary and the route for learning
from the code. The product vision is broader; the runtime's job is narrower:
keep authority, memory, evidence, and recovery outside replaceable agents.

## The planes

```text
Owner / Main Agent
  intent · proposals · corrections · approval requests
                 |
                 v
Kernel
  Journal · Policy · Approval · Memory · Verification
  Run state · retry · recovery arbitration · completion decision
                 |
                 v
Black-box workers
  Claude Code · Codex · Pi · opencode · future providers
```

The Main Agent may be persistent and conversational. A worker is not. A worker
gets a fresh process for a WorkOrder and may use its own system prompt, Skills,
and MCPs, but its provider session is never the Clone AI memory store.

## The black-box boundary

```text
WorkOrder
  -> policy / capability / approval
  -> scoped prompt + memory packet + workspace
  -> BlackBoxWorkerAdapter
       environment allowlist · budget · deadline · termination
       snapshot(before) -> child process -> snapshot(after)
  <- exit status + workspace diff + redacted output tail
  -> observed evidence -> verification -> Run projection
```

No provider protocol, session database, or completion marker is parsed. A zero
exit is only a process fact. If a required artifact was not added or modified
in the Workspace, the WorkOrder is not complete. Receipts need a trusted source
and cannot be minted by worker output.

## Memory is Kernel-owned

The Kernel recalls a scoped packet from the local Memory Store, journals the
selected item ids, and injects summaries as background facts. The packet is
rebuilt for every fresh worker session. Switching providers therefore does not
require migrating provider-owned memory.

```text
Memory Store -> Kernel recall -> memory.recalled -> one-time prompt
                                             -> any provider
```

Workers may propose memory candidates, but only the Kernel's pipeline can
promote them.

## Recovery is external arbitration

A provider's `--resume` is optional and never authoritative. The Kernel persists
a durable JSON Workspace checkpoint before the first attempt and uses the
Journal plus a fresh Workspace snapshot after an interruption:

| Observation | Decision |
| --- | --- |
| No changes | Rerun in a new worker session |
| Enough added/modified required artifacts | Reconcile observed artifacts; do not rerun |
| Deletion, read-only write, incomplete artifact, or missing checkpoint | Block and escalate to the owner |

This makes recovery independent of Claude Code, Codex, Pi, or opencode's
internal session model. A missing checkpoint is a safety failure, not permission
to blindly rerun.

## Workspace concurrency

A Workspace receives an exclusive lease while a WorkOrder is executing. This
is intentionally conservative: it serializes reads with writes as well as
writes with writes, preventing an observer from seeing a half-written project.
The lease uses an in-process queue and an atomic lock file, with PID-based stale
owner recovery after a supervisor crash.

## Provider configuration

Provider launch recipes are data. Built-in defaults live in
`src/adapters/providers.json`; `<dataDirectory>/providers.json` can add or
override them. A recipe contains a command, argument template, prompt transport,
timeout, capabilities, and names of environment variables to allow through.
It never contains credential values. The registry and Kernel do not branch on
vendor names.

## Structured JSON diagnostics

Failures are stable JSON-shaped reports with a coarse category, normalized
signature, provider/agent identity, and redacted detail. The owner can edit
`<dataDirectory>/outcomes/failures.json` to add error patterns and guidance;
that file changes diagnostics, not authority. Categories distinguish launch,
timeout, authentication, input, network, artifact, unexpected-side-effect,
and recovery failures. Independent providers failing with the same diagnostic
category corroborate a task/environment obstacle; catch-all failures need
overlapping signatures before they stop retries.

## Route

The old route treated Pi RPC, CLI event translation, and Provider SDK sessions
as execution features. Those mechanisms are useful implementation knowledge,
but they are not the architecture boundary anymore. The current route is:

| Step | Goal | Proof |
| --- | --- | --- |
| A1 | Kernel state, policy, verification, and Journal | replay and invariant tests |
| A2 | One black-box process boundary | exit, deadline, environment, artifact tests |
| A3 | Durable interruption arbitration | checkpoint, partial-output, and recovery tests |
| A4 | Workspace concurrency safety | competing assignment test and stale-lock test |
| A5 | Provider configuration seam | JSON built-ins, user override, third-party provider test |
| B | Main Agent proposal surface | agent tools can propose but not approve or complete |
| C | Personal state plane | owner-governed goals, commitments, situations, and memory |

## What is intentionally not promised

- A worker session is not resumed by default.
- A worker's prose is not evidence of completion.
- A provider declaration does not grant authority or contain a secret.
- A crash with unknown Workspace side effects is not automatically retried.
- Opencode is an optional launch recipe, not a required dependency.

For the detailed WorkOrder contract see [Work Orders and black-box workers](work-orders-and-pi.md).
For the provider boundary see [Black-box agent boundary](coding-cli-adapters.md).
