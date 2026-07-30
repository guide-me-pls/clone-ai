# Codex CLI 与 Claude Code Adapter

[English](coding-cli-adapters.md) · **简体中文**

这是 Clone AI 接入真实执行 Provider 的第一版边界。Codex CLI 与 Claude Code 保留各自的内部
Agent Loop；Clone AI 始终是 Supervisor。

```text
WorkOrder -> Policy 与能力检查 -> CodingCliAdapter
  -> Codex CLI / Claude Code -> Provider 自己的 Agent Loop
  <- JSONL Event、Session ID、最终消息
-> Clone AI Evidence 与 Verification
```

## 当前实现

| Provider | 调用方式 | Resume |
| --- | --- | --- |
| Codex CLI | `codex exec --json` | `codex exec resume <session>` |
| Claude Code | `claude -p --output-format stream-json` | `claude --resume <session>` |

`CodingCliAdapter` 将 Provider 输出统一为 Runtime Event，应用 WorkOrder 时长 Budget，并支持取消。
Provider 无权批准操作、写入 Memory、修改父 Run 状态或宣布最终成功。

Codex 对 read-only 工作使用 `read-only` Sandbox，只在 `reversible_write` 时使用
`workspace-write`。Claude Code 对 read-only 使用 `plan` Permission Mode，只在
`reversible_write` 时使用 `acceptEdits`。外部副作用仍会停在 Clone AI 的审批边界。

## Evidence 合同

Agent 完成不是交付证明。当需要 Artifact 时，Worker 必须在末尾准确输出：

```text
CLONE_AI_EVIDENCE: {"kind":"artifact","summary":"...","locator":"relative/path"}
```

Runtime 会记录并校验 Evidence。下一版 Verifier 必须在受限 Workspace 内解析 locator，检查真实
文件或 Receipt。

## 已验证与尚未宣称完成

- 本机已安装 Codex CLI `0.145.0` 与 Claude Code `2.1.220`。
- 类型检查和完整自动化测试已通过，且没有发起付费请求。
- 本次改动尚未真实调用 Provider WorkOrder。
- Provider JSON Event 形状和真实 Artifact 检查仍需一次只读 Live Smoke Test。

## 第一个安全 Smoke Test

一次只运行一个 Provider，并使用只读 WorkOrder：

```text
分析当前仓库结构。不要修改文件，不要调用外部服务。
返回一条 CLONE_AI_EVIDENCE observation，写明你检查过的文件。
```

检查 Journal 中的 Provider Session、统一后的 Event、Evidence 和 Verification 结果；让这次
观察决定下一步优化。
