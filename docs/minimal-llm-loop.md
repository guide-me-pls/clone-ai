# Minimal LLM loop

**English** · [简体中文](minimal-llm-loop.zh-CN.md)

This is the first deliberately small, real Agent Loop in clone-ai. It is a learning
vertical slice, not yet the production Supervisor Runtime.

```text
user goal
  -> durable run event
  -> OpenAI Responses model chooses a tool
  -> local tool executes inside the workspace boundary
  -> tool result returns to the model
  -> model final answer
  -> response check + durable completion event
```

The implementation lives in `src/loop/`. It is intentionally isolated from the
existing Supervisor scaffold until both have a stable shared task and event contract.
That keeps the new real loop from being hidden behind the older deterministic demo
adapters.

## What is real now

- A real OpenAI Responses API adapter, implemented with native `fetch` and no SDK
  dependency.
- Native function tools: `list_files` and `read_file`, scoped to the current workspace.
- Tool selection by the model, tool-result feedback, repeated model turns, and a final
  answer.
- An append-only JSONL trace at `.clone-ai/llm-loop.jsonl` for every model, tool, and
  completion event.
- A mocked `write_file` tool. It returns a proposed-write receipt but never mutates the
  filesystem.
- Checkpoint + replay recovery. A restarted run executes pending safe reads and then
  continues the model from its persisted Responses protocol history.
- A Tool Runtime with stable operation IDs, cooperative timeout/cancellation, risk policy,
  approval routing, receipt generation, and conservative reconciliation after interruption.
- Verification outcomes that can pass, retry, request replanning, request approval, or fail.
- Run budgets for model calls, tool calls, verification retries, and elapsed duration.

## What is deliberately not in this loop yet

- Personal memory, subagents, schedules, connectors, and external side effects.
- Domain-specific verification. The first verifier only rejects an empty final answer.
- A live email, calendar, payment, or browser connector. Such a Tool must implement its
  own external receipt lookup in `reconcile` before it can be safely retried after a crash.
- Provider-reported token/currency budgets. The current budget is deterministic: elapsed
  time, model calls, tool calls, and verification retries.
- The production Claude Code, Codex, Pi, and opencode black-box Worker boundary. This
  direct model/tool loop remains an isolated learning vertical slice, not its protocol.

## Run it

Install dependencies once:

```powershell
npm install --ignore-scripts
npm run typecheck
npm test
```

Set an OpenAI API key in the PowerShell window you will use. Do not put it in a source
file or commit it:

```powershell
$env:OPENAI_API_KEY = "your-key"
$env:CLONE_AI_OPENAI_MODEL = "gpt-5" # optional; this is the default
npm run loop -- "Read README.md and explain the current Clone AI runtime in five bullets."
```

The request is sent to the configured remote model. The adapter sets `store: false` and
keeps its conversation transcript in local process memory, but this is still a remote
model call: use a non-sensitive repository while learning the loop.

The trace can be inspected directly:

```powershell
Get-Content .clone-ai/llm-loop.jsonl
```

## Read the code in this order

1. `src/loop/contracts.ts` — the model, tool, result, and event boundaries.
2. `src/loop/tools.ts` — actual workspace-scoped reads and the mocked write boundary.
3. `src/loop/agent-loop.ts` — the turn-by-turn state machine and durable event order.
4. `src/loop/run-state.ts` — Event Projector: events become a recoverable next action.
5. `src/loop/checkpoint.ts` and `src/loop/recovery.ts` — atomic checkpoint writes and
   replay of events newer than a checkpoint.
6. `src/loop/openai-responses-model.ts` — model function calls and local transcript
   replay.
7. `test/agent-loop.test.ts` — deterministic proof of the loop, state machine, and API adapter
   payload, without an API key.

## State machine and checkpoints

The journal is an append-only source of truth. The checkpoint is a materialized view of
the next safe action, with a `lastAppliedSequence` marker:

```text
Event Log                     Checkpoint
---------                     ----------
model.completed(tool call) -> status = waiting_tools
                              pendingToolCalls = [read_file(...)]
                              lastAppliedSequence = 4
```

The first checkpointable state machine is:

```text
created -> waiting_model -> running_model
                            |                \
                            | tool calls       \ final answer
                            v                   v
                       waiting_tools         verifying
                            -> running_tool       -> completed / failed
                            -> waiting_model
```

After each durable event, the loop projects its `LoopRunState` and atomically replaces
`<run-id>.json`. On restart, `restoreLoopRun` loads that checkpoint and applies only
events with a higher sequence. The OpenAI adapter snapshots its API protocol history after
each model response; a new adapter can use that continuation to finish the next model turn.

The recovery runner follows the state rather than rerunning a task from the beginning:

```text
waiting_tools -> execute the pending Tool
waiting_model -> recreate the model adapter from its continuation and call it
running_tool -> reconcile the stable operation ID before any retry
verifying    -> continue verification
```

Read-only tools reconcile as `not_started` and are safe to rerun. A side-effecting Tool
without a reconciliation handler fails safely rather than being replayed blindly.

## Tool control and convergence

Every Tool call has an `operationId` that survives recovery. Before external execution,
the local policy allows reads and reversible local writes, requests approval for external
side effects, and denies irreversible operations until a more specific policy exists.

Verification is a routing decision, not a boolean:

```text
passed         -> completed
retryable      -> return verification feedback to the model
needs_replan   -> return replanning feedback to the model
needs_approval -> waiting_approval
failed         -> failed
```

The loop also has deterministic safety budgets. A caller can cap model calls, tool calls,
verification retries, and elapsed duration; the runtime records a terminal failure when a
budget is exhausted rather than looping indefinitely.

## 中文说明

这是 clone-ai 第一条刻意保持很小、但真正可运行的 Agent Loop。它目前是一个学习用的垂直切片，
还没有并入生产级 Supervisor Runtime。

链路是：用户目标 → 持久化事件 → 模型选择 Tool → Tool 在本地工作区边界内执行 → 结果回传模型
→ 最终答案 → 基础验证与完成事件。

现在真实具备的是：OpenAI Responses 调用、模型原生 Function Tool 选择、真实的
`list_files`/`read_file`、Tool 回传、多轮循环、以及 `.clone-ai/llm-loop.jsonl` 的可回放轨迹。
`write_file` 故意只是 Mock，不会写入任何文件。

目前故意没有接入：Memory、SubAgent、Schedule、外部连接器、真实写操作的服务端回执查询、领域级验证、
Provider 返回的 Token/成本预算。Runtime 已经能从 Checkpoint 和 Event Replay 恢复，跨进程继续 OpenAI
Provider 协议历史，并安全恢复只读 Tool；先把这条最小闭环跑稳，再把它接入上层 Runtime。

在 PowerShell 中设置 `OPENAI_API_KEY` 后运行：

```powershell
$env:OPENAI_API_KEY = "your-key"
npm run loop -- "读取 README.md，用五条说明当前 Runtime。"
```

这会调用远程模型。适配层请求 `store: false`，对话历史保存在本机进程内；但请求内容仍会发送给模型
提供方，所以学习阶段请只在不含个人敏感信息的仓库中运行。
