# WorkOrder 与黑盒 Worker

[English](work-orders-and-pi.md) · **简体中文**

本页保留历史文件名，但执行边界已经改变。Pi 不再是特殊的 RPC Adapter。Pi、Claude Code、
Codex、opencode 和未来的 Agent 都经过同一个黑盒 Worker 边界。

## WorkOrder 合同

`SubagentWorkOrder` 声明：

- 目标、输入与验收标准；
- 所需能力与可选路由提示；
- 预期 Artifact；
- 风险等级、执行预算与重试上限；
- 依赖边与 DAG。

Main Agent 或 Planner 可以提出这份对象，但 Kernel 会在派发前校验图结构、风险、预算、产物
合同、能力和审批要求。Worker 不能修改 WorkOrder，也不能关闭父 Run。

## 所有 Provider 共用一个边界

```text
WorkOrder
  -> Kernel 策略 / 能力 / 审批
  -> 一次性 Prompt + 有作用域记忆 + Workspace
  -> BlackBoxCliWorker
       环境白名单 · 超时 · 终止
       执行前快照 -> 子进程 -> 执行后快照
  <- 退出状态 + Workspace 差异 + 脱敏输出尾部
  -> 观察到的 Artifact -> 验证 -> Run 投影
```

Adapter 不解析 Provider 的事件协议、Session 数据库或完成标记，只观察进程行为和 Workspace。
退出码为 0 不等于完成；合同要求的产物没有写入就是 `no_artifact`。Receipt 不能来自 Worker
可控制的文字。

## Pi 只是启动配方

内建配方位于 `src/workers/providers.json`，用户可以用 `<dataDirectory>/providers.json` 覆盖：

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

`env` 只包含变量名。Clone AI 不会把凭据值放进源码、fixture 或 Provider 声明。派发时替换
`{{prompt}}` 与 `{{workspace}}`；`promptVia: "stdin"` 可以避免 Prompt 出现在进程参数中。

不依赖 Pi 自己的 Session 或 `--resume`。每次派发都是新的黑盒 Session，Kernel 从 Journal、
Memory Store、WorkOrder 与 Workspace 证据重建上下文。

## 崩溃后的恢复

Supervisor 在第一次尝试前保存 Workspace 检查点。子进程崩溃，或 Supervisor 在 WorkOrder 运行
时重启后，Kernel 将检查点与当前 Workspace 比较：

- 没有变化：用新 Session 重跑；
- 新增/修改的文件已经足以满足必需 Artifact：接受观察到的 Artifact，不重复执行；
- 发生删除、意外写入、产物不完整或检查点缺失：生成结构化恢复失败，等待所有者处理。

恢复是外部裁决，不是要求黑盒 Agent 记住做到哪一步。Provider 的 resume 可以是优化，但绝不
能成为事实来源。

## Workspace 并发

WorkOrder 可以在计划中处于同一波次，但同一个 Workspace 使用独占 lease 执行。这既防止两个
Coding Agent 同时覆盖同一项目，也防止读任务看到写入到一半的状态。lease 由进程内排队和原子
锁文件共同组成；Supervisor 崩溃后可依据持有者 PID 回收陈旧锁。

## 失败 JSON

失败使用稳定类别，例如 `launch_failed`、`timeout`、`missing_credential`、`missing_input`、
`network`、`partial_side_effect`、`unexpected_side_effect`、`recovery_blocked`。报告带有归一化
signature 与脱敏 detail。独立 Provider 报告同一诊断类别时，说明障碍更可能在任务或环境，Kernel
会停止继续消耗尝试次数。

## 代码地图

```text
src/core/contracts.ts
  WorkOrder、RuntimeAdapter、归一化事件、失败/恢复数据

src/core/runtime.ts
  策略、DAG 波次、Workspace 恢复裁决、验证

src/core/workspace-evidence.ts
  快照、差异、持久 JSON 检查点

src/core/workspace-lock.ts
  独占 Workspace lease 与陈旧持有者回收

src/workers/black-box-cli-worker.ts
  进程边界、预算、环境白名单、观察型证据

src/workers/providers.json
  内建启动配方

src/workers/provider-catalog.ts
  JSON 加载、用户覆盖、Registry 定义
```

关键不变量不是 Provider 是否说自己成功，而是 Kernel 不信任 Provider 的记忆和对话，也能重建
实际发生过什么。
