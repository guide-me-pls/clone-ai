# 初始 Runtime

[English](initial-runtime.md) · **简体中文**

这是 `clone-ai` 第一段可运行的代码。它是个人数字分身的本地控制平面，不是聊天机器人，也不是托管网页产品。当前已具备显式开启的 LLM Planner，同时保留确定性的本地回退策略；它先建立未来接入 Codex、Claude Code、Pi 和自定义 Agent 时必须遵守的监督边界。

```text
桌面客户端
  -> 本地 Clone AI daemon
      -> 触发 -> Task + 持久化 Run -> 计划
      -> 权限策略 -> 子 Agent 工作单 -> Evidence
      -> 独立验证 -> 记忆候选
```

## 当前已经具备的能力

| 能力 | 当前行为 |
| --- | --- |
| 触发入口 | 接受 `query`、`schedule`、`signal` 和 `manual` 四类触发。 |
| Task 与 Run | 创建可持久化的 `Task` 与 `Run`；它们都不是 Agent Session。 |
| 事件 Journal | 以可检查的 JSONL 追加事件，并可通过重放恢复 Runtime 状态。生产版本计划替换为 SQLite。 |
| 权限关口 | 默认允许本地、可逆工作；外部或不可逆动作必须等待精确审批。 |
| 子 Agent 工作单 | 一个计划步骤可以按依赖关系分批派发子工作单：独立工作并行执行，审查工作只有在前置 Evidence 返回后才启动。 |
| 监督边界 | 子 Agent 无法修改父任务状态、绕过策略、提交记忆或关闭 Run；它们只能提交进度、Evidence、失败和显式完成信号。 |
| 重启恢复 | 子 Agent 的派发、进度、Evidence、完成和失败都会进入 Journal。恢复后的 Run 会跳过已经完成且有 Evidence 的工作单。 |
| 验证 | Runtime 会独立检查每个计划步骤是否拥有可观察的 Evidence，只有通过后才能完成 Run。 |
| 记忆管道 | 已验证 Run 异步请求记忆提取；Worker 只能提出候选，不能直接写入长期个人记忆。 |

## 运行演示

需要 Node.js 24 或更高版本：

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run demo
```

演示会依次展示：

1. Supervisor 创建三个子 Agent 工作单：调研和草稿并行，审查必须等待两者的 Evidence。
2. 每个子 Agent 返回 Evidence。Supervisor 记录完整生命周期，但不接受 Agent 的自我声明作为最终完成。
3. 父 Run 在模拟的外部副作用之前停在审批处。
4. 精确审批后，外部执行器运行；Runtime 验证全部 Evidence，并排入一条记忆候选。

默认 Journal 位于 `.clone-ai/journal.jsonl`。设置 `CLONE_AI_DATA_DIR` 可使用其他本地目录。

## 桌面端方向

`clone-ai` 的目标是可安装的桌面数字分身，而不是网站。最终客户端将提供本地工作台、系统托盘、通知、审批和活动追踪；Node.js Runtime 仍是本地 daemon，不会被塞进 UI 进程。

当前静态界面位于 `apps/desktop/ui/`。在原生桌面壳接入前，它只通过 `npm run companion:debug` 作为开发期预览，服务仅绑定 `127.0.0.1`，不会成为公开或托管服务。

```text
apps/desktop/                 已安装客户端的边界（目标为 Tauri）
  ui/                         临时桌面 WebView 资源

src/
  core/                       Journal、策略、Supervisor、验证
  adapters/                   可替换 Agent Adapter 与演示注册表
  memory/                     异步记忆候选管道
  companion-server.ts         仅用于本地开发预览
  demo-workflow.ts            带子 Agent 工作单的父计划
  cli.ts                      开发者演示与 Trace 入口
```

## Runtime 不可破坏的约束

1. Runtime 而不是 Agent 拥有 Task 和 Run 状态。
2. 子 Agent 工作单不是 Task，也没有独立权限。
3. 子 Agent 的输出只是 Evidence 或声明，不能自行被接受为结果。
4. 外部动作不能绕过默认策略，必须获得精确审批。
5. 只有验证通过，Run 才能成为 `completed`。
6. 记忆提取与任务完成分离，不能直接写入长期个人记忆。
7. 重放 Journal 后，已完成的工作单和 Run 能在重启后恢复。

## 有意暂未实现的部分

- 真实的 Codex、Claude Code Adapter；Pi 已有第一版受 Supervisor 管理的 JSONL RPC Adapter。
- 将自然语言和设备信号转为计划的 Planner 与 Context Compiler。
- SQLite WAL、加密、快照、压缩和长期记忆审核。
- 外部动作的细粒度 Sandbox、Worktree 和连接器回执。
- Tauri 打包桌面壳、托盘、通知、原生审批和自动 daemon 生命周期。
- 机会发现与受治理的个人世界模型。

用真实 Pi 工作验证 checkpoint/resume 已经完成，相同的 Adapter 合同现在也承载着 Codex 与
Claude Code。下一阶段是个人状态平面：把 `SelfModel`、`Goal`、`Commitment`、`Situation`
实现为受治理的 Journal 投影。详见
[Runtime 架构与路线](runtime-architecture-and-route.zh-CN.md)。
