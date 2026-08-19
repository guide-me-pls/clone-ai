# 黑盒 Agent 边界

[English](coding-cli-adapters.md) · **简体中文**

Clone AI 把所有 Coding Agent 都当作黑盒：提供 Prompt、有作用域的上下文和 Workspace，随后只
根据可观察事实判断结果——进程生命周期和磁盘上真正发生的变化。不解析 Provider 协议、Session
数据库、Tool 流或完成声明。

```text
WorkOrder -> 策略 + 能力 + 审批
  -> BlackBoxWorkerAdapter    Prompt · 预算 · 截止 · 终止
     |                        环境白名单
     |                        Workspace 执行前/后快照
  <- 退出状态 + Workspace 差异 + 脱敏输出尾部
-> 观察型 Artifact -> 验证 -> Run 状态
```

## 接入 Agent 是配置

内建启动配方位于 `src/adapters/providers.json`。用户可以在 `<dataDirectory>/providers.json` 中
新增或覆盖：

```json
{
  "providers": [
    {
      "id": "opencode",
      "label": "opencode",
      "command": "opencode",
      "args": ["run", "{{prompt}}"],
      "env": ["ANTHROPIC_API_KEY"],
      "timeoutMs": 900000
    }
  ]
}
```

派发时替换 `{{prompt}}` 与 `{{workspace}}`。`promptVia: "stdin"` 表示通过 stdin 发送 Prompt，
而不是把 Prompt 放进参数列表。与内建 ID 相同的声明会覆盖内建配方。`env` 只包含变量名；源码
和配置不应出现凭据值。

| 内建 | 命令 |
| --- | --- |
| Claude Code | `claude -p {{prompt}}` |
| Codex CLI | `codex exec --skip-git-repo-check {{prompt}}` |
| Pi | `pi -p {{prompt}}` |
| opencode | `opencode run {{prompt}}` |

声明只控制启动方式和可见环境，不能授予审批、扩大 WorkOrder 预算、改变 Run 状态或宣布成功。

## 证据靠观察

Adapter 在派发前对 Workspace 拍快照，结束后比较差异。新增和修改文件成为 Artifact Evidence，
并用真实相对路径定位；删除是变化，但不是产物。当合同要求产物而没有文件变化时，结果就是
`no_artifact`，无论 Agent 说了什么。普通黑盒 Provider 仍不能产生 Receipt。

## 恢复不使用 Provider 记忆

Kernel 在第一次尝试前保存持久 JSON Workspace 检查点。Worker 或 Supervisor 崩溃后，Kernel 将
检查点与当前 Workspace 比较：

- 没有变化：用新 Session 重跑；
- 新增/修改文件足以满足必需 Artifact：接受观察到的 Artifact，不重复执行；
- 发生删除、只读任务写入、产物不完整或检查点缺失：生成结构化恢复失败，等待所有者处理。

因此 Claude Code、Pi 或未来 Provider 的 `--resume` 都不是依赖。Provider resume 可以优化重试，
但不能成为事实来源。

## Workspace 并发

WorkOrder 执行期间持有 Workspace 独占 lease。读与写、写与写都会串行，防止 Agent 互相覆盖，
也防止读者看到写入一半的项目。lease 由进程内队列和原子锁文件组成，可依据持有者 PID 回收
已经死亡的 Supervisor 的锁。

## 失败 JSON 与交叉印证

失败使用稳定类别，例如 `launch_failed`、`timeout`、`nonzero_exit`、`no_artifact`、
`missing_credential`、`missing_input`、`permission_denied`、`network`、`partial_side_effect`、
`unexpected_side_effect`、`recovery_blocked` 与 `unknown`。

报告带有 Provider/Agent 身份、归一化 signature 和脱敏的可读 detail。所有者可以在
`<dataDirectory>/outcomes/failures.json` 中增加匹配模式和处理建议；这个文件只用于诊断，绝不
授予执行权限。独立 Provider 以同一诊断类别失败时，可以印证障碍在任务或环境；兜底类别还需要
signature 有重合，才会停止重试。

## 已验证的边界

脚本化黑盒测试覆盖 Workspace 产物、只声明不写入、命令不存在、硬截止、环境隔离、失败类别、
检查点裁决、Workspace 锁和跨 Provider 印证。默认测试不需要付费 Provider 请求。真实 Provider
冒烟仍然是显式开启的，不代表其他 Provider 的启动配方已经实测正确。
