# 设置里的工具与技能

[English](tools-settings.md)

桌面设置页现在有 **工具与技能** 分区。它列出 clone home 的 `mcp.json` 中每个 MCP 服务器、
服务器声明的每个工具，以及所有者技能根目录下发现的技能。每个服务器都有 **加载 / 停用**
按钮，页面还可以从 npm 包安装新服务器或移除服务器。加载只改写该服务器的 `enabled` 字段；
下一次 Worker 运行即可看到变化。

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

## 安装服务器

**安装 MCP 服务器** 卡片从 npm 包安装一个 stdio 服务器：

1. 填写服务器 ID、npm 规格（`@scope/name@version`）与参数（空格分隔；参数含空格时用
   JSON 数组）。
2. 按 **探测工具**。运行时会启动 `npx --yes <spec> <args>`，完成 MCP 握手并列出包暴露的
   工具。此时不写任何文件。
3. 为每个工具指定风险，或按 **读取 / 写入 / 网络** 一键全部设定。每个工具从 **外部**
   （`external`）开始，Worker 永远拒绝该风险。
4. 按 **安装** 并确认。安装会重新探测包，在包暴露了请求未声明的工具时拒绝，并把一条启用
   条目原子写入 `mcp.json`（权限 0600）。其他服务器与未知顶层字段都会保留。

每个服务器卡片上的 **移除** 按钮删除该条目。所有失败都发生在写入之前，因此被拒绝的安装不会
改动 `mcp.json`。安装会以所有者权限、在无 OS 沙箱的情况下运行包；这是该流程的代价，也是
Agent 无法发起安装的原因。

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

- 目录是声明视图。Worker 只看 `mcp.json` 声明的工具；安装流的探测是唯一读取包真实
  `tools/list` 的地方，且它会拒绝暴露未声明工具的包。安装后改变工具表的服务器仍会被同一道
  闸门过滤。
- 页面可以安装服务器，但不能运行命令或读取凭据：`~/.clone` 是受保护根，
  `env`/`command`/`args`/`url` 永远到不了设置页。
- `enabled` 按 clone home 而不是按工作区，因此所有工作区共用同一份服务器列表；只有技能根目录
  与工作区相关。
- 技能视图是只读的。把技能接进 Main Agent 回合并加启用/停用开关是另一项变更。

## 状态

安全投影、原子切换、损坏文件报告、技能发现与被拒绝技能由 `test/mcp-settings.test.ts` 覆盖；
安装流由 `test/mcp-installer.test.ts` 与 `test/tools-install-api.test.ts` 覆盖；路由由
`test/companion-config-api.test.ts` 覆盖；分区与控件由 `test/ui-structure.test.ts` 钉住。
命令与执行链路见
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) 的 2026-11-24 条目。
