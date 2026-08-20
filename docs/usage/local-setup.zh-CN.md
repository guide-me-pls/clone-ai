# 本地使用指南

[English](local-setup.md) · **简体中文**

在自己机器上运行 Clone AI 的方法，覆盖 Windows 与 macOS。运行时是本地优先的：
所有内容都在你的 clone home 下，除非你配置了外部集成，否则数据不会离开机器。

## 需要什么

- Node.js 24+（LTS）。Clone AI 直接跑 `node --experimental-strip-types`，无需构建步骤。
- 至少一个黑盒 Worker CLI。目前支持：**Claude Code**、**Codex CLI**、**Pi**、
  **opencode**。每一个都只是启动配方；Clone AI 不依赖你装了哪一个。

## 安装

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
npm install --ignore-scripts
npm run typecheck
npm test
```

## 启动 companion（GUI + daemon）

```bash
npm run companion:debug
# 然后浏览器打开 http://127.0.0.1:4317
```

桌面壳（Tauri）是打包版替代方案，它把同一个 daemon 作为 sidecar 构建；
`npm run desktop:build` 需要 Rust 工具链。

## 用 CLI 和 Main Agent 对话

```bash
npm run main -- "整理今天需要推进的事情"
npm run main -- "用 pi 调研这个项目的架构并写一份总结"
```

Main Agent 负责意图识别并路由到 Worker（你显式指定时以你为准），Kernel 在启动
任何进程之前完成全部校验。

## 各平台 Worker 配方

配方位于 `src/workers/providers.json`，可被 `<dataDirectory>/providers.json`
按用户覆盖。`command` 字段会自动解析：`claude.cmd` / `pi.cmd` 垫片会被追到真实
可执行文件，不需要 shell 也不需要手工写路径。

| Worker | Windows | macOS |
| --- | --- | --- |
| Claude Code | `claude.cmd`（npm 全局） | `claude` |
| Codex CLI | `codex.cmd` | `codex` |
| Pi | `pi.cmd` | `pi` |
| opencode | `opencode.cmd` | `opencode` |

凭据变量按配方白名单透传（`ANTHROPIC_*`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等）。
**不要把凭据值写进 `providers.json`**——那里只放变量名。

## 数据都在哪里

| 项目 | 位置 |
| --- | --- |
| Clone home | `~/.clone-ai/`（用户级）或 `CLONE_AI_DATA_DIR` |
| Journal | `<dataDirectory>/journal.jsonl`（`CLONE_AI_JOURNAL=sqlite` 切 SQLite） |
| 记忆索引 | `<dataDirectory>/memory-index.db` + `memory/*.md` |
| 坏案例日志 | `<dataDirectory>/reporting/bad-cases.md` |
| 用户 Provider 覆盖 | `<dataDirectory>/providers.json` |
| 失败分类目录 | `<dataDirectory>/outcomes/failures.json` |

`~/.clone-ai` 是用户级 home；工作区里遗留的 `.clone-ai/` 会在迁移完成后不再使用。

## 平台注意事项

- **Windows**：`.cmd` 垫片自动解析；超时时用 `taskkill /T` 终止整棵进程树，
  孤儿孙进程不会残留。测试套件挂起时先清理残留的 `claude.exe` 进程。
- **macOS**：终止使用 POSIX 进程组；配方直接用裸命令名。

## 首次运行检查清单

1. `npm test` 全绿。
2. `npm run main -- "你好"` 有回复（Main Agent 工作）。
3. 至少一个 Worker 已安装并在 GUI 设置 → Agent Registry 中可见。
4. 一个真实任务端到端完成（见下面的可靠性基准）。
5. 坏案例开始累积到 `reporting/bad-cases.md`——这份文件就是你优化循环的输入。

## 可靠性基准

```bash
npm run bench          # 对真实 pi 跑固定任务集（几美分）
```

见 [benchmark/README.zh-CN.md](../../benchmark/README.zh-CN.md)。
