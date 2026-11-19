# 优化成果

[English](optimization-results.md) · **简体中文**

本文件记录**真正有效的优化**，每条对应一次经过验证的改进，新的在前。每条写明主张、支撑
它的证据（命令、数字、结果文件），以及完整过程记录在哪里。

**负优化**——eval 显示没有收益、出现回退，或被撤销的——**不写在这里**。它的取舍条目仍保留在
[`docs/architecture/trade-offs.md`](../architecture/trade-offs.md)，作为决定与推翻条件的记录。
推理过程与执行链路留在 [`optimizations.md`](optimizations.md)；本文件只保留值得引用的成果。

规则见 [`AGENTS.md`](../../AGENTS.md) 第 6 条。

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
  工具表与每次工具调用的输入不再渲染在那里；"查看审计"控件以本请求为搜索词落在"主 Agent
  回合"。
- **证据：** `test/ui-structure.test.ts` 从断言对话标记里有"上下文 / 派发 / 模型字符串 /
  `charter v3` / `dispatch_task`"改为断言它们不存在，且"结果 / 产物 / 依据 / 审计入口"存在
  （**22/22**）；`npm test` **901/901**；`npm run typecheck` 退出 0；`npm run gate`
  **PASS**，baseline 不变。用真实标记与 CSS 做静态渲染：四次调用的回合显示为回答加
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
  所有者机器上报告 `/Users/qihoo/work` 下今天 **9 个文件** 变化、**5 个仓库** 及其状态
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
  `/Users/qihoo/study/clone-ai` 里执行，把 knowledge-base 的 README 报成工作区之外。
  变更后：在 `/Users/qihoo/work/knowledge_base` 上的 live 检查（native /
  `360/openai/gpt-6.1-terra`）只产生**一个** Run（`99504e85`），单个
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
  live 检查（native / `360/openai/gpt-6.1-terra`，全新的临时工作区）：原始请求改为询问路径
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
  --workspace "/Users/qihoo/Documents/Clone AI" --out …/verify/app-final2 --interactive`
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
