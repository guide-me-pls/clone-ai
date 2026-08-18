# Agent Runtime 架构路线（学习笔记）

> 记录时间：2026-08-18 · 坐标：Phase 0 中段 · 分支参考：PR #10（证据信任）、PR #11（CLI 边界加固）已完成
>
> **2026-08-18 晚更新**：阶段 A（站 1-4）复验完成（`npm test` 67 个：66 过 1 跳过；`npm run typecheck` 干净）。
> 路线升级：执行引擎的六站路线不变（站 5-6 仍待做），但上层已定下 **Main Agent 架构决定与四阶段路线**（见第 5 节），阶段 B 从精读 Pi 源码开始。
>
> 这份笔记回答一个问题：**执行引擎（Agent Runtime）按什么顺序补完，每一步学什么、以什么为验收。**
> 上层平面（个人状态、认知规划、观察边界）不在本路线内，它们在第 6 站之后交接。

---

## 0. 当前坐标

```text
┌─ 观察边界（Connector：日历/邮件/文件）──────── 🔴 零
├─ 个人状态平面（SelfModel/Goal/Commitment）──── 🔴 纸面（仅 Memory 有约 340 行初版）
├─ 认知与规划平面（Opportunity/Context Compiler）🟡 10%（DemoPlanner + 受限 LLM Planner）
├─ 治理平面（Policy/审批/验证/证据授权）──────── 🟢 壳已搭好
└─ 执行与证据平面（Adapter/WorkOrder/Journal）── 🟢 壳已搭好，正在做防水  ← 本路线在这里
```

已验证的资产：44→54 个确定性测试；Pi JSONL RPC Adapter；受监督 CLI 边界（环境白名单、
证据授权、孤儿清理）；事件溯源 + 投影 + 原子 Checkpoint 的完整机器（`src/loop/`）。

已知但未修的洞（**2026-08-18 阶段 A 已全部修复**，保留原文供对照）：
- ~~`loop/cli.ts:16-17` 只接了 Journal，没接 Checkpoint Store~~ → 站 2 已通电，支持 `--resume <run-id>`。
- ~~`pi-agent-adapter.ts:171-174` 超时只发协作式 abort，Pi 挂死则永远等待~~ → 站 1 加了 abort 宽限期 + 硬终止。
- ~~`coding-cli-adapter.ts` 的 `textDelta`/`toolEvent` 事件格式是猜的~~ → 站 3 已对真实 claude-code 2.1.234 验证并修正（发现 3 处解析错误 + 1 处 Windows 启动 bug）。
- README 的 9 条不可破坏约束，没有一条是可执行断言 → 站 4 已把第 3/5/6 条变成 `src/core/invariants.ts` 的重放断言，其余待续。

---

## 1. 路线总览

| 站 | 名称 | 一句话目标 | 验收证明 |
|---|---|---|---|
| 1 ✅ | Pi 中断-恢复闭环 | 被打断的 Pi Run 能确定性恢复 | kill 中断后 resume，产物不重复、状态确定 |
| 2 ✅ | 恢复接主入口 | 重启进程后世界还在 | kill -9 → 重启 → 从 checkpoint+journal 续跑通过 |
| 3 ✅ | 真实 CLI 只读冒烟 | 协议猜测被真实事件流证实或证伪 | 真 codex/claude 跑通一个 read-only WorkOrder |
| 4 ✅ | 可执行不变量 | 约束从文档变成断言 | 违反约束的事件序列在测试中必然抛错 |
| 5 | SDK 结构化接入 | 删掉 stdout 启发式解析层 | Agent SDK / app-server 接入，猜测函数整块删除 |
| 6 | 存储升级 | JSONL → SQLite WAL | 断电/并发写测试通过，投影可重建 |

**阶段 A（站 1-4）于 2026-08-18 完成**，测试从 54 → 67（含 1 个 `CLONE_AI_LIVE_SMOKE=1` 门控的真实冒烟，已实跑通过）。各站"实际学到"：

- **站 1**：协作式 abort 必须配硬截止（宽限期后 `terminate`），否则 `ignore-abort` 场景永久挂住——测试先证明了挂住，再证明修复（704ms 内失败返回）。踩坑：fixture 输出必须 `writeSync`，`process.exit` 会截断异步 stdout。
- **站 2**：恢复机器本身早就有测试，缺的只是入口接线——"能力存在"和"能力可达"是两回事。跨进程测试的关键是让第一个进程死得不体面（`process.exit(137)` 不做清理），否则测的还是礼貌路径。
- **站 3**：录一次真实事件流值回票价——一次录制暴露 3 个解析错误（result 才是 settled 信号、result 文本被重复计入、工具事件在 content 块里）+ 1 个启动 bug（Node 拒绝无 shell spawn `.cmd`，CVE-2024-27980，须解析垫片背后的 claude.exe）。意外收获：环境白名单剥掉嵌套会话变量后，真实 CLI 认证反而通了。
- **站 4**：不变量 = 拒绝非法历史，projector = 拒绝非法转移，两层缺一不可。伪造历史的反向测试和真实运行的零违规测试必须成对出现，否则不知道断言是不是永真式。

