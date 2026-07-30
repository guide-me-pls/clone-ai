# Work Orders and the first Pi adapter

This slice turns child-agent delegation from a role name into a bounded,
verifiable execution contract. It also connects the first real external agent
runtime: Pi, through its JSONL RPC mode.

## What is implemented

A `SubagentWorkOrder` now carries:

- objective and human-readable acceptance criteria;
- declared inputs, including evidence-producing dependencies;
- required capabilities used by the dispatcher;
- required artifact contracts;
- work-order risk and execution budgets;
- automatic retries only for non-external work; external or irreversible work
  must use `maxAttempts=1`;
- an acyclic dependency graph;
- an optional preferred agent id.

The planner may propose this object, but the Runtime validates it before it is
persisted. Invalid references, duplicate identifiers, empty contracts, invalid
budgets, and indirect cycles are rejected before any agent starts.

`DemoPlanner` remains the deterministic fallback. An opt-in LLM Planner is now
implemented: it may only return a structured `create_work_plan` proposal, which
is validated before any worker is dispatched. See [LLM Planner](llm-planner.md)
and [Query execution flow](query-execution-flow.md) for the authoritative path.

## Execution flow

```text
Plan
  -> validate WorkOrder graph
  -> find ready WorkOrders
  -> select adapter by required capabilities
  -> start or resume a persisted agent session
  -> normalize messages and tool activity
  -> collect artifact evidence
  -> verify the WorkOrder artifact contract
  -> unlock dependent WorkOrders
  -> verify the parent Run
```

Independent work orders execute in the same wave. A dependent work order only
becomes ready after every dependency has both completed and passed its
work-order verification.

## Why Pi uses RPC

Pi provides both an in-process TypeScript SDK and a subprocess JSONL RPC mode.
clone-ai uses RPC for the first adapter because process isolation is a useful
runtime boundary:

- a Pi crash does not crash the Supervisor;
- stdin/stdout contains a structured protocol, not scraped terminal text;
- `--session-id` reopens the exact persisted Pi conversation;
- `abort` provides cooperative cancellation;
- `agent_settled` distinguishes true completion from a low-level turn that may
  still retry or compact.

The adapter disables project extensions, skills, prompt templates, themes,
context files, and all built-in tools. Pi's built-in file tools accept absolute
paths, so `cwd` alone is not a security boundary. The first binding is therefore
limited to tool-free direct reasoning and evidence review over context injected
by the Supervisor. Research, file edits, shell commands, and external effects
must later call back into clone-ai's workspace-bounded Tool Runtime.

The child process receives a minimal environment instead of inheriting every
Runtime variable. Platform variables and only the selected provider's
credential variables are forwarded; additional names require explicit adapter
configuration.

## Event normalization

Pi RPC events become Runtime events:

```text
Pi agent_start          -> progress
Pi message_update       -> message_delta
Pi tool_execution_start -> tool_started
Pi tool_execution_end   -> tool_completed
Pi agent_settled        -> evidence + completed
```

The Runtime journals the Pi session id, coarse progress, tool lifecycle, and
redacted completion evidence. Model deltas remain transient because they may
echo file contents or personal data. Common secret-shaped values are redacted
before durable summaries enter the journal.

## Resume and cancellation

The Pi session id is deterministic for a Run, plan step, and WorkOrder. When a
running subagent is replayed from the journal, the Supervisor invokes
`adapter.resume(sessionId, assignment)`. Pi reopens that session and receives a
resume prompt that tells it to preserve valid progress and avoid repeating
completed side effects.

`CloneRuntime.cancel()` forwards cancellation to every active adapter session,
records the child cancellation, and then moves the parent Run to `cancelled`.

## Important current boundary

The adapter and transport are tested without real credentials using:

- pure RPC event fakes;
- a real child-process JSONL fixture;
- session resume and cancellation tests.

The local Pi binary is detected separately. A paid/provider-backed live task is
not run by the automated suite, so provider authentication and a real model
response still require a manual smoke test.

The working directory is explicit. For the desktop/sidecar path, set
`CLONE_AI_WORKSPACE` to the directory represented by the current task. Pi is a
supervised local child process, not an OS-level sandbox; hardened isolation is a
later milestone.

To run that live check deliberately:

```powershell
$env:CLONE_AI_WORKSPACE = (Get-Location).Path
# Optional: set CLONE_AI_PI_PROVIDER and CLONE_AI_PI_MODEL.
npm run pi:smoke -- "Review the current WorkOrder contract"
```

This command can consume model-provider quota. It sends one tool-free review
WorkOrder through the real Supervisor and prints the resulting evidence.

## Code map

```text
src/core/contracts.ts
  WorkOrder, artifacts, budgets, normalized events

src/agents/dispatcher.ts
  capability-based adapter selection

src/core/runtime.ts
  DAG waves, resume, cancellation, work-order verification

src/adapters/pi-agent-adapter.ts
  Pi JSONL RPC process, event translation, budgets

src/adapters/configured-agent-registry.ts
  local role/provider settings -> concrete adapters

src/pi-smoke.ts
  opt-in live WorkOrder -> Pi verification

test/work-order.test.ts
test/pi-agent-adapter.test.ts
  validation, routing, RPC, resume, cancellation
```
