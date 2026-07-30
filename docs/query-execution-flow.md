# Query execution flow

**English** · [简体中文](query-execution-flow.zh-CN.md)

This page describes the **current runnable path**, not the final product
vision. Read it from top to bottom: the Supervisor owns the process; planners
and worker agents have intentionally narrower authority.

![Query execution flow](assets/query-execution-flow.svg)

## The actual path, step by step

### 1. A trigger enters the Runtime

`startDemoWorkflow()` accepts a `query`, `schedule`, `signal`, or `manual`
trigger. The Runtime creates a durable `Trigger`, `Task`, and `Run`, writes
their events to the JSONL journal, and moves the Run to `planning`.

**Authority:** only the Runtime can create or change the parent Run status.

### 2. Relevant local memory is recalled

`LocalMemoryStore` ranks active, user-governed memories against the incoming
query. The selected summaries are recorded as a `memory.recalled` event and
are given to the Planner as context.

Memory can help the Planner understand preference or history. It cannot grant
permission, change policy, or silently cause an external action.

### 3. The Planner proposes a bounded plan

The default is the deterministic `buildDemoPlan()` policy so that demos stay
repeatable and do not make paid model calls. If `CLONE_AI_PLANNER=openai` and
`OPENAI_API_KEY` are set, `LlmWorkPlanner` instead asks an OpenAI Responses
model for one strict `create_work_plan` function call.

The proposal contains `PlanStep`s and, when appropriate, child
`SubagentWorkOrder`s. A WorkOrder states its objective, required capabilities,
inputs, expected evidence/artifacts, acceptance criteria, risk, budget, and
dependencies.

The Planner **proposes data only**. It cannot execute a tool, write memory,
grant approval, or mark the Run as complete.

### 4. Clone AI validates and persists the plan

`LlmWorkPlanner` rejects malformed model proposals before they reach workers:
unknown agents or capabilities, invalid risks, missing artifact contracts,
bad dependencies, and unsafe retry budgets fail validation. One correction
attempt is allowed; a second invalid answer fails closed.

`CloneRuntime.attachPlan()` performs the authoritative Runtime validation,
persists `plan.created`, and moves the Run to `queued`.

### 5. Policy decides whether execution may start

Before every plan step, `DefaultPolicyEngine` decides whether it is allowed or
needs explicit approval. `external_side_effect` and `irreversible` work pauses
at `waiting_approval`; planning a risky action is not permission to run it.

### 6. The Supervisor routes and dispatches Workers

`CapabilityDispatcher` checks that the selected adapter has every capability
required by the WorkOrder. Independent WorkOrders run in parallel waves;
dependent WorkOrders receive only verified evidence from their predecessors.

Today Pi is the first real, tool-free JSONL adapter. Configured Codex and
Claude Code entries still use deterministic demo adapters, so they are not
yet real execution integrations.

### 7. Workers return events and evidence

A worker may stream progress, session information, tool events, evidence,
completion, or failure. The Runtime writes normalized events to the journal.
A worker's `completed` message is a claim, not final success.

### 8. Verification decides the Run outcome

The Runtime first verifies each WorkOrder's artifact contract. Then
`EvidenceVerifier` checks that every plan step has observable evidence and
that risky work has a durable receipt locator. Only a passing verifier moves a
Run to `completed`.

The verifier is intentionally an initial layer: it checks evidence contracts,
not yet the contents of a file, a real test suite, or a third-party connector
state. Those are the next production verifiers.

### 9. A completed Run proposes memory asynchronously

Completion queues a memory-extraction request. The worker creates proposed
candidates with evidence provenance; it never writes personal memory directly.
The desktop companion can synchronize candidates into the inspectable local
memory store, where the owner can edit or archive them.

## State machine

```text
created -> planning -> queued -> running -> verifying -> completed
                              |              |
                              |              -> failed
                              -> waiting_approval -> running

Any active state can become cancelled when cancellation is requested.
```

## What is complete versus what is still a boundary

| Area | Current status |
| --- | --- |
| Durable journal, Task/Run state, WorkOrders, dependency waves, policy gate | Implemented and tested |
| Memory recall and asynchronous candidates | Implemented; keyword ranking, not semantic retrieval |
| Opt-in LLM Planner with strict structured output and repair | Implemented and unit tested; no live API call is made by default |
| Pi supervised, tool-free adapter | Implemented |
| Codex and Claude Code real adapters | Not implemented yet; their current configured adapters are demos |
| Evidence verification | Initial contract/receipt verification; real artifact and connector verification remains next |
| World model, proactive life signals, external tool runtime | Planned, not implemented |

## Code reading order

1. [`src/demo-workflow.ts`](../src/demo-workflow.ts) — the end-to-end entry point.
2. [`src/planning/llm-planner.ts`](../src/planning/llm-planner.ts) — proposal and validation boundary.
3. [`src/core/runtime.ts`](../src/core/runtime.ts) — the Supervisor and state transitions.
4. [`src/agents/dispatcher.ts`](../src/agents/dispatcher.ts) — capability-safe routing.
5. [`src/core/verification.ts`](../src/core/verification.ts) — the current completion gate.
