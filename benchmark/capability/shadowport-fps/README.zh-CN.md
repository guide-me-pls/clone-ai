# Shadowport 一次性 FPS 评测

[English](README.md) · **简体中文**

只测一件事：**一条用户消息**能不能在**干净工作区**里产出一个可玩的战术 FPS，以及 Agent
能不能用浏览器自己验收，而不是让所有者去点。它是能力评测，不是画面比赛；场景、机制与美术由
模型自己决定。

## 提示词

[`prompt.md`](prompt.md) 就是全部用户消息，一段话。这个评测存在的意义就是让它保持这么短：
质量来自 harness（浏览器工具、预览服务器、预算纪律、验收契约），不是来自更长的提示词。

## 工作区契约

[`setup.mjs`](setup.mjs) 准备一个干净工作区：

- `index.html` —— 带 canvas 的最小 classic-script 页面；
- `game.js` —— 空文件；
- `vendor/three.iife.js` —— 以全局 `THREE` 构建的 Three.js r170；
- `AGENTS.md` —— [`workspace-AGENTS.md`](workspace-AGENTS.md)，替换预览端口。

规则要求 classic script（无 ES module、无 CDN）、本地预览服务器，以及一个很小的公开测试钩子：

```js
window.__game = { state, player, enemies, relays, begin, pause, resume, fire, reload, interact, nearTarget, endGame };
```

`state.phase` 依次为 `menu` → `playing` → `ended`；`player.position` 是 `THREE.Vector3`；
`relays` 有三项，各带 `position`/`cut`；`enemies` 带 `position`/`health`/`alive`；
`state.extraction` 是 `{x, z}`。

钩子是任务的一部分，不是测试的事后补丁：检查器读不到的游戏无法评分。

## 准备

```bash
node benchmark/capability/shadowport-fps/setup.mjs \
  --workspace /tmp/shadowport-clean \
  --three /path/to/three.module.js \
  --port 8138
```

`setup.mjs` 使用仓库开发依赖里的 `esbuild` 构建 IIFE；它不写任何游戏代码。

## 运行

```bash
# 1. 本地预览服务器（只读、环回）
node scripts/serve-workspace.mjs --root /tmp/shadowport-clean --port 8138

# 2. 把浏览器 MCP 装进隔离 clone home
node --experimental-strip-types scripts/install-browser-mcp.mjs \
  --workspace /tmp/shadowport-clean --clone-home /tmp/shadowport-home --port 8138

# 3. 一条用户消息
CLONE_AI_MAIN_EFFORT=medium node --experimental-strip-types eval-runs/2026-11-17-browser-mcp/run.mjs \
  /tmp/shadowport-clean /tmp/shadowport-home \
  benchmark/capability/shadowport-fps/prompt.md
```

主 Agent 必须用 `propose_work_plan` 排队（长构建不能占住对话回合），Worker 必须用
`playwright.*` 检查控制台/状态并保存截图。运行元数据：Provider
`360/openai/gpt-6.1-terra`，Worker 强度 `high`，`MAX_ROUNDS=60`、`MAX_TOKENS=24000`，
工作单时长 600 秒。

## 检查

```bash
node benchmark/capability/shadowport-fps/verify/check-shadowport.mjs \
  --workspace /tmp/shadowport-clean \
  --out benchmark/capability/shadowport-fps/verify/out \
  --port 8140
```

检查器自己起静态服务器、驱动钩子，写出 `report.json` / `report.txt` / `shadowport.png`；
它不信任工作区自己的报告。

17 项检查，全部通过才算通过：

| 组 | 检查 |
| --- | --- |
| 文件 | `index.html`、`game.js`、`vendor/three.iife.js` |
| 运行 | 无 ES module 入口；本地 Three |
| 钩子 | 必需的 `window.__game` 键 |
| 开始 | phase `playing`、生命/弹药、≥5 个敌人、3 处中继 |
| 移动 | `W` 使玩家移动 >0.2 米 |
| 战斗 | 一次射击消耗弹药并扣除敌人生命 |
| 任务 | 3 处中继切断；撤离结束游戏；结算可见 |
| 卫生 | 0 控制台错误；0 外部请求 |

## 基线

实测运行、token/耗时成本、逐项检查与已知限制见 [`ANALYSIS.zh-CN.md`](ANALYSIS.zh-CN.md)。
简版：干净的一段话运行产出了可玩的 7 敌人 FPS，含中继、撤离与结算；外部检查器 17/17 通过。
第一次干净尝试的 Worker 自查打到了过期的预览端口；第二次用匹配端口，是自查通过的基线。

## 为什么这是评测集，不是演示

- 工作区从空开始，模型不能依赖上一版。
- 检查器独立于 Worker 的报告，并驱动公开钩子。
- 成本被记录：没有 token 与墙钟时间的分数只是轶事。
- 提示词只有一段话，所以胜利是 harness 的胜利，不是提示词的胜利。
