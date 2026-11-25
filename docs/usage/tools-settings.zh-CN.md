# 设置里的工具与技能

[English](tools-settings.md)

**工具与技能** 分区现在有两个分类：**MCP 服务器** 与 **技能**。每个服务器、每个技能都是
一行；点行进入详情页。即使服务器只声明一个工具，也不在列表里内联展开。分区还有两个
市场——MCP 与技能——从各自的分类标题进入。

## 分区里有什么

- **MCP 服务器** —— 每个服务器一行，显示 id、传输方式、工具数与启用状态。详情页列出每个
  已声明工具的风险（`read`、`write`、`network`、`external`）、可读摘要与参数表（名称、
  类型、必填、默认）。参数表来自描述中的 `Args: {...}` 块；安装时优先使用探测得到的 JSON
  Schema——原始片段不会出现在页面上。目录从不返回 `env`、`command`、`args` 或 `url`；
  这些可能携带凭据。
- **技能** —— 每个已安装技能一行，显示说明。详情页显示 `SKILL.md` 路径、技能请求的工具，
  以及渲染后的 Markdown 正文。技能从以下目录读取：
  - `<clone home>/skills`（市场安装到这里）
  - `<workspace>/.clone/skills`

  格式错误的 `SKILL.md` 会列在「无法解析的技能」下并说明原因，而不是被静默丢弃。
- **MCP 配置问题** —— 损坏的 `mcp.json` 条目显示在 MCP 分类顶部，而不是藏起其余目录。

返回链接回到上一页；列表保留原来的阅读位置。

## 技能怎么被使用

每个 Main Agent 回合的系统提示词里都有已安装技能的一行列表。每个技能同时是一个
`Skill(name)` 工具；调用时返回技能正文（流程）。正文只在模型主动请求时进入回合。技能里的
`allowed-tools` 是给模型的指引；真正的闸门仍由 Kernel 决定。新安装的技能在下一个 Main
Agent 回合生效，不需要重启。

## 加载与停用

在已加载服务器的详情页按 **停用**，下一次 Worker 的工具表就不再包含它；对已停用的服务器
按 **加载** 即可恢复。按钮原子地写入 `mcp.json`（0600），保留其他服务器与字段——包括
`command`、`args`、`env` 与未知键。变更在下一次 Worker 运行时生效，不需要重启运行时，
因为 `workerTools` 每次运行都会重建工具表。

已加载的服务器仍按步骤过滤：`network` 工具（如 `agent-tools.fetch_url`）需要网络 Scope，
`agent-exec.run_command` 是只提供给可逆写入步骤的 `write` 工具。加载服务器不会授予这些
Scope。

## 安装 MCP 服务器

**安装 MCP** 按钮打开 MCP 市场：五个核对过的服务器（文件系统、记忆图谱、分步思考、
Playwright、Chrome 调试），每个固定一个 npm 版本，并把需要的输入声明成有类型的字段。
搜索同时匹配中英文词。按 **配置** 打开条目页；客户端只发送条目 id 与输入值，包、argv 与
环境由服务器从 `src/mcp/mcp-registry.ts` 构造。两个条目带安全默认值：`memory` 把图谱放在
`<clone home>/mcp-memory.jsonl` 而不是 npx 缓存；`chrome-devtools` 带
`--no-usage-statistics` 安装；文件系统条目默认打开 `--read-only`。

安装仍走探测 → 风险 → 确认：

1. 按 **探测工具**。运行时启动 `npx --yes <固定规格> <args>`，完成 MCP 握手并列出暴露的
   工具。此时不写任何文件。
2. 为每个工具指定风险，或按 **读取 / 写入 / 网络** 一键全部设定。每个工具从 **外部**
   （`external`）开始，Worker 永远拒绝该风险。
3. 按 **安装** 并确认。安装会重新探测包，在包暴露了请求未声明的工具时拒绝，并把一条启用
   条目原子写入 `mcp.json`（权限 0600）。

安装器从运行运行时的 Node 解析 `npx`（其次是 Homebrew、`/usr/local`、pnpm、volta、bun），
并把这个 Node 目录放到 MCP 子进程 `PATH` 的最前；绝对命令写入 `mcp.json`。这正是让安装
在 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` 的 launchd 守护进程下也能工作的原因。

市场下方的 **手动安装** 保留自由文本表单，适用于任意 npm 包。已安装条目保留卡片并显示
**已安装** 徽章。每个服务器详情页的 **移除** 按钮删除该条目。所有失败都发生在写入之前，
因此被拒绝的安装不会改动 `mcp.json`。安装会以所有者权限、在无 OS 沙箱的情况下运行包；
这是该流程的代价，也是 Agent 无法发起安装的原因。

## 安装技能

**获取技能** 打开技能市场：四个随仓库发布的内置技能——周复盘、文档审阅、发布说明、交付
自检。打开一个会显示摘要、它请求的工具与完整正文。确认后 **安装技能** 写入
`<clone home>/skills/<name>/SKILL.md`；已安装技能的 **移除技能** 删除该目录。只有 clone
home 技能根的直接、非符号链接子目录可以被移除；工作区技能可读，但不从这里移除。

技能仍可手写：创建 `<clone home>/skills/<name>/SKILL.md`，带 frontmatter（`name`、
`description`、`allowed-tools`、`disable-model-invocation`、`user-invocable`）与 Markdown
正文。

```markdown
---
name: my-procedure
description: 模型与所有者在列表里看到的一行说明。
allowed-tools: read_file, search_text
---

完整流程。正文只在技能被调用时加载。
```

技能是 clone-ai 自己的概念，不是 Claude Code 的技能库；两者不共用目录。远程技能下载尚未
启用：第三方 `SKILL.md` 还没有签名或信任模型。

## 安全与限制

- 目录是声明视图。Worker 只看 `mcp.json` 声明的工具；安装流的探测是唯一读取包真实
  `tools/list` 的地方，且它会拒绝暴露未声明工具的包。安装后改变工具表的服务器仍会被同一道
  闸门过滤。
- 页面可以安装服务器，但不能运行命令或读取凭据：`~/.clone` 是受保护根，
  `env`/`command`/`args`/`url` 永远到不了设置页。技能安装只写入 clone home 的技能根；
  移除要求是该根的直接子目录，并拒绝符号链接。
- 技能正文是数据，只在被调用时进入回合。工作区技能就是该项目放在 `.clone/skills` 下的
  内容；依赖它之前先读一遍。
- `enabled` 按 clone home 而不是按工作区，因此所有工作区共用同一份服务器列表；只有技能根目录
  与工作区相关。
- 需要 API 密钥的 MCP 服务器与远程技能尚不能从市场安装。免密钥包仍可走自由文本表单；
  带密钥的服务器需要取舍条目里描述的 env 输入。

## 状态

安全投影、原子切换、损坏文件报告、技能发现与被拒绝技能由 `test/mcp-settings.test.ts` 覆盖；
MCP 市场、搜索与 argv/env 解析由 `test/mcp-registry.test.ts` 覆盖；安装流与 launchd 下的
`npx` 解析由 `test/mcp-installer.test.ts` 与 `test/mcp-host.test.ts` 覆盖；MCP 与技能路由
由 `test/tools-install-api.test.ts` 覆盖；内置技能清单与 clone-home 边界由
`test/skill-registry.test.ts` 覆盖；Main Agent 的技能列表与 `Skill(name)` 正文由
`test/skill-runtime.test.ts` 覆盖；两个分类、跳转行、市场与技能页由
`test/ui-structure.test.ts` 钉住。命令与执行链路见
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) 的 2026-11-25 条目。