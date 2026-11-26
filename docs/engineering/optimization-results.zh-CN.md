# 优化成果

[English](optimization-results.md) · **简体中文**

本文件记录**真正有效的优化**，每条对应一次经过验证的改进，新的在前。每条写明主张、支撑
它的证据（命令、数字、结果文件），以及完整过程记录在哪里。

**负优化**——eval 显示没有收益、出现回退，或被撤销的——**不写在这里**。它的取舍条目仍保留在
[`docs/architecture/trade-offs.md`](../architecture/trade-offs.md)，作为决定与推翻条件的记录。
推理过程与执行链路留在 [`optimizations.md`](optimizations.md)；本文件只保留值得引用的成果。

规则见 [`AGENTS.md`](../../AGENTS.md) 第 6 条。

## 2026-11-25 —— 待决定项固定显示在每个对话里

- **主张：** 对话顶部的固定决定栏现在显示所有任务记录里等待中的审批与复核，而不只是当前
  会话自己的。每张卡片带任务名、Scope、裁判理由与 Worker 结果，并按任务页相同的 Run id
  批准或拒绝。macOS 通知只是提示；决定不再需要打开通知指向的任务页，也不会因为点击应用而消失。
- **证据：** `test/ui-structure.test.ts`、`test/companion-config-api.test.ts`、
  `test/bilingual-documentation.test.ts`、`test/main-conversation-approvals.test.ts` 与
  `test/companion-control-plane.test.ts` **109/109**；`npm run typecheck` 0；
  `npm run gate` PASS；完整 `npm test` **1169/1169**，退出 0。实机：守护进程重启后
  Dashboard 返回 `approvals 0`、`reviews 0`、`counts.reviews 0`。实机 clone home 没有
  待决定项，因此固定栏渲染由 vm 测试覆盖，而非实机截图。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--待决定项固定显示在每个对话里而不只在拥有该-run-的任务页)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--待决定项固定显示在每个对话里而不只在拥有该-run-的任务页)。

## 2026-11-25 —— 每条消息承载二十个附件，而不是四个

- **主张：** 一次选择超过四个文件时不再丢弃多余文件。输入框与服务端解析器都接受单条
  消息最多 20 个附件——与 Claude 应用的单条消息上限一致——同时单文件上限、
  50,000/100,000 字符的文档预算与请求体仍约束回合。选择的六份需求文档会全部到达。
- **证据：** 变更前，`test/attachment-client.test.ts` 与 `test/attachments.test.ts`
  钉住四个（选 5 个保留 4 个、解析器 5 项被拒绝）；变更后，选 24 个恰好保留 20 个、
  解析器 20 项接受而 21 项拒绝、已有 19 个时失败发送的回填只补剩余空位。定向套件
  **29/29**；`npm test` **1162/1162**，退出码 0；`npm run typecheck` 退出码 0；
  `npm run gate` **PASS**。未跑 Provider benchmark；这是确定性变更。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--每条消息的附件从-4-个提高到-20-个)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--附件上限从四个提高到二十个)。

## 2026-11-25 —— MCP 安装在 launchd 下可用；技能可安装并接入 Main Agent

- **主张：** 市场安装现在能在应用真实的 launch 环境中运行。`npx` 从运行守护进程的 Node
  解析（其次是常见包管理器位置），Node 目录排在每个 MCP 子进程 `PATH` 最前，绝对命令写入
  `mcp.json`。设置页自带四个技能——周复盘、文档审阅、发布说明、交付自检——可安装到
  `<clone home>/skills`，也只能从这里移除。每个 Main Agent 回合现在收到技能根目录，列表
  进入系统提示词，每个技能变成一个 `Skill(name)` 工具并返回正文。工具页分成两个分类；
  每个服务器与技能都是一行跳转，即使只有一个工具也不内联正文；MCP 与技能市场都是跳转页。
