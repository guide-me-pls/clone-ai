# Agent 调用审计

[English](agent-invocations.md)

每一次 Main Agent 调用都会写入共享、追加式的账本
`~/.clone/audit/invocations.jsonl`。它刻意不受 `CLONE_HOME` 影响：外部 Agent
可以把 Run Journal 隔离在临时目录，但请求、可见回复、错误、模型、调用者与 Run id
仍会出现在所有者的审计视图中。

## 记录内容

- 唯一调用 id、调用者类型（`codex`、`claude-code`、`whatsapp`、`cli` 或显式值）、
  调用界面、pid 与可选的调用者会话 id；
- 用户可见的请求与最终可见回复；
- 失败时的错误文本；
- Workspace、数据目录、会话文件、模型、Provider 与推理强度；
- 本回合产生的 Run id；
- 开始时间、结束时间与耗时。

模型私有推理永远不会记录。文本在进入账本前会做 PII/Token 脱敏并截断。只有开始而没有
结束的记录会保持 `running`，如实表示进程被中断。

## 查看方式

- 桌面端：**设置 → 审计与轨迹 → Agent 调用**。
- CLI：`clone-ai invocations` 或 `clone-ai invocations show <id>`。
- API：`GET /api/invocations` 与 `GET /api/invocations/:id`。

## 调用者身份与覆盖

CLI 会自动识别 `CODEX_THREAD_ID`、`CLAUDE_SESSION_ID` 与
`CLAUDE_CODE_SESSION_ID`。接入方应设置：

```bash
CLONE_AI_CALLER=my-agent
CLONE_AI_CALLER_SESSION=run-123
```

受控部署或测试可用 `CLONE_AI_AUDIT_HOME` 移动共享账本。它是一个目录，账本写入其下的
`audit/` 子目录。生产环境中 `CLONE_HOME` 与 `CLONE_AI_DATA_DIR` **不会**移动它。
