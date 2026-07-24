# Knotwork

> **一个面向异构 AI Agent 的持久化编排运行时。**
>
> **一个 Supervisor，任意 Agent，让工作最终收敛。**

[English](README.md) · **中文**

---

Knotwork 将 Hermes、Claude Code、Codex、Pi，以及未来的自定义 Agent 编结为一个能够真正完成工作的系统：任务有边界、执行可追踪、失败可恢复、交接附带证据、结果能够验证。

它不是一个“同时启动多个 Agent”的工具。

它是让多个 Agent 协作，并最终交付结果的运行时。

```text
Knotwork Runtime
├── Supervisor           负责决策、派发和收敛
├── Workers              通过可插拔 Agent Adapter 执行工作
├── Work Orders          定义有边界、可问责的工作单元
├── Threads              跨回合保留 Session 连续性
├── Artifact Contracts   规定交付物必须包含的内容
├── Evidence             记录结果为何可信
└── Convergence Engine   验证、重试、升级或完成
```

## 问题

今天的编码 Agent 已经能够调研、规划、编辑、测试和调用工具，但多 Agent 协作仍然会以一些熟悉的方式失败：

- 一个 Agent 输出了一段说明文字，下一个 Agent 却需要明确的产物。
- 进程退出、Session 丢失，Supervisor 无法可靠恢复工作。
- Agent 声称“完成”，但结果没有经过验证。
- 虽然留有日志，却无法重建决策、失败和交接过程。
- 不同 CLI 的生命周期、事件流、能力模型和取消方式彼此不同。

启动多个 Agent 很容易；让异构工作在中断后仍能恢复，并收敛到可检查的结果，才是难题。

## Knotwork 模型

Knotwork 在 Supervisor 与任意数量的 Worker 之间提供一个小而明确的控制平面。

```text
用户意图
    │
    ▼
Supervisor ── 创建 ──► Work Orders
    │                       │
    │ 派发                  ▼
    ├──────────────────► Agent Adapters ──► Hermes / Claude Code / Codex / Pi
    │                                             │
    │                                      事件 + 产物
    ▼                                             │
Convergence Engine ◄──── 证据 + 验证 ────────────┘
    │
    ├── 通过             → 完成
    ├── 可重试           → 重新规划或重试
    ├── 需要审批         → 等待人工介入
    └── 不可恢复         → 带持久化 Trace 的失败
```

运行时负责工作的完整生命周期；Agent 只负责它被分配到的那一段工作。

## 核心原则

1. **Agent 中立。** 每种集成都是统一生命周期协议后的 Adapter，而不是 Fork 某个供应商的运行时。
2. **产物优先于断言。** Worker 返回结构化结果、产物、证据和验证结论，而不是只用一段文字宣称成功。
3. **事件是事实来源。** 所有重要状态转换都追加为事件，因此运行崩溃后可以重放。
4. **失败是一等状态。** 超时、取消、部分完成、依赖阻塞和验证失败都有明确的恢复或升级路径。
5. **收敛才是产品。** 并行执行只有在推动工作走向可验证结果时才有价值。

## 概念表

| 概念 | 含义 |
| --- | --- |
| **Run** | 用户目标的一次可持久化执行。 |
| **Work Order** | 有输入、验收标准和责任归属的受限工作单元。 |
| **Supervisor** | 负责规划、派发、审阅与下一步决策的策略层。 |
| **Worker** | 正在执行 Work Order 的具体 Agent Session。 |
| **Thread** | Knotwork 与 Agent Session 之间可恢复的连续性记录。 |
| **Artifact** | 可交付的具体输出，例如补丁、文档、数据集、报告、命令结果或 URL。 |
| **Evidence** | 支撑结果的事实，例如测试输出、diff、Trace、引用或审批。 |
| **Contract** | 让产物可被下一个 Worker 使用的 Schema 与验收规则。 |
| **Convergence** | 对工作已通过、需重试、需人工介入或无法继续的最终判断。 |

## 运行时协议

所有供应商特有的实现都通过一个统一的 Adapter 接口规范化：

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

Adapter 将 SDK、JSONL 流、子进程和 CLI Session 转换为统一的事件语言：

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

这样 Codex Worker 可以交接给 Claude Code；调研 Worker 也可以交接给编码 Worker，而交接不会退化为无结构的聊天上下文。

## 持久化状态机

Knotwork 使用事件驱动的持久化状态机，而不是只依赖内存中的编排状态。

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

