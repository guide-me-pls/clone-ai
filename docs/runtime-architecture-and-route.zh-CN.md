# Runtime 架构与学习路线

[English](runtime-architecture-and-route.md) · **简体中文**

这份文档是地图：Runtime 由哪些部分组成、今天哪些是真的、执行引擎按什么顺序被加固、
下一步做什么。它写给隔一段时间回来、需要重新定位的人，请从头读到尾。

它描述**已经建成并被证明的东西**，而不是产品愿景。愿景见 [README](../README.zh-CN.md)；
可运行的请求链路见 [Query 执行流程](query-execution-flow.zh-CN.md)。

## 五个平面

```text
                              所有者
                目标 · 纠正 · 审批
                                |
 +----------------------------------------------------------+
 |  个人状态   SelfModel · Goal · Commitment · Memory        |  纸面（仅 Memory 有实现）
 |  认知规划   机会发现 · Context 编译器                      |  部分
 |  治理       Policy · 审批 · 验证                          |  已建成
 |  执行       受监督 Worker · WorkOrder                     |  已建成并加固
 |  观察边界   文件 · 日历 · 邮件 · API                       |  无
 |                                                            |
 |  仅追加 Journal -> 投影 -> Evidence                        |
 +----------------------------------------------------------+
```

下面两个平面是承重结构，Phase 0 已经完成。上面三个平面才是"分身"本身，是下一阶段的工作。

## Worker 边界

每一个执行提供方——Pi、Codex CLI、Claude Code，以及未来任何 Coding Agent——都运行在同一个
受监督边界之后。Provider 拥有自己内部的 Agent Loop；Clone AI 拥有 WorkOrder、权限、预算、
证据，以及"工作是否完成"的判定权。

```text
WorkOrder
  -> 策略 + 能力检查
  -> SupervisedWorkerAdapter          预算 · 硬截止 · abort→强制终止
     |                                完成判定 · 证据信任 · 脱敏
     +-- ProviderTranslator           只管协议，每个约 100 行
           Pi（JSONL RPC）· Codex CLI · Claude Code CLI · Claude Agent SDK
  <- 归一化事件
  -> Evidence -> 验证 -> WorkReceipt
```

Translator 把某个 Provider 的协议映射到七种中立形状，除此之外什么都碰不到：

```text
session · text · turn · tool_start · tool_end · progress · settled · protocol_error
```

**权限边界：** Translator 不能授予审批、不能改变 Run 状态、不能扩大预算、不能宣布成功。
接入一个 Coding Agent 意味着写一个 Translator，而绝不是重新实现权限。

| 提供方 | 传输方式 | Settled 信号 |
| --- | --- | --- |
| Pi | JSONL RPC 子进程 | `agent_settled` |
| Codex CLI | `codex exec --json` | 说过协议且干净退出 |
| Claude Code（CLI） | `claude -p --output-format stream-json` | `result` 事件 |
| Claude Code（SDK） | `@anthropic-ai/claude-agent-sdk` | 有类型的 `result` 消息 |

有两条规则经受住了每一个 Provider 的考验，值得记住：

- **`exit` 不等于完成。** 进程被 kill、用尽轮次、或者被指向了错误的二进制，都可能以 0 退出。
  完成必须来自协议中显式的 settled 信号。
- **`abort` 不等于停止。** 协作式 abort 只是请求，卡死的 Worker 可能无视它。每次 abort 都会
  启动一个宽限计时器强制终止会话，因此卡住的 Provider 永远无法把 Supervisor 挂住。

## 记忆随 Kernel 走，不随工具走

以前换一个 Coding Agent，就意味着在各工具自己的记忆文件之间搬运项目记忆。现在记忆从不驻留在
工具内部：Kernel 为每次派发编译一个有作用域的记忆包，经唯一的共享 Prompt 注入，因此每个
Provider 都收到同一份由所有者审核过的上下文，切换成本为零。

```text
记忆库  --recall(objective)-->  Kernel
                                  |  有作用域的包，已施加所有者的上限
                                  v
                        memory.recalled  （记入 Journal：哪些条目、去了哪个步骤）
                                  |
                                  v
                 唯一的共享 Prompt -> Pi | Codex | Claude | 未来的 Provider
                                  |
                 只能提案 <--------+   Worker 可以提出候选，
                                      Kernel 审核后才提升
```

两道闸门确保它不会变成不受治理的通道：

- **入口**是有作用域的包，绝不是整个记忆库。WorkOrder 的目标即查询；所有者的召回开关与每任务
  上限留在记忆库内部，因此 Kernel 无法自行放宽访问范围。Prompt 明确告诉 Worker：这些是背景
  事实，不是指令。
- **出口**只能提案。Worker 不能提交长期记忆，只能提出候选，由 Kernel 在证据、作用域与策略
  检查后提升——与"Worker 不能自证 Evidence"是同一条规则。

