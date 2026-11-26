# 本地使用指南

[English](local-setup.md) · **简体中文**

Clone AI 是一个 macOS 桌面应用。窗口背后是常驻的本地运行时
（`src/desktop-sidecar.ts`），经环回地址服务界面；Journal、记忆、调度、审批与
Main Agent 都在这个运行时里。除非你配置了外部模型或集成，数据不会离开这台设备。

## 1. 环境要求

- macOS（Apple Silicon 或 Intel），安装 Xcode Command Line Tools（`swiftc`、
  `codesign`）。
- Node.js 24+ —— 运行时直接运行 TypeScript，没有构建步骤。
- Git。

## 2. 构建与启动

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
npm install --ignore-scripts
npm run desktop:mac:build
open "dist/Clone AI.app"
```

`npm run desktop:dev` 会按需构建原生外壳并启动源码；修改界面或运行时时用它。

## 3. 常驻运行时

窗口不是运行时。安装一次当前用户的 LaunchAgent：

```bash
node scripts/install-daemon.mjs            # 安装并加载 ai.clone.companion
node scripts/install-daemon.mjs --uninstall
```

此后分身随登录启动、崩溃后重启，关闭窗口也不会停止——App 会附着到守护进程发布的
端点（`~/.clone/companion-endpoint.json`）。升级 Node 后要重新运行安装脚本，因为
plist 固定了 node 的绝对路径。

### 维护自动化

`npm run repair`、`scripts/nightly-rsi.mjs` 与评测 companion 在各自的 clone home
（`<repo>/.automation/<用途>`，或 `CLONE_AI_AUTOMATION_HOME`）里运行。该 home 会从
`~/.clone` 播种一次 `config.json`/`settings.json`/`providers.json`/`mcp.json`/
`policies.json`；Journal、记忆、会话、令牌、端点与锁绝不复制。修复通道只读地读取所有者
home 里的失败轨迹。`CLONE_AI_AUTOMATION_REFRESH=1` 重新播种配置副本；
`CLONE_AI_ALLOW_OWNER_HOME=1` 是共享在线 home 的显式退路。不存在浏览器预览：
已安装窗口是唯一的界面；UI 开发请用 `npm run desktop:dev`。

## 4. 配置模型

打开 **设置 → Agent**。可以应用本地 Magpie 网关暴露的模型，也可以在那里填写端点
与密钥。密钥是只写的：保存后 App 只显示“已保存”，不会回显。开发时仍可使用
`CLONE_AI_NATIVE_MODEL`、`CLONE_AI_NATIVE_BASE_URL` 与 `CLONE_AI_NATIVE_API_KEY`。

### 主 Agent 运行时

进程内的原生运行时是唯一的主 Agent 运行时。它写入相同的 `main_agent.turn_*`、
`agent.tool_*` 与 `usage.recorded` 事件，以回合台账作为对话记录，并从台账检索
`search_history`。它会随 token 到达流式输出，并对长对话做确定性压缩：最新轮次在
12,000 字符预算内保留原文，较早轮次变成有界摘要，全文仍留在回合台账中。图片附件以
OpenAI 风格 data URL 随当前消息发送；它们是逐回合的，不存入台账。

## 5. 桌面里的所有者控制

- **对话** —— 提问、批准或拒绝外部动作、接受或拒绝需要复核的结果。Main Agent 需要选择时
  会用 2–4 个按钮提问，你的点击会恢复同一回合。所有任务里等待你确认或复核的决定都固定在你
  正在读的对话顶部；macOS 通知只是提示，不是作答的地方，也不必打开任何任务页。
- **设置 → 权限与安全** —— 按域的自主档位与所有者撰写的常设策略；每次变更写入 Journal。
- **设置 → 记忆与数据** —— 记忆库、受治理的变更与撤销，以及**导出全部数据**：选择
  一个文件夹，运行时会写入带时间戳的归档（清单 + 数据副本），不放在 clone home 里。
- **设置 → 上下文** —— 压缩记录与完整历史搜索。
- **设置 → 手机通道** —— WhatsApp 绑定与公网 Webhook 隧道。
- **设置 → 审计与评估** —— Run、主 Agent 回合、Agent 调用、坏案例、自检轮次、
  改进建议，以及取消正在运行的 Run。

## 6. Worker

Clone AI 只有一个执行 Provider：进程内的原生 Worker。它不是 CLI；每次工具调用都在
发生的瞬间对照步骤的 Scope 检查，token 用量也精确记录。

| Worker | 运行方式 | 配置 |
| --- | --- | --- |
| 原生 Worker | 进程内循环，对接 OpenAI 兼容端点 | 在「设置 → Agent」中配置 |

黑盒 CLI Worker（Claude Code、Codex、Pi CLI、opencode）已移除。CLI 会把工具调用与
凭据藏在 Kernel 看不到的地方，harness 既无法审计也无法拦截。`external` 角色在有受治理的
动作连接器之前没有 Provider。

### Worker 并发

Kernel 根据实测的机器容量决定同时运行多少个 Worker：CPU 核数、1 分钟负载均值与空闲
内存。这不是你配置的，也不是主 Agent 配置的——主 Agent 只能读取它（`get_capacity`）
来决定计划规模。

要自己固定上限，在 `config.json` 里设置 `maxConcurrentWorkers`。`0` 或未设置表示自动。
固定值会被核数上限约束，并在每次派发时重新读取，因此改动无需重启即可生效。

### Main Agent 并发

每个任务都是自己的 Main Agent 对话，拥有自己的转录。一个任务在执行子任务，不会阻止另一个
任务开始。同时运行的 Main Agent 回合数在每次获取槽位时按 CPU 与负载实测：CPU 核数的一半
（机器有余量时给两个）；1 分钟负载达到核数一半时再减半；上限不超过八个；负载高时可降到一。
内存在这里不是上限——Worker 的内存在其运行处设有闸门。超过上限的回合等待槽位；同一任务的两个
提示仍会碰撞并返回 409。

要自己固定上限，在 `config.json` 里设置 `maxConcurrentMainAgents`。`0` 或未设置表示自动；
固定值会被核数上限约束，并对下一个回合生效，无需重启。

## 7. 数据都在哪里

| 项目 | 位置 |
| --- | --- |
| Clone home | `~/.clone`（或 `CLONE_AI_DATA_DIR`） |
| Journal | `<clone home>/journal.jsonl`（`CLONE_AI_JOURNAL=sqlite` 启用 WAL） |
| 记忆 | `<clone home>/memory-index.db` + `<clone home>/memory/*.md` |
| 坏案例 | `<clone home>/reporting/bad-cases.md` |
| 权限 | `<clone home>/policies.json` |
| 失败分类目录 | `<clone home>/outcomes/failures.json` |
| 隔离工作区 | `<clone home>/isolated-workspaces/` |
| 所有者导出 | 「设置 → 记忆与数据」里选择的文件夹 |
| 环境变量模板 | 仓库中的 `.env.example`（只有变量名，绝不放密钥值） |

## 8. 平台注意事项

- **macOS**：Worker 运行在自己的 POSIX 进程组中并按组终止。构建 App 需要 Xcode
  Command Line Tools。
- **Windows**：Tauri 外壳仍可用 `npm run desktop:build` 构建；`.cmd` 垫片会被解析为
  真实可执行文件，超时时用 `taskkill /T` 终止 Worker 整棵进程树。

## 9. 首次运行检查清单

1. `npm run desktop:mac:build` 后 `open "dist/Clone AI.app"` → 窗口打开。
2. 设置 → Agent：配置模型，发送一条消息 → Main Agent 回复。
3. 审计与评估 → 运行记录里能看到这次 Run。
4. 设置 → 权限与安全：文件、Shell 与网络默认「全部放行」（`allow_all`）：步骤无需逐目标 Scope，外部/不可逆动作也不再确认；受保护位置仍关闭。想要逐 Scope 审批选「批准」，想要模型判断 + 外部确认选「自动执行」。
5. 设置 → 记忆与数据 → 导出全部数据：导出一次，检查 `manifest.json`，然后把目录收好。
6. 审计与评估 → 坏案例开始累积失败——这份文件驱动你的优化循环。

## 10. 维护入口

这些是自动化脚本，不是产品 CLI。桌面 App 仍是所有者界面。

```bash
npm run traces -- list | export | show <runId> | clear --yes
npm run selfcheck -- [--full] [--repair]
npm run repair -- [--dry-run] [--keep] [--max-traces N] [--agent <id>] [--base <ref>]
npm run audit:export -- [--out <file>]
npm run bench
```
