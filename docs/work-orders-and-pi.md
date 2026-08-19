# Work Orders and black-box workers

**English** · [简体中文](work-orders-and-pi.zh-CN.md)

This page keeps the historical filename, but the execution boundary has
changed. Pi is no longer a special RPC adapter. Pi, Claude Code, Codex, and
opencode all enter through the same black-box Worker boundary.

## WorkOrder contract

A `SubagentWorkOrder` declares:

- objective, inputs, and acceptance criteria;
- required capabilities and an optional routing hint;
- expected artifacts;
- risk class and execution budget;
- dependency edges and retry limit.

The Main Agent or planner may propose this object. The Kernel validates the
DAG, risk, budgets, artifact contract, capabilities, and approval requirements
before anything is dispatched. A Worker cannot modify the WorkOrder or close
the parent Run.

## One boundary for every provider

```text
WorkOrder
  -> Kernel policy / capability / approval
  -> one-time prompt + scoped memory + workspace
  -> BlackBoxWorkerAdapter
       allowlisted environment · timeout · termination
       snapshot before -> child process -> snapshot after
  <- exit status + workspace diff + redacted output tail
  -> observed artifacts -> verification -> Run projection
```

The adapter does not parse a provider's event protocol, session database, or
completion marker. It only observes process behavior and the Workspace. A
zero exit is not completion; a required artifact that was not written is a
`no_artifact` failure. A receipt cannot originate from worker-controlled text.

## Pi is just a launch recipe

The built-in recipe is stored in `src/adapters/providers.json` and can be
replaced by `<dataDirectory>/providers.json`:

```json
{
  "providers": [
    {
      "id": "pi",
      "command": "pi",
      "args": ["-p", "{{prompt}}"],
      "env": ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
    }
  ]
}
```

The environment list contains names only. Clone AI never stores credential
values in source, fixtures, or provider declarations. `{{prompt}}` and
`{{workspace}}` are substituted at launch; `promptVia: "stdin"` avoids putting
the prompt in the process argument list.

Pi's own session or `--resume` option is not required. Every dispatch is a
fresh black-box session, and the Kernel rebuilds context from its Journal,
Memory Store, WorkOrder, and Workspace evidence.

## Recovery after a crash

The supervisor persists a Workspace checkpoint before the first attempt. If a
process dies or the supervisor restarts while a WorkOrder is running, the
Kernel compares that checkpoint with the current Workspace:

- no change -> rerun in a new session;
- enough added/modified required artifacts -> reconcile the observed artifacts
  and avoid repeating the work;
- deletion, unexpected write, incomplete artifact, or missing checkpoint ->
  emit a structured recovery failure and wait for owner intervention.

Recovery is therefore an external arbitration decision, not a request for the
black-box Agent to remember where it was. Provider-specific resume support can
be an optimization, never the source of truth.

## Workspace concurrency

Ready WorkOrders may be planned together, but execution against one Workspace
uses an exclusive lease. This prevents two coding agents from concurrently
modifying the same project and also prevents a reader from observing a write
halfway through. The lease is process-local queueing plus an atomic lock file;
a dead supervisor's lock can be reclaimed using its owner PID.

## Failure JSON

Failures use stable categories such as `launch_failed`, `timeout`,
`missing_credential`, `missing_input`, `network`, `partial_side_effect`,
`unexpected_side_effect`, and `recovery_blocked`. The report includes a
normalized signature and redacted detail. Independent providers failing with
the same diagnostic category corroborate a task/environment obstacle, so the
Kernel stops spending attempts on it.

## Code map

```text
src/core/contracts.ts
  WorkOrder, RuntimeAdapter, normalized events, failure/recovery payloads

src/core/runtime.ts
  policy, DAG waves, workspace recovery arbitration, verification

src/core/workspace-evidence.ts
  snapshots, diffs, durable JSON checkpoints

src/core/workspace-lock.ts
  exclusive Workspace lease and stale-owner recovery

src/adapters/black-box-worker.ts
  process boundary, budgets, environment allowlist, observed evidence

src/adapters/providers.json
  built-in launch recipes

src/adapters/built-in-providers.ts
  JSON loading, user overrides, registry definitions
```

The important invariant is not that a provider reports success. It is that the
Kernel can reconstruct what happened without trusting the provider's memory or
conversation.
