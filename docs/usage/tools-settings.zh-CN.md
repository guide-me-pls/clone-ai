# 设置里的工具与技能

[English](tools-settings.md)

桌面设置页现在有 **工具与技能** 分区。它列出 clone home 的 `mcp.json` 中每个 MCP 服务器、
服务器声明的每个工具，以及所有者技能根目录下发现的技能。每个服务器都有 **加载 / 停用**
按钮。加载只改写该服务器的 `enabled` 字段；下一次 Worker 运行即可看到变化。

## 分区里有什么

- **MCP 服务器** —— id、传输方式、启用状态，以及每个已声明工具的风险（`read`、`write`、
  `network`、`external`）与说明。目录从不返回 `env`、`command`、`args` 或 `url`；这些可能
  携带凭据。
- **技能** —— 在以下目录中找到的每个技能的名字、说明与 `SKILL.md` 路径：
  - `<clone home>/skills`
  - `<workspace>/.clone/skills`

  格式错误的 `SKILL.md` 会列在“无法解析的技能”下并说明原因，而不是被静默丢弃。
- **MCP 配置问题** —— 损坏的 `mcp.json` 条目会显示在服务器卡片上方，而不是藏起其余目录。

2026-11-24 这个 clone home 的分区显示：

| 服务器 | 工具 | 已加载 |
| --- | --- | --- |
| `playwright` | 10 个浏览器工具 | 是 |
| `agent-tools` | 7 个读取/网络工具 | 是 |
| `agent-exec` | `list_commands`、`run_command` | 是 |

两个技能根目录下都没有发现技能；分区会说明这一点并列出目录。

## 加载与停用

对已加载的服务器按 **停用**，下一次 Worker 的工具表就不再包含它；对已停用的服务器按
**加载** 即可恢复。按钮原子地写入 `mcp.json`（0600），保留其他服务器与字段——包括
`command`、`args`、`env` 与未知键。变更在下一次 Worker 运行时生效，不需要重启运行时，
因为 `workerTools` 每次运行都会重建工具表。

已加载的服务器仍按步骤过滤：`network` 工具（如 `agent-tools.fetch_url`）需要网络 Scope，
`agent-exec.run_command` 是只提供给可逆写入步骤的 `write` 工具。加载服务器不会授予这些
Scope。

## 添加技能

在任一技能根目录下创建一个带 `SKILL.md` 的目录：

```text
~/.clone/skills/my-procedure/SKILL.md
```

```markdown
---
name: my-procedure
description: 模型与所有者在列表里看到的一行说明。
allowed-tools: read_file, search_text
---

完整流程。正文只在技能被调用时加载。
```

分区读取技能列表；正文留在磁盘上。技能是 clone-ai 自己的概念，不是 Claude Code 的技能库；
两者不共用目录。

## 安全与限制

- 目录是声明视图。它不启动服务器，也不调用 `tools/list`；服务器真实提供的工具与 `mcp.json`
  漂移时，卡片会显得过期，直到有真实探测动作。Worker 仍只看已声明工具。
- 切换改的是所有者的 `mcp.json`；文件仍是事实来源。页面不能安装服务器、运行命令或读取凭据。
- `enabled` 按 clone home 而不是按工作区，因此所有工作区共用同一份服务器列表；只有技能根目录
  与工作区相关。
- 技能视图是只读的。把技能接进 Main Agent 回合并加启用/停用开关是另一项变更。

## 状态

安全投影、原子切换、损坏文件报告、技能发现与被拒绝技能由 `test/mcp-settings.test.ts` 覆盖；
路由由 `test/companion-config-api.test.ts` 覆盖；分区与加载控件由 `test/ui-structure.test.ts`
钉住。命令与执行链路见
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) 的 2026-11-24 条目。
