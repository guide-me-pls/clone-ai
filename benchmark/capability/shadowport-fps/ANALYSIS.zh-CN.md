# Shadowport FPS 评测 — 基线分析（2026-11-18）

[English](ANALYSIS.md) · **简体中文**

这是 [Shadowport 一次性 FPS 评测](README.zh-CN.md) 的第一次实测。它问的是：在干净工作区里，
一条用户消息能不能产出一个可玩的战术 FPS，并且由 Agent 自己验收。这里的答案是**可以，但有
前提**：第二次干净运行产出了 8 个敌人、三处中继、撤离与结算的 FPS，浏览器工具零错误，并通过
独立检查器 17/17。终态是 `waiting_review` 而不是 `completed`，因为计划的验收标准是散文，
不是 Kernel 能机器读取的文件/测试契约。

## 1. 方法与复现

| 项 | 值 |
| --- | --- |
| 被测链路 | Main Agent（native）→ Kernel 队列 → native worker |
| 命令 | `CLONE_AI_MAIN_EFFORT=medium node --experimental-strip-types eval-runs/2026-11-17-browser-mcp/run.mjs <workspace> <clone-home> benchmark/capability/shadowport-fps/prompt.md` |
| Provider / 模型 | native / `openai/gpt-6.1-terra` |
| 强度 | Main `medium`；Worker `high` |
| Worker 限制 | `MAX_ROUNDS=60`、`MAX_TOKENS=24000`、工作单时长 600 秒 |
| 工具集 | 四个文件工具 + 本地 Playwright MCP 子集（navigate、console、snapshot、evaluate、screenshot、press_key、resize、wait、back、close） |
| 工作区 | 由 `setup.mjs` 生成；只有 `index.html`、空 `game.js`、`vendor/three.iife.js`、`AGENTS.md` |
| 提示词 | [`prompt.md`](prompt.md)，一段话 |
| 检查器 | [`verify/check-shadowport.mjs`](verify/check-shadowport.mjs)，17 项检查 |
| 机器 | macOS 27.0.0 arm64，Node v26.8.1，Google Chrome 157 |
| 结果文件 | `eval-runs/2026-11-18-shadowport-clean2/run.log`、`home/journal.sqlite3`、`ws/`、`verify/out/report.json`、`audit-shadowport.jsonl`、`dist/shadowport.html` |

**Benchmark 记录（AGENTS.md 第 5 条）。** 这是基线测量，不是变更门禁，因此没有前后对比；
命令、模型、参数、任务与结果路径都在上表与 `run.log` 中。

## 2. 结果

| 运行 | 工作区 | 模型调用 | Token 输入/输出/总计 | 耗时 | Run 状态 | 检查器 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| clean1 `c8e69c85` | 全新 | 22 | 357,772 / 15,776 / 373,548 | 207.1 秒 | `waiting_review` | 17/17；**Worker 自查失败**（旧端口 8137 vs MCP 8138） |
| clean2 `2e8e10a8` | 全新 | 33 | 724,977 / 19,213 / 744,190 | 312.8 秒 | `waiting_review` | **17/17；Worker 自查通过** |

自查通过的是 clean2。它的 Main Agent 回合 17.9 秒 / 3 次调用（10,358 tokens），Worker 步骤
312.8 秒 / 33 次调用。Worker 的 Journal 中：2 次 `browser_navigate`、4 次
`browser_console_messages`、18 次 `browser_evaluate`、6 次 `browser_take_screenshot`、
5 次 `browser_press_key`，**零工具错误**。它保存了 `shadowport-menu.png`、
`shadowport-game.png`、`shadowport-relay.png`、`shadowport-debrief.png`。

### 检查器输出（clean2）

```
PASS  file.index.html, file.game.js, file.vendor/three.iife.js
PASS  classic-script, local-three
PASS  hook — state,player,enemies,relays,begin,pause,resume,fire,reload,interact,nearTarget,endGame
PASS  start — phase playing, health 100, ammo 30, 8 enemies, 3 relays
PASS  movement — 移动 2.73 米
PASS  shot — 弹药 30→29，敌人生命 100→-10（爆头）
PASS  relays-cut — [true,true,true]
PASS  extraction — phase ended
PASS  debrief — 结算可见
PASS  console — 0 错误
PASS  external-requests — 0
17/17
```

## 3. Worker 实际做了什么

Main Agent 用 `propose_work_plan` 排了一个自包含 step（3 次模型调用），对话回合 17.9 秒返回。
Worker 读取工作区，写出 `game.js` 与 `index.html`，然后用浏览器工具：

- 打开 `http://127.0.0.1:8138/`，等待首帧；
- 每次修改后读控制台；
- 用 `window.__game` 断言状态，移动玩家、向敌人开火、切断三处中继、到达撤离点；
- 保存菜单/游戏/中继/结算截图。

工件是一个 classic-script Three.js 页面：雨夜集装箱港、第一人称、指针锁定、开镜/姿态、带爆头
的命中扫描步枪、巡逻/警戒/掩体/增援的敌人、三中继目标、结算和最小本地 HUD。它不是 3A 游戏，
是一次性 query 产出的可玩原型。单文件构建
`eval-runs/2026-11-18-shadowport-clean2/dist/shadowport.html`（705 KB）可从 `file://` 打开，
零外部请求，并通过同一次浏览器检查的开始/移动/中继/撤离。

## 4. 基线对 harness 的结论

- **排队很重要。** 同类构建此前在 `dispatch_task` 里卡住主 Agent 约 50 分钟；排队计划 17.9 秒
  返回，Worker 单独执行。
- **最后一轮预算提示很重要。** 用满 60 轮、工件完整却没有回答的构建会判失败；预留两轮后它会
  停下并报告。
- **浏览器工具很重要。** Worker 自己的控制台/状态/截图回路，是它与"盲写文件"的分界；自查通过
  的那一轮 Playwright MCP 零工具错误。
- **预览端口不匹配是 harness 失败，不是游戏失败。** clean1 的游戏外部检查 17/17，而 Worker
  查的是旧 8137；`setup.mjs` 的端口替换就是为防止这一点。

## 5. 限制

- 每种配置只跑一次；还没有统计重复或模型对比。
- 检查器驱动公开钩子，不测人手感中的枪械、音频或"好玩"；这些仍需所有者试玩。
- `waiting_review` 是终态，因为计划的标准是散文；机器可读的测试契约才能让 Kernel 判完成。
- Windows 显卡与非 Chrome 浏览器未实测。
- 成本是真实的：自查通过的一轮 744k tokens、约 5.5 分钟。
- 评测的是战术 FPS 原型，不是与商业作品持平。

## 6. 复现

```bash
node benchmark/capability/shadowport-fps/setup.mjs --workspace /tmp/shadowport-clean --three /path/to/three.module.js --port 8138
node scripts/serve-workspace.mjs --root /tmp/shadowport-clean --port 8138
node --experimental-strip-types scripts/install-browser-mcp.mjs --workspace /tmp/shadowport-clean --clone-home /tmp/shadowport-home --port 8138
CLONE_AI_MAIN_EFFORT=medium node --experimental-strip-types eval-runs/2026-11-17-browser-mcp/run.mjs /tmp/shadowport-clean /tmp/shadowport-home benchmark/capability/shadowport-fps/prompt.md
node benchmark/capability/shadowport-fps/verify/check-shadowport.mjs --workspace /tmp/shadowport-clean --out benchmark/capability/shadowport-fps/verify/out --port 8140
```