顺序依据：站 1-2 是仓库自己声明的里程碑（`docs/initial-runtime.md:108`：
"proving Pi checkpoint/resume against interrupted real work"）；站 3 是
`docs/coding-cli-adapters` 承认欠下的冒烟测试；站 4 把前三站的成果锁死；站 5-6 是
在可信地基上做的置换。**每一站都以"能写出断言"为完成标志，写不出断言=还没学会。**

---

## 2. 各站详情

### 第 1 站 · Pi 中断-恢复闭环（约 1 周）

**为什么是现在**：正常路径已被 54 个测试覆盖；分水岭能力是"进程在任意一行死掉后，
世界处于什么状态"。CLI 边界已经练过一遍同样的故障注入（PR #11 的 5 种模式），搬到 Pi 是肌肉记忆。

**做什么**
1. 给 `test/fixtures/fake-pi-rpc.mjs` 加故障模式（环境变量开关，默认行为不变）：
   `die-mid-line`（半行 JSON 后自杀）/ `no-settle`（不发 agent_settled 就退出）/
   `ignore-abort`（收到 abort 装死）/ `garbage` / `double-settle`。
2. 每种模式一个测试，断言 `ExecutionEvent[]` 序列与确定终态。
3. **修 abort 挂死 bug**：`ignore-abort` 测试会证明 for-await 永远等待；修法是硬截止
   （超时后 `session.terminate()` + `Promise.race`），先写测试再修。
4. resume 语义测试：同一 sessionId 恢复后，Pi 端会话上下文仍在，已完成的部分不重跑。

**读什么**
- 自己的：`src/adapters/pi-agent-adapter.ts:177-287`（事件循环）、`:302-394`（进程边界）
- DSH：`docs/subsystems/subagent.md`（可续跑后台子 Agent）、`session-checkpoint-policy`
  的 README——对比它在哪个**语义时刻**落 checkpoint（模型响应后/工具提交后）与
  自己每事件全量覆写的差异

**学习点**：协作式取消 vs 硬截止；`agent_settled` 类显式完成信号；重复事件幂等。

**坑**：故障 fixture 别忘了 Windows 的 `\r\n`；`terminate` 后要断言进程真的退了（无孤儿）。

---

### 第 2 站 · 恢复接主入口（约 3-5 天）

**为什么**：`restoreLoopRun`（`src/loop/recovery.ts:12-22`）三行公式已实现且有单测，
但 `loop/cli.ts` 构造 AgentLoop 时没传 Checkpoint Store——文档宣称的恢复能力在默认入口是假的。
Phase 0 的验收（"重启 Daemon 后仍能准确恢复计划/尝试/验证/阻塞状态"）就卡在这里。

**做什么**
1. `loop/cli.ts` 接上 `JsonFileLoopCheckpointStore`，启动时先 `restoreLoopRun`：
   有未完成 Run 则续跑，而不是新建。
2. 写跨进程测试：子进程跑到 `waiting_tools` 时 kill -9 → 重启 → 断言从 checkpoint
   续跑且 `lastAppliedSequence` 之前的事件不重放副作用。
3. 对 `CloneRuntime` 做同样的审视：`subagent.resumed`（`runtime.ts:383`）只在进程存活时
   走 `adapter.resume`；补"从 journal 重建 Run 状态后再 resume"的重启路径。

**读什么**：`src/loop/run-state.ts:21-27`（sequence 去重）、`:215`（requireStatus 大声失败）、
`checkpoint.ts:24-26`（tmp+rename 原子写）——这 3 处是恢复正确性的全部支点。

**学习点**：Checkpoint 是可删的派生缓存，Journal 是真相；恢复 = 快照 + 重放高 sequence 事件。

**坑**：恢复后 Model Provider 会话是独立问题（`recovery.ts` 注释明说了）；第一版允许
"状态恢复了，模型上下文重建"，不要试图一步到位。

---

### 第 3 站 · 真实 CLI 只读冒烟（约 2-3 天，需要装 CLI）

**为什么**：`textDelta`/`toolEvent`/`sessionFrom` 的事件字段名全是猜测。假 fixture 只能证明
"如果协议长这样则处理正确"，不能证明协议真的长这样。

**做什么**
1. 装 codex CLI 或 Claude Code，用 `--sandbox read-only` / `--permission-mode plan`
   跑一个真实 read-only WorkOrder（例如"读 README 总结成五点"）。
