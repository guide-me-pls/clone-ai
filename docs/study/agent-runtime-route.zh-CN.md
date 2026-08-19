# Agent Runtime 路线：Kernel 持状态，Worker 是黑盒

> 这是一份代码演化学习记录，不是 Agent 工作日志。
> 记录重点是：为什么把执行 Agent 设计成无状态黑盒，以及 Kernel 如何在黑盒之外保留权威。

## 1. 当前架构结论

```text
用户 / Main Agent
        │ 只能提出意图、计划和审批请求
        ▼
Kernel（唯一权威）
  Journal · Policy · Approval · Verification · Memory
  Run 状态 · 重试 · 恢复裁决 · 完成判定
        │ 只发送一次性 WorkOrder + 受治理上下文
        ▼
BlackBox Worker
  Claude Code · Codex · Pi · opencode · 未来 Agent
  每次都是新的无头进程；内部 session、记忆、协议都不属于 Clone AI
```

这里的“无状态”不是说 Agent 本身不能使用系统提示词、Skill 或 MCP，而是说这些能力不
成为 Clone AI 的事实来源。Worker 只在一次 WorkOrder 内工作；项目上下文、长期记忆、
任务进度和完成判定都留在 Kernel。

Main Agent 可以是持久的对话大脑，但它也没有权威：它只能调用提案型 Kernel 工具，不能
审批、派发、伪造 Evidence 或宣布 Run 完成。

## 2. 黑盒边界

Clone AI 对 Worker 只依赖四类可观察事实：

1. 进程是否成功启动；
2. 进程是否在预算和硬截止内退出；
3. Workspace 前后实际发生了哪些文件变化；
4. 受限的输出尾部，用于诊断而不是证明完成。

不解析 stdout 协议、不读取供应商 session、不依赖供应商的 resume、不接受“我完成了”作为
证据。需要产物时，新增或修改的文件才是 Artifact；只说话、不落盘就是 `no_artifact`。
Receipt 仍然不能由黑盒 Worker 自报。

```text
WorkOrder
  -> Policy / capability / approval
  -> prompt + workspace + owner-approved memory packet
  -> BlackBoxWorkerAdapter
       budget · hard deadline · termination · environment allowlist
       workspace snapshot(before) -> process -> snapshot(after)
  <- exit status + diff + redacted output tail
  -> observed Evidence -> verification -> Run state
```

## 3. 记忆只归 Kernel

供应商自己的历史不是项目记忆。Kernel 从本地 Memory Store 召回有作用域的条目，写入
`memory.recalled`，再把摘要作为背景事实注入本次 Prompt。Worker 不获得整个记忆库，也不
获得修改 Kernel 状态的工具。

```text
Memory Store --recall(objective)--> Kernel
                                      │ memory.recalled
                                      ▼
                           一次性 Prompt + facts
                                      ▼
                         任意 Provider 的新 session
```

切换 Claude Code、Codex、Pi 或新 Agent 时，不需要把供应商 session 迁移到另一个供应商；
只需要让新 Provider 接受同一份 WorkOrder 和记忆包。

## 4. JSON 是诊断边界，不是完成捷径

错误应该是可枚举、可比较、可由用户编辑或 MCP 读取的 JSON 数据。当前错误类别包括：

- `launch_failed`
- `timeout`
- `aborted`
- `nonzero_exit`
- `no_artifact`
- `missing_credential`
- `missing_input`
- `permission_denied`
- `network`
- `partial_side_effect`
- `unexpected_side_effect`
- `recovery_blocked`
- `unknown`

每个失败还带有 `providerId`、`agentId`、`signature` 和脱敏的 `detail`。`signature` 会去掉
路径、ID、数字和时间戳，用于比较两个不同 Agent 是否撞上同一堵墙。所有者可以编辑
`<dataDirectory>/outcomes/failures.json`，用 JSON 增加匹配模式和处理建议；它只影响诊断，不会
授予权限。两个独立 Provider 报告同一诊断类别时，Kernel 停止盲目重试并把问题升级给所有者。

