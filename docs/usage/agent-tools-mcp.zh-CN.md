# 本地 Agent 工具（内置 MCP 服务器）

[English](agent-tools-mcp.md)

clone-ai 的原生 Worker 只有四个文件工具。它足以读写一个已经知道路径的文件，却不足以跨仓库
找符号、看 diff 或提交历史、知道今天的日期，或打开一个文档页面。本页安装 **`agent-tools`**：
一个随 clone-ai 发布的小型 MCP 服务器，只补这些只读能力。

它是 clone-ai 自己的服务器（`src/mcp/agent-tools-server.ts`），不是第三方包。它只使用
Node 内建模块，因此安装器可以把一份文件复制到 clone home，服务器无需构建步骤或 Python 运行时。

## Worker 能拿到什么

| 工具 | 风险 | 用途 |
| --- | --- | --- |
| `agent-tools.search_text` | read | 递归字面量/正则检索，可加 glob 过滤；返回 `path:line: text` |
| `agent-tools.find_files` | read | glob 发现（`**/*.ts`、`*.md`），返回相对路径 |
| `agent-tools.git_status` | read | 分支与工作区状态 |
| `agent-tools.git_diff` | read | 统一 diff，可选暂存区或对某个提交 |
| `agent-tools.git_log` | read | 最近提交，格式为 `hash date author subject` |
| `agent-tools.current_time` | read | ISO/本地时间、时区、UTC 偏移、epoch 毫秒 |
| `agent-tools.fetch_url` | **network** | 一次 HTTP(S) GET，HTML 降为文本；拒绝私有地址 |

没有声明任何写工具或 shell 工具。`git_commit` 与 `run_command` 刻意缺席：提交仍是修复通道的
职责，而 shell 需要面向 Worker 的沙箱执行域，目前还没有。

读取工具可以提供给只读步骤。`fetch_url` 声明为 `network`，只有步骤声明了网络 Scope 才会出现；
安装服务器本身不会授予网络。

## 安装

```bash
node --experimental-strip-types scripts/install-agent-tools.mjs \
  --workspace /path/to/project
```

这会在 clone home（默认 `~/.clone`）写入两样东西：

- `mcp-servers/agent-tools-server.ts` —— 服务器副本；
- `mcp.json` —— 已启用的 `agent-tools` 条目，每个工具都已声明并分级。文件中的其他服务器保持不变。

用 `--print` 只查看条目而不写入；用 `--clone-home` 指向另一个 clone home。条目固定绝对 Node
路径（daemon 可能由 launchd 以空 `PATH` 启动）；Node 升级后需要重跑安装器。重启运行时，
Worker 才会用新的 `mcp.json` 重建工具表。

## 在任务里使用

工具名与参数形状都在各自的描述里，因此工作区说明可以很短：

```markdown
## 仓库检查
`agent-tools.*` 工具都是只读的。改代码前用 `search_text` 找调用点，改完用 `git_diff` 看自己的
改动；历史能解释代码时用 `git_log`。`fetch_url` 需要网络 Scope。
```

于是“找到所有调用 `parseConfig` 的地方，改完用 `git_diff` 检查一下”这样的请求就够了：
Worker 可以先检索，再检查自己的改动。

## 安全边界

- 服务器是**只读**的。它不能创建、修改或删除文件，不能执行 shell、提交、推送或发帖。
- 点名路径的工具声明了 `pathField: "path"`，Kernel 会在调用前核对该路径，与 `read_file`
  完全一样。检索与发现不会进入符号链接目录，并跳过 `src/authority/scope.ts` 中的同一批
  受保护根（SSH 密钥、云凭据、浏览器配置、Journal 与策略）。测试会保持两份受保护列表同步。
- 检索跳过 `.git`、`node_modules`、构建输出、二进制文件与超过 1MB 的文件；遍历到 100,000 个
  目录条目或达到请求的匹配数就停止。被跳过树内的匹配找不到；确有需要时收窄根目录或提高
  `maxResults`。
- `fetch_url` 只接受 `http:` 与 `https:`，拒绝内嵌凭据的 URL，解析主机后拒绝回环/私有/
  链路本地/CGNAT 地址，逐跳复核重定向，不发送 cookie 或凭据，响应体上限 200,000 字节。
  检查与请求之间的 DNS rebinding 没有被完全阻止；网络授权与服务器的可选启用是接受的边界。
- Git 命令通过 `execFile`（不经过 shell）执行，超时 10 秒、输出上限 200,000 字节，
  `GIT_TERMINAL_PROMPT=0`，并用 `--no-optional-locks` 使读取不刷新索引。`--no-textconv` 与
  `--no-ext-diff` 阻止仓库配置的 diff 助手执行，`core.fsmonitor=false` 关掉 fsmonitor 钩子，
  以 `-` 开头的修订号会被拒绝。`git_diff` 可以读取步骤点名的仓库；Kernel 的读取闸门仍会挡住
  受保护位置。
- 服务器是 Worker 步骤的子进程，步骤结束时关闭。服务器失败是模型能看到的工具错误，不会
  杀死整个运行。

## 卸载

在 `mcp.json` 中把 `agent-tools` 的 `"enabled"` 设为 `false`，或删除该条目。随后可以删除
复制出的 `mcp-servers/agent-tools-server.ts`。重启运行时。

## 状态

声明、合并、受保护根列表、地址检查、检索、发现、Git、时间与 `fetch_url` 的拒绝路径由
`test/agent-tools-mcp.test.ts` 覆盖，其中包括真实 stdio 子进程与 `workerTools` 接线用例。
真实网络路径只通过注入的 fetch 走通，没有请求公网 URL。命令与执行链路见
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) 的 2026-11-22 条目。
