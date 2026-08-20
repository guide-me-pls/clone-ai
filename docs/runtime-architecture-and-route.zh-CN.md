# Runtime 架构与学习路线

[English](runtime-architecture-and-route.md) · **简体中文**

这份文档描述当前的执行边界与代码学习路线。产品愿景可以更大，但 Runtime 的职责更窄：把
权威、记忆、证据和恢复放在可替换 Agent 之外。

## 各平面

```text
所有者 / Main Agent
  意图 · 提案 · 纠正 · 审批请求
                 │
                 ▼
Kernel
  Journal · Policy · Approval · Memory · Verification
  Run 状态 · 重试 · 恢复裁决 · 完成判定
                 │
                 ▼
黑盒 Worker
  Claude Code · Codex · Pi · opencode · 未来 Provider
```

Main Agent 可以是持久的对话 Agent，但 Worker 不是。Worker 为一个 WorkOrder 启动一个全新的
进程，可以使用自己的系统提示词、Skill 和 MCP，但 Provider Session 永远不是 Clone AI 的记忆库。

## 黑盒边界

```text
WorkOrder
  -> 策略 / 能力 / 审批
  -> 有作用域 Prompt + 记忆包 + Workspace
  -> BlackBoxCliWorker
       环境白名单 · 预算 · 硬截止 · 终止
       执行前快照 -> 子进程 -> 执行后快照
  <- 退出状态 + Workspace 差异 + 脱敏输出尾部
  -> 观察型 Evidence -> 验证 -> Run 投影
```

不解析 Provider 协议、Session 数据库或完成标记。退出码为 0 只是进程事实；如果合同要求的
Artifact 没有在 Workspace 中新增或修改，WorkOrder 就没有完成。Receipt 必须有可信来源，
不能由 Worker 输出铸造。

## 记忆归 Kernel

Kernel 从本地 Memory Store 召回有作用域的记忆包，记录选中的条目 ID，再把摘要作为背景事实
注入一次性 Prompt。每次启动新的 Worker Session 都重新编译，因此切换 Provider 不需要迁移
供应商记忆。

```text
Memory Store -> Kernel recall -> memory.recalled -> 一次性 Prompt
                                             -> 任意 Provider
```

Worker 可以提出记忆候选，但只有 Kernel 的 Pipeline 可以提升它们。

## 恢复是外部裁决

Provider 的 `--resume` 是可选优化，绝不是权威。Kernel 在第一次尝试前保存持久 JSON Workspace
检查点；中断后结合 Journal 与新的 Workspace 快照作出裁决：

| 观察结果 | 决策 |
| --- | --- |
| 没有变化 | 用新的 Worker Session 重跑 |
| 新增/修改文件足以满足必需 Artifact | 接受观察到的 Artifact，不重跑 |
| 发生删除、只读任务写入、产物不完整或检查点缺失 | 阻塞并交给所有者 |

这样恢复不依赖 Claude Code、Codex、Pi 或 opencode 的内部 Session 模型。检查点缺失是安全
失败，不是盲目重跑的许可。

## Workspace 并发

WorkOrder 执行期间会持有 Workspace 独占 lease。当前实现有意保守：读与写、写与写都会串行，
避免观察者看到写入一半的项目。lease 使用进程内队列和原子锁文件；Supervisor 崩溃后依据
PID 回收陈旧持有者。

## Provider 配置

Provider 启动配方是数据。内建默认值在 `src/workers/providers.json`；`<dataDirectory>/providers.json`
可以新增或覆盖。配方包含命令、参数模板、Prompt 传输方式、超时、能力和允许透传的环境变量名，
绝不包含凭据值。Registry 与 Kernel 不按供应商名称写分支。

## 结构化 JSON 诊断

失败是稳定的 JSON 形状：粗粒度类别、归一化 signature、Provider/Agent 身份和脱敏 detail。所有者
可以编辑 `<dataDirectory>/outcomes/failures.json`，增加错误模式和处理建议；这个文件只改变诊断，
不改变权限。类别区分启动、超时、认证、输入、网络、产物、意外副作用和恢复失败。独立 Provider 以
同一诊断类别失败时，说明障碍更可能在任务或环境；兜底类别还需要 signature 有重合，才能停止重试。

## 路线

旧路线把 Pi RPC、CLI 事件翻译和 Provider SDK Session 当成执行能力。它们仍是有用的实现学习
材料，但不再是架构边界。当前路线是：

| 步骤 | 目标 | 证明 |
| --- | --- | --- |
| A1 | Kernel 状态、策略、验证与 Journal | 重放与不变量测试 |
| A2 | 一个黑盒进程边界 | 退出、截止、环境、产物测试 |
| A3 | 持久中断裁决 | 检查点、部分产物与恢复测试 |
| A4 | Workspace 并发安全 | 竞争派发与陈旧锁测试 |
| A5 | Provider 配置 seam | JSON 内建值、用户覆盖、第三方 Provider 测试 |
| B | Main Agent 提案面 | 工具可以提案，但不能审批或完成 |
| C | 个人状态平面 | 所有者治理的目标、承诺、情境与记忆 |

## 刻意不承诺的事情

- 默认不续接 Worker Session；
- Worker 的话语不是完成证据；
- Provider 声明不授予权限，也不携带 Secret；
- Workspace 副作用未知的崩溃不会自动重试；
- opencode 是可选启动配方，不是必需依赖。

WorkOrder 合同见 [WorkOrder 与黑盒 Worker](work-orders-and-pi.zh-CN.md)，Provider 边界见
[黑盒 Agent 边界](coding-cli-adapters.zh-CN.md)。
