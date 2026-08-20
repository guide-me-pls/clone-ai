# Agent Runtime 收敛方案

[English](agent-runtime-convergence.md) · **简体中文**

## 目标

Clone AI 存在两种不同的 Loop，必须明确分层：

```text
主推理 Loop（Pi Agent Core）
  -> 理解请求并调用 Kernel 工具

持久任务 Loop（Clone AI）
  -> 选择黑盒 Worker
  -> 注入有边界的记忆上下文
  -> 启动全新的 Worker 会话
  -> 验证工作区
  -> 到达终态任务状态
```

Pi Agent Core 可以作为 Main 的推理引擎；Pi CLI、Claude Code、Codex、
OpenCode 都属于黑盒 Worker。Main 使用 Pi 不代表任务默认派发给 Pi。

## 不变量

1. 用户明确指定 Agent 时，优先级高于规则、Memory 和描述匹配。
2. 指定 Agent 不可用时必须进入 `blocked`，不能静默切换到其他 Agent。
3. 长期记忆归 Main 管理，Worker 只能收到有限的 `MemoryContext`。
4. 每次 Worker 调用都必须是 `sessionPolicy: "fresh"`。
5. Pi 必须使用 `--no-session`，不能使用续聊参数。
6. 启动 Worker 前必须持久化 `DispatchDecision`。
7. 只有客观验证通过才算任务完成，不能因为 Worker 声称完成就算完成。

## 目标目录职责

```text
src/
  main-agent/
    dispatch-contracts.ts       # 共享派发边界（已实现）
    intent-classifier.ts        # 自然语言 -> TaskIntent
    memory-context-builder.ts   # 检索 + 有界摘要
    agent-router.ts             # 确定性选择
    dispatch-recorder.ts        # 执行前持久化决策
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

只有路由测试通过后才移动已有文件。在此之前保持 import 稳定，新模块统一依赖
`dispatch-contracts.ts`。

## 缺失模块

### P0 - 证明 Main 真正派发

- `intent-classifier.ts`：提取任务类型、所需能力、显式 Worker 与排除项。
- `memory-context-builder.ts`：检索相关记忆、拒绝指令型记忆、产出带来源 ID 的有界摘要。
- `agent-router.ts`：优先级为显式指定 -> 排除 -> 能力规则 -> 记忆结果 -> 描述；无默认 Worker。
- `dispatch-recorder.ts`：进程启动前持久化路由记录。
- `worker-registry.ts`：把逻辑 Worker ID 精确解析到一份 Provider 配置。
- `fresh-session-policy.ts`：拒绝续跑标志，保证每次尝试都是新进程/新会话。

### P1 - 单任务收敛到终态

- `run-task-until-terminal.ts`：持有循环直到 `succeeded` / `failed` / `blocked` / `cancelled`。
- `task-attempt.ts`：持久化 Worker 身份、调用 ID、退出信息、输出路径与验证结果。
- `terminal-state.ts`：集中合法状态转移，防止无限重试。
- `task-store.ts`：原子持久化与重启恢复。

### P2 - 正式化加固

- 按任务类型与历史 Worker 结果做记忆评分。
- Prompt 预算与上下文压缩。
- 心跳、空闲超时与进程树终止。
- 从最后一次已验证的尝试做重启恢复。
- 带显式审计记录的 Provider 故障转移策略。
- 为意图、记忆证据、派发决策与任务尝试提供 GUI 视图。

## 必须通过的测试

```text
显式请求 Pi
  -> selectedAgentId = pi-agent
  -> route source = explicit
  -> 没有其他 Worker 启动

显式请求不可用的 Codex
  -> blocked / REQUESTED_AGENT_UNAVAILABLE
  -> Pi 不启动

隐式 TypeScript 任务 + 相关 Pi 成功记忆
  -> selectedAgentId = pi-agent
  -> route source = memory
  -> usedMemoryIds 包含该结果记忆

两次 Pi 派发
  -> 两个调用 ID 与进程
  -> 都使用 --no-session
  -> 第二个 Prompt 不含第一个 Pi 的对话记录
  -> 只有 Main 生成的 MemoryContext 越过边界
```

第一层测试必须使用假 Worker 和确定性 Memory；全部通过后，再运行本地 Pi 的
可选集成测试。

## 迁移说明

- `src/agents` 应向 `src/workers` 收敛；这些对象执行任务，不是 Main Agent。
- `src/loop` 应向 `src/task-runtime` 收敛；"loop" 太含糊，与 Pi 推理循环冲突。
- Provider 配置存储属于 `src/config`，不属于 Worker Adapter。
- Workflow/Application 入口必须接收 Runtime 组装；不得各自构造独立的 Journal、
  Memory Store 或 Runtime。
- `scripts/run-pi-task.mjs` 是垂直切片实验；行为被测试覆盖后，把通用行为移入
  `black-box-worker.ts`，脚本只保留为薄 CLI 入口。