- **证据：** 受影响套件 **136/136**，最终文案调整后 **80/80**；`npm run typecheck` 0；
  `npm run gate` PASS（verdict 14、policy 30、audit 5、memory 31、baseline unchanged）；
  完整套件 **1161/1161**，退出 0。实机：常驻守护进程的探测
  曾在 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` 下返回
  `MCP server probe spawn npx ENOENT.`；修复并重启守护进程后，同一条探测在 **0.6 秒内
  列出 10 个工具**，技能安装 → 详情（480 字节正文）→ 移除后 clone home 干净，实机 UI 显示
  两个分类、5 张 MCP 卡片、4 张技能卡片，技能正文按 Markdown 渲染。
  `test/skill-runtime.test.ts` 证明列表与正文都能到达模型。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--mcp-安装使用运行时自己的-node技能有内置市场并接入-main-agent每个条目都是跳转)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--mcp-安装在-launchd-下可用技能可安装并接入-main-agent每个条目都是跳转)。

## 2026-11-25 —— 粘贴的文件成为附件 chip

- **主张：** 在 Finder 复制文件并粘贴到输入框时，它成为附件 chip，而不是裸路径文本。原生
  外壳读取剪贴板自身的文件 URL 与字节（单文件 12 MB、单次 24 MB），页面重建 File，现有
  附件管线承载文本、PDF/.docx 与图片；无法成为附件的文件回退为绝对路径，供 `read_file`
  打开。
- **证据：** `test/attachment-client.test.ts` **14/14**（原生载荷变成 File 与文档附件）；
  `test/ui-structure.test.ts` **44/44**（剪贴板截图契约与 UI 定义检查）；`npm run typecheck`
  退出码 0；`npm run gate` **PASS**。所有者在 Finder 复制文件并粘贴到重建后的 App，输入框
  出现附件 chip（所有者确认）。写这份记录时完整 `npm test` 为 1152/1160，因为另一个会话的
  planner/workspace 改动仍在途；这些失败都与本次变更无关。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--粘贴的文件作为附件路径只是回退)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--粘贴的文件成为附件而不是路径文本)。

## 2026-11-25 —— 一个执行者；派发声明读或写，答复回到主 Agent

- **主张：** Clone AI 只有一个通用执行者，而不是四个指向同一原生 Provider 的角色 Profile。
  `dispatch_task` 要求主 Agent 声明 `read`（调查、不改变文件）或 `write`（创建或修改本地
  文件）；这个选择生成计划，派发的验收标准成为计划的标准，`write` 派发携带必需产物合同，
  因此只读取的任务无法完成。工具返回 Worker 的持久答复、实际逐步执行者与验证结果，主 Agent
  能在同一回合继续，也不会再把任务级默认值当成实际执行者。`get_run_status` 也显示持久答复。
  Kernel 的风险下限、Scope、Authority 与受保护路径未变；Worker 的能力集一直不是工具级闸门。
- **证据：** `test/regression/worker-responsibility.test.ts` 钉住读/写计划形状、调用方标准、
  产物要求与"只产生观察不能完成写"；定向套件（加上 worker-defaults、dispatch-task、
  plan-routing、fallback-planner、write-scopes、run-query-routing、golden-path、
  llm-planner、worker-brief、tool-format）**99/99**；`npm run typecheck` 退出码 0；
  `npm run gate` **PASS**（verdict 14、policy 30、audit 5、memory 31，基线未变）。
  `npm test` **1152 / 1145 通过 / 7 失败**；7 个是并行验证器变更的期望
  （waiting_review/verdict 复核），不是本变更。未运行 Provider 基准；这是确定性接线。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--一个执行者主-agent-为每次派发声明职责)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--一个执行者主-agent-为每次派发声明读或写)。

## 2026-11-25 —— 工具页提供精选 MCP 服务器，工具按表格阅读

- **主张：** 工具与技能现在以可搜索的 MCP 市场开场：五个经过核对、固定版本的免密钥
  服务器。客户端只发送条目 id 与有类型的输入；包、argv 与固定环境由服务器构造，因此
  `memory` 把图谱放在 clone home，`chrome-devtools` 关闭使用统计，文件系统服务器默认带
  `--read-only` 安装。安装仍走探测 → 逐工具风险 → 确认 → 重新探测 → 原子写入，每个工具从
  `external` 开始。三个及以下工具的服务器直接列出；更多时一次跳转到详情页，每个工具读作
  描述加一张从 `Args:` 解析出的参数表——原始片段不再出现。自由文本 npm 安装留在
  **手动安装** 下。
- **证据：** `test/mcp-registry.test.ts` **6/6**；`test/tool-format.test.ts` **12/12**；
  `test/mcp-installer.test.ts` **10/10**；`test/tools-install-api.test.ts` **9/9**；
  `test/mcp-settings.test.ts` **6/6**；UI 结构 **44/44**。在隔离 clone home 上实机：文件系统条目探测
  `@modelcontextprotocol/server-filesystem@2.4.0`（10 个工具），安装参数为
  `["--yes", "@modelcontextprotocol/server-filesystem@2.4.0", "/tmp", "--read-only"]`，
  所有工具为 `external`；目录字段为空时在启动前被拒绝。`npm run typecheck` 0、
  `npm run gate` PASS；完整套件 1144/1151，7 个失败是并发改动留下的 recovery/重启夹具
  （测量于 2026-11-25 11:10 CST；并发夹具变更已在最终重跑前修复：定向套件 89/89、
  typecheck 0）。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--mcp-市场用精选且锁版本的清单工具列表只留摘要详情跳转)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--mcp-市场精选并锁版本工具跳转到详情页)。

## 2026-11-25 —— 减少回合和记忆的重复维护点

- **主张：** 回合 HTTP 处理和无工具模型补全各从两套减为一套；连同退役 JSON 实现一起，生产源码净减 **357 行**。
- **证据：** 基于 `bf3f108` 的隔离快照 `npm test` **1108/1108**，类型检查通过，门禁前后报告一致。未测量性能收益。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--回合入口和记忆补全各保留一套实现) · [执行链路、命令及报告](optimizations.zh-CN.md#2026-11-25--删除重复的回合与记忆实现)。

## 2026-11-25 —— 自动检查决定完成；任何步骤都不再做文字复核

- **主张：** 记录了证据并通过机械检查（点名文件存在/包含承诺内容；外部/不可逆步骤有带
  locator 的回执）的步骤，无论只读、写入还是外部，都直接完成，不再 `waiting_review`。
  点名文件缺失、回执缺失与无证据仍失败。人工复核只在 AI 裁判无法决定的产物合同缺口里保留。
- **证据：** `test/verification.test.ts` **18/18**；`npm run gate` **PASS**（verdict 14 个用例、
  14 已判定、一致率 100%、review 0；审阅有意的 review→pass 翻转后重新生成基线）。完整
  `npm test` 当前因并发的执行器目录变更而红（`assertPlanIsExecutable` 只认识 `worker`，
  而旧夹具写 `draft-maker` 等）；这些不是本次变更造成的。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--自动检查决定完成文字标准不再触发人工复核)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--自动检查决定完成文字复核门移除)。

## 2026-11-25 —— 只读步骤自动完成，对话只保留结果

- **主张：** 有证据且机械检查通过的 `read_only` 步骤现在自动完成，不再进入
  `waiting_review`；它的文字标准被信任。写入、外部与产物合同仍保留复核。对话的回合日志只显示
  结果与审计入口——工具调用数与派生任务留在审计。
- **证据：** `test/verification.test.ts` **18/18**（新增只读通过用例与 reversible_write 复核
  用例）；`test/ui-structure.test.ts` 钉住阅读栏不含 `依据`/`工具调用`/`派生任务`，且保留
  审计入口；`npm test` **1122/1122**，`npm run typecheck` 退出码 0，`npm run gate` **PASS**
  （verdict 14 个用例；`read-only-evidence-passes-without-review` 为 pass）。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--有证据的只读步骤自动通过不再等所有者复核)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--只读步骤自动完成对话移除过程行)。

## 2026-11-25 —— 主 Agent 自己打开点名文件，而不是让所有者粘贴

- **主张：** 主 Agent 有了只读的 `read_file`。绝对路径、`~/` 路径、工作区相对路径或纯文件名
  都能解析到文件；纯文件名依次搜索工作区与已知文件夹、精确文件名的 Spotlight、再有界遍历，
  有歧义时列出候选而不是猜一个。长文本按约 7,000 字符的窗口返回并给出续读 offset，
  PDF/.docx/.doc 走文本提取，目录返回条目，受保护位置拒绝。提示词要求模型调用它，且不再
  要求所有者粘贴它能打开的内容。从 Finder 复制的文件粘贴时作为附件加入；无法作为附件的文件
  回退为绝对路径。
- **证据：** `test/main-agent-read-file.test.ts` **10/10**；连同 worker-brief、
  companion-main-agent、desktop-shell、attachment-client 与 prompt-snapshot 的聚焦套件
  **53/53**；`test/attachment-client.test.ts` **14/14**（原生剪贴板载荷变成 File 与文档
  附件）；`npm run typecheck` 退出码 0；`npm run gate` **PASS**，基线与上次一致。现场：
  裸名 `toolbox-20261125-delivery-plan.md` 经 Spotlight 解析到
  `/Users/user/work/doc_translate/docs/…`（10.6 KB，56 行）。Benchmark
  `npm run bench:main -- --repeat 1`（`deepseek/deepseek-v4.1-flash`）**4/4 PASS**；
  新增的 `named-file-read` 格以 `tools=["read_file"]` 通过，2.9 秒 / 16,122 tokens
  （`benchmark/results/main-agent-2026-11-25T02-30-55-603Z.json`）。`npm test`
  **1122/1122**，typecheck 0。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--主-agent-自己按名字读文件按窗口读大文件)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--主-agent-自己打开点名文件而不是让所有者粘贴)。

## 2026-11-25 —— 审计回合卡改成一个工具跳转；回复按 Markdown 渲染

- **主张：** 在 设置 → 审计与轨迹 → 主 Agent 回合 中，每张回合卡现在只显示一行计数与一个
  「查看工具调用」跳转，而不是逐条调用与输入；工具页先按工具分组，再按顺序列出调用，每个
  输入留在开关之后。回合回复与 Agent 调用回复经对话的转义渲染器按 Markdown 渲染，而不是
  原始 `<pre>` 文本。
- **证据：** `test/ui-structure.test.ts` 的两个新用例在旧渲染下失败（缺少
  `data-au-turn-tools`；`markdownReply` 不存在），现在通过；整文件 **43/43**，
  `npm test` **1122/1122**，`npm run typecheck` 退出码 0，`npm run gate` **PASS**。
  现场检查运行中的应用：一个 4 次调用的回合显示 工具调用 4 次 · 4 种 · 32.9 s 与一个跳转；
  工具页把那四个工具分组；展开 `dispatch_task` 看到可读目标与"原始参数"开关；两个回复都带
  `class="au-reply log-reply"`，粗体、列表与行内代码正常渲染。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--审计回合点名工具并打开一页工具明细回复按-markdown-渲染)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--审计回合卡改成一个工具跳转回复按-markdown-渲染)。

## 2026-11-25 —— 主对话显示自己 Run 的复核与正文

- **主张：** 派生到主对话的 Run 若处于 `waiting_approval` 或 `waiting_review`，现在会带着
  Scope/理由、验证、验收标准与最后一条持久结果显示在那里；所有者可以直接在操作面接受或拒绝。
  Agent 协作卡只显示最近一回合的子 Agent 与仍在进行的 Run，旧失败不再长期占着"需要处理"。
- **证据：** `test/main-conversation-approvals.test.ts` **5/5**（等待复核带结果，不只是标准）；
  `npm test` **1109/1109**，`npm run typecheck` 退出码 0，`npm run gate` **PASS**。现场 Run
  `d36bb093`（`waiting_review`，15 条证据）现在把复核与结果返回主对话；
  `cd74804b`（2026-11-18）已从 `subagents` 过滤。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-25--主对话承载自己-run-的复核旧子-agent-离开协作卡)；
  [执行链路](optimizations.zh-CN.md#2026-11-25--主对话显示自己-run-的复核而不是过期的协作卡)。

## 2026-11-24 —— 简报不再重复教它记住文件夹的那条请求

- **主张：** 主 Agent 的每回合简报只用路径、使用次数与最近时间列出已知文件夹，不再重复
  教它的请求原文。最近的后台工作标为历史，并明确不是重试清单。这去掉了曾出现在每个提示词里、
  并被当成工作重复执行的 README 请求。
- **证据：** `test/known-folders.test.ts` + `test/situation-briefing.test.ts` **14/14**；
  新增用例给文件夹设置点名 README.md 的示例，断言简报包含文件夹与使用次数，但不含 `README`
  或请求动词。现场渲染只剩 `/Users/user/work — 10 request(s), last …` 与
  `/Users/user/Documents/Clone AI — 5 request(s), last …`。`npm test` **1109/1109**，
  `npm run typecheck` 退出码 0，`npm run gate` **PASS**。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--简报只展示学到的位置与历史绝不展示可被重复执行的请求)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--简报展示学到的位置而不是教它的那条请求原文)。

## 2026-11-24 —— Kernel 的每次拒绝都成为 AI 上诉；所有者是最后权威

- **主张：** 被确定性 Policy 引擎拒绝的步骤不再直接结束 Run。一个有界模型裁判回答
  `ALLOW`、`DENY` 或 `ASK`；`ALLOW` 记录 `model_judge` 审批，并带受保护路径/`.git`/`.rsi`
  覆盖执行；`ASK`（或裁判不可用）让所有者决定，审批卡列出 Scope 与理由，侧栏行显示红点；
  `DENY` 以裁判理由失败。所有者对被上诉步骤的批准同样带覆盖执行。
- **证据：** `test/policy-judge.test.ts` **3/3**（提示词、解析器、所有失败→ask）；
  `test/authority.test.ts` 的运行时上诉用例（所有者批准覆盖、AI 放行记录 `model_judge` 审批
  并通过 `checkJournalInvariants`、AI 拒绝失败）；`test/path-gate.test.ts` **10/10**
  （覆盖授权 `~/.ssh` 与 `.git`，无覆盖时被拒）；`test/regression/failure-reason.test.ts`
  **6/6**；`npm test` **1108/1108**，`npm run typecheck` 退出码 0，`npm run gate` **PASS**
  （30 个策略用例不变）。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--kernel-的每一次拒绝都成为-ai-上诉所有者是最后权威)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--kernel-的每次拒绝都成为-ai-上诉所有者是最后权威)。

## 2026-11-24 —— 只读请求不再因产物合同失败

- **主张：** 明确写着只读的请求由确定性规划器处理，Worker 读取文件并回答；Run 不再以
  "Subagent draft did not satisfy its artifact contract." 失败。交付类请求仍交给 LLM
  Planner。
- **证据：** 失败轨迹 `c03c7cea` 显示一个带 draft 工作单的 `prepare` 计划、一条
  `README.md` 观察与产物合同原因；新回归用例注入空 Planner，证明只读查询从未调用它。
  Planner 测试 **28/28**，受影响套件 **48/48**，`npm test` **1103/1103**，
  `npm run typecheck` 退出 0，`npm run gate` **PASS** 且基线不变；重建后的应用
  `/api/health` 返回 200。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--只读请求永远不经过-llm-planner)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--只读请求绕过-llm-planner)。

## 2026-11-24 —— 子 Agent 自动执行，需要决定时桌面通知

- **主张：** 「子 Agent 边界」卡片不再声称"默认禁止"；进程内的原生 Worker 按步骤风险自动
  执行，只有决定确实属于所有者时才停下。Run 进入 `waiting_approval` 或 `waiting_review`
  时，守护进程发一条 macOS 通知（任务标题、步骤与原因，仅以 argv 传参的 AppleScript）；
  失败或缺失的通知器不能改变 Run 的结果。
- **证据：** `test/owner-notifier.test.ts` **3/3**（仅 argv 的脚本、有界正文、非 macOS 与
  抛错执行器路径）；`test/authority.test.ts` 注入会抛错的通知器仍得到 `waiting_approval`，
  随后复核 Runtime 收到 `review` 通知；`npm test` **1103/1103**，`npm run typecheck`
  退出码 0，`npm run gate` **PASS**（策略套件不变）。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--子-agent-自动执行真正需要决定时桌面通知所有者)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--子-agent-自动执行需要决定时桌面通知)。

## 2026-11-24 —— 设置页可以完成所有者确认的 MCP 安装

- **主张：** 工具页可以从 npm 包安装一个 stdio MCP 服务器：探测包、为每个工具展示风险
  选择（默认 `external`，Worker 永远拒绝）、确认；安装会重新探测，在包暴露了未声明工具时
  拒绝，并把一条启用条目原子写入 `mcp.json`（权限 0600），不影响其他服务器与未知字段。
  每个服务器的 **移除** 删除一条条目。Agent 仍然装不了：`~/.clone` 是受保护根，exec 沙箱
  也会重新拒绝它。
- **证据：** `node --experimental-strip-types --test test/mcp-installer.test.ts test/tools-install-api.test.ts`
  **14/14**（8 个 installer + 6 个路由）。`npm test` **1103/1103**，
  `npm run gate` **PASS**。`npm run typecheck` 报一个来自并发会话未提交改动的既有错误
  （`src/companion-server.ts:2689`），新文件没有类型错误。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--所有者确认的-mcp-安装先探测包再展示工具最后写-mcpjson)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--所有者确认的-mcp-安装探测展示再写-mcpjson)。

## 2026-11-24 —— 「全部放行」成为默认，免 Scope、免外部确认

- **主张：** 可见档位是批准 / 自动执行 / 全部放行，且全部放行是 files、shell、network 的
  标准。可逆写入无需声明 Scope；声明 Scope 的有效档位全是全部放行的外部/不可逆步骤无需
  确认即可执行；受保护位置、未实现强制的域、`.git`/`.rsi` 写入仍被拒绝，Runtime 在外部派发前
  记录一条策略审批，因此 `approval-before-external-execution` 仍成立。存在收紧写策略时，
  全域授权被撤回。
- **证据：** `npm run gate` 策略套件 **30 个用例、一致率 100%、不安全放行 0、误拦截 0、
  PASS**（变更前 24 个用例、100%）。新增用例：`files-write-unscoped-allow-all-allowed`、
  `allow-all-external-scoped-allowed`、`allow-all-irreversible-scoped-allowed`、
  `allow-all-external-no-scope-approval`、`allow-all-protected-path-denied`、
  `allow-all-narrowing-withholds-unscoped`；`files-read-allowed-under-observe` 取代旧的
  读取审批用例。`test/authority.test.ts` 断言默认值、无 Scope 写入、风险豁免、收紧撤回，
  以及外部 `execution.started` 之前存在 `grantedBy: "standing_policy"` 的
  `approval.granted`，且 `checkJournalInvariants` 返回 `[]`。`test/path-gate.test.ts` 断言
  全部放行下 `/` 是写入根，而受保护写入被拒绝。`npm test` **1083/1083**，
  `npm run typecheck` 退出码 0。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--全部放行成为默认免-scope免外部确认但禁区仍关闭)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--全部放行成为默认免-scope免外部确认)。

## 2026-11-24 —— 自动执行不再需要逐 Scope 策略

- **主张：** 把文件、Shell 与网络设为「自动执行」现在本身就足够。`act_auto` 域里带 Scope
  的步骤无需所有者撰写的常设策略即可放行；缺省域默认也是 `act_auto`；受保护位置、无 Scope
  写入、未实现强制域、外部动作与不可逆步骤仍受闸门。整个 clone home 受保护（端点密钥、
  Provider 密钥、`mcp.json`、记忆、对话、Journal 与轨迹），唯一例外是 Kernel 的隔离沙箱；
  更低上限的策略始终起收紧作用，即使另一条更宽的授权也覆盖该 Scope。
- **证据：** `npm run gate` 策略套件 **24 个用例、一致率 100%、不安全放行 0、误拦截 0、
  PASS**。引擎变更前同一套件为 **23 个用例、一致率 78%、不安全放行 0、误拦截 5**——正好是
  `files-write-act-auto-no-policy-allowed`、`files-write-default-domain-allowed`、
  `files-read-act-auto-no-policy-allowed`、`shell-exec-act-auto-no-policy-allowed` 与
  `network-read-act-auto-no-policy-allowed`。守卫用例保持
  （`irreversible-act-auto-needs-approval`：approval_required，
  `protected-path-act-auto-denied`：denied，`narrowing-policy-restricts-act-auto`：denied）；
  `overlapping-policies-lowest-ceiling-wins` 在修复前的 `max()` 并集下返回 `allowed`，
  最低上限修复后返回 `denied`。`test/path-gate.test.ts` 钉住 clone home 保护与隔离沙箱例外；
  `test/authority.test.ts` 钉住语法与语义损坏配置。`npm test` **1073/1073**，
  `npm run typecheck` 退出码 0。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--自动执行成为默认档位自动执行意味着模型判断)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--自动执行成为默认由模型判断)。

## 2026-11-24 —— 所有者手写的记忆是常驻上下文

- **主张：** 所有者手写的、活跃且非机密的记忆会以有界常驻段进入每个主 Agent 回合，
  不依赖查询是否与它共享词。它们以 `standing: true` 记入 Journal；机密的所有者记忆与
  非所有者记忆不包含。
- **证据：** `node --experimental-strip-types --test test/memory-context.test.ts test/synthesized-recall.test.ts`
  **21/21**；新测试用"继续总结"（与"我是jiaoxiangyu,我的工作内容以此为展开"无重叠）
  推送，在提示词中找到所有者便签、在 `memoryIds` 中找到其 id、在 Journal 中找到
  `standing: true`，而机密与非所有者便签不出现。`npm test` **1053/1053**，0 失败；
  `npm run typecheck` 退出码 0；`npm run gate` **PASS**，基线未变。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--所有者亲手写的记忆是常驻上下文而不只是词面命中)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--所有者亲手写的记忆是常驻上下文)。

## 2026-11-24 —— 失败的子 Agent 在所有者提问的地方解释自己

- **主张：** 主对话里的子 Agent 行原地展开，显示记录的摘要、最多五条证据，以及确定性的
  "要修改什么"提示；默认不再跳转到任务记录。完整执行轨迹留在显式的
  「打开任务记录查看完整轨迹」链接后面，Agent 列表标题把失败项计为"需要处理"。
- **证据：** `node --experimental-strip-types --test test/ui-structure.test.ts`
  **35/35**，包含重写的子 Agent 测试（details 结构、artifact 提示、证据、显式链接、
  无 `agent-row--open`/整行按钮）。`npm test` **1052/1052**，0 失败；
  `npm run typecheck` 退出码 0；`npm run gate` **PASS**，基线未变。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--子-agent-行在主对话里原地解释任务记录成为一个显式链接)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--子-agent-行在主对话里原地解释自己)。

## 2026-11-24 —— 输入框的模型与强度跨 Daemon 重启保留

- **主张：** 一个对话保留的模型与强度按对话保存在 clone home，打开该对话时恢复，即使
  Daemon 在新端口上重启。local storage 只作为尚无对话 id 的新请求的缓存。
- **证据：** `node --experimental-strip-types --test test/turn-choice-store.test.ts test/companion-config-api.test.ts test/ui-structure.test.ts`
  **3/3 + 62/62**；API 测试通过 Daemon 保存、读取并清除一个对话的选择；UI 测试证明
  守护进程条目优先于过期的 local storage 值。`npm test` **1052/1052**，0 失败；
  `npm run typecheck` 退出码 0；`npm run gate` **PASS**，基线未变。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--输入框的模型与强度跟着对话走而不是跟着页面-origin-走)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--输入框的模型与强度跟着对话走)。

## 2026-11-24 —— observe 下带 Scope 的写入现在请求一次确认，而不是直接死掉

- **主张：** 当 files 域为 observe 时，一个声明了 `files` 写 Scope 的
  `reversible_write` 步骤进入 `waiting_approval`；现有审批卡让所有者允许这一步一次或
  拒绝。批准只解除该步骤 Scope 的 observe 拒绝；域本身仍是 observe。把 files 设为
  `act_auto` 仍是自动模式；受保护路径、无 Scope 写入、其他域与不可逆步骤保持拒绝。
- **证据：** `node --experimental-strip-types --test test/authority.test.ts test/regression-gate.test.ts test/regression/failure-reason.test.ts`
  **12/12 + 13/13**；Runtime 用例记录两次执行的 `approval_required` 后 `allowed`。
  `npm test` **1047/1047**，0 失败；`npm run typecheck` 退出码 0；`npm run gate`
  **PASS**。门禁基线差异是有意为之：`files-write-observe-denied` →
  `files-write-observe-asks-approval`（`approval_required`），加上
  `files-write-observe-approved`（`allowed`）。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--observe-的-files-域里带-scope-的可逆写入向所有者请求一次确认)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--observe-下带-scope-的可逆写入向所有者请求一次确认)。

## 2026-11-24 —— 一天现在记录操作，生成文件不进答案

- **主张：** 常驻 Daemon 运行期间，每个已学会文件夹通过递归 FSEvents 监听；创建、修改或
  删除的文件变成一条带时间戳的操作记录，即使它的内容没活到下一次采集。构建产物、缓存、
  系统/编辑器垃圾与仓库自己的 gitignore 路径会从台账、监听器与摘要中过滤，并报告跳过数量。
  Mac 休眠/关机仍会丢事件；下一次采集的 mtime 回填会补上它能补的部分。
- **证据：** `node --experimental-strip-types --test test/workspace-noise.test.ts test/workspace-watch.test.ts test/workspace-ledger.test.ts test/daily-digest.test.ts`
  **30/30**。监听器测试为一次保存记录一条 `created`，丢弃 `.DS_Store` / `debug.log` /
  `state.tmp` / `node_modules/pkg.md` 与被 gitignore 的 `draft.md`；摘要输出
  `Operations (watcher): 1 recorded` 与过滤计数。`npm test` **1046/1046**，0 失败；
  `npm run typecheck` 退出码 0；`npm run gate` **PASS**，基线未变。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--常驻-daemon-记录-fsevents生成文件不进台账)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--daemon-记录-fsevents-操作噪声不进每日摘要)。

## 2026-11-24 —— 一天的工作读成内容级 diff，而不是一串文件名

- **主张：** 分身可以靠一份有界的每日台账回答"这一天发生了什么"：文本文件对存储的基线
  给出 unified 风格 diff，每个仓库提供当天提交与当前状态，当天的回合、Run、验证与
  记忆文档写入被合并进来。台账没有覆盖的文件夹回退到现有 mtime 读取，并明确标注没有
  内容基线，而不是被呈现成完整的一天。
- **证据：** `node --experimental-strip-types --test test/workspace-ledger.test.ts test/daily-digest.test.ts`
  **22/22**。digest 测试在同一份夹具上钉住前后对比：旧的按天读取（`collectFolderReport`）
  返回 `plan.md` 与时间戳；`collectDailyDigest` 返回 `--- a/plan.md` / `+++ b/plan.md`
  以及 `-第二行`、`+改过的第二行`、`+第三行`，并带上 `Turns: 1 completed` 与记忆行。
  `npm test` **1038/1038**，0 失败；`npm run typecheck` 退出码 0；`npm run gate`
  **PASS**，基线未变。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--有界的每日台账让工作区可以按天做内容级-diff)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--有界的每日台账让工作区可以按天做内容级-diff)。

## 2026-11-24 —— Worker 收到主 Agent 的任务，而不是通用模板

- **主张：** 主 Agent 现在编写每个 Worker 的完整 `workerBrief`；Worker 的 system 提示词就是
  这份简报加固定的执行契约，user 消息只携带 Kernel 解析出的事实。`dispatch_task` 的简报到达
  主执行工作单，按步骤的简报到达其工作单，只写在简报里的写入目标也会被纳入 Scope。没有简报时
  沿用原模板。
- **证据：** `node --experimental-strip-types --test test/worker-brief.test.ts` **15/15**；
  `npm test` **1025/1025**，0 失败；`npm run typecheck` 退出 0；`npm run gate` **PASS**，
  基线不变。`79780a6` 上的变更前后提示词探针：旧 system 首行
  `You are a worker inside Clone AI...`；新 system 首行
  `Write out/report.md. Read README.md first. Stop after the write is verified.`，
  新 user 首行 `Runtime facts (resolved by the Kernel...)`。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--主-agent-编写-worker-简报kernel-只追加事实)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--主-agent-编写-worker-简报)。

## 2026-11-24 —— 设置页展示 MCP 工具与技能，每个服务器都有加载按钮

- **主张：** 桌面设置页现在有 **工具与技能** 分区，列出 clone home 的 `mcp.json` 中每个
  MCP 服务器、每个已声明工具及其风险，以及 clone home 与工作区技能根目录下的技能。每个
  服务器都有 加载/停用 按钮，只改写它的 `enabled` 字段，下一次 Worker 运行就会加载或卸载它。
  目录从不暴露 `env`、`command`、`args` 或 `url`；技能只读。
- **证据：** `test/mcp-settings.test.ts` **6/6**；
  `test/companion-config-api.test.ts` **23/23**；`test/ui-structure.test.ts` **34/34**；
  `npm test` **1038/1038**，0 失败；`npm run typecheck` 退出 0；`npm run gate` **PASS**，
  基线不变。在重建后的应用上，真实 `GET /api/tools` 返回 `playwright`（10 个工具）、
  `agent-tools`（7）与 `agent-exec`（2）、0 个技能，且根目录只有 `~/.clone/skills`；服务出的
  HTML 含新分区与目录宿主。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-24--设置页列出-mcp-服务器工具与技能并给每个-mcp-一个加载按钮)；
  [执行链路](optimizations.zh-CN.md#2026-11-24--设置页列出-mcp-服务器工具与技能并给每个-mcp-一个加载按钮)。

## 2026-11-23 —— Worker 可以在沙箱里运行允许的测试与类型检查

- **主张：** 原生 Worker 现在可以运行项目自己的 `test`、`typecheck`、`lint`、`check`、`gate`
  或 `build` 脚本——只要所有者在 `agent-exec.json` 里列出——不经过 shell，也不接收模型提供的
  argv。在 macOS 上每条命令都在 Seatbelt 下运行：写入留在工作区、临时目录与包缓存；网络关闭；
  受保护位置与工作区 `.git` 只读。`run_command` 是提供给可逆写入步骤的 write 风险工具；
  `list_commands` 只读。Worker 可以在一个步骤内复现失败、编辑并重跑检查。
- **证据：** `node --experimental-strip-types --test test/agent-exec-mcp.test.ts`
  **17/17**；`npm test` **991/991**，0 失败；`npm run typecheck` 退出 0；
  `npm run gate` **PASS**，基线不变。安装器 `--print` 检测到 `test`/`typecheck`/`gate`，并
  输出包含工作区、缓存、网络拒绝、受保护根与 `.git` 拒绝的 profile。真实 macOS 探测：允许的
  命令在 `sandbox: seatbelt` 下打印 `sandbox-ok`；写工作区之外的 `$HOME` 失败；写 `.git` 失败；
  500ms 超时杀死命令；120KB 输出保留 50KB 尾部。安装后，安装副本通过 `workerTools` 在
  `sandbox: seatbelt` 下运行 `npm run typecheck`（退出 0，1.8 秒）。主张的是反馈回路；测试
  仍可在工作区内覆盖源码。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-23--沙箱内白名单式的命令执行器给-worker-一个测试回路)；
  [执行链路](optimizations.zh-CN.md#2026-11-23--沙箱化的-agent-exec-服务器给-worker-一个测试回路)。

## 2026-11-22 —— Worker 获得七个只读工具，包括仓库检索

- **主张：** 原生 Worker 现在可以检索仓库（`search_text`、`find_files`）、查看 Git 状态、
  diff 与历史、读取时钟，并抓取一个文档 URL——七个只读工具，沿用现有的按服务器启用与逐工具
  风险声明。没有新增写工具或 shell 工具。
- **证据：** `node --experimental-strip-types --test test/agent-tools-mcp.test.ts`
  **17/17**；`npm test` **974/974**，0 失败；`npm run typecheck` 退出 0；
  `npm run gate` **PASS**，基线不变。安装器的 `--print` 输出七个声明，`fetch_url` 为
  `network`。真实网络路径是假设：正常路径使用注入的 fetch，而不是公网 URL。检索收益的依据是
  修复通道 12/31 轮的探索证据，而不是本次变更的前后 benchmark。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-22--一个内置本地-mcp-服务器补齐-worker-的检索git日期与网页能力)；
  [执行链路](optimizations.zh-CN.md#2026-11-22--内置-agent-tools-mcp-服务器为-worker-补上检索git日期与网页读取)。

## 2026-11-20 —— 对话提前 155px 开始，强度选择器提供十档

- **主张：** 三条失败跟进现在收成 40px 的摘要行，而不是 205px 的卡片堆，对话因此提前
  155px 开始；默认模型的强度选择器从四行变为十行（三个声明档位、六个其他已知档位与模型
  默认）；请求气泡去掉眉线后仍是同一个声音，正文以 620px 行宽阅读。
- **证据：** 更新后的 `test/ui-structure.test.ts` 在 HEAD UI 文件上 **26/32**，在当前工作区
  **32/32**；`npm test` **957/957**；`npm run typecheck` 退出 0；`npm run gate` **PASS**，
  基线不变。同一段真实对话、同一 1468×1080 视口，由当前工作区 UI 接真实 `/api` 负载渲染，
  量得 `.opportunity-strip` **205 → 50px**、`.conversation` 顶部 **279 → 124px**、请求气泡
  **61 → 45px**、强度选项 **4 → 10**、正文行宽 **760 → 620px**
  （`/tmp/clone-ui-fixture/before-full.png`、`after-full.png`）。舒适度收益是假设，没有
  测量所有者会话。
- **位置：** [取舍：强度词汇](../architecture/trade-offs.zh-CN.md#2026-11-20--强度选择器给出已知档位并标明模型声明了哪些)；
  [取舍：失败积压](../architecture/trade-offs.zh-CN.md#2026-11-20--失败的跟进是一行不是一堵墙)；
  [取舍：安静的声音](../architecture/trade-offs.zh-CN.md#2026-11-20--对话用一个安静的声音说话)；
  [执行链路](optimizations.zh-CN.md#2026-11-20--对话更早开始读起来更安静并提供已知的强度档位)。

## 2026-11-20 —— 验证失败只点名一次原因

- **主张：** 验证失败现在说明被承诺的路径是缺失、目录、不可读，还是在步骤可验证的根之外；
  组合摘要只带一个 "Verification failed." 前缀。
- **证据：** 通道回归修复前红、修复后绿；worktree 全量 **952/952**、typecheck 0、gate PASS
  （在唯一一条过期测试契约更新之后）；main 上目标用例 **18/18**、全量 **956/956**、
  typecheck 退出 0、gate **PASS**。在 protected-path 批准后以 `78006a9` 落地。四次通道运行
  合计约 408 秒 / 52 次模型调用 / 410,701 token。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-20--验证失败只说一次原因并把原因说准)；
  [执行链路](optimizations.zh-CN.md#2026-11-20--验证失败只说一次原因并把原因说准)。

## 2026-11-19 —— 被提供方拦截的回答报为失败

- **主张：** 带 `content_filter` 或另一个已定义、且不在
  `stop/end_turn/stop_sequence/completed` 里的 finish reason 的回答，不再被记成完成；回合以
  该 finish reason 失败，所有者看到中文摘要与下一步。`length`/`max_tokens` 保留截断失败，
  正常 `stop` 仍然完成。
- **证据：** 循环用例在旧代码上红（content_filter 与未知值都完成），修复后绿；展示测试在旧映射
  上红。`test/agent-loop.test.ts` **31/31**，`test/failure-display.test.ts` **2/2**，
  `npm test` **951/951**，typecheck 退出 0，gate **PASS**。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--provider-的停止是失败不是完成的回答)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--provider-的停止是失败不是完成的回答)。

## 2026-11-19 —— 失败轨迹带上步骤指令与标准

- **主张：** `FailedTrace.plan` 现在携带每个步骤脱敏后的 instructions、验收标准、所需能力、
  scopes 与子代理数量，修复通道可以只凭轨迹复现计划层或验证层失败。
- **证据：** `test/failed-traces.test.ts` 在旧导出形状上红（没有 `instructions`），修复后绿；
  该文件 **3/3**；`npm test` **946/946**，typecheck 退出 0，gate **PASS**。缺口由验证器通道
  失败的运行 `8464295d` 记录。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--失败轨迹携带步骤-instructions)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--失败轨迹携带步骤-instructions)。

## 2026-11-19 —— 首次发送的 no_progress 显示摘要与下一步

- **主张：** failed SSE 事件携带 `errorSummary` 与 `errorGuidance`，首次发送失败卡渲染它们并
  折叠原始错误。首次发送的无进展停止显示“已停止以免空转”与下一步，而不是只有原始英文循环
  错误。
- **证据：** 新的服务端用例脚本化五次相同的 `get_run_status` 调用，在旧 payload 上红（没有
  `errorSummary`），修复后绿；`test/companion-main-agent.test.ts` **8/8**，
  `test/ui-structure.test.ts` **28/28**；共享树 `npm test` **945/946**——唯一失败是另一会话
  未跟踪的 `.claude/launch.json`，移开后 **946/946**；typecheck 退出 0，gate **PASS**。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--首次发送失败显示所有者可读的原因而不是原始循环错误)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--首次发送失败显示所有者可读的原因)。

## 2026-11-19 —— 侧栏每个对话一行，而不是每个 Run 一行

- **主张：** 一个对话派发的 Run 不再出现在侧栏。列表是对话（主对话固定在前，然后今天/更早）
  加上每个等待所有者决定的任务一行；运行中、已完成或没有对话的 Run 都没有行。同样的 Run
  在 设置 → 审计与轨迹 里仍可一键打开，对话保留一行"依据"点明派发了几个。
- **证据：** 侧栏沙箱用"运行中任务 + 等待任务 + 主对话任务 + 定时任务"的夹具渲染：三个非
  等待的 Run 产出 **0** 行 `data-test-session`（变更前各 1 行），等待任务在
  `session-group-needs` 下恰好 **1** 行，计数从"对话 + Run"降为"对话 + 等待任务"。
  `test/ui-structure.test.ts` 在源码里找不到 `session-children`、`data-child-group`、
  `autoBlock` 与 `data-log-run`，回合日志没有 产物 块。`npm run typecheck` exit 0、
  `npm run gate` PASS、baseline 不变、`npm test` **943/944**（唯一失败来自另一个会话的
  `.claude/launch.json`，与本次变更无关）。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--侧栏只列对话run-的细节放在审计里)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--侧栏只列对话回合派发的-run-在审计里读)。

## 2026-11-19 —— 一个 clone home 一个运行时，窗口直接附着而不再空等

- **主张：** 只要有守护存活，打包窗口就不再显示"launchd 没有在 60 秒内发布端点"。
  `npm run desktop:dev` 在会话期间把常驻 LaunchAgent bootout；同一 home 上的第二个
  companion 会在重放 Journal、声明回合台账或覆盖端点之前拒绝启动。
- **证据：** `node --experimental-strip-types --test test/companion-singleton.test.ts`
  ——变更前 **3/3 失败**（第二个 sidecar 在独立进程中启动、同进程第二个服务器启动、死属主
  的锁什么也挡不住）；变更后 **3/3 通过**，子进程以非零退出并打印
  `Another Clone AI runtime (pid …) already owns <home>`，端点文件逐字节不变，陈旧锁被
  回收。变更前的现场观察：launchd 46832 与开发 sidecar 53933 同时存活，端点与回合台账
  都指向 53933。`npm run typecheck` 退出 0，`npm run gate` PASS（基线不变）；
  `npm test` 940/944，四个失败位于另一个会话正在编辑的文件中，且都不读取本次变更。
  修复后的现场：开发会话运行期间 LaunchAgent 不在 launchd 域中，恰好一个 sidecar
  持有端点与回合台账（`/api/health` 200）；停止驱动会恢复任务并启动一个新守护。
- **链接：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--每个-clone-home-只跑一个运行时开发模式先卸载-launchagent第二个-sidecar-拒绝启动)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--开发模式与-launchd-不再在同一个-clone-home-上各跑一个-sidecar)。

## 2026-11-19 —— 网关声明的强度档位会真正送到 Provider，而不是 400

- **主张：** 网关为模型声明的档位不再被 clone-ai 自己的校验拒绝。
  `openai/gpt-6.1-terra` 声明 `none, low, medium, high, xhigh, max, ultra`；
  `ultra` 此前会从 `POST /api/main-agent/stream` 与 `PATCH /api/config` 得到 HTTP 400，
  于是输入框与设置页的选择器给出了服务端会拒绝的选项。变更后名称会被去空白、限制在 64
  字符内，并以 `reasoning_effort` 转发；只有根本不像名称的值（非字符串、空、过长）才被拒绝。
- **证据：** 在线网关 `curl 127.0.0.1:3425/v1/models` 显示 11 个模型各声明 3–7 档；
  把 `reasoning_effort` 设为 `off`/`ultra`/`medium`/`xhigh`/`minimal`、跨三个模型探测，
  每次都是 200。`test/companion-main-agent.test.ts` 断言假 Provider 收到
  `reasoning_effort: "ultra"`；`test/companion-config-api.test.ts` 通过
  `PATCH /api/config` 保存并清除 `ultra`，仍拒绝 `42`。`npm test` **934/934**、
  `npm run typecheck` exit 0、`npm run gate` PASS、baseline 不变。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--推理强度以网关声明为准而不是固定七档)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--强度选择器与服务端的档位名称不一致通道未能启动所有者批准了手写补丁)。

## 2026-11-19 —— 失败任务的教训必须引用失败本身

- **主张：** 从失败 Run 提炼的 procedure 只有在引用记录失败的 Evidence 时才被接受。记录中的
  记忆 `mem-81aab49b-a11`——引用成功目录列表的任务复述——会被拒绝，而任务里的持久偏好
  （“以后所有报告默认使用简体中文”）在失败结局 **2/3**、已完成结局 **3/3** 的样本中保留。
  记忆文件不再把摘要作为正文首行重复一遍。
- **证据：** `npm run gate` **PASS**，memory **31/31**（五个新用例）；首次全量 `npm test`
  **930/931**（唯一失败是一条新增纯英文注释，已修复）；typecheck 退出 0。真实模型在记录
  Run 上每种结局采样 3 次：变更前，**3/3** 次失败结局样本（库里那条 + 两次探针）都产出复述
  任务的 procedure；变更后，两种结局均为 **0 条保留教训**，已完成结局的偏好 **3/3**、失败
  结局 **2/3**——
  `benchmark/results/memory-failure-lesson-2026-11-19T09-11-25-790Z.json`。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--失败任务的教训必须引用失败本身)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--失败任务的教训必须引用失败本身)。

## 2026-11-19 —— 内部基准是机器根目录

- **主张：** 未显式设置 `CLONE_AI_WORKSPACE` 时，运行时的内部基准是 `/`；任务的相对路径与
  验证器从整台机器出发，执行锁留在 clone home 下，而不是创建 `/.clone`。
- **证据：** `test/clone-home.test.ts` 钉住 `/` 默认值、显式与环境覆盖，以及 clone home 下的
  `workspaceLockFile`；`test/workspace-lock-abort.test.ts` 使用显式锁文件并断言没有
  `workspace/.clone`。`npm test` **927/927**、typecheck 退出 0、gate **PASS**。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--内部基准是机器根目录而不是某个文件夹)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--内部基准是机器根目录而不是某个文件夹)。

## 2026-11-19 —— 失败的回合在运行中的子任务旁边保持可见

- **主张：** 最新回合失败或被中断的对话，不再因为有子任务活跃就显示运行中。行显示需要处理，
  预览显示回合的失败并追加“N 个任务仍在执行”；等待中的子任务仍给出等待状态，完成/运行中的
  回合带活跃子任务仍显示运行中。
- **证据：** `test/companion-control-plane.test.ts` 的新用例在旧顺序上红（行运行中、预览
  “1 个任务正在执行”），修复后绿；该文件 **28/28**，`npm test` **941/941**，typecheck 退出 0，
  gate **PASS**。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--失败的回合在子任务仍运行时保持可见)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--失败的回合不会被运行中的子任务藏起来)。

## 2026-11-19 —— 失败的 Run 说明失败原因

- **主张：** policy 拒绝现在把理由、验证失败或被拒绝复核把验证摘要写进
  `run.status_changed`；因此 `run.failureReason` 覆盖每一次失败。`get_run_status` 打印
  `Failure:`，`dispatch_task`/`QueryRunResult` 返回 `failureReason`，工作更新与机会卡读取它，
  而不是“没有记录到具体原因”。
- **证据：** `test/regression/failure-reason.test.ts` 修复前红（policy、验证重放、状态读取与
  `runQuery` 共 6 条断言），修复后绿；`npm test` **940/940**，typecheck 退出 0，gate
  **PASS**。在保护路径越权批准后以 `443aa73` 落地。补丁与报告：
  `.automation/repair-reports/failure-reason-20261119T0851.{patch,json}`。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--失败的-run-携带原因主-agent-能读到)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--失败的原因到达模型与所有者)。

## 2026-11-19 —— 交替轮询与被掩护的轮询都以无进展停止

- **主张：** 共享循环现在按整回合统计每个已执行调用的身份。两个相同的 `get_run_status` 轮询
  彼此交替，或一个轮询与结果变化的读取同批，仍会在第三次提示、第五次以 `no_progress` 停止。
  结果变化的调用仍算进展；原来的八次轮询事故仍在第五次停止。
- **证据：** `test/agent-loop.test.ts` 的两个新用例在修改前的循环上红（都正常完成），修改后绿；
  整个文件 **28/28**。交替在第 9 轮停止，被掩护的轮询在第 5 轮，八次相同轮询在第 5 轮；
  A,A,B,A,A 正常完成。`npm test` **924/924**，typecheck 退出 0，gate **PASS**。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--无进展守卫按整回合内每个调用计数而不是相邻批次)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--无进展守卫按整回合统计每个调用)。

## 2026-11-19 —— 被记录的验证计划不再因自己的搜索路径失败

- **主张：** 在真实的 `fa36a720` `plan.created` 步骤上，`extractFileExpectations` 现在返回
  `[]`；“package.json / pnpm-workspace.yaml”里的斜杠与“里的线索”的搜索位置不再变成文件承诺，
  而真实交付物（包括带空格的绝对路径）仍会被检查。
- **证据：** 新回归修复前红（`["/ pnpm-workspace.yaml","/Users/user/.clone"]`），修复后绿
  （`[]`）；通道完整套件 **919/919**，typecheck 0；main 上两个回归加
  `test/verification.test.ts` 与 `test/fallback-planner.test.ts` 共 **31/31**，完整套件
  **922/922**，gate **PASS**。在保护路径越权批准后以 `763dcd8` 落地。通道报告后来被一次
  `no-traces` 运行覆盖；以提交与测试为证据。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--搜索位置不是文件承诺回归用例必须使用事故里的真实计划)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--验证器以真实计划为-fixture搜索位置不是文件承诺)。

## 2026-11-19 —— 只读 dispatch 目标在 fallback planner 里保持只读

- **主张：** 写着“只读 / 不修改”的 `dispatch_task` 目标，不再因为描述了带“保存 / 写”字样的代码
  就变成 `reversible_write` 计划。两条被记录的目标都规划成一次 `read-only-lookup`，而点名的写入
  目标仍然规划为交付。
- **证据：** 回归用例 `test/regression/fallback-read-only-dispatch.test.ts` 修复前红（两个计划都是
  `prepare/reversible_write`，带 draft 子代理），修复后绿；通道完整测试 **919/919**，typecheck
  退出 0；main 上回归用例加 `test/fallback-planner.test.ts` 共 **13/13**。通道报告：
  `.automation/repair-reports/planner-20261119T0812.json`。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--只读标记压过裸写入动词fallback-planner)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--只读-dispatch-目标不再被规划成写入)。

## 2026-11-19 —— 没有配置的工作目录

- **主张：** “工作目录”设置与持久化文件夹已移除；写入必须点名确切目标，默认没有文件夹可写；
  运行时锁与执行数据库位于 clone home；验证器通过步骤声明的写 Scope 验证基准之外的写入。
- **证据：** `test/write-scopes.test.ts` **12/12**、`test/authority.test.ts` **12/12**、
  `test/companion-config-api.test.ts` **17/17**、`test/verification.test.ts` **17/17**；
  黄金路径、混沌（杀进程/重启）与修复通道测试通过；完整套件 **918/919**（一个无关失败来自
  另一会话的 `.claude/launch.json`）；typecheck 退出 0；gate **PASS**，基线只有一行变化
  （`policy/local-write-allowed`：allowed → `policy/local-write-without-scope-denied`：
  denied）。所有者的请求就是可用性证据；没有测量所有者会话。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--没有配置的工作目录写入自己点名目标)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--没有配置的工作目录写入自己点名目标)。

## 2026-11-19 —— 以目录引入的路径不是文件承诺，带空格的路径保持完整

- **主张：** 验证器不再因为指令把目录作为上下文引入（“数据目录 /path”）而判失败；带空格的绝对
  文件路径被完整提取。两条被点名的形式已处理；但这次补丁**没有**清掉记录中只读排查的真实计划
  文本（见下方更正）。
- **证据：** 修复通道的回归用例 **1/1**；`test/verification.test.ts` **16/16**；main 上完整
  套件 **916/916**；typecheck 退出 0；gate **PASS**；用**缩减后**的指令文本复现返回
  `extracted: []` 与 `needsReview`；带空格的写入路径返回
  `[{"path":"/Users/user/Documents/Clone AI/out.md"}]`。以提交 `6dc13f0` 落地；此前通道的
  保护路径闸门拒绝了它，所有者明确批准了这个已验证的补丁。
- **更正（2026-11-19，审计后）：** 用真实 `plan.created` 步骤（journal seq 1818）在合并后的
  提取器上重放，仍返回两个假承诺——`/Users/user/.clone` 与新增的
  `/ pnpm-workspace.yaml`——`EvidenceVerifier` 仍然 `passed:false`。fixture 使用的是缩减后的
  指令。随后用真实指令重跑的修复通道在所有者批准后以 `763dcd8` 落地；
  修正后的决定见 `trade-offs.zh-CN.md` 的“搜索位置不是文件承诺”条目。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--以目录引入的路径不是文件承诺带空格的路径是一个路径)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--验证路径的修复由通道产出被保护路径闸门拒收由所有者批准合入)。

## 2026-11-19 —— Agent 设置显示模型选择，而不是接线

- **主张：** 设置 → Agent 不再暴露 Magpie 回环地址（`http://127.0.0.1:3425/v1`），也不再
  重复显示原始 provider/model id 的"当前模型"卡；连接状态、说明与友好的模型下拉保留。
- **证据：** `test/ui-locale.test.ts` **4/4** 断言 URL、`gateway?.endpoint` 表达式与
  `label: "当前模型"` 不存在，而 `id: "gateway-model"` 与 `data-gateway-apply` 仍存在；
  新 sidecar 启动后的线上页面只显示两张概览卡、没有端点；`npm test` **910/910**、
  `npm run typecheck` 退出 0、`npm run gate` **PASS**。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--agent-设置只显示连接不显示回环路径或原始模型-id)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--agent-设置不再打印回环地址与重复的原始模型-id)。

## 2026-11-19 —— 对话里的表格渲染成表格，并可按需导出 CSV

- **主张：** 回复里的 GFM 表格现在在对话中渲染成真正的表格——表头、对齐、单元格内的行内
  代码与粗体、转义的竖线、窄窗口下的横向滚动——而不是字面的 `|` 与 `---` 行。每张渲染出的
  表格都带一个"导出 CSV"控件，把带时间戳的 CSV 写进所有者挑中的文件夹，Excel 可直接打开。
- **证据：** `test/ui-structure.test.ts` **24/24**（解析、对齐、转义竖线、围栏代码块隔离、
  HTML 转义、CSV 载荷、浏览器下载与原生选择器接线）；`test/desktop-only-surface.test.ts`
  **5/5**（CSV 逐字节写入；空表、相对路径、不存在的目录与数据目录都被拒绝）；`npm test`
  **910/910**；`npm run typecheck` 退出 0；`npm run gate` **PASS**，baseline 不变。用真实
  标记与样式在 1024×900 与 375×812 下静态渲染，表格与控件可见，页面没有横向溢出。可用性
  收益在此检查之外为假设；没有测量所有者会话。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--对话里的表格渲染成表格并可按需导出-csv)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--对话里的表格渲染成表格并可按需导出-csv)。

