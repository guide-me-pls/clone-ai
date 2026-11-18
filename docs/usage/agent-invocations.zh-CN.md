# Agent 调用审计

[English](agent-invocations.md)

每一次 Main Agent 调用都会写入共享、追加式的账本
`~/.clone/audit/invocations.jsonl`。它刻意不受 `CLONE_HOME` 影响：外部 Agent
可以把 Run Journal 隔离在临时目录，但请求、可见回复、错误、模型、调用者与 Run id
仍会出现在所有者的审计视图中。

## 记录内容

- 唯一调用 id、调用者类型（`codex`、`claude-code`、`whatsapp`、`desktop` 或显式值）、
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
- API：`GET /api/invocations` 与 `GET /api/invocations/:id`。

## 搜索与隐藏

桌面视图在**服务端**搜索整个共享账本，而不只是已经加载的那一页，并显示
`显示 N / 共 M 条`。匹配是对请求、可见回复、错误、调用者、调用界面、工作区、数据目录、
模型、Provider、推理强度与 Run id 做不区分大小写的子串搜索。**主 Agent 回合** 标签页
也以同样方式搜索 Journal。

删除一条记录会向账本追加墓碑（`{"phase":"deleted","id":…}`），并把它从默认列表隐藏。
原有的开始与回复行永不重写，因为多个进程会同时追加同一个文件。勾选**含已删除**可以看到
被隐藏的记录并恢复；**删除这 N 条**只标记当前筛选结果里已加载的记录，所有者始终看得到
将要隐藏什么。这是隐私清洁，不是彻底擦除：原文仍在磁盘上，`includeDeleted=1` 与详情端点
仍能读到。

- `GET /api/invocations?q=<文本>&limit=<1..500>&includeDeleted=1` 返回
  `{records, total, hidden}`；`total` 是限制之前的命中总数，`hidden` 是仅因默认排除
  墓碑而被隐藏的命中数（界面据此说“其余记录都已隐藏”，而不是“一条都没有”）。
- `POST /api/invocations/delete` 与 `POST /api/invocations/restore` 接收
  `{ids: string[]}`，返回 `{changed}`。

## 调用者身份与覆盖

账本会自动识别 `CODEX_THREAD_ID`、`CLAUDE_SESSION_ID` 与
`CLAUDE_CODE_SESSION_ID`。接入方应设置：

```bash
CLONE_AI_CALLER=my-agent
CLONE_AI_CALLER_SESSION=run-123
```

受控部署或测试可用 `CLONE_AI_AUDIT_HOME` 移动共享账本。它是一个目录，账本写入其下的
`audit/` 子目录。生产环境中 `CLONE_HOME` 与 `CLONE_AI_DATA_DIR` **不会**移动它。
