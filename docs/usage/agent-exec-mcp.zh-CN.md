# 本地命令执行器（agent-exec MCP 服务器）

[English](agent-exec-mcp.md)

原生 Worker 能读写、检索和编辑项目，却跑不了项目自己的测试。修 Bug 因此只能盲改：Worker
改完代码就停下，修复通道事后再跑套件。本页安装 **`agent-exec`**：一个随 clone-ai 发布的
MCP 服务器，只运行所有者在 `agent-exec.json` 里列出的命令，并把它们放进 macOS Seatbelt 沙箱。
它就是 Worker 的“复现 → 修复 → 验证”回路。

## Worker 能拿到什么

| 工具 | 风险 | 用途 |
| --- | --- | --- |
| `agent-exec.list_commands` | read | 列出所有者批准的命令（名字、argv、说明） |
| `agent-exec.run_command` | **write** | 按名字运行一条命令；没有 shell，模型不提供 argv |

`run_command` 声明为 `write`，因此只有 `reversible_write` 步骤会拿到它。只读步骤可以列命令，
但不能运行。工具输出与其他 MCP 结果一样，由 MCP 客户端包裹为不可信观察。

## 安装

```bash
node --experimental-strip-types scripts/install-agent-exec.mjs \
  --workspace /path/to/project
```

这会在 clone home（默认 `~/.clone`）写入四样东西：

- `mcp-servers/agent-exec-server.ts` —— 服务器副本；
- `agent-exec.sandbox` —— 该工作区的 Seatbelt profile；
- `agent-exec.json` —— 所有者撰写的命令白名单；
- `mcp.json` —— 已启用的 `agent-exec` 条目，保留其他服务器。

`--print` 不写文件，只打印配置、profile 与 `mcp.json` 条目。`--clone-home` 指向另一个
clone home。`agent-exec.json` 里已有的命令会保留；检测到的命令按名字追加。`--replace` 才会
用检测结果替换命令表。

安装器会检测一个起始集合：

- `package.json` 中名为 `test`、`typecheck`、`lint`、`check`、`gate` 或 `build` 的脚本
  变成 `npm run <name>`；
- `pyproject.toml`、`pytest.ini` 或 `setup.cfg` 变成 `python3 -m pytest`；
- `go.mod` 变成 `go test ./...`；
- `Cargo.toml` 变成 `cargo test`；
- `pom.xml` 变成 `mvn test`；
- `gradlew` 变成 `./gradlew test`，否则 `build.gradle` 变成 `gradle test`。

复核检测结果。测试命令仍是项目代码；边界是沙箱，不是名字。

## 白名单

`agent-exec.json` 是普通 JSON。服务器从不接收模型给的 argv，只解析名字。

```json
{
  "workspace": "/Users/owner/project",
  "sandboxProfile": "/Users/owner/.clone/agent-exec.sandbox",
  "commands": [
    { "name": "test", "argv": ["npm", "run", "test"], "description": "运行测试套件。" },
    { "name": "typecheck", "argv": ["npm", "run", "typecheck"], "description": "运行 TypeScript 检查。" },
    { "name": "test:one", "argv": ["node", "--experimental-strip-types", "--test", "test/foo.test.ts"], "description": "运行单个测试文件。" }
  ]
}
```

在宿主机上编辑文件即可添加聚焦命令（Worker 不能写它）；重跑安装器会保留它。不要添加
`deploy`、`publish`、`start` 或长时间运行的服务。下一次 Worker 步骤会读取新文件；如果没生效，
重启运行时。

## 在任务里使用

一个修 Bug 的步骤会：

1. `agent-exec.list_commands` —— 看有哪些命令；
2. 用 `{"name":"test"}` 调用 `agent-exec.run_command` —— 复现失败；
3. 用 `edit_file` 修改；
4. 再跑测试，然后跑 `typecheck`；
5. `agent-tools.git_diff` —— 检查改动。

命令输出包含退出码、耗时以及 stdout/stderr 的尾部。非零退出会作为带输出的工具错误返回，
模型可以读完再试。完成判定仍归 Kernel，修复通道仍会跑自己的套件与 typecheck——执行器是反馈
回路，本身不是证据来源。

## 安全边界

- **没有 shell。** 服务器用 `execFile`/`spawn` 和 argv 数组执行，绝不把模型的文本解释成命令。
  模型只提供名字。
- **所有者白名单。** 只有 `agent-exec.json` 里的命令会运行。清单可审查、可编辑；添加命令是
  宿主机的有意动作。
- **最小环境。** 命令只收到 `PATH`、`HOME`、`LANG`、`TMPDIR` 与 `CI`；没有模型密钥、云 token、
  数据库密码或其他环境凭据。
- **macOS Seatbelt。** 命令由 `/usr/bin/sandbox-exec` 包裹，profile 来自
  `src/authority/seatbelt.ts`：写入只落在工作区、临时目录与包缓存（`~/.npm`、`~/.cache`）；
  网络关闭；内核的受保护根（密钥、浏览器档案、Journal 与策略）被拒绝；工作区的 `.git`
  禁止写入，因此测试不能提交、重置或改写检出。
- **超时与清理。** 每条命令默认 240 秒（最多 600 秒）；MCP 请求超时为 660 秒。超时会杀死
  命令的进程组；步骤结束时服务器会把自己的 SIGTERM 转发给仍在运行的命令。挂起的测试不能
  活过步骤。
- **输出上限。** 每个流保留最后 50KB，并标明被截断。巨大的通过日志会被缩短；结尾的失败摘要
  会保留。
- **没有沙箱就不运行。** 在没有沙箱的平台（或 `/usr/bin/sandbox-exec` 消失时），除非配置显式
  写 `allowUnsandboxed: true`，服务器拒绝执行。Apple 已弃用 `sandbox-exec`；如果未来的
  macOS 移除它，命令会拒绝运行，直到接上替代沙箱。
- **源码仍可能被改。** 测试脚本是项目代码，可以在工作区内覆盖源文件。这与 Worker 的
  `write_file` 是同一个写面；`.git` 与工作区之外是额外的边界。

## 卸载

在 `mcp.json` 中把 `agent-exec` 的 `"enabled"` 设为 `false`，或删除条目。然后删除
`mcp-servers/agent-exec-server.ts`、`agent-exec.sandbox` 与 `agent-exec.json`。重启运行时。

## 状态

声明、配置解析、命令检测、合并行为、真实允许命令、无沙箱拒绝、工作区外与 `.git` 内写入被拒、
超时与输出上限由 `test/agent-exec-mcp.test.ts` 覆盖（17 个用例）。真实探测仅限 macOS，没有
沙箱时跳过。命令与执行链路见
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) 的 2026-11-23 条目。