## 2026-11-19 —— 重复的工具调用在本机停下，运行中的 Run 不被轮询

- **主张：** 共享循环现在在第三次连续相同调用时提示，在第五次以 `no_progress` 停止；它用工具名、
  规范化参数与结果文本标识一次调用，因此结果变化的调用仍算进展。主 Agent 被告知
  `propose_work_plan` 提出的 Run 会自行推进、`get_run_status` 只是快照且不得轮询，运行中的
  Run 状态文本也这样写。以此停下的 Worker 记为 `no_progress` 而不是 `completed`，所有者会看到
  中文摘要与下一步。
- **证据：** `test/agent-loop.test.ts` 变更前 **23/26**（失败三条为无进展停止、提示、JSON 键
  重排）→ 变更后 **26/26**；`test/main-agent.test.ts` **16/16**；`npm test` **906/906**；
  `npm run typecheck` 退出 0；`npm run gate` **PASS**，baseline 不变。真实失败在所有者
  Journal 中：回合 `fa63e0f3…` 对 Run `fa36a720…` 调用八次 `get_run_status`，得到相同的
  `running` 投影，外部网关的停止被存成了一条完成的回复。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--重复的工具调用在本机停下排队中的-run-不再被轮询)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--重复的工具调用在本机停下排队中的-run-不再被轮询)。