2. 把真实事件流录成 fixture（脱敏后存 `test/fixtures/recorded-*.jsonl`），
   用录制回放代替手写猜测——以后协议变更时测试会先报警。
3. 修正猜错的字段；确认 `exec resume` / `--resume` 的恢复语义是否如假设。

**学习点**：录制-回放测试法；"设计完成"和"实测通过"之间的距离。

**坑**：真实 CLI 输出含机密（路径、token）——录制前过 `redactFreeText`；
冒烟测试标记为需要环境的可选测试，不进默认 `npm test`。

---

### 第 4 站 · 可执行不变量（约 3-5 天，可与站 3 并行）

**为什么**：README 的 9 条约束（"没有任何 Runtime 能直接标记完成"、"预测不是权限"…）
目前靠人肉遵守。攻击面每加一个 adapter 就翻倍，只有断言能守住。

**做什么**：建 `src/core/invariants.ts`，从 3 条起步——
1. `subagent.completed` 之前必须存在通过验证的 evidence 事件（同 WorkOrder）；
2. `external_side_effect` 风险的步骤必须存在先行的 `approval.granted`；
3. evidence 的 kind 必须在该 adapter 声明的 `evidenceKinds` 内（已有运行时检查，
   补成事后可审计的 journal 扫描）。
   违反即抛 + 一个"重放整本 journal 校验所有不变量"的测试工具（这也是站 6 的迁移验证器）。

**读什么**：DSH `docs/invariants` 与 `defensive-patterns`——"模型可见即已记录"是同一思想。

**学习点**：不变量 = 跨事件的全局断言，projector 里的 `requireStatus` 只是单状态机局部版。

---

### 第 5 站 · SDK 结构化接入（约 1-2 周）

**为什么**：站 3 之后你会确切知道 stdout 解析哪里脆。正确终态是官方结构化通道：
Claude Code 走 Agent SDK，Codex 走 app-server 协议。届时 `textDelta`/`toolEvent`/
`CLONE_AI_EVIDENCE` 魔法行整层删除，证据回到结构化事件。

**做什么**：精读 DSH `subagent-claude-code/src` 与 `subagent-codex/src` 的接法 →
为 Claude Code 写第二个 adapter（与 CLI adapter 并存，capabilities 区分）→
用站 3 的录制流做对照测试 → 稳定后废弃 CLI 解析路径。

**学习点**：同一 `RuntimeAdapter` 合约下替换 Provider 实现——这正是 README 第 9 条约束
（"接入的 Runtime 可替换"）的第一次真实演练。

---

### 第 6 站 · 存储升级 SQLite WAL（约 1 周，可延后）

**为什么**：JSONL 追加在单进程下够用；桌面端 + daemon 并存后需要并发写与崩溃一致性。
README 已规划 SQLite WAL + Drizzle。

**做什么**：Journal 接口后换 SQLite 实现（接口已是 seam，`JsonlJournalStore` 可留作测试用）；
迁移工具 = 站 4 的全量不变量校验器跑一遍旧 journal；断电模拟测试（写一半 kill）。

**学习点**：为什么 WAL 模式适合"单写多读"的本地 daemon；seam 让存储替换不动业务代码。

---

## 3. 交接点：Phase 0 完成的定义

六站走完时，以下句子全部为真：

- [ ] 任意时刻 kill 掉 Supervisor 或任何子 Agent，重启后状态确定、副作用不重复；
- [ ] 至少一个真实 Provider（Pi 或 Claude Code）完成过被中断的真实工作并恢复；
- [ ] 9 条约束中至少 3 条是重放 journal 即可机器校验的不变量；
- [ ] 换掉一个 Provider 实现（CLI→SDK）没有改动 Runtime 核心。

此时才开始画上层平面的类型：`SelfModel` / `Goal` / `Commitment` / `Situation` ——
它们全部实现为 **journal 事件的受治理投影**（与 `LoopRunState` 同一模式），
Memory 重构（MemoryItem 带来源证据与失效规则）也在此时动工。执行引擎的每一课
（真相在日志、状态是投影、完成要证据）会在那里第二次用上。

---

## 5. Main Agent 架构决定与四阶段路线（2026-08-18 定）

### 5.1 架构决定：Main Agent = Pi 形态二次开发

```text
┌─────────────────────────────────────────────────┐
│  Main Agent（大脑）                               │
│  = 在 Pi 的形态上二次迭代开发                       │
│  对话、理解意图、规划、提出 WorkPlan                 │
├─────────────────────────────────────────────────┤
│  clone-ai Kernel（权威）← 已完成的部分              │
│  Journal · Policy · 审批 · 证据验证 · 完成判定       │
├─────────────────────────────────────────────────┤
│  Worker 插件（手脚）← RuntimeAdapter 合约          │
│  Claude Code │ Codex │ Pi-RPC │ 未来 Runtime       │
└─────────────────────────────────────────────────┘
```

