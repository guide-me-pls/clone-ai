# 优化成果

[English](optimization-results.md) · **简体中文**

本文件记录**真正有效的优化**，每条对应一次经过验证的改进，新的在前。每条写明主张、支撑
它的证据（命令、数字、结果文件），以及完整过程记录在哪里。

**负优化**——eval 显示没有收益、出现回退，或被撤销的——**不写在这里**。它的取舍条目仍保留在
[`docs/architecture/trade-offs.md`](../architecture/trade-offs.md)，作为决定与推翻条件的记录。
推理过程与执行链路留在 [`optimizations.md`](optimizations.md)；本文件只保留值得引用的成果。

规则见 [`AGENTS.md`](../../AGENTS.md) 第 6 条。

## 2026-11-13 — 主 Agent 会读仓库自己的规则

- **主张：** clone-main 现在把工作区的 `AGENTS.md` / `CLAUDE.md`、嵌套 Claude 文件与
  `.claude/rules/*.md` 加载进系统提示词，并标注为项目指令；导入不能离开工作区，这一层有上限、可关闭。
- **证据：** `test/project-instructions.test.ts` 7/7（顺序、嵌套路径、工区内导入展开、区外导入与符号
  链接逃逸被拒绝、循环终止、截断写明、开关关闭）。在本仓库端到端验证：真实主 Agent 回合的提示词材料记录
  `[{ path: "AGENTS.md", bytes: 11576 }]`，编译后的系统提示词包含 `npm run gate`；变更前
  `grep -rn 'AGENTS.md' src/` 什么都没有。全量套件 677/677；typecheck 与 `npm run gate` 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-13--主-agent-读取项目指令文件并按信任类标注)、
  [执行链路](optimizations.zh-CN.md#2026-11-13--记忆对比找出的四项差距)。

## 2026-11-13 — 记忆编辑可以撤销

- **主张：** 每次所有者可见的记忆变更都会记录变更前的状态，撤销会把该状态作为可审计的
  `memory.updated` 回退恢复；第二次撤销会再往前回退一次变更。
- **证据：** `test/memory-versions.test.ts` 5/5（编辑撤销回原始摘要与正文、撤销事件带
  `source: "undo"` 与被恢复的版本 id、二次撤销返回更早状态、归档撤销回 `active`、无变更时拒绝、
  历史上限 20）。全量套件 677/677；typecheck 与 `npm run gate` 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-13--记忆编辑带版本撤销恢复上一个版本)、
  [执行链路](optimizations.zh-CN.md#2026-11-13--记忆对比找出的四项差距)。

## 2026-11-13 — 巩固用终于有了调用方的信号提出合并建议

- **主张：** 闲置改进扫描会为同类型、达到实测重叠阈值的记忆提出合并建议；批准后手写合并记忆并把来源以
  `retired` 归档，因此合并可逆。
- **证据：** `test/memory-consolidation.test.ts` 5/5（改写句对被提出且保留较新陈述、无关与跨类型忽略、
  显式修订被排除、secret 被排除、批准后剩一条活跃记忆与两条原因 `retired` 的归档）。此前
  `findConflicts` 没有生产调用方。全量套件 677/677；typecheck 与 `npm run gate` 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-13--后台巩固只提出合并建议仍由所有者决定)、
  [执行链路](optimizations.zh-CN.md#2026-11-13--记忆对比找出的四项差距)。

## 2026-11-11 — 修复通道产出了经过验证的修复

- **主张：** clone-ai 自己的修复通道产出了"按 token 的压缩不可达"这一缺陷的修复，工作 Agent
  只做功能验证，没有重写补丁。
- **证据：** 补丁修改 `src/main-agent/native-runtime.ts`，让压缩始终启用、默认 128,000 token
  窗口。回归用例 `test/regression/audit-ctx-1.test.ts` 在 `8e9bbd4` 上为**红**（没有
  `main_agent.context_compacted` 事件），打补丁后为**绿**；全量套件 634/634、typecheck 与
  `npm run gate` 通过。由 DeepSeek V4.1 Flash、`reasoning_effort=max` 经
  `clone-ai repair`（运行 `bd3451a6`）产出，依据捕获的请求/响应轨迹审查。
- **位置：** [Worker 流式上报与停止指令](../architecture/trade-offs.zh-CN.md#2026-11-11--worker-流式上报活动修复通道说清何时停止)、
  [窗口读取与片段拒绝](../architecture/trade-offs.zh-CN.md#2026-11-11--读取按窗口进行并给出总数写入拒绝片段)、
  [执行链路](optimizations.zh-CN.md#2026-11-11--让修复通道可审查)。

## 2026-11-10 — 作用域闸门现在拒绝它声称会拒绝的东西

- **主张：** 逐次路径闸门拒绝工作区内指向外部的符号链接，读授权不能授权写，覆盖受保护根的
  祖先授权被拒绝，写入 `.git` 被拒绝。
- **证据：** `test/path-gate.test.ts` 4/4 覆盖以上四项；修复前每项都在仓库自己的模块上复现过——
  `decideTool` 对 `link/secret.txt` 与 `link/new.txt` 返回 `{allowed: true}`，`~/Library` 的
  授权被接受且 `dropped: []`。全量套件 626/626；typecheck 与 `npm run gate` 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-10--scope-检查比较解析后的路径修复通道的闸门真正生效)、
  [执行链路](optimizations.zh-CN.md#2026-11-10--关闭审计中已核实的缺陷)。

## 2026-11-09 — 共享循环内核、逐次授权与可记录的压缩

- **主张：** Main Agent 与原生 Worker 运行同一套循环契约；每次工具调用在执行前被决定；
  长转录按 token 压力压缩并记录丢弃了什么；MCP 与技能按回合显式开启，不改变没有请求它们的回合。
- **证据：** 上游“仅原生 Worker”迁移合并后，确定性套件从 585 个测试 / 4 失败（迁移遗留）变为
  **560 个测试、560 通过、0 失败**；`test/agent-loop.test.ts` 14/14 覆盖终止原因、并发屏障、
  工具配对、预算、abort、重试、截断与 deny/ask/allow；`test/context-window.test.ts` 8/8；
  `test/mcp-host.test.ts` 5/5（对真实 stdio 子进程）；`test/skill-loader.test.ts` 5/5；
  原生 Worker/客户端 17/17；一个端到端 Main Agent 回合同时调用技能与 MCP 工具。
  `npm run typecheck` 与 `npm run gate` 通过。没有实机模型调用，因此这是 harness 契约收益，
  不是质量测量。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-06--每个进程内工具调用都经过逐次决定)、
  [压缩取舍](../architecture/trade-offs.zh-CN.md#2026-11-06--压缩按-token-计算并落记录先确定性摘要)、
  [MCP 与技能取舍](../architecture/trade-offs.zh-CN.md#2026-11-06--先做-mcp-与-skills插件云vmcomputer-use-延后)、
  [执行链路](optimizations.zh-CN.md#2026-11-09--逐次权限上下文压缩mcp-与技能)。

## 2026-11-07 — Worker 并发跟随实测机器容量

- **主张：** 派发并发由实测的 CPU、负载与空闲内存约束，而不是计划形状；队列与每个子 Agent
  波次共享一份预算，模型可以读上限但不能设置它。
- **证据：** `test/capacity.test.ts`（6 个用例：CPU 受限、内存受限、负载敏感、所有者固定值
  受核数约束、闸门不超限且按序唤醒、取消等待释放槽位）。全量 525/525；typecheck 与
  `npm run gate` 通过。大主机上的端到端吞吐尚未测量；已验证的主张是"任何执行都不会超过
  上限"。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-06--worker-并发跟随实测机器容量硬上限由-kernel-掌握)、
  [执行链路](optimizations.zh-CN.md#2026-11-06--worker-并发跟随实测机器容量)。

## 2026-11-06 — 唯一可审计的执行路径

- **主张：** 主 Agent 与每个 Worker 都是我们自己写的进程内循环。Pi SDK 与所有黑盒 CLI Worker
  已移除，因此每个回合、每次工具调用都被 Kernel 记录并放行；没有 CLI 能带着隐藏的工具或
  凭据运行。
- **证据：** `package.json` 移除 `@earendil-works/pi-coding-agent`；删除
  `black-box-cli-worker`、`worker-registry`、`worker-env`、`providers.json` 及其测试；
  移除后全量 519/519；typecheck、`npm run gate` 与双语文档通过。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-06--只保留自己的-agent去掉-pi-sdk-与黑盒-cli)、
  [执行链路](optimizations.zh-CN.md#2026-11-06--移除黑盒-cli-worker两步中的第二步)。

## 2026-11-06 — 原生主 Agent 与 Pi 持平，tokens 更少

- **主张：** 在固定的主 Agent 任务集上，原生循环的结果与 Pi 一致，且 tokens 略少。
- **证据：** 每格 5 个样本，`360/deepseek/deepseek-v4.1-flash` 经 Magpie，结果文件
  `benchmark/results/main-agent-2026-11-06T02-07-58-472Z.json`：两边均 **15/15**；中位
  耗时合计 **原生 17.2s vs Pi 20.0s**；中位 tokens **17,973 vs 19,081**（少约 5.8%）；
  plan 的 p90 **15.8s vs 26.9s**。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-循环放在开关后而不是一次性切换)、
  [执行链路](optimizations.zh-CN.md#2026-11-06--五次样本确认)。

## 2026-11-06 — 原生主 Agent 支持流式、压缩与图片

- **主张：** 原生循环随 token 到达输出，长对话在预算内保留且不丢全文，并接受图片附件。
- **证据：** 长对话实机运行——24 条种子轮次、4,000 字符预算、2,121 字符摘要到达端点、
  最老一轮的针保留、回复恰好是 `BLUE-FALCON`、7,842 tokens、五项检查全为真
  （`benchmark/results/native-main-long-context-2026-11-05T09-43-52-438Z.json`）。
  图片实机运行——64×64 红色 PNG，回复 `Red.`，3,806 tokens
  （`benchmark/results/native-main-images-2026-11-05T10-01-47-161Z.json`）。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-流式输出并做确定性压缩)、
  [执行链路](optimizations.zh-CN.md#2026-11-06--原生压缩的长对话验证)。

## 2026-11-05 — 原生 Worker 完成可靠性任务集

- **主张：** 进程内 Worker 完成固定的可靠性任务，报告精确 token 用量，并对声明为缺失的
  输入干净失败，而不是编造产物。
- **证据：** `npm run bench -- --provider native`（CLI 移除之前），模型
  `360/moonshotai/kimi-k3.1-pro` 经 Magpie：**5/5**，包含作为预期失败的
  `missing-input`；逐任务用量已记录（summarize 2,252 tokens，三步管道 12,420，合计
  约 27k）（`benchmark/results/native-2026-11-05T11-09-55-300Z.json`）。加入缺失输入守卫后，
  该任务以 `no_artifact` / `native-missing-input` 失败，消耗 1,397 tokens
  （`benchmark/results/native-2026-11-05T08-10-22-910Z.json`）。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-05--命名输入缺失时原生-worker-失败而不是允许编造)、
  [执行链路](optimizations.zh-CN.md#2026-11-05--命名输入缺失时原生-worker-失败)。

## 2026-11-05 — 每个主 Agent 回合都可归因

- **主张：** 来自 CLI、`npm run main`、桌面/服务器 companion 或 WhatsApp 的每个主 Agent
  回合，都在 Journal 中记录输入、回复、工具调用、模型、强度与精确用量；没有生成 Run 的
  回合同样留痕。
- **证据：** `test/main-agent-turn-audit.test.ts`（4 个用例：脱敏、工具事件、失败回合、
  中断幂等、新的在前加载）；当时全量 544/544；`clone-ai audit turns` 与
  `GET /api/audit/turns` 读取同一份记录。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-05--每个主-agent-回合都是一条-journal-记录而不是旁路文件)、
  [执行链路](optimizations.zh-CN.md#2026-11-05--所有主-agent-入口的回合级审计)。

## 2026-11-05 — 回归门禁守住判断层

- **主张：** 证据验证、权限策略与审计校准在每次提交时无需模型即可重跑，任何判定变化都是
  可审查的 diff。
- **证据：** `npm run gate`——11 个判定用例、14 个策略用例、5 条审计记录；一致率 100%、
  假通过 0、不安全放行 0；CI 在 `npm test` 与 `npm run typecheck` 之后运行它
  （`benchmark/gate/baseline.json`）。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-05--回归门禁离线逐用例只衡量行为)、
  [执行链路](optimizations.zh-CN.md#2026-11-05--提示词溯源与离线回归门禁)。

## 2026-11-05 — 提示词改版可识别

- **主张：** 失败的一轮可以归因到它读到的确切提示词：charter 版本、编译后的简报、
  已注册工具表、模型与强度，按内容寻址并逐回合记入 Journal。
- **证据：** `test/prompt-snapshot.test.ts`（哈希稳定性、相同材料复用、简报与工具变化命中
  不同哈希、Journal 事件与定位符、所有注册工具可见、写失败只记日志不抛出）；
  `GET /api/main-agent/prompt-snapshots` 列出最近的回合。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-05--提示词溯源--内容寻址文件--一条-journal-事件)、
  [执行链路](optimizations.zh-CN.md#2026-11-05--提示词溯源与离线回归门禁)。