## 2026-11-19 —— 对话回合只显示结果与依据，不显示过程

- **主张：** 对话的阅读栏现在只承载请求、结果、派生的 Run 与一行"依据"。模型、提示词快照、
  工具表与每次工具调用的输入不再渲染在那里；"查看审计"控件按回合 id 与对话 id 精确筛到
  本回合，落在"主 Agent 回合"。
- **证据：** `test/ui-structure.test.ts` 从断言对话标记里有"上下文 / 派发 / 模型字符串 /
  `charter v3` / `dispatch_task`"改为断言它们不存在，且"结果 / 产物 / 依据 / 审计入口"存在，
  渲染 `assemblyBlock` 验证压缩摘要、渲染 `turnsView` 验证被移除的工具清单（**26/26**）；
  `npm test` **916/916**；`npm run typecheck` 退出 0；`npm run gate` **PASS**，baseline
  不变。用真实标记与 CSS 做静态渲染：四次调用的回合显示为回答加
  `依据 工具调用 4 次 查看审计 ›`；派发任务的回合显示 `产物 1` 与其 Run 行。可用性收益为
  假设；没有测量所有者会话。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--对话只显示结果与依据过程移入审计页)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--对话回合只显示结果与依据过程移入审计页)。

## 2026-11-19 —— 直接作答留在侧栏，今天的工作来自学到的文件夹

- **主张：** 主 Agent 没有派发任务就作答的请求，现在是侧栏里的一条"对话"行；整理今天的工作信息
  能说出分身从使用中学到的文件夹下今天真正变化了哪些文件——不需要文件夹设置、Connector 或
  Worker Run。
- **证据：** `test/companion-control-plane.test.ts` 从期望 **0** 条对话行改为期望
  `conversation-a` 与 `conversation-b`（**25/25**）；`test/known-folders.test.ts` +
  `test/recent-changes.test.ts` **8/8**；`test/ui-structure.test.ts` **21/21**；线上工具在
  所有者机器上报告 `/Users/user/work` 下今天 **9 个文件** 变化、**5 个仓库** 及其状态
  （Spotlight **0.13 秒**，裁剪 `find` **5.2 秒**）；一次使用 `deepseek-v4.1-flash` 的
  真实预览回合先调用该工具（**573 毫秒**），并给出了按项目组织的摘要；桌面重启后，同一
  工具在真实 home 的线上回合中先被调用（**454 毫秒**，未派发），侧栏显示 **10 行**、其中
  一条"对话"行；审计回合卡现在有右侧请求与左侧回答，丢失的 `.au-turn*` 层已恢复。
- **位置：** [取舍：请求仍是一行](../architecture/trade-offs.zh-CN.md#2026-11-19--没有派发任务的请求仍是侧栏的一行)、
  [取舍：回合是一次交流](../architecture/trade-offs.zh-CN.md#2026-11-19--回合是一次交流所有者在右分身在左)、
  [取舍：文件夹是学到的](../architecture/trade-offs.zh-CN.md#2026-11-19--文件夹是学到的不是配置的今天的修改来自本机)；
  [执行链路](optimizations.zh-CN.md#2026-11-19--新请求留在侧栏回合读成交流今天的工作来自学到的文件夹)。

## 2026-11-19 —— 视频附件的画面来自 AVFoundation

- **主张：** 通过原生选择器选中的视频，现在由 `AVAssetImageGenerator` 产出 1280×720 JPEG
  帧，而不是 WebView 媒体管线；抽帧等待从约 1.1 秒降到冷 0.16 秒 / 热 0.013 秒。拖放、粘贴
  与抽取失败仍回退到 HTML `<video>` 路径。
- **证据：** `benchmark/video-frame.swift` 在 8.2MB/30 秒/1080p fixture 上：**第一次
  160ms、热 13ms**，164,786 字节 JPEG；
  [`benchmark/results/video-frame-2026-11-19T07-14-36Z.json`](../../benchmark/results/video-frame-2026-11-19T07-14-36Z.json)。
  同一文件的 WKWebView `<video>` 路径为 1,065–1,277ms，所有 seek/metadata/`toBlob` 变体
  1,112–1,222ms，编码 10–19ms。`test/attachment-client.test.ts` **13/13**（含原生帧用例）；
  Swift 外壳 typecheck 通过；全量 **916/916**（本次运行时）；typecheck 与 gate 通过。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--视频附件的画面来自-avfoundation)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--视频帧来自-avfoundation而不是-webview-媒体管线)。

## 2026-11-19 —— 审计视图不再等待网关用量

- **主张：** 审计列表把 Magpie 用量行缓存 15 秒，并把可选网关等待限制在 1 秒；慢或缺失的
  网关不再让每次打开审计都等待，重复打开复用 499KB 响应，而不是重新拉取与解析。
- **证据：** 变更前线上 `/api/audit`：2,290/404/62ms（181KB、27 个 Run）；仅网关用量请求
  429/57/21ms、499,369 字节。变更后直接拉取测得 **第一次 438ms / 第二次 0ms**；审计投影约
  60ms，因此热的审计打开约 60ms，冷的也有界在 1.5 秒左右。`test/magpie-usage.test.ts`
  **4/4**（缓存、过期、悬挂网关、失败缓存为空）；全量 **916/916**（本次运行时）；typecheck
  与 gate 通过。Benchmark：
  [`benchmark/results/audit-usage-2026-11-19T06-46-17Z.json`](../../benchmark/results/audit-usage-2026-11-19T06-46-17Z.json)。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--审计用量补充有缓存与上限)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--审计视图不再等待网关的用量历史)。

## 2026-11-19 —— 附件选择器跳过 sheet 动画

- **主张：** 原生附件选择器改用应用级模态 `NSOpenPanel.begin`，不再用窗口 sheet；页面就绪
  1.5 秒后预热一次冷构造。每次选择的 sheet 约 270ms 动画消失，第一次点击不再支付约
  300–660ms 的冷构造。
- **证据：** `benchmark/attachment-panel.swift` 在 M5 Pro 上用外壳的内容类型测得：第一次冷
  sheet `build=659ms, visible=984ms`；构造预热 `112ms`；热 sheet
  `build=100ms, visible=389ms`；热 `begin` `build=80ms, visible=106ms`。结果文件：
  [`benchmark/results/attachment-panel-2026-11-19T06-21-31Z.json`](../../benchmark/results/attachment-panel-2026-11-19T06-21-31Z.json)。
  `test/desktop-shell.test.ts` 钉住 `panel.begin` 与预热函数；全量 **906/906**（本次运行时），
  `npm run typecheck` 与 `npm run gate` 通过。打包 App 没有为点击到面板的绝对值加计时，但在
  2026-11-19 重建并重启后，所有者反馈附件交互"现在很快了"。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--附件面板不再播放-sheet-动画)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--附件面板约-110ms-出现不再播放-sheet-动画)。

## 2026-11-19 —— 原生窗口是唯一的界面；浏览器预览入口已移除

- **主张：** 仓库只暴露一个界面入口：已安装的原生窗口及其受监督的 `port: 0` loopback
  服务。`.claude/launch.json`、`scripts/companion-dev.mjs` 与 `companion:dev` 脚本已删除，
  Claude 会话不能再启动一个与 App 相似、却写第二个 clone home 的浏览器页面。归档评测重放
  仍以 `CLONE_AI_PORT` 直接启动服务器。
- **证据：** `test/desktop-only-ui.test.ts` 在移除前失败（`.claude/launch.json` 仍在），
  移除后 **2/2** 通过；`npm test` **884/884**；`npm run typecheck` exit 0；
  `npm run gate` **PASS**；停掉三个预览服务器后，4317/4318/4319 上没有监听。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--已安装窗口是唯一的界面浏览器预览入口被移除)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--浏览器预览入口被移除原生窗口是唯一的界面)。

## 2026-11-19 —— Agent 协作 的行打开拥有它的任务记录

- **主张：** 主对话 Agent 协作 卡片里的每个子 Agent 行都能一次点击打开拥有它的任务记录；
  目标卡片展开、对应行被滚入视野一次，悬停时标题显示下划线且光标为指针。自己记录内的行保持
  纯文本。
- **证据：** `test/agent-collaboration-link.test.ts` **1/1**（对话与任务记录都返回子 Agent
  的 `runId`）、`test/ui-structure.test.ts`（记录外是按钮、记录内是纯行、一次性焦点、点击
  接线、悬停下划线）、全套 **876** 个测试 / **875** 通过且 WhatsApp 文件在空闲端口上通过
  （共享工作区上的最终重跑 **885/885**）、
  `npm run typecheck` 与 `npm run gate` 通过；浏览器预览中点击后落到记录、卡片展开且行在
  视野内，Playwright 悬停报告 `underline` 与 `pointer`。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--agent-协作的行打开拥有它的任务记录)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--agent-协作-的行打开解释它的记录)。

## 2026-11-19 —— Worker 可读整机，每个写入都携带 Scope

- **主张：** Worker 可以读取本机任何可读位置，受保护位置除外；没有文件夹（包括工作区）默认
  可写——每个写入步骤携带显式的 `files` 写 Scope，由权限引擎判定（`observe` 拒绝，
  `prepare`/`act_with_approval` 询问所有者，`act_auto` 放行）。当前目录之外被点名的项目会被
  读取，而不是回答"在工作区之外"。
- **证据：** `test/path-gate.test.ts`（外部读取放行、写入需要授权根、活工作区不是根、隔离副本
  是根、`~/.ssh` 被拒、任何根下的 `.git` 被拒）、`test/native-worker-tools.test.ts`
  （工作区外无 Scope 读取、设备被拒）、`test/native-agent-worker.test.ts` 与
  `test/mcp.test.ts`（读取路径不受限、写入仍受限）、`test/companion-main-agent.test.ts`
  （提示词说明整机是可读范围且没有默认可写文件夹）、`test/write-scopes.test.ts` **9/9**
  （工作区回退、点名目标、写入线索提取、observe/批准转换）、`test/golden-path.test.ts` 在 `act_auto`
  策略下完成；全量 **873/873**（排除端口冲突的 WhatsApp 文件为 852/852，空闲端口下
  21/21），`npm run typecheck` 与 `npm run gate` 通过。
- **记录位置：** [读取取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--整台电脑就是工作区读取不设边界)、
  [写入取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--写入也没有工作区每个写入都携带-scope)、
  [读取链路](optimizations.zh-CN.md#2026-11-19--整台电脑就是工作区仅限读取)、
  [写入链路](optimizations.zh-CN.md#2026-11-19--写入按步骤授权而不是按工作区)。

## 2026-11-19 —— Main Agent 可以按需召回另一个任务的上下文

- **主张：** `search_history` 默认检索全部任务对话，每条结果带对话与时间，可收窄到当前对话，
  并把查询、范围与命中写入审计；自动上下文仍按对话隔离，因此多个 Main Agent 实例保留隔离与
  并发。
- **证据：** `test/history-search.test.ts` **2/2**；`test/native-main-agent.test.ts` 的
  跨对话工具用例；`test/main-agent-turn-audit.test.ts` 的来源用例；
  `test/ui-structure.test.ts` 的界面用例；全量 **858/858**，`npm run typecheck` 与
  `npm run gate` 通过。浏览器：主对话的提问召回了 `conversation-other` 的回合与一个弱匹配，
  审计显示 "检索 1 次 … 历史检索 海港项目 · 全部对话 → 2 条 · 对话 other、对话 b276bc66-d13"。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--main-agent-可以跨任务对话检索)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--main-agent-可以跨任务对话检索)。

## 2026-11-19 —— 新请求由 Clone AI 路由，而不是由所有者选择

- **主张：** 一个"新请求"动作取代新建对话/新建任务的选择；规则线索沿用相关对话，新目标线索
  或没有上下文时新开 Main Agent，含糊请求只问模型一次（失败即新开）；每个任务记录标出派发它的
  Main Agent 并可打开该对话；审计显示路由决定与理由。
- **证据：** `test/conversation-router.test.ts` **8/8**（规则续接/新开、新目标线索、模型
  续接/新开、模型不可用回落、最近对话、任务 → 对话）；`test/companion-control-plane.test.ts`
  的路由 API 与 Journal 用例；`test/main-agent-turn-audit.test.ts` 的审计路由用例；
  `test/ui-structure.test.ts` 的界面用例；全量 **848/848**，`npm run typecheck` 与
  `npm run gate` 通过。浏览器：任务记录显示 "派发者 对话 ce9205bc-c20… 的 Main Agent" 与
  按钮；"继续整理这份资料…" 以规则沿用了该对话；"做一个全新的项目…" 创建了
  `conversation-b276…`；审计显示 "路由 沿用对话 …（规则判断）" 与
  "新开 Main Agent …（模型不可用，按新开处理）"。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-19--只有一个新请求动作由-clone-ai-路由到-main-agent)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--一个新请求由-clone-ai-路由到-main-agent)。

## 2026-11-19 —— 就绪不再等待首轮维护

- **主张：** 伴随服务器先发布回环端点并回答 `/api/health`，再运行首轮后台维护。被持有的
  记忆提炼锁——另一个 sidecar 正在提炼，或提炼器正在等模型——不再让 Daemon 活着却不可见、
  桌面窗口停在"正在连接"。在八条待提炼请求且锁被持有时，sidecar 现在约 170 毫秒就绪，
  而不是在 15 秒测量脚本超时内始终不就绪；锁空闲的对照为 246 毫秒。维护轮内部，机会扫描
  先于提炼排空，因此所有者首屏看到的到期卡片在锁被持有时仍然最新；关停会中止所有后台锁等待
  ——维护轮、其治理操作、进程内锁队列，以及定时任务运行后的提炼——保持优雅，而不是挂起到
  SIGKILL。
