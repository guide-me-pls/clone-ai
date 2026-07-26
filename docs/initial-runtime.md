# Initial Runtime

This is the first runnable slice of `clone-ai`. It is a local control plane
for a personal digital twin, not a chatbot and not a hosted web product. It
does not call an LLM yet. Instead, it establishes the supervision boundary
that future Codex, Claude Code, Pi, and custom agents must obey.

```text
Desktop shell
  -> local Clone AI daemon
      -> trigger -> Task + durable Run -> plan
      -> policy gate -> child-agent work orders -> evidence
      -> independent verification -> memory candidate
```

## What works now

| Capability | Current behavior |
| --- | --- |
| Trigger ingress | Accepts `query`, `schedule`, `signal`, and `manual` triggers. |
| Task and Run | Creates a durable `Task` and `Run`; neither is an agent session. |
| Event journal | Appends inspectable JSONL events and rebuilds runtime state by replay. SQLite is the planned production replacement. |
| Policy gate | Allows local and reversible work by default; pauses external and irreversible work for exact approval. |
| Child-agent work orders | A plan step can dispatch bounded child work orders in parallel waves, then release dependent review work only after prerequisites return evidence. |
| Supervision | Child agents cannot change parent status, bypass policy, commit memory, or close a Run. They can only stream progress, evidence, failure, and an explicit local completion signal. |
| Durable recovery | Child-agent dispatch, progress, evidence, completion, and failure are journaled. A resumed Run skips work orders that already completed with evidence. |
| Verification | The Runtime independently checks that every planned step has observable evidence before it completes a Run. |
| Memory pipeline | A verified Run requests memory extraction asynchronously. The worker proposes candidates; it cannot write durable personal memory directly. |

## The executable demo

Requires Node.js 24 or later.

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run demo
```

The demo demonstrates this sequence:

1. A supervisor creates three child work orders: research and drafting run in
   parallel; review waits for both.
2. Each child returns evidence. The supervisor records the lifecycle but does
   not accept an agent's self-report as final completion.
3. The parent Run pauses before a simulated external side effect.
4. After the exact approval is granted, the external operator runs, the
   Runtime verifies all evidence, and a memory candidate is queued.

The local journal defaults to `.clone-ai/journal.jsonl`. Set
`CLONE_AI_DATA_DIR` to use another local directory.

## Desktop client

`clone-ai` is being shaped as an installed desktop companion, not a website.
The repository now includes an early Windows Tauri shell: it starts the Node.js
Runtime as a supervised local sidecar, waits for its dynamic loopback address,
and opens the work surface in a native window. The runtime remains a local daemon;
it is not moved into the UI process.

Run `npm run desktop:build` to create the directly runnable executable at
`apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/clone-ai-desktop.exe`.
The installer, tray behavior, notifications, and native approval UX remain later work.
The static interface in `apps/desktop/ui/` is also available through
`npm run companion:debug` for developer browser inspection only; it binds to
`127.0.0.1` and is not a public or hosted service.

```text
apps/desktop/                 installed client boundary (Tauri target)
  ui/                         temporary desktop WebView assets

src/
  core/                       journal, policy, supervisor, verification
  adapters/                   replaceable agent adapters and demo registry
  memory/                     asynchronous memory-candidate pipeline
  companion-server.ts         local development preview only
  demo-workflow.ts            parent plan with subagent work orders
  cli.ts                      developer demo and trace surface
```

## Runtime invariants

1. The Runtime, not an agent, owns Task and Run status.
2. A child work order is not a Task and has no independent authority.
3. Every child output is evidence or a claim, never an accepted result by
   itself.
4. An external action cannot pass the default policy without exact approval.
5. A Run becomes `completed` only after verification passes.
6. Memory extraction remains separate from task completion and cannot write
   durable personal memory directly.
7. Replaying the Journal rebuilds completed work orders and Runs after restart.

## Not implemented yet

- Live Codex, Claude Code, or Pi adapters.
- Planner and context compiler that turn natural language and device signals
  into a plan.
- SQLite WAL, encryption, snapshots, compaction, and durable-memory review.
- Cancellation propagation, retries, budgets, worktrees, and sandboxes.
- The packaged Tauri shell, tray, notifications, native approval dialogs, and
  automatic daemon lifecycle.
- Opportunity detection and a governed personal world model.

The next milestone is a real coding-agent adapter with checkpoint/resume,
followed by the installed desktop shell around this same local Runtime.
