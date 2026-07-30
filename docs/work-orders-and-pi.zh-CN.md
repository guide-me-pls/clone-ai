# WorkOrder 与第一版 Pi Adapter

这一阶段把“交给一个子 Agent”从角色名称升级成一份有边界、可验证的执行合同，并接入第一个真实的
外部 Agent Runtime：通过 JSONL RPC 运行的 Pi。

## 已经实现什么

`SubagentWorkOrder` 现在包含：

- 明确目标和人能读懂的验收条件；
- 输入声明，以及输入来自哪个前置 WorkOrder；
- Dispatcher 用于选择 Agent 的能力要求；
- 必须交付的 Artifact 合同；
- WorkOrder 自身的风险和执行预算；
- 只有非外部任务可以自动重试；外部或不可逆任务必须使用 `maxAttempts=1`；
- 无环依赖图；
- 可选的首选 Agent，但不能绕过能力检查。

Planner 可以提出 WorkOrder，但 Runtime 会在保存前校验。依赖不存在、ID 重复、合同为空、预算非法、
间接循环等问题都会在任何 Agent 启动前被拒绝。

`DemoPlanner` 仍然是确定性的回退策略。现在已经实现了显式开启的 LLM Planner：它只能返回结构化的
`create_work_plan` 提案，任何 Worker 被派发前都会先经过校验。完整链路见
[LLM Planner](llm-planner.zh-CN.md) 与 [Query 执行流程](query-execution-flow.zh-CN.md)。

## 执行链路

```text
Plan
  → 校验 WorkOrder 图
  → 找出依赖已满足的 WorkOrder
  → 根据 requiredCapabilities 选择 Adapter
  → 启动或恢复持久化 Agent Session
  → 统一消息和 Tool 事件
  → 收集 Artifact Evidence
  → 验证 WorkOrder 产物合同
  → 解锁后续 WorkOrder
  → 验证父 Run
```

互不依赖的 WorkOrder 会在同一批次并行执行。某个依赖任务只有在前置 WorkOrder “执行完成并通过工作单
验证”后才能开始，不能只相信 Agent 自己说完成。

## 为什么 Pi 使用 RPC

Pi 同时提供进程内 TypeScript SDK 和子进程 JSONL RPC。第一版选择 RPC，是因为进程隔离更符合
clone-ai 的 Runtime 边界：

- Pi 崩溃不会带崩 Supervisor；
- stdin/stdout 是结构化协议，不需要解析终端文本；
- `--session-id` 可以重新打开同一个 Pi 会话；
- `abort` 支持协作式取消；
- `agent_settled` 能区分真正结束与后面还会自动重试或压缩的普通回合结束。

Adapter 会关闭项目扩展、Skill、Prompt Template、主题、项目上下文文件以及全部内建 Tool。Pi
内建文件 Tool 接受绝对路径，因此只设置 `cwd` 不能形成真正的安全边界。第一版 Pi 只负责无 Tool 的
直接推理与证据复核，输入由 Supervisor 注入。调研、文件修改、Shell 和外部动作以后必须回到
clone-ai 自己受 Workspace 约束的 Tool Runtime。

Pi 子进程不会继承 Runtime 的全部环境变量。它只接收系统运行所需变量，以及当前所选 Provider 的
凭据变量；其他环境变量必须在 Adapter 中显式加入白名单。

## 事件如何统一

```text
Pi agent_start          → progress
Pi message_update       → message_delta
Pi tool_execution_start → tool_started
Pi tool_execution_end   → tool_completed
Pi agent_settled        → evidence + completed
```

Runtime 会持久化 Pi Session ID、粗粒度进度、Tool 生命周期和脱敏后的完成证据。模型消息增量可能
回显文件内容或个人数据，因此只作为瞬时事件，不写入不可变 Journal。常见的 key、token、secret、
password 等内容会在持久化摘要前脱敏。

## Resume 与 Cancel

Pi Session ID 由 Run、PlanStep 和 WorkOrder 稳定生成。Journal 重放后，如果发现某个子 Agent 仍为
`running`，Supervisor 会调用 `adapter.resume(sessionId, assignment)`。Pi 打开原会话，并收到明确的
恢复指令：复用有效进度，不重复已经完成的副作用。

`CloneRuntime.cancel()` 会把取消传给活跃 Pi Session，记录子 Agent 取消事件，最后把父 Run 变成
`cancelled`。

## 当前仍然存在的边界

Pi Adapter 已通过下面三类无凭据测试：

- 纯内存 RPC 事件测试；
- 真实子进程 JSONL 通信测试；
- Session Resume 与 Cancel 测试。

自动测试不会调用付费模型，因此 Provider 登录、真实模型响应和真实 Coding 任务仍需要一次人工冒烟
测试。当前“合同与 Adapter 已接通”，不等于“所有 Pi Provider 配置都已经验证”。

工作目录必须明确。桌面/Sidecar 运行时可通过 `CLONE_AI_WORKSPACE` 指向当前任务对应的目录。Pi 是受
Supervisor 管理的本地子进程，并不是操作系统级 Sandbox；更强隔离属于后续里程碑。

需要主动验证真实 Provider 时，可以手动执行：

```powershell
$env:CLONE_AI_WORKSPACE = (Get-Location).Path
# 可选：设置 CLONE_AI_PI_PROVIDER 和 CLONE_AI_PI_MODEL。
npm run pi:smoke -- "复核当前 WorkOrder 合同"
```

这个命令可能消耗模型 Provider 配额。它会把一份无 Tool 的 Review WorkOrder 送入真实 Supervisor，
最后打印 Pi 返回并通过 Runtime 记录的 Evidence。

## 代码位置

```text
src/core/contracts.ts
  WorkOrder、Artifact、Budget、统一事件

src/agents/dispatcher.ts
  按能力选择 Adapter

src/core/runtime.ts
  DAG 批次、Resume、Cancel、WorkOrder 验证

src/adapters/pi-agent-adapter.ts
  Pi JSONL RPC、事件转换、预算约束

src/adapters/configured-agent-registry.ts
  本地角色/Provider 设置 → 真实 Adapter

src/pi-smoke.ts
  手动触发真实 WorkOrder → Pi 验证

test/work-order.test.ts
test/pi-agent-adapter.test.ts
  合同校验、能力路由、RPC、恢复和取消
```