- **证据：** `test/companion-startup-readiness.test.ts` 钉住四种行为：持锁时就绪、持锁时
  `/api/opportunities` 已含到期卡片、不释放提炼锁或治理锁时 `close()` 在 2 秒内返回。
  `test/workspace-lock-abort.test.ts` 钉住四个聚焦用例（外部锁等待、排队等待、流水线提炼、
  对话排空）：信号被去掉时它们会超时。第一条在变更前
  为红（4 秒就绪等待在 4.04 秒超时；测试第一版报告的信息为
  `startCompanionServer did not publish readiness while the extraction lock was
  held`），变更后为绿；扫描与关停两条由独立审查的探针在变更第一版上
  验证为红（释放前 `0` 张卡片；close 在 2 秒后仍未返回）。最终隔离运行：服务器用例
  **52.9 / 15.1 / 114.2 毫秒**，聚焦中止用例 **105.6 / 53.1 / 107.6 / 108.3 毫秒**，
  均通过。对线上 home 副本的启动测量，
  `node /tmp/clone-startup-measure.mjs /tmp/clone-home-hang-tJjQVr 15000`：变更前 15 秒内
  没有 `CLONE_AI_READY`，变更后 **178 毫秒** / **170 毫秒**。完整测试 **858/858**，
  `npm run typecheck` 退出码 0，`npm run gate` **PASS**。没有加载 LaunchAgent 时的端到端
  启动（App 拉起自带的 sidecar，其中包含本次变更）：五次干净启动在 **512–1158 毫秒** 打印
  `CLONE_AI_DESKTOP_READY`；另有独立的界面浏览器测量在 282 毫秒完成最初一轮 API 调用
  （另一次在退出一秒后的启动耗时 4.4 秒，原因未查明且未复现）。现场症状：launchd PID 80762
  存活 15 小时 51 分，却没有监听套接字与端点文件；窗口停在"正在连接"。
- **位置：** [取舍：先发布就绪端点，再跑首轮维护](../architecture/trade-offs.zh-CN.md#2026-11-19--先发布就绪端点再跑首轮维护)、
  [执行链路](optimizations.zh-CN.md#2026-11-19--先发布就绪端点再跑首轮维护)。

## 2026-11-18 —— 决定属于任务记录，审计显示组装

- **主张：** 侧栏只列派发的任务；等待中的任务被提升到"需要你的确认"并带明确的
  `需你确认`/`需你复核` 标签；确认与复核卡——含步骤与按钮——直接在任务记录上决定；审计中的
  每个主 Agent 回合显示对话、历史窗口、提示词材料、工具表与派发的 Run。
- **证据：** `test/ui-structure.test.ts` **15/15**、`test/companion-control-plane.test.ts`
  **22/22**、`test/main-agent-turn-audit.test.ts` **13/13**、
  `test/companion-config-api.test.ts` **21/21**；全量 **831/831**，`npm run typecheck`
  与 `npm run gate` 通过。浏览器：一个暂停的 Run 只出现在"需要你的确认 · 1"并带
  `需你确认`；其记录显示"需要你确认后才能继续 / 步骤：发送"与确认/拒绝；一个新任务经桩模型
  派发了 Run，审计 → 主 Agent 回合显示 "任务组装 · 1 个 Run · 材料 ebbfb873 … charter v2 ·
  情境简报 · AGENTS.md · 工具表 11 个 … 整理本周资料 失败 起草"。
- **记录位置：** [取舍：以任务记录为单位](../architecture/trade-offs.zh-CN.md#2026-11-18--以任务记录为单位列表不留对话行确认在任务内完成)、
  [取舍：审计说明组装](../architecture/trade-offs.zh-CN.md#2026-11-18--审计说明每一次-main-agent-回合是怎么组装任务的)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--列表是任务决定在任务内审计说明组装)。

## 2026-11-18 —— 直接回答为 direct_response 步骤提供证据

- **主张：** 单 Agent 的 `direct_response` 步骤不再在 Worker 已作答之后失败。原生 Worker 为
  最终回答记录恰好一条 `observation` 证据（有界摘要、`locator: answer:<stepId>`），并以
  `produced.size === 0` 为条件，避免真实读取被重复记录；其他步骤保留自己的证据闸门，Kernel
  不合成证据。
- **证据：** 确定性轨迹 `53074cf2` 复现失败
  （`Agent direct-responder completed step direct-response without evidence.`）。修复通道
  第三次尝试：第一阶段 Run `566b1603` 在
  `test/regression/direct-response-evidence.test.ts` 上为红；修复 Run `1d811b94` 让用例
  转绿；通道内完整套件 **760/760**、typecheck 0。分支 `rsi/auto-fix-20261118T1044`，
  提交 `76aec5d`。应用到共享树：回退修复时新用例为红，恢复后为绿；全量 **832/832**、
  `npm run typecheck` 0、`npm run gate` **PASS**。前两次通道尝试（没有写测试；注释只有
  英文）记录在优化日志，不写进成果文件。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--直接回答就是-direct_response-步骤的证据)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--直接回答证据缺口修复通道经过三次尝试产出了补丁)。

## 2026-11-18 —— 只读请求得到回答，而不是因缺少产物而失败

- **主张：** 只读或分析请求被规划为一个只读步骤、以观察证据交付，而不是一份要求目标
  明确禁止的文件的草稿。混合计划中的研究与复核工单也要求观察证据。不可满足的合同在挂载
  计划时被拒绝，被拒绝的计划会关闭它的 Run，而不是冻结在 `planning`。Worker 会被告知
  必需合同；证据记录不再让先前的读取掩盖写入，也不会在观察上限下丢掉写入。
- **证据：** 三段 Journal 原文（`663b45b5`、`c03c7cea`、`cd74804b`）在变更前复现为
  `prepare/reversible_write` + `draft/local-draft`（`kind: artifact`、
  `locatorRequired: true`），Journal 只有 `observation` 行，验证以
  `Missing required artifact evidence: local-draft` 失败；变更后同样原文得到单个
  `read-only-lookup` 步骤，没有产物合同。确定性 eval：
  `node --experimental-strip-types --test test/fallback-planner.test.ts
  test/worker-evidence-contract.test.ts` **18/18**；全量 **831/831**；
  `npm run typecheck` 退出 0；`npm run gate` **PASS**（verdict/policy/audit/memory
  100%）。未在桌面 App 中实测：变更后没有再派发真实任务。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--只读请求得到观察证据而不是产物)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--只读请求得到回答而不是因缺少产物而失败)。

## 2026-11-18 —— 已完成任务不再把目标提为记忆

- **主张：** 未配置提炼器时，任务提炼不提出候选；任何提炼器提出的、只是复述任务目标的
  无类型或 `procedure` 候选都会在所有者审核列表之前被丢弃，等于目标的有类型偏好等留给审核。
  一次性治理扫描拒绝了线上 home 中待确认的遗留复制，剩下零条；审核列表、注意力列表与
  Dashboard 不再把已决定的复制当作当前候选。
- **证据：** 线上 Journal `~/.clone/journal.sqlite3`：8 条 requested / 8 条 extracted
  （全部 `count: 1`）/ 8 条 proposed，每条摘要都是 `候选流程：` 加完全一致的任务目标；
  2 条由所有者拒绝、6 条由清理拒绝，**0 条待确认**。`test/memory-candidate-quality.test.ts`
  **8/8**（默认为零、闸门丢弃/保留、等于目标的有类型偏好保留、`=all` 选中真实提炼器、
  清理只执行一次）；`test/golden-path.test.ts` **2/2**；`test/runtime.test.ts` **5/5**；
  `npm run gate` **13/14/4 + memory 26/26**，100% 一致，基线已重新生成；
  `npm run typecheck` 退出 0。完整 `npm test`：**831/831**。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--已完成的任务不是记忆候选必须陈述持久知识)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--已完成任务的目标不再变成记忆候选)。

## 2026-11-18 —— 并发 Main Agent 回合共享一份 Worker 预算

- **主张：** Worker 容量现在是每个 clone home 一份实测 `CapacityGate`，由该 home 上的每个
  组装共享——Daemon、每次 Query 工作流、主 Agent 逐次调用的 Kernel 会话与修复通道——因此两个
  并发 Main Agent 回合同时派发时，不会超过一份实测 Worker 预算。所有者的
  `maxConcurrentWorkers` 固定值仍然生效，且通过任一组装刷新后无需重启即可到达全部组装。
  注册表带引用计数，因此测试中的临时 home 不会累积条目。
- **证据：** `test/runtime-capacity-sharing.test.ts`——5 个确定性用例（固定为 1 时共享闸门
  且一次获取排队；固定值跨组装传播；Kernel 会话从 Daemon 的闸门取用；最后一个关闭后退休，
  重复关闭只释放一次；十二个临时 home 不留残余）。对 `HEAD` 的逐组装工厂运行时，用例 1–4
  失败；加上本变更后 5/5 通过。全量 **798/798**、`npm run typecheck`、`npm run gate` 通过。
  未经 live 验证：超订本身从未在两个同时派发的任务上实测。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--每个-clone-home-一份实测-worker-预算而不是每个组装一份)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--worker-容量变成每个-clone-home-一份预算)。

## 2026-11-18 —— 主界面读起来是一份派发日志

- **主张：** 对话的主界面按 Main Agent 回合渲染日志条目——query、组装出的上下文（Provider/
  模型/强度、提示词材料与工具表、历史窗口、压缩）、本回合派发的工作（工具调用与派生 Run）与
  结果——而不是聊天气泡；任务记录视图与决定卡片不变。
- **证据：** `test/main-agent-turn-audit.test.ts`（投影与搜索）、
  `test/ui-structure.test.ts`（日志与消息、实时回显、隐藏与失败回合）、
  `test/companion-control-plane.test.ts`（会话视图回合、日志边界、隐藏的派生 Run）与
  `test/prompt-snapshot.test.ts` 通过——**58/58**；全量 **834/834**、
  `npm run typecheck`、`npm run gate` 通过。隔离的预览 home 上的浏览器检查：两个回合都渲染成
  日志条目，带 `native/verify-model`、`charter v2`、`工具 11 个`、
  `此前 1 轮已完成对话` 与回复，没有一个聊天气泡。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--主界面是派发日志而不是聊天记录)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--对话的主界面变成派发日志)。

## 2026-11-18 —— 只读请求只跑一次，且在工作区里跑

- **主张：** 显式只读请求（或没有交付物的研究请求）变成一个由 `context-researcher` 执行的
  只读步骤，没有 draft 工作单，也没有必需工件；`dispatch_task` 的 Run 在本回合的工作区里
  执行，而不是守护进程所在的检出；`execution.started` 记录该工作区。
- **证据：** `test/fallback-planner.test.ts` **10/10**（只读请求与只读代码审查都是一个步骤；
  点名输出目标仍得到 draft；含"写"的禁止写入短语不会变成交付）；`test/main-agent.test.ts`
  **37/37**（含工具 Runtime 工作区用例）；`test/native-main-agent.test.ts` 与
  `test/dispatch-task.test.ts` 通过。变更前：Run `c03c7cea`/`cd74804b` 以
  "Missing required artifact evidence: local-draft" 失败；Run `b1e04b18` 在
  `/Users/user/study/clone-ai` 里执行，把 knowledge-base 的 README 报成工作区之外。
  变更后：在 `/Users/user/work/knowledge_base` 上的 live 检查（native /
  `openai/gpt-6.1-terra`）只产生**一个** Run（`99504e85`），单个
  `read-only-lookup` 步骤（`delegated: false`、`risk: read_only`），读到了绝对路径的
  README、记录 observation、把三句概述写成 `execution.completed`，进入 `waiting_review`。
  全量 `npm test` **829/829**；`npm run typecheck` 与 `npm run gate` 通过。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--只读请求是一个步骤工具使用本回合的工作区)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--只读请求是一个步骤run-使用本回合的工作区)。

## 2026-11-18 —— 复核显示 Worker 的回答，Prompt 知道工作区

- **主张：** 主 Agent 的 Prompt 现在从设置里配置的工作区加载项目指令，并写明该工作区；规划者
  与 Worker 都被告知，工作区之外点名的项目必须如实报告，不能用工作区里的文件顶替。单 Agent
  步骤的最终回答会写入 Journal，并显示在任务记录与固定在面板顶部的复核卡里。Worker 的文件
  工具与闸门一样用 `resolve` 解析路径，因此工作区内或授权读取根内的绝对路径能读到闸门批准的
  文件。保存不同的工作区时会提示需要重启 App。
- **证据：** `test/companion-main-agent.test.ts` **6/6**（新用例捕获到配置工作区的
  `AGENTS.md` 标记与 `Current workspace: …`，且不含检出里的规则）；
  `test/run-query-routing.test.ts` **11/11**（新用例找到摘要为 Worker 回答的
  `execution.completed`）；`test/main-conversation-approvals.test.ts` **5/5**；
  `test/companion-config-api.test.ts` **19/19**（不同路径时重启提示为 true，运行中的路径没有
  该字段）；`test/ui-structure.test.ts` **14/14**；`test/native-agent-worker.test.ts`
  **15/15**；`test/native-worker-tools.test.ts` **6/6**（工作区内的绝对路径与工作区外的
  授权读取根）；`npm run typecheck` 退出 0；`npm run gate` PASS，基线未变。变更前的 live 数据：
  Run `062716a9` 没有完成事件，提示词快照 `a063d154…` 读的是 clone-ai 检出的 `AGENTS.md`。
  live 检查（native / `openai/gpt-6.1-terra`，全新的临时工作区）：原始请求改为询问路径
  或切换工作区，且没有派发任何 Run（`newRuns: []`）；没有"没有文件系统工具"这一行时它仍
  派发了一个失败的 Run，说明该行是必要的。真实 App 验证：Run `b1e04b18` 因 `join` 把绝对路径
  拼成双前缀而失败；修复 `resolve` 后，Run `496d2061` 读到了 knowledge-base 的 `README.md`
  （`isError: false`），记录了三句 `execution.completed`，进入 `waiting_review`，任务记录在
  "已接受"之前显示了这条回答。全量 `npm test` 在共享检出的并发变更稳定后是 **829/829**
  （更早一次运行撞上另一个会话的 dev server 占用 4318 端口造成的 `EADDRINUSE`；该服务
  停止后通过）。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--主-agent-知道自己的工作区复核带着答案)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--主-agent-读取自己的工作区复核带着回答)。

## 2026-11-18 —— 只在文字中提到的路径不再让 Worker 步骤失败

- **主张：** Native Worker 只有在工作单以 `required: true` 声明某输入时，才因该输入缺失而判步骤失败；仅仅出现在目标、指令或验收标准里的路径只是上下文，运行期间后来被读取或写入的路径也不再算缺失。已声明且仍然缺失的必需输入仍会失败。
- **证据：** 修复通道报告：`status: fixed`、分支 `rsi/auto-fix-20261118T0913`、提交 `fb496e5b`，变更前红色、回归全绿（4 个文件）、worktree 全套 **759/759**、typecheck **0**（`/tmp/clone-repair-automation/rsi/last-run.json`）。独立检查：`test/regression/native-missing-input.test.js` 在未打补丁的 `07f8bb5` worktree 上以断言失败，在分支上通过。分支已快进合并进 `main`。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--指令里提到的路径不是必需输入)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--指令里提到的路径不是必需输入修复通道已修复)。

