# 优化成果

[English](optimization-results.md) · **简体中文**

本文件记录**真正有效的优化**，每条对应一次经过验证的改进，新的在前。每条写明主张、支撑
它的证据（命令、数字、结果文件），以及完整过程记录在哪里。

**负优化**——eval 显示没有收益、出现回退，或被撤销的——**不写在这里**。它的取舍条目仍保留在
[`docs/architecture/trade-offs.md`](../architecture/trade-offs.md)，作为决定与推翻条件的记录。
推理过程与执行链路留在 [`optimizations.md`](optimizations.md)；本文件只保留值得引用的成果。

规则见 [`AGENTS.md`](../../AGENTS.md) 第 6 条。

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