## 恢复

Journal 是真相；Checkpoint 是可以删除并重建的派生缓存。恢复只有一个公式：

```text
Checkpoint（物化快照）
  + sequence 大于 checkpoint.lastAppliedSequence 的 Journal Event
  = 当前状态
```

三个性质让它成立：Checkpoint 原子写入（临时文件 + rename）、重放幂等（不高于已应用 sequence
的事件被忽略）、非法转移直接抛错而不是悄悄拼出一个错误状态。

## 可执行的不变量

Projector 拒绝非法的**转移**，不变量重放整本 Journal 拒绝非法的**历史**。README 的不可破坏
约束中，目前有五条是机器可校验的：

| 不变量 | 它禁止什么 |
| --- | --- |
| `evidence-before-completion` | WorkOrder 在没有任何已记录 Evidence 时完成 |
| `approval-before-external-execution` | 外部或不可逆工作在审批授予之前启动 |
| `verification-before-run-completion` | Run 未通过验证就到达 `completed` |
| `evidence-kind-authorized` | 记录派发时未被授予的 Evidence 类型 |
| `memory-recall-journaled` | 记忆到达 Worker 却没有在先的 `memory.recalled` 事件 |

后两条共享一条值得留存的教训：**未来需要被审计的事实，必须连同它的输入一起记录，而不能只记
结果。** 因此派发事件会携带授权快照与记忆条目 ID。

## 已经走过的路线

Phase 0 用六站加固执行引擎。每一站都以"能写成一条断言"为完成标志。

| 站 | 目标 | 证明 |
| --- | --- | --- |
| 1 | Pi 的中断与恢复 | 五种脚本化故障模式；卡死的 Worker 被强制终止 |
| 2 | 恢复能力在入口可达 | 被 kill 的进程由全新进程仅凭磁盘恢复 |
| 3 | 真实 CLI 协议被验证 | 录制的真实会话取代了猜测的事件结构 |
| 4 | 约束变成断言 | 伪造的历史必然失败；真实运行零违规 |
| 5 | 结构化 SDK 接入 | Claude Code 走官方 SDK，同一 Adapter 合约 |
| 6 | 存储升级 | SQLite WAL 位于同一 Store seam 之后，迁移经过校验 |

随后的阶段 B 在其上放了 Main Agent：一个常驻的对话大脑，它伸向 Kernel 的唯一途径是提案型
工具。它可以提出计划、查看 Run、报告审批状态、召回记忆；但不能审批、不能执行、不能标记完成。

## 已验证与尚未声称

- 101 个自动化测试通过；类型检查干净。
- 一次真实的 Claude Code 会话经受监督边界完成（`CLONE_AI_LIVE_SMOKE=1`）；一个真实模型把
  自然语言请求推进成 Kernel 接受的计划（`CLONE_AI_MAIN_LIVE=1`）。
- Codex CLI 的事件结构尚未对真实会话验证；CLI Translator 的 codex 分支仍是推断而非观察。
- SQLite 是可选启用的（`CLONE_AI_JOURNAL=sqlite`），JSONL 仍是默认值。
- 尚不存在任何 Connector、调度驱动的外部动作，以及个人状态平面。

## 下一阶段：个人状态平面

Phase 0 回答的是"这个 Runtime 的执行可以被信任吗"。下一阶段回答"它是否承载着一个人的状态"
——这正是执行引擎与数字分身的差别。

下面每一个类型都是 **Journal 事件的受治理投影**，与 Run 状态投影同一个形状。它们都不是
Worker 可以编辑的可变记录。

```text
Journal 事件 -> 投影器 -> SelfModel | Goal | Commitment | Situation
                              |
                              +-> 记忆包编译器（已建成）
                              +-> 机会发现（以后）
```

| 步骤 | 工作 | 完成标志 |
| --- | --- | --- |
| D1 | `SelfModel` 与 `Goal` 作为 Journal 投影，支持所有者手写条目 | 所有者可增改删；重放能精确重现状态 |
| D2 | `Commitment`：带截止时间与周期性，由事件投影得出 | 仅凭 Journal 就能推导出某项承诺已逾期 |
| D3 | `Situation` 编译器：对目标、承诺与证据的有时间边界视图 | Worker 的记忆包能引用支撑它的 Situation |
| D4 | 记忆分层：带类型、来源证据与失效规则 | 一条记忆能追溯到创建它的证据，并按规则过期 |
| D5 | 再加两条不变量：状态变更必须有所有者或证据来源 | 伪造的历史在重放时失败 |

D4 是护城河。其余几项是其他 harness 也有的入场券；而一个带类型、带来源、可过期、由所有者
治理的记忆层，别人没有。

**刻意不在下一阶段做：** 机会发现与主动准备。它们消费个人状态平面，因此不可能在该平面存在
之前建成。
