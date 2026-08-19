# Agent Runtime Convergence / Agent Runtime 收敛方案

## Outcome / 目标

Clone AI has two different loops and they must not be mixed:

Clone AI 存在两种不同的 Loop，必须明确分层：

```text
Main reasoning loop (Pi Agent Core)
  -> understands the request and calls kernel tools

Durable task loop (Clone AI)
  -> selects a black-box Worker
  -> injects bounded memory context
  -> starts a fresh Worker session
  -> verifies the workspace
  -> reaches a terminal task state
```

Pi Agent Core may power Main's reasoning. Pi CLI, Claude Code, Codex, and
OpenCode are black-box Workers. Using Pi inside Main must never imply that Pi
is the default Worker.

Pi Agent Core 可以作为 Main 的推理引擎；Pi CLI、Claude Code、Codex、
OpenCode 都属于黑盒 Worker。Main 使用 Pi 不代表任务默认派发给 Pi。

## Non-negotiable invariants / 不变量

1. Explicit user selection wins over rules, memory, and descriptions.
2. An unavailable explicitly requested Worker produces `blocked`; it must not
   silently fall back to another Worker.
3. Main owns long-term memory. Workers receive only a bounded `MemoryContext`.
4. Every Worker invocation uses `sessionPolicy: "fresh"`.
5. Pi invocations use `--no-session` and never use `--continue`, `--resume`, or
   `--session`.
6. A `DispatchDecision` is persisted before spawning the Worker.
7. A task finishes only through objective verification, not because the Worker
   claims it is finished.

中文：

1. 用户明确指定 Agent 时，优先级高于规则、Memory 和描述匹配。
2. 指定 Agent 不可用时必须进入 `blocked`，不能静默切换到其他 Agent。
3. 长期记忆归 Main 管理，Worker 只能收到有限的 `MemoryContext`。
4. 每次 Worker 调用都必须是 `sessionPolicy: "fresh"`。
5. Pi 必须使用 `--no-session`，不能使用续聊参数。
6. 启动 Worker 前必须持久化 `DispatchDecision`。
7. 只有客观验证通过才算任务完成。

## Target ownership / 目标目录职责

```text
src/
  main-agent/
    dispatch-contracts.ts       # shared dispatch boundary (implemented)
    intent-classifier.ts        # natural language -> TaskIntent
    memory-context-builder.ts   # retrieval + bounded summary
    agent-router.ts             # deterministic selection
    dispatch-recorder.ts        # persist decision before execution
    query.ts
    session.ts
    tools/

  task-runtime/
    task-run.ts
    task-attempt.ts
    run-task-until-terminal.ts
    terminal-state.ts
    task-store.ts

  workers/
    black-box-worker.ts
    process-supervisor.ts
    worker-registry.ts
    worker-config.ts
    fresh-session-policy.ts

  memory/
    memory-store.ts
    memory-retriever.ts
    memory-summarizer.ts
    memory-pipeline.ts

  core/
    policy/
    evidence/
    journal/
    workspace/

  application/
    run-main-query.ts
    approve-run.ts

  interfaces/
    http/
    cli/
```

Existing files should move only after routing tests pass. Until then, imports
must remain stable and new behavior should depend on `dispatch-contracts.ts`.

只有路由测试通过后才移动已有文件。在此之前保持 import 稳定，新模块统一依赖
`dispatch-contracts.ts`。

## Missing modules / 缺失模块

### P0 - Prove Main dispatch / 证明 Main 真正派发

- `intent-classifier.ts`
  - Extract task kind, required capabilities, explicit Worker, and exclusions.
- `memory-context-builder.ts`
  - Retrieve relevant memory, reject instruction-like memory, and produce a
    bounded summary with source IDs.
- `agent-router.ts`
  - Priority: explicit selection -> exclusion -> capability rules -> memory
    outcomes -> descriptions. No default Worker.
- `dispatch-recorder.ts`
  - Append an immutable routing record before process launch.
- `worker-registry.ts`
  - Resolve exactly one logical Worker ID to one provider configuration.
- `fresh-session-policy.ts`
  - Reject continuation flags and guarantee a new process/session per attempt.

### P1 - Run one real task to terminal / 单任务收敛

- `run-task-until-terminal.ts`
  - Own the loop until `succeeded`, `failed`, `blocked`, or `cancelled`.
- `task-attempt.ts`
  - Persist Worker identity, invocation ID, exit information, output paths, and
    verification result.
- `terminal-state.ts`
  - Centralize legal state transitions and prevent infinite retry loops.
- `task-store.ts`
  - Atomic persistence and restart hydration.

### P2 - Production hardening / 正式化

- Memory scoring by task kind and historical Worker outcomes.
- Prompt budget and context compaction.
- Heartbeat, inactivity timeout, and process-tree termination.
- Restart recovery from the last verified attempt.
- Provider failover policies with explicit audit records.
- GUI views for intent, memory evidence, dispatch decision, and task attempts.

## Required tests / 必须通过的测试

```text
explicit Pi request
  -> selectedAgentId = pi-agent
  -> route source = explicit
  -> no other Worker starts

explicit unavailable Codex request
  -> blocked / REQUESTED_AGENT_UNAVAILABLE
  -> Pi does not start

implicit TypeScript task + relevant Pi success memory
  -> selectedAgentId = pi-agent
  -> route source = memory
  -> usedMemoryIds contains the outcome memory

two Pi dispatches
  -> two invocation IDs and processes
  -> both use --no-session
  -> second prompt contains no prior Pi transcript
  -> only Main-generated MemoryContext crosses the boundary
```

The first tests use fake Workers and deterministic memory. A real local Pi test
is an opt-in integration test after the deterministic suite passes.

第一层测试必须使用假 Worker 和确定性 Memory；全部通过后，再运行本地 Pi 的
可选集成测试。

## Migration notes / 迁移说明

- `src/agents` should converge to `src/workers`; these objects execute tasks and
  are not the Main Agent.
- `src/loop` should converge to `src/task-runtime`; “loop” is too ambiguous and
  conflicts with the Pi reasoning loop.
- Provider configuration stores belong under `src/config`, not under Worker
  adapters.
- Workflow/application entry points must receive a runtime assembly; they must
  not construct independent journals, memory stores, or runtimes.
- `scripts/run-pi-task.mjs` is a vertical-slice experiment. After its behavior is
  covered by tests, move the generic behavior into `black-box-worker.ts` and
  keep scripts as thin CLI entry points only.