## 2026-11-18 —— 任务作为独立的 Main Agent 运行，并发由机器约束

- **主张：** 每个任务都是自己的 Main Agent 对话，拥有自己的历史；一个任务在执行子任务，不再
  阻止另一个任务；并发 Main Agent 回合由跨进程槽位池按 CPU 与负载采样限制，
  `maxConcurrentMainAgents` 是所有者的固定值；桌面端可以在第一个任务仍在流式输出时开始第二个。
- **证据：** 功能测试 **21/21**（`test/main-agent-capacity.test.ts` 3/3、
  `test/main-agent-slots.test.ts` 5/5、真实的双进程槽位测试 1/1、
  `test/prompt-lock.test.ts` 4/4、`test/native-main-agent.test.ts` 7/7（含对话隔离）、
  `test/run-triggers.test.ts` 1/1）；`test/companion-control-plane.test.ts` **22/22**
  （各自独立的历史、主对话不吸收任务、同名失败对话保持独立、隐藏对话拒绝发送、裸 Run id 被
  拒绝为对话 id）；`test/companion-config-api.test.ts` **20/20**（固定值可设置与清除）；
  全量 **791/791**，`npm run typecheck` 与 `npm run gate` 通过。在全新的 companion 与本地
  SSE 桩模型上做浏览器检查：两个任务相隔 350 ms 启动，都作为独立对话完成；第一个完成时第二个
  仍是选中项；每个视图只含自己的回合；主对话两者都不含。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--每个任务有自己的-main-agent并发由机器实测决定)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--每个任务有自己的-main-agent并发由机器实测决定)。

## 2026-11-18 —— 核验记录读起来是一个决定，而不是一份重复的清单

- **主张：** 核验卡现在把所有者的决定作为结论，标准变成带编号的短行、重复的步骤标题降为
  弱化的一行，摘要只给计数而不是再粘贴一遍；新记录只存一次标准。
- **证据：** `test/ui-structure.test.ts` **12/12**、`test/verification.test.ts` **16/16**；
  浏览器检查渲染出 4 个带编号行、标签 `已接受结果`、`检查了 11 条证据`；全量 **759/759**，
  typecheck 与 gate 通过。运行 `18569eb4` 的存储摘要是历史事件，由界面改写呈现。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--核验记录只给计数不再重复整份标准)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--核验记录不再自我重复)。

## 2026-11-18 —— 已结束的任务记录保留核验、证据与产物

- **主张：** 已复核 Run 的任务记录在决定之后仍保留系统结论、所有者决定、未自动验证的标准
  与被检查证据数；证据以清单形式列出产物（在观察之前），而不只是计数；等待决定时轨迹默认展开。
- **证据：** `node --experimental-strip-types --test test/ui-structure.test.ts` ——
  12/12，其中包含渲染标记检查（用假会话跑
  `verificationMarkup`/`evidenceMarkup`/`traceMarkup`）；`npm test` 759/759、
  `npm run typecheck` 与 `npm run gate` 通过。在所有者 Journal 的隔离副本里，Run
  `91b685cf` 显示「核验结果/需要你的复核」、9 行证据与展开的 43 行轨迹；Run `4ce0db3d`
  显示「通过/你的决定：接受结果」、3 行产物排在 23 条观察之前，以及展开的 214 行轨迹。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--已结束的-run-仍要显示核验证据与轨迹)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--已结束的-run-保留核验证据与轨迹)。

## 2026-11-18 —— 确认从主对话完成

- **主张：** 每个待确认与待复核项都可以在 Main Agent 主对话里决定，每张卡片提交到所属的
  Run id——包括两者同时等待的情况；子任务记录只给出回到主对话的入口，不再有第二套按钮；
  派生任务折叠在所属对话之下。
- **证据：** `node --experimental-strip-types --test test/ui-structure.test.ts
  test/main-conversation-approvals.test.ts`——**14/14**，而 HEAD 上界面契约因
  `session.id !== MAIN_CONVERSATION_ID` 失败；`test/main-conversation-approvals.test.ts`
  **3/3**；全量 **758/758**，typecheck 与 gate 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--确认集中在主对话子任务折叠在其下)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--确认移到主对话)。

## 2026-11-18 —— 已结束的任务记录保留结论与证据

- **主张：** 所有者接受或拒绝结果后，任务记录仍显示系统结论、所有者的决定、未自动验证的
  标准、Run 产出的证据行（产物在前），以及仍在等待决定时展开的轨迹。
- **证据：** 新界面契约测试在 HEAD 上失败（**9/11**），变更后通过（**11/11**）；全量
  **758/758**，typecheck 与 gate 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--已结束的-run-仍要显示核验证据与轨迹)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--已结束的-run-保留核验证据与轨迹)。

## 2026-11-18 —— 界面编辑无需重启守护即可到达运行中的窗口

- **主张：** 服务源码检出的常驻守护现在按请求重读每个客户端资源，因此界面编辑在下一次加载
  就生效，而不是让窗口停留在启动时读取的脚本上；调用了自己从未定义的函数的源码现在会让界面
  测试失败。
- **证据：** 向 `app.js` 追加一行后，下一次请求提供的长度随之变化（152,768 → 152,778
  字节），无需重启，而陈旧快照提供的是 150,805；`test/ui-structure.test.ts` **10/10**；
  全量 **757/757**，typecheck 与 gate 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--服务源码检出的守护按请求重读客户端文件)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--服务源码检出的守护提供文件本身而不是启动时的副本)。

## 2026-11-18 —— 步骤在模型说完成时结束，而不是撞上某个轮次数字

- **主张：** 共享 Agent 循环不再有默认的模型轮次上限。它一直继续，直到模型给出回答、回合被
  中止，或时长/工具调用/token 预算把它停下；显式的计划预算或 `CLONE_AI_NATIVE_MAX_ROUNDS`
  仍可在设置时约束步骤，规划器不再写 `maxModelCalls`。
- **证据：** `node --experimental-strip-types --test test/agent-loop.test.ts
  test/native-agent-worker.test.ts test/companion-main-agent.test.ts`——连续 13 轮请求工具
  后回答的脚本模型能完成，而显式 `maxRounds: 2` 仍以 `max_turns` 结束；
  `effectiveRoundLimit(undefined, undefined)` 为 `undefined`。`npm test` 756/756，
  `npm run typecheck` 与 `npm run gate` 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--worker-在模型停下时停下没有默认轮次上限)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--worker-在模型停下时停下默认轮次上限已移除)。

## 2026-11-18 —— 故宫基准在 App 内端到端通过

- **主张：** 经 App 自己的守护进程、用一段话任务提交的运行 `18569eb4` 现在评为 **28/28**、
  零硬失败：十座具名殿与屋顶类型、961 米中轴、共用三台、太和殿 64×37×35 米、屋面/斗拱/
  棂格/门钉细节、阴影、orbit 63°、zoom ×0.58、主殿占画面高度 34.5%、体仁阁/弘义阁左右
  对称。
- **证据：** `node benchmark/capability/forbidden-city/verify/check-forbidden-city.mjs
  --workspace "/Users/user/Documents/Clone AI" --out …/verify/app-final2 --interactive`
  → **28/28**，截图在 `screens/`，报告在 `report.json`。过程中：`91a50a87` 在第 12 轮
  被切断（已修）、`9d706a27` 工作区错误（已修）、`4ce0db3d` 数据正确但主殿只占 9%
  （已加入评分）、`18569eb4` 27/28 因配楼放在 `props.sideHalls`（查找已修）。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--默认视角按构图评分而不只看数据)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--加载时的视角按构图评分)。

## 2026-11-18 —— 所有者的消息气泡渲染 Markdown

- **主张：** 所有者消息现在通过 Agent 回复所用的同一个先转义渲染器呈现标题、列表、行内/
  围栏代码与粗体，粘贴的任务说明不再是字面 Markdown。
- **证据：** `node --experimental-strip-types --test test/ui-structure.test.ts` ——
  **8/8**。在隔离的 companion 预览服务器上做浏览器检查：注入的所有者消息产生 1 个标题
  （计算权重 720）、2 个圆点、1 个粗体、2 个行内代码与 1 个代码块；文本里的 `<script>`
  没有产生 script 节点，`window.__pwned` 保持 false。全量 **751/751**，typecheck 与 gate
  通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--所有者的消息与-agent-回复走同一条-markdown-路径)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--所有者的消息渲染-markdown)。

## 2026-11-18 —— 自动化不再与所有者的运行时竞争

- **主张：** 修复通道、夜间 RSI 与评测 companion 解析隔离的 clone home
  （`.automation/<用途>` 或 `CLONE_AI_AUTOMATION_HOME`），只播种配置文件，并拒绝所有者的
  在线 home；失败轨迹仍可读，而报告、状态与锁不再落在 `~/.clone`。
- **证据：** `test/automation-home.test.ts` **5/5**；
  `npm run repair -- --dry-run --max-traces 2` 打印隔离 home，并从
  `~/.clone/failed-traces` 读到 **2 条轨迹**；
  `node scripts/nightly-rsi.mjs --dry-run --max-traces 2` 用 `.automation/nightly` 的
  状态从同一批轨迹规划；`companion-dev` 在没有提供 home 时回落到
  `.automation/preview`，并拒绝 `~/.clone`。全量 **750/750**，typecheck 与 gate 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--维护自动化在自己的-clone-home-里运行)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--自动化在自己的-clone-home-里运行)。

## 2026-11-18 —— 一条 Agent 调用可以从行上删除

- **主张：** 每条 Agent 调用记录所在的行在可选记录旁自带删除/恢复动作，删除单条不再需要打开详情并滚过 Prompt；批量动作仍作用于筛选后的列表，两者都是软删除。
- **证据：** `node --experimental-strip-types --test test/ui-structure.test.ts` —— **7/7**。在隔离审计 home 里用三条预置记录的浏览器验证：每行都显示「删除」；删除一条后剩两行，追加墓碑并播报"已隐藏 1 条…"；勾选「含已删除」后该行显示「恢复」，恢复后回到三条并播报"已恢复 1 条…"。没有控制台错误。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--调用列表暴露行级删除控件)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--agent-调用列表的行级删除入口)。

## 2026-11-18 —— 从 Finder 打开的 App 附着到常驻守护

- **主张：** LaunchAgent `ai.clone.companion` 已加载时，从 Finder 打开的打包 App 附着到它
  发布的端点，而不是在同一本 Journal 上再拉起一个运行时；没有该任务时仍独立运行。
- **证据：** `node --experimental-strip-types --test test/desktop-shell.test.ts` ——
  **1/1**。手工验证：任务已加载时，变更前的构建拉起了子进程 76242 并重写端点；变更后的构建
  （App 81494）没有子进程，端点仍是守护 pid 78156，`GET /api/health` 返回 HTTP 200。
  全量 **744/744**，typecheck 与 gate 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--打包启动在-launchagent-已加载时选择附着)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--从-finder-打开的-app-附着到已加载的守护)。

## 2026-11-18 —— 完整的模型不再被允许看起来像平面图

- **主张：** 交互检查器评加载时的构图：太和殿必须占画面高度至少 25% 且完整落在画面内，
  方法是按页面报告的相机投影它的角点。运行 `4ce0db3d` 在数据与交互上通过 26/27，却只占
  9.0%；新检查确定性地判该视角失败。
- **证据：** 同一工作区在检查前后的结果：`26/27` → `hero covers 9.0% of frame height,
  inside=true`，26/28、两个硬性失败。评分不消耗模型调用。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--默认视角按构图评分而不只看数据)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--加载时的视角按构图评分)。

## 2026-11-18 —— 一次性的构建并自证步骤不再在第 12 轮被切断

- **主张：** Native Worker 的默认模型调用预算现在是 40，因此一个"写页面—渲染—经浏览器
  工具看截图—按所见修复"的步骤可以在一次 query 内完成。计划预算与
  `CLONE_AI_NATIVE_MAX_ROUNDS` 仍然优先。
- **证据：** App 运行 `91a50a87` 写出了 `index.html`、`src/main.js`、`README.md` 与五张
  截图，随后以 `The agent reached its 12-round limit without a final answer` 失败
  （12 次模型调用、14 次工具调用、102,872 tokens、112.2 秒）。在修正交互检查器、不再评
  视频专属字段后，同一工作区评为 **26/27**（orbit 63°、zoom ×0.55、每帧中位数 33.3 ms），
  唯一未过的是评测提示词从未要求的左右配楼。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--native-worker-的默认轮次预算从-12-改为-40)、
  [检查器取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--交互评分不再考核视频专属字段)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--构建并自证的步骤现在有-40-轮交互评分去掉视频专属检查)。

## 2026-11-18 —— OCR 与旧式 .doc 不离开本机就能交给模型

- **主张：** 扫描 PDF 会回退到 Vision OCR，旧式 `.doc` 由编译进 App 的 Swift 助手用
  AppKit 读取；两者都以有边界的文本块交给模型，沿用现有 50,000/100,000 字符上限。助手从
  stdin 读、向 stdout 写，Node 侧从不写临时文件。
- **证据：** `node --experimental-strip-types --test test/attachments.test.ts
  test/document-extract.test.ts test/native-main-agent.test.ts
  test/desktop-shell.test.ts` —— 31/31；`npm test` 742/742；typecheck 通过；gate PASS。
  编译后的助手读取 `textutil` 生成的 `.doc`，并把渲染后的扫描 PDF 识别为
  `Hello from a PDF fixture.` / `Second line with Tom & Jerry.`；打包 Node 从同级目录
  找到助手并提取两份夹具。45 行密集夹具从 53 行输出中得到 33 行以 `Line` 开头，OCR 可用
  但不完美。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--ocr-与旧式-doc-走原生-macos-助手)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--扫描-pdf-与旧式-doc-也能交给模型)。

## 2026-11-18 —— 窗口自行恢复停掉的运行时

- **主张：** 打包 App 拉起的运行时停止后，窗口不再停在静态的"关闭后重新打开"上：外壳按
  指数退避重启（实测 1、2、4、8、16 秒），显示 stderr 尾行；两种模式每 5 秒探测一次
  `/api/health`，卡死的运行时会被重启（非常驻）或重新附着（常驻）。