每次状态转换都会写入不可变的事件：

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

运行时重启后，会重放事件流，在可能时重新连接可恢复 Thread，并报告需要人工介入的工作。因此暂停、恢复、取消、重试和事后复盘都是产品能力，而不是尽力而为的行为。

## v0.1 范围

**包含：**

- Hermes Supervisor Adapter。
- Claude Code 与 Codex Worker Adapter。
- Work Order 与 Worker Result 协议。
- 基于 SQLite 的追加式事件存储。
- Supervisor 驱动的任务拆分与有边界的并行执行。
- 超时、显式取消和策略驱动的重试。
- Artifact 与 Evidence 验证钩子。
- 查看 Run、Work Order 与事件 Trace 的 CLI。

**暂不包含：**

- 向量记忆或长期记忆系统。
- 预设 Agent 市场。
- 无边界的 Swarm 拓扑。
- 分布式队列、Redis 或多节点协调。
- 完整 Web 控制台。
- Agent 人格或社交模拟。

第一版只验证一个务实的问题：用户能否启动一项非平凡任务，中断后恢复它，检查其证据，并在多个 Agent Runtime 之间得到经过验证的结果？

## 建议架构

第一版采用 TypeScript 控制平面。Node.js 适合监督 CLI 子进程与流式事件；TypeScript 则为跨供应商协议提供统一、类型安全的语言。

```text
packages/
├── core/                Run 状态、调度器、协议、收敛策略
├── storage/             SQLite 事件存储与投影
├── adapters/
│   ├── hermes/
│   ├── claude-code/
│   ├── codex/
│   └── custom/
├── cli/                 初始化、Agent 管理、执行、追踪、恢复、取消
└── testkit/             Fake Agent、事件 Fixture、故障注入
```

建议的技术基础：

- **TypeScript strict + Node.js：** 可移植运行时与类型安全协议。
- **pnpm workspace：** 清晰划分 core、adapter、CLI 与测试工具。
- **SQLite WAL：** 无运维依赖、可本地检查的持久化。
- **Drizzle + Zod：** 类型化持久层与 Adapter 边界上的运行时校验。
- **Pino + OpenTelemetry：** 跨 Run、Worker 和工具的结构化日志及 Trace 关联。
- **Vitest：** 确定性的 Fake Agent、事件重放与故障注入测试。
- **Git Worktree，必要时配合容器：** 在引入更重的沙箱之前，为编码任务提供隔离。

Knotwork 可以在 MCP 提供稳定集成边界时使用它；但 MCP 不是运行时的事实来源。工作生命周期、产物和收敛始终属于 Knotwork 自己的协议。

## CLI 形态

```bash
knotwork init
knotwork agent add codex
knotwork agent add claude
knotwork run "调研并实现这个需求"
knotwork trace <run-id>
knotwork resume <run-id>
knotwork cancel <run-id>
```

`trace` 必须能回答：请求是什么、谁完成了工作、产出了什么、哪些内容被验证、哪里失败，以及为什么 Run 处于当前状态。

## 一个执行示例

```text
$ knotwork run "为 API 添加限流，并证明它可用"

Run rw_01J... 已创建
  Supervisor: hermes
  Work order 1: 检查现有 API 边界                 → codex
  Work order 2: 调研兼容的限流策略                → claude-code

两个 Worker 都返回产物与证据。
  Supervisor 创建 work order 3：实现已确认的改动  → codex
  验证步骤运行测试，并检查最终 diff。

Run rw_01J... 已完成
  3 个 work order · 2 个 agent runtime · 5 个 artifact · 4 条 verification record
```

若 Worker 在修改代码后失败，Run 不会消失。Knotwork 会保留部分产物和失败事件，然后恢复 Thread、重新分配 Work Order、请求人工审批，或带着可检查的原因终止。

## Knotwork 不是什么

- 不是多个模型 API 的 Prompt 包装器。
- 不是只展示 Agent 日志的仪表盘。
- 不是要求每个 Worker 重写的 Agent 框架。
- 不是 Git、CI 或 Agent 自身工具运行时的替代品。
- 不是“Agent 越多结果越好”的承诺。

它是一个持久化协调层：给独立 Agent 分配可问责的工作，提供统一交接语言，并让工作走向可验证的结束状态。

---

> **Knotwork 是让 Agent 协作并完成工作的运行时。**

*状态：实现前设计。本文的协议是有意确定的起点，尚不是稳定的公开 API。*