成功不是 Worker 返回的 JSON，而是 Workspace 观察结果与 Kernel 的验证结果。以后可以增加
用户可编辑的结论 JSON；它只能作为输入事实，不能替代文件证据和验证器。

## 5. 三个缺口的处理规则

### 5.1 黑盒崩溃恢复：重建，不续接

黑盒没有可依赖的 session ID。恢复不要求 Worker 自己恢复，而是由 Kernel 根据 Journal 和
Workspace 检查点决定：

```text
Journal: WorkOrder 正在 running
  + durable workspace checkpoint（派发前文件 hash）
  + 当前 Workspace snapshot
  = side-effect arbitration
```

裁决规则：

- 没有文件变化：安全地用新的 session 重跑；
- 只有新增/修改文件，且足以满足必需 Artifact 合同：记录观察到的 Artifact，重建完成状态，
  不再重复执行；
- 出现删除、只读任务发生写入、产物不完整或检查点缺失：不自动重跑，写入
  `recovery_blocked` / `partial_side_effect`，等待所有者处理；
- 外部动作不能因为文件变化而被推断成功，仍需可信 Receipt 或人工审批。

因此 Claude Code 的 `--resume` 不是架构依赖。它可以在某个 Provider 内部存在，但 Kernel 的
权威恢复路径必须在供应商 session 消失后仍然成立。

### 5.2 Workspace 写互斥

同一 Workspace 的写类 WorkOrder 使用独占 Workspace lease；读类任务不能与写类任务同时
运行。当前实现宁可保守地把同一 Workspace 的派发串行化，也不让两个 Agent 互相覆盖文件。
lease 在进程内排队，并使用 Workspace 下的原子锁文件处理同一项目的其他 Supervisor 进程；
持有者崩溃后可依据 PID 清理陈旧锁。

### 5.3 Provider 配方 JSON 化

Provider 不再由 Runtime 分支识别。内建默认配方位于 `src/adapters/providers.json`，用户可以在
`<dataDirectory>/providers.json` 覆盖内建项或增加新 Agent：

```json
{
  "providers": [
    {
      "id": "my-agent",
      "label": "My Agent",
      "command": "my-agent",
      "args": ["run", "{{prompt}}"],
      "promptVia": "arg",
      "env": ["MY_AGENT_HOME"],
      "timeoutMs": 900000
    }
  ]
}
```

`env` 只列出允许透传的变量名，仓库和配置模板不携带 token 或 API key 值。接入一个新 Agent
变成配置问题；Kernel、WorkOrder、记忆和验证器都不需要知道它来自哪家公司。

## 6. 文档和代码的边界

- `pi-source-notes.zh-CN.md` 仍然有效：它记录 Pi 的 loop、session 和 extension 机制，属于
  客观源码知识；但这些机制不是 Worker 黑盒边界的依赖。
- 旧的 Pi RPC / stdout 事件解析路线不再是当前架构；Pi 只是一个可替换 Provider。
- `BlackBoxWorkerAdapter` 是统一监督边界；Provider 配置只负责启动命令、参数和环境白名单。
- Journal 是事实来源，Workspace checkpoint 是可重建的派生缓存；用户可查看 JSON，但不能靠
  修改 Worker 输出绕过 Kernel 的授权和验证。

## 7. 学习方法

1. 先写“崩溃、超时、只说不做、部分产物、并发写入”的测试，再改实现；
2. 把 Worker 的话与 Kernel 接受的事实分开记录；
3. 每个可审计事实都记录其输入（授权、记忆 ID、Workspace checkpoint）；
4. Provider 只通过配置接入，任何新 Agent 都必须经过同一黑盒边界；
5. 不能证明安全恢复时，宁可阻塞并交给所有者，不要自动重跑可能产生副作用的任务。