- **证据：** `node --experimental-strip-types --test test/desktop-shell.test.ts` ——
  加上新断言后 **1/1**；HEAD 的外壳没有 `scheduleRuntimeRestart`、没有 `/api/health`
  调用，并且仍打印旧文案。用 `CLONE_HOME` 指向普通文件手工启动
  `dist/Clone AI-2026-11-18T06-53-44-937Z.app`：14:55:22.777 / 24.004 / 26.241 /
  30.443 / 38.632 五次重启，间隔 1.2 / 2.2 / 4.2 / 8.2 / 16.2 秒；对一个运行中的运行时，
  `GET /api/health` 返回 HTTP 200。全量 **742/742**，typecheck 与 gate 通过。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--窗口自己监管运行时重启探测并说明原因)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--窗口重启运行时并说明它为什么停下)。

## 2026-11-18 —— 竞态写入的 Journal 事件不再阻止 App 启动

- **主张：** 即使某个进程记录了一次非法的 `failed -> verifying` 转换，companion 仍能从共享 Journal 重建投影；桌面 sidecar 恢复启动与服务，而实时写入方仍被 `changeStatus` 拒绝。
- **证据：** `node --experimental-strip-types --test test/run-state.test.ts test/runtime.test.ts test/run-queue.test.ts test/recovery-concurrency.test.ts` —— **19/19**，`npm run typecheck` 通过。此前在 `hydrate()` 崩溃的 sidecar 现在打印 `CLONE_AI_READY`；带 bearer token 的 `GET /api/dashboard` 返回 **HTTP 200、8 个会话**；每 2 秒一次的 `failed -> verifying` 队列错误停止。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--journal-重放如实反映记录写入方负责校验)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--投影重建能越过竞态写入的状态转换)。

## 2026-11-18 —— 隔离步骤能看到所有者未被跟踪的输入

- **主张：** 在 git worktree 中运行的外部步骤现在会带上所有者未被跟踪、未被忽略的文件，
  因此在 `~/.clone/isolated-workspaces/...` 里能读到种下的 `vendor/three.module.js`，而不是以
  “Required input missing”中止。已跟踪文件仍来自 HEAD；被忽略的产物与符号链接不进入。
- **证据：** `node --experimental-strip-types --test test/isolated-workspace.test.ts`——
  8/8；worktree 用例从沙箱读取 `note.md` 与 `vendor/three.module.js`，读取 HEAD 的
  `tracked.md`，并拒绝 `debug.log`。`npm test` 740/740，`npm run typecheck` 通过，
  `npm run gate` **PASS**。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--隔离-worktree-复制进未被跟踪的工作区文件)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--隔离-worktree-带上所有者未被跟踪的输入)。

## 2026-11-18 —— 归档记忆集是一个控件，而且可以清理

- **主张：** 记忆面板的「已归档」计数现在点一下就把列表筛到归档集；一条归档记忆可以永久删除——两个可能位置的 `.md`、索引行、检索词、权重、版本与暂存变更——并在删除文件之前把决定连同摘要记为 `memory.deleted`。使用中的记忆必须先归档，使唯一不可逆的记忆动作离默认视图保持一步。
- **证据：** `node --experimental-strip-types --test test/md-memory-store.test.ts test/memory-governance.test.ts test/memory-library-api.test.ts test/regression/memory-refresh-focus.test.ts` —— **48/48**。API 用例证明归档→200、使用中→409、未知→404、第二次 DELETE→404、`.md` 消失且没有残留行；存储用例证明 `syncFromFiles()` 不会复活已删除的记忆。`npm test` **734/734**，`npm run typecheck` 通过，`npm run gate` **PASS**（13 个用例、一致率 100%、基线未变）。在隔离的 `CLONE_AI_HOME=/tmp/clone-ai-preview-home` 中，浏览器流程创建 → 归档 → 点击「已归档」 → 删除，最终没有任何 `.md` 文件、`stats 0/0`、一条 `memory.deleted` 事件，归档卡片切换 `aria-pressed`，归档行出现「删除」。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--已归档的记忆可以永久删除且必须先归档)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--归档记忆点一下就能看到也可以永久删除)。

## 2026-11-18 —— PDF 或 .docx 在回合内变成文本

- **主张：** PDF 与 `.docx` 附件在进程内提取，并在该回合以有边界的文本块交给模型，沿用
  文本文档的 50,000/100,000 字符上限。扫描 PDF 与旧式 `.doc` 会带原因拒绝；超长文档会
  截断并写入标记、完成后提示。不向磁盘写任何内容，台账只保留文件名/大小。
- **证据：** `node --experimental-strip-types --test test/attachments.test.ts
  test/document-extract.test.ts test/native-main-agent.test.ts
  test/desktop-shell.test.ts` —— 28/28。夹具 `sample.pdf.b64`、`sample.docx.b64`、
  `scanned.pdf.b64`：文本 PDF 与 `.docx` 提取出预期句子（实体已解码）；纯图片 PDF 以
  OCR 提示拒绝；20 字符预算产生截断标记与 report；损坏的 `.docx` 被拒绝。聚焦测试
  28/28；typecheck 与 `npm run gate` 通过。并发 `companion:dev` 占用 4318 端口之前，全量
  测试为 727/727；之后一次为 731/733，两个失败是该端口上无关的 WhatsApp 网桥
  `EADDRINUSE`。打包产物自带的 Node 从 `dist/…/runtime` 提取了两份夹具（unpdf 4.1MB）；
  重建后的 App 输入框显示两个文档 chip，并发出两条 `{kind:"document", data}`。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--pdf-与-docx-在回合之前提取而不是交给模型直接读)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--pdf-与-docx-在模型看到之前变成文本)。

## 2026-11-18 —— 调用审计可搜索、可清理，且不丢证据

- **主张：** **Agent 调用** 标签页在服务端搜索整个共享调用账本，显示 `显示 N / 共 M 条`，
  并能用可逆墓碑隐藏记录（单条，或已加载的筛选结果）；**含已删除** 可把它们找回来。
  **主 Agent 回合** 标签页也增加了服务端搜索框。
- **证据：** `node --experimental-strip-types --test test/invocation-ledger.test.ts
  test/companion-control-plane.test.ts` —— 10/10 与 15/15；实现前账本测试在导入时失败
  （`does not provide an export named 'markInvocations'`）。完成后全量测试 735/735 通过。
  在预览服务器占用 4318 端口期间有一次运行为 733/734，唯一失败是无关的 WhatsApp 桥
  `EADDRINUSE`；端口释放后复跑为 735/735。在 Browser 面板里用真实
  账本验证：`只回复 ok` 把 23 条收窄到 3 条并恢复焦点；删除一条后剩 2 条；勾选**含已删除**
  后它以「已删除」徽标出现，恢复后回到 3 条且无删除标记。账本文件里该 id 的
  `started`、`completed`、`deleted`、`restored` 齐全，请求原文完好。回合搜索 `故宫`
  由服务端返回 8 条中的 3 条。用 520 条种子账本验证：最旧记录仍可按 id 打开，而列表页在
  500 处截断；带空白的 id 会被裁剪，500 字符的 id 返回 400。浏览器里隐藏 → 恢复一个来回，
  先显示「另有 1 条已隐藏」，恢复后回到 23/23 且无删除标记。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--删除审计里的-agent-调用是墓碑而不是抹掉账本行)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--agent-调用审计可搜索可软删除)。

## 2026-11-18 —— 文本文档随回合移动，而不是进台账

- **主张：** 输入框支持从选择器或全窗口拖入文本文档；模型在该回合收到一个有边界的数据块，
  而回合台账与历史只保留文件名/大小清单。上限是 4 个附件、每个文档 50,000 字符、合计
  100,000 字符；PDF 与二进制文件会带原因拒绝。
- **证据：** `node --experimental-strip-types --test test/attachments.test.ts
  test/native-main-agent.test.ts` —— 18/18。原生用例捕获 Provider 请求，断言文档正文出现在
  `<document name="notes.md" media-type="text/markdown">` 中，而
  `readMainAgentTurnRecords` 只有 `[attached documents: notes.md (11 characters)]`。
  `npm test` 715/715、`npm run typecheck` 通过、`npm run gate` PASS 且 baseline 不变。
  在重建 App 的环回服务器上，选择 `notes.md`、拖入 `todo.txt` 与 PNG，得到两个文档 chip 与
  一个图片 chip；被截获的流请求同时带两份文本正文（`kind:"document"`）与图片 base64，
  发送后输入框清空。无控制台错误；没有发起模型调用。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-18--文本文档以内联方式随消息发送pdf-与跨回合文档暂缓)、
  [执行链路](optimizations.zh-CN.md#2026-11-18--文本文档随回合内联不写进工作区)。

## 2026-11-17 — 细节成为可测量的要求，渲染画面终于体现出来

- **主张：** 故宫基准用计数构件与声明的阴影状态来评建筑细节，而不是任何满足数据契约的渲染都放过；
  一个此前凭数据拿到 24/24 的模型，现在会在三项细节检查与一项阴影检查上失败。
- **证据：** 细节契约下的尝试 E：**24/28**——`model.roof-detail`、`model.dougong`、
  `model.facade-detail` 失败（未报告计数），`browser.shadows` 失败（源码无
  `castShadow`/`shadowMap`；中心裁剪诊断 83.2% 近平坦像素、221,850 个三角形）。同一契约下的
  尝试 F：**27/28**——6 座殿报告 ≥3 段、≥24 条瓦垄、≥40 个斗拱、≥32 条棂格、≥36 枚门钉；源码
  启用 `shadowMap.enabled` 与投影太阳；中心裁剪平坦像素降到 **72.7%**；t=0 与 t=22.5 截图可见
  瓦垄与投影。主管渲染 30.00 s 1920×1080 H.264（7.8 MB）。证据：
  `eval-runs/2026-11-17-forbidden-city/verify/{e-detail,f}/report.json`、
  `…/verify/f/video.mp4`。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-17--细节由计数与阴影评分而不是由文字描述)、
  [执行链路](optimizations.zh-CN.md#2026-11-17--细节在故宫基准中成为可评分的契约)。

## 2026-11-17 — 诚实的交付不再因为诚实而被判失败

- **主张：** 文件验证器不再把 `不要声称 out/video.mp4 已生成` 读成承诺；把 `tests/` 列为交付物
  （或声明测试未运行）的计划不再触发测试证据闸门——而真正要求运行测试的步骤仍然要求测试证据。
- **证据：** 修复前 `extractFileExpectations(尝试C的步骤)` 返回 `[{ path: "out/video.mp4" }]`、
  `mentionsTests(...)` 返回 `true`；修复后分别为 `[]` 与 `false`，而 `npm test passes`、
  `修复后运行测试`、``Run `node --test tests/` `` 仍为 `true`。
  `test/verification.test.ts` 16/16；完整套件 688/688；typecheck 与 `npm run gate` 通过，
  两个新门禁用例已记入基线。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-17--验证器读取否定点名-tests-不再要求测试运行)、
  [执行链路](optimizations.zh-CN.md#2026-11-17--验证器不再惩罚诚实披露)。

## 2026-11-17 — 3D 任务现在会对真实世界失败，而不只是对自身失败

- **主张：** 故宫建模现在对照外部建筑契约评分——十座具名宫殿及其正确的屋顶形制、共用三台、
  可测量中轴线、公开的太和殿尺寸——由主管检查器从 `window.getForbiddenCityModel()` 读取，
  并把 harness 与建模分开报告。
- **证据：** 尝试 C（steered 提示）产出 20 个文件；`node --test` 6/6；检查器 **21/21 硬性
  检查**通过，含 10/10 屋顶形制、10/10 中轴建筑 \|x\| ≤ 1 m、`platformId: three-halls`、
  太和殿 64×37×35 m、对称误差 0 m；主管渲染 900 帧 → 30.00 s 1920×1080 H.264；中位
  33.3 ms/帧。在较早的 01 城市工件上的校准：11/14，仅有的硬性失败是缺少模型契约与 import map
  指向错误。证据：`eval-runs/2026-11-17-forbidden-city/verify/c/report.json`、
  `…/render/video.mp4`；分析见
  [`ANALYSIS.zh-CN.md`](../../benchmark/capability/forbidden-city/ANALYSIS.zh-CN.md)。
- **位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-17--故宫基准考核外部契约并把-harness-与建模分开)、
  [执行链路](optimizations.zh-CN.md#2026-11-17--故宫-3d-基准)。

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

## 2026-11-17 — Finder 启动的 App 也有端点

- **主张：** 端点与凭据持久化在 `config.json`，因此进程环境为空的 App 仍能运行；凭据经
  接口只写，文件权限 0600。
- **证据：** `test/companion-config-api.test.ts`（已存密钥绝不回显、完整重读不泄漏、
  显式清除会移除、缺协议地址被拒）；`test/daemon-supervisor.test.ts`（sidecar 在启动
  companion 之前设置 `umask 0o077`）；全量 687/687；typecheck 与 `gate` 通过。
  未验证：没有用仅配置端点跑真实回合。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-17--端点保存在-configjson-中密钥是只写的)、
  [执行链路](optimizations.zh-CN.md#2026-11-17--端点被持久化密钥是只写的)。

## 2026-11-13 — 分身能挺过 App 退出

- **主张：** 运行时是一个 `launchd` 任务，因此登录即启动、崩溃后重启、关窗后仍在运行；
  App 附着到 Daemon 发布的端点，而不是拥有该进程。
- **证据：** `test/daemon-supervisor.test.ts`（7 个用例：RunAtLoad/KeepAlive/节流存在、
  XML 转义、0600 plist 可重复写入、卸载可重复、argv 与外壳 spawn 一致、默认安装位置）；
  `swiftc -parse -typecheck apps/desktop/macos/main.swift` 返回 0；全量 684/684；
  typecheck 与 `gate` 通过。未实机验证：本会话没有执行 `launchctl bootstrap`，因此安装
  出来的登录项本身未证明。
- **记录位置：** [取舍](../architecture/trade-offs.zh-CN.md#2026-11-13--运行时是一个-launchd-任务app-只是窗口)、
  [执行链路](optimizations.zh-CN.md#2026-11-13--运行时成为-launchd-任务)。

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
- **证据：** 每格 5 个样本，`deepseek/deepseek-v4.1-flash` 经 Magpie，结果文件
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
  `moonshotai/kimi-k3.1-pro` 经 Magpie：**5/5**，包含作为预期失败的
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
