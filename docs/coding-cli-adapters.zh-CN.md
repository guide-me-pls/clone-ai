# 受监督的 Worker 边界

[English](coding-cli-adapters.md) · **简体中文**

Codex CLI、Claude Code 与 Pi 都保留各自内部的 Agent Loop。Clone AI 始终是 Supervisor：
它拥有 WorkOrder、权限、预算、证据，以及"工作是否完成"的判定权。

```text
WorkOrder -> 策略 + 能力检查
  -> SupervisedWorkerAdapter     预算 · 硬截止 · abort→强制终止
     |                           完成判定 · 证据信任 · 脱敏
     +-- ProviderTranslator      只管协议
  <- 归一化事件、会话 ID、settled 信号
-> Clone AI Evidence + 验证
```

## 一个核心，多个翻译器

权限只存在一份，在 `SupervisedWorkerAdapter` 中。Provider 只贡献一个 Translator，把自己的
协议映射到七种中立事件形状：

```text
session · text · turn · tool_start · tool_end · progress · settled · protocol_error
```

| 提供方 | 调用方式 | 恢复 | Settled 信号 |
| --- | --- | --- | --- |
| Codex CLI | `codex exec --json` | `codex exec resume <session>` | 说过协议且干净退出 |
| Claude Code（CLI） | `claude -p --output-format stream-json` | `claude --resume <session>` | `result` 事件 |
| Claude Code（SDK） | `@anthropic-ai/claude-agent-sdk` | `resume` 选项 | 有类型的 `result` 消息 |
| Pi | JSONL RPC 子进程 | `--session-id` | `agent_settled` |

接入一个 Coding Agent 意味着写一个 Translator（约 100 行），而它不能授予审批、不能扩大预算、
不能改变 Run 状态、不能宣布成功。Claude Code 选择 SDK 传输方式用
`CLONE_AI_CLAUDE_TRANSPORT=sdk`，CLI 传输仍是默认值。

Codex 对只读工作使用 `read-only` Sandbox，只有 `reversible_write` 才用 `workspace-write`。
Claude Code 对只读工作使用 `plan` Permission Mode，只有 `reversible_write` 才用 `acceptEdits`。
外部副作用仍然停在 Clone AI 的审批边界。

## 完成是协议事实，不是退出码

进程被 kill、用尽轮次、或被指向错误的二进制，都可能以 0 退出。因此完成必须来自显式的 settled
信号；一条干净结束却从未 settle 的流会被报告为失败。

同理，协作式 abort 只是请求而非停止。每次 abort 都会启动宽限计时器强制终止会话，因此卡死的
Provider 无法把 Supervisor 挂住。时长、模型调用数与工具调用数的预算由核心为所有 Provider
统一施加。

## 环境与证据

每个 Worker 进程从空环境启动，只收到显式白名单：操作系统基础变量、该 Provider 自己的凭据，
以及配置的额外名单。Supervisor 环境中的其他机密一律不可见。

Agent 声称完成不等于交付的证明。需要产出 Artifact 时，Worker 以这一行精确格式结束：

```text
CLONE_AI_EVIDENCE: {"kind":"artifact","summary":"...","locator":"relative/path"}
```

这个声明会被校验而非信任：只接受 `artifact`，且 locator 必须解析到有边界 Workspace 内真实
存在的文件。其他任何声明——包括任何用于证明外部动作确实发生的 `receipt`——都会降级为一条记录
了拒绝原因的 observation。该策略只有一份实现，被所有 Provider 共享。

Worker 同时会收到由 Kernel 编译的、所有者已审核的有作用域记忆包，因此更换 Provider 从不意味着
在工具之间迁移记忆。详见 [Runtime 架构与路线](runtime-architecture-and-route.zh-CN.md)。

## 已验证与尚未声称

- 一次真实的只读 Claude Code 会话已经端到端通过本边界完成，对应 `claude-code 2.1.234`
  （`CLONE_AI_LIVE_SMOKE=1`）。录制这次会话修正了 3 处解析错误和 1 个 Windows 启动 bug；
  脱敏后的事件流已作为回放 fixture 入库。
- 类型检查与完整自动化测试套件在不产生付费请求的情况下通过。
- Codex CLI 的事件结构仍是**推断而非观察**：尚未运行过真实的 Codex WorkOrder，其 Translator
  分支未经验证。
- `CLONE_AI_EVIDENCE` 行目前仍是文本约定。把它换成结构化通道是 SDK 传输方式的后续工作。