**为什么是 Pi 形态**：

- Pi 提供**进程内 TypeScript SDK**（`docs/work-orders-and-pi` 里早已写过这句话，第一版只是刻意选了 RPC 做进程隔离）；
- Pi 代码库小而可读，适合二次开发；
- 已有从外面驱动 Pi 的经验（站 1 的 RPC adapter），现在换成从里面改。

**边界红线（README 第 5/9 条约束的要求）**：Main Agent 是大脑，不是权威。
它对 Kernel 只能"提案"——`propose_work_plan` / `request_approval` / `recall_memory` /
`get_run_status` 全部做成它的 tool，每个 tool 的另一端是 Kernel 的校验逻辑。
这与现有 LLM Planner 是同一模式（只能返回结构化 `create_work_plan`，校验后才生效），
Main Agent 就是把这个模式从"一个 Planner 调用"扩大到"一整个常驻对话 Agent"。

**不可动摇的一条**：Pi 形态的 loop 可以换、可以崩、可以升级，Kernel 里的状态和
完成判定权永远不跟着走——这正是与 openclaw/hermes 的本质区别：它们的大脑和权威是
焊死在一起的。

### 5.2 四阶段路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| **A · 执行地基收尾**（= 站 1-4） | Kernel 先可信，再放更聪明的大脑 | ✅ 2026-08-18 完成：kill 任意进程后状态确定；abort 挂死已修；恢复在主入口真实可用 |
| **B · Main Agent 原型**（Pi 形态二次开发，2-4 周） | 精读 Pi 源码三块 → SDK 起 `clone-main` → CLI/companion 入口改为对话驱动 | 一句自然语言 → Main Agent 规划 → Kernel 校验 → 派发 Worker → 证据验证 → WorkReceipt；Main Agent 全程无法自证完成、无法绕过审批 |
| **C · Worker 插件化**（= 站 5-6，2-3 周） | Claude Code 走 Agent SDK、Codex 走 app-server 结构化 adapter；registry 从 settings 动态装载；SQLite WAL | 换掉一个 Provider 实现，Kernel 和 Main Agent 零改动 |
| **D · 个人状态平面**（分身的灵魂） | `SelfModel` / `Goal` / `Commitment` / `Situation` 全部实现为 journal 投影；Memory 分层重构 | Main Agent 的 `recall_memory` 从这里读——"执行引擎"变成"分身" |

### 5.3 阶段 B 起点（下一步）

1. 精读 Pi 源码三块：**agent loop / session 持久化 / extension 与 tool 注册机制**
   （用 SDK 扩展优先，fork 是最后手段——upstream 还在演进，钉住版本号 0.84.x）；
2. 用 Pi SDK 起 `clone-main` agent：clone-ai 专属 system prompt + 提案型 tools
   （`propose_work_plan` / `recall_memory` / `request_approval` / `get_run_status`），
   每个 tool 落到 Kernel 的现有校验路径；
3. 把 CLI / companion 入口改成经 Main Agent 对话驱动。

阶段 B 第 1 步的先行收获（2026-08-18 排查 shell 环境时顺带精读）：

- `dist/core/tools/bash.js`：bash 工具 = `spawn(shellPath, ["-c", command])`，
  `getShellConfig` 查找顺序 = settings.shellPath → Git Bash 固定路径 → PATH 上的 bash；
- `dist/core/settings-manager.js`：settings 启动时加载进内存，`reload()` 才重读；
  bash 工具的 shellPath 在 `_buildRuntime()` 创建工具定义时捕获（改文件后必须 `/reload`）；
- `dist/core/agent-session.js`：`executeBash` 每次动态读 `settingsManager.getShellPath()`
  （与 agent 工具路径的差异点，对 Main Agent 的 tool 设计有参考价值）；
- 开发环境备注：本机无 Git Bash（PowerShell 被系统层拦截，spawn UNKNOWN），
  `~/.pi/agent/settings.json` 的 shellPath 现指向 Python 3.13（`python -c` 兼容 bash 工具的调用方式）。

---

## 4. 学习方法约定（给未来的自己）

1. **先写故障测试，再修代码**——写不出断言的地方就是还没理解的地方。
2. **每站结束在本文件对应小节追加"实际学到/踩坑"三行**，坐标漂移时回来改第 0 节。
3. 反面教材和正面范本并排读（CLI adapter 旧版 vs Pi adapter），比只读好代码快一倍。
4. 假 fixture 证明"处理正确"，录制回放证明"协议正确"，两者缺一不可。
