# 优化日志

[English](optimizations.md) · **简体中文**

每个优化在这里占一条，新的在前。取舍条目在变更之前写；本条目在变更落地后补全。
它的目的是让**工作本身**可审计：不仅改了什么，还包括怎么做的、花了多少、链路哪里弱。
规则见 [`AGENTS.md`](../../AGENTS.md)。

**值得引用的成果放在 [`optimization-results.md`](optimization-results.zh-CN.md)**——每次验证
成立的收益一条短记录，eval 没有收益的优化不写。本文件保留每一次尝试，包括没有成功的那些。

## 模板

```markdown
### YYYY-MM-DD — <标题>

- **目标 / 假设：** 期望什么变好，以及为什么相信它会变好。
- **取舍：** 链接到 `docs/architecture/trade-offs.md` 中的条目。
- **变更：** 一段说明，加上主要文件或目录。
- **Eval：** 命令、数据集或用例 id、变更前后的结果。
- **Benchmark run：** 命令、Provider/模型、数据集或任务 id、评分参数与结果文件。只要跑了
  benchmark 就必须写；仅跑确定性测试的 eval 可以省略。
- **执行链路：** 走过的步骤、使用的 Worker 或工具、耗时与成本、失败与重试。
- **优点：** 这条链路做得好的地方。
- **缺点 / 下次：** 哪里慢、贵、脆或不完整。
- **推翻条件：** 从取舍条目复制。
```

### 2026-11-09 — 合并修复线与共享循环线

- **目标 / 假设：** 本地 `main` 与 `origin/main` 从同一基座分叉：一边是修复通道、自检回路与
  设置页，另一边是共享 Agent 循环、仅原生 Worker、容量闸门、MCP 宿主与技能。两者都需要；
  合并应保留两者，只丢弃所有者明确否决的部分。
- **取舍：** 合并本身沿用既有决定；这里做的两个选择（用本地 MCP 客户端而不是远端宿主、接受
  CLI 移除）由所有者在本会话中确认。
- **变更：** 14 个冲突路径。文档（CHANGELOG、两种语言的取舍与优化日志）逐节取并集，两边的
  条目都没有丢失。代码采用远端架构（仅原生、无 Pi SDK、无 CLI Worker）加上本地 MCP 接线
  （provider catalog 中的 `workerTools`）。合并后恢复：凭据名策略 `worker-env.ts`（对抗探针
  读取它）、共享循环上的所有者轮次预算、Worker Prompt 的"先写再答"规则，以及修复通道在构建
  Provider 之前报告未知 Worker。客户端测试改为单次补全契约；MCP 测试的客户端桩现在回答两次
  （请求工具，然后总结）。
- **Eval：** `npm test` → **616 个测试、616 通过、0 失败**；`npm run typecheck` → 退出 0；
  `npm run gate` → PASS，基线未变。没有遗留冲突标记。
- **Benchmark run：** 无。这是合并而非行为变更；测试套件就是检查。
- **执行链路：** 拉取后发现进行中的合并，列出未合并路径，逐文件比较 stage 1/2/3，就两个真正的
  设计问题（MCP 实现、CLI 移除）询问所有者，文档按并集、代码按架构解决，然后在六轮中修复
  编译与测试后果。
- **优点：** 没有丢弃任何一侧的历史或条目；合并后的树是绿的，两条功能线都还能工作。
- **缺点 / 下次：** 第一次合并把代码文件整体解析成远端版本，丢掉了本分支的循环集成，导致完整
  重做一次。两条长期分叉的线合并时，应逐文件解决并明确记下"这个文件归哪边"，而不是整体取舍。
- **推翻条件：** 如果本地 MCP 客户端更严格的模型挡住了远端宿主支持的工作流，只重新审视那一个
  决定；合并的其余部分是结构性的。

### 2026-11-10 — 关闭审计中已核实的缺陷

- **目标 / 假设：** 对照 Claude Code 2.1.319 的六维审计确认了 78 条缺陷。安全问题不是假设：
  其中多条在本仓库自己的模块上复现过。关闭高危组，让代码声称的边界与它实际执行的边界一致。
- **取舍：** [Scope 检查比较解析后的路径，修复通道的闸门真正生效](../architecture/trade-offs.zh-CN.md#2026-11-10--scope-检查比较解析后的路径修复通道的闸门真正生效)。
- **变更：** 新增 `src/authority/path-contains.ts`（`realTarget`、`containsPath`、`samePath`）；
  `src/authority/scope.ts` 增加 `isCaseSensitive` 与折叠大小写的 `isForbiddenPath`；
  `src/authority/path-gateway.ts` 拒绝覆盖受保护根的授权；`decideTool` 解析两侧、分开读写根、
  拒绝写入 `.git`、路径工具解析不出路径时拒绝；步骤声明的风险等级限制可提供的工具；
  `workerTools` 接受 `writeFileMode`，`provider-catalog` 把修复通道的值传进去；
  `linkDependencies` 改为复制；`max_turns` 一律失败并使用统一的 `effectiveRoundLimit`；
  `toProviderToolName` 在两个客户端边界映射名字；压缩保持工具调用与结果成对；
  请求体上限高于附件上限并返回 413；容量闸门同步转移释放的槽位；Worker 实现
  `cancel(sessionId)`；两个 MCP 客户端监听 stdin 错误；关停时销毁活动连接。
- **Eval：** `npm test` → **626 个测试、626 通过、0 失败**（此前 616 通过）。新增确定性覆盖：
  `test/path-gate.test.ts` 4/4（符号链接逃逸、读写根分离、祖先授权、大小写折叠）、
  原生 Worker 的轮次上限回归、Worker 取消、容量转移、EPIPE、真实图片请求体、带打开流的关停。
  `npm run typecheck` → 退出 0；`npm run gate` → PASS，基线未变。每个安全用例在修复前都用
  脚本手工复现过（`/tmp/sym-test`、`/tmp/ancestor-check.ts`、`/tmp/repair-guard.ts`、
  `/tmp/gate-race2.ts`、`/tmp/attach-body.ts`）。
- **Benchmark run：** 无。这些是契约与正确性修复；实机模型运行无法区分闸门行为。
- **执行链路：** 审计工作流（6 个维度阅读器，74 条发现经对抗性核实）→ 逐条手工复现高危 →
  分四组修复（安全、正确性、可靠性、诚实性）→ 每个缺陷一条测试。过程中的失败：三个既有测试
  假设 `read_only` 步骤可以写（改为 `reversible_write`）；大小写探针需要基于目录清单而不是
  `realpath` 比较；一个附件测试用了签名检查会拒绝的 PNG（换成真正合法的图片）。
- **优点：** 同一条代码路径现在执行文档声称的行为；每条修复都有确定性测试，回归会立刻失败。
- **缺点 / 下次：** 诚实性条目（58.5 基线、"Phase 2 已实现"、Seatbelt 证据、MCP/技能可达性）
  仍未处理；生产路径仍不传 `contextWindow`，因此 token 压缩不可达；`dispatch_task` 仍不可取消，
  因为 `runQuery` 不接受 signal；修复通道仍不持 claim 执行。这些需要各自的变更。
- **推翻条件：** 见取舍条目。

### 2026-11-09 — 停止正在生成的回答

- **目标 / 假设：** 服务端已经能取消回合，但界面没有入口。回合运行时把发送槽位换成停止控件，
  让现有能力变成一键可达。
- **取舍：** [每个进程内工具调用都经过逐次决定](../architecture/trade-offs.zh-CN.md#2026-11-06--每个进程内工具调用都经过逐次决定)
  是让回合中取消有意义的那道闸门；界面变更属于桌面控制面的决定。
- **变更：** 输入区在发送槽位渲染 `stop-turn`；点击或按 Escape 会中止 fetch，进而关闭 SSE
  连接并触发此前加入的服务端 abort。用户停止与静默超时的提示不同；回合结束后发送按钮恢复；
  没有收到回答时恢复已输入的文本。
- **Eval：** `test/ui-structure.test.ts` 检查控件、默认隐藏、Escape 绑定与独立文案。
  `npm test` → **566 个测试、566 通过、0 失败**；typecheck 与 gate 通过。浏览器预览中控件
  在发送槽位内以自己的样式渲染。
- **Benchmark run：** 无。这是既有端点上的界面可达性变更。
- **执行链路：** 标记 → 样式 → 发送路径 → 文案 → 结构测试；浏览器预览显示停止控件比发送
  高 2px，因此两者改为在同一个槽位共用一个固定盒子。预览停止并重启一次以确认样式表重新加载。
- **优点：** 所有者能结束失控回合；可见文案把主动停止与网络卡住区分开。
- **缺点 / 下次：** 两个控件共用了槽位却没有共用盒子，直到加入共享尺寸规则才一致；预览发现了
  38px 与 30px 的差异。凡是可能占用该槽位的控件，都应共用一条尺寸规则。
- **推翻条件：** 如果所有者更希望保留常驻发送按钮并在旁边单独放停止，就拆回两个控件，但保留
  同一条 abort 路径。

### 2026-11-09 — 对话中的实时工具时间线

- **目标 / 假设：** 桌面端会流式输出回答，却不显示 Agent 在做什么。通过同一条 SSE 流送达
  的工具时间线，让回答仍在生成时就能看见拒绝与慢工具。
- **取舍：** [模型可以派发任务，但只有 Kernel 规划与判定完成](../architecture/trade-offs.zh-CN.md#2026-11-09--模型可以派发任务但只有-kernel-规划与判定完成)
  覆盖这条时间线展示的工具；界面变更本身遵循桌面控制面的决定。
- **变更：** `NativeMainAgentOptions.onToolEvent` 发出带工具名、错误/拒绝与耗时的
  `started`/`completed`；`runMainAgentQuery` 透传；companion 流以 `tool` 事件发送；
  对话渲染 `tool-timeline`，包含运行中/完成/失败/拒绝状态、右对齐耗时与 reduced-motion
  回退。文案中英双语。
- **Eval：** `test/companion-main-agent.test.ts` 断言流中出现 `event: tool`、`"phase":"started"`
  与工具名；`test/ui-structure.test.ts` 断言处理器、时间线元素与样式（含 reduced-motion 规则）。
  `npm test` → **565 个测试、565 通过、0 失败**；typecheck 与 gate 通过。浏览器预览中渲染
  四行，完成/失败/拒绝/运行中的颜色与布局符合预期。
- **Benchmark run：** 无。这是界面与事件接线变更。
- **执行链路：** 运行时事件 → 查询选项 → SSE 帧 → 渲染层；先由结构测试验证，再把同样的
  markup 注入实时预览，读取计算样式并截图。过程中修正两处：预览启动配置指向不存在的脚本，
  开发服务器忽略 `PORT` 变量。
- **优点：** 所有者不必打开审计就能看见拒绝与慢工具；同一批事件已写入回合审计，两个视图不会
  互相矛盾。
- **缺点 / 下次：** 同名工具会合并成一行，重复调用更新上一行而不是新增；停止按钮仍然没有。
- **推翻条件：** 如果时间线挤占回答，就默认折叠，只在摘要行后展开。

### 2026-11-09 — 模型可调用的 dispatch_task 工具

- **目标 / 假设：** Main Agent 能描述工作却不能开始工作。一个接受目标与验收标准、调用现有
  `runQuery` 路径的工具能补上这个缺口，同时不制造第二个权威。
- **取舍：** [模型可以派发任务，但只有 Kernel 规划与判定完成](../architecture/trade-offs.zh-CN.md#2026-11-09--模型可以派发任务但只有-kernel-规划与判定完成)。
- **变更：** 新增 `src/main-agent/tools/dispatch-task.ts` 并在 `nativeTools` 注册；charter
  现在告诉模型何时用它而不是 `propose_work_plan`。校验在任何规划轮之前执行：非空目标、
  1–12 条去空白的标准、4,000 字符上限。
- **Eval：** `test/dispatch-task.test.ts` → 3/3。`npm test` → **563 个测试、563 通过、
  0 失败**。`npm run typecheck` → 退出 0。`npm run gate` → PASS。
- **Benchmark run：** 无。该工具是对 `runQuery` 的接线变更；实机运行会检验规划器与 Worker，
  而不是这条绑定。
- **执行链路：** 读审计缺口与 `runQuery`；写工具；修正两处相对导入，并删除不支持的
  `signal` 选项而不是用类型转换掩盖；注册；加 charter 一行；写校验测试；记录取舍与本文。
- **优点：** 模型现在有受治理的启动工作方式，完成路径仍然只有一条。
- **缺点 / 下次：** 派发是同步的，长任务会占住回合；模型无法通过该工具设置逐步骤 scope；
  后台派发、取消传播与完成通知仍在前面。
- **推翻条件：** 见取舍条目。

### 2026-11-09 — 逐次权限、上下文压缩、MCP 与技能

- **目标 / 假设：** 补齐决定 harness 是否完整的四个 Claude Code 缺口：每次工具调用（而不是每个
  计划步骤）都被授权；长会话按 token 压力压缩并留下记录；第三方工具经 MCP 进入；可复用流程
  以技能而非硬编码 Prompt 的形式进入。
- **取舍：** [每个进程内工具调用都经过逐次决定](../architecture/trade-offs.zh-CN.md#2026-11-06--每个进程内工具调用都经过逐次决定)、
  [压缩按 token 计算并落记录](../architecture/trade-offs.zh-CN.md#2026-11-06--压缩按-token-计算并落记录先确定性摘要)、
  [先做 MCP 与 Skills](../architecture/trade-offs.zh-CN.md#2026-11-06--先做-mcp-与-skills插件云vmcomputer-use-延后)
  与 [执行 Worker 是通用的](../architecture/trade-offs.zh-CN.md#2026-11-06--执行-worker-是通用的编码只是其中一种工具配置)。
- **变更：**
  - `src/agent/loop.ts` 增加 `authorize`、`requestApproval`、`hooks.preToolUse` /
    `postToolUse` 与 `tool_decision` 事件。deny 胜过 ask，ask 胜过 allow；hook 可以改写
    输入但不能扩大权威；被拒绝的调用是一条配对的工具结果，回合继续。
  - `src/workers/native-agent-worker.ts` 现在运行在 `runAgentLoop` 上：客户端只做一次
    completion，`decideTool` 是 `authorize` 回调，读工具并行安全，预算失败带可比较签名。
  - `src/main-agent/context-window.ts` 推导压缩/警告/阻断三档、估算 token、确定性压缩；
    `main_agent.context_compacted` 把每次压缩记在回合与 Journal 上。
  - `src/mcp/mcp-host.ts` 是 stdio MCP 宿主，工具带命名空间；失败的服务器记入记录且不贡献工具。
  - `src/skills/skill-loader.ts` 加载 `SKILL.md` 并渐进披露；主 Agent 回合接受 `skillRoots`
    与 `mcpServers`，暴露 `Skill(<name>)` 与 `mcp__server__tool`。
  - `apps/desktop/src-tauri/tauri.conf.json` 现在设置限制性 CSP，而不是 `null`。
- **Eval：** `npm test` → **622 个测试、619 通过、0 失败、3 跳过**（本批之前：
  601/598/0/3）。`npm run typecheck` → 退出 0。`npm run gate` → PASS，基线未变。
  内核套件 14/14；上下文 8/8；MCP 5/5；技能 5/5；原生 Worker/客户端 17/17；
  一个端到端主 Agent 回合同时使用技能与 MCP 工具。没有实机模型调用。
- **Benchmark run：** 无。变更属于契约层；实机基准无法区分授权、压缩或加载逻辑。
- **执行链路：** 内核权限路径 → 原生 Worker 迁移 → 上下文模块与记录 → MCP 宿主与假 stdio
  服务器 → 技能加载器与夹具 → 端到端回合 → CSP。就地修复的失败：TypeScript 参数属性
  （strip-only 模式）、Worker 类的闭合括号、两处测试辅助签名、一处字符数断言，以及一个
  单独运行与重跑都通过的 WhatsApp 偶发测试。
- **优点：** 权限现在逐次且有原因；压缩有记录且可见；MCP 与技能按回合显式开启，不改变
  既有回合；Worker 与 Main Agent 共享一套循环契约。
- **缺点 / 下次：** MCP 还没有 HTTP 传输、resources、prompts 或 OAuth；技能自身还不缩小
  工具表（真正的闸门仍由 Kernel 执行），插件与延迟工具搜索也还没有。额外的编码工具
  （edit/glob/grep/bash）仍只是配置，没有实现。
- **推翻条件：** 见各取舍条目；对 MCP/技能而言，如果攻击面增长快于能力，或真实工作流需要
  本宿主没有的传输，就推翻。

### 2026-11-09 —— 补上桌面修复轮次的三条审查发现

- **目标与假设：** 两个已合并的桌面修复本身正确，但审查发现三处缺口会让同类故障回归：回归用例从不进入 CI、记忆修复只覆盖“数据未变”的轮询、`write_file` 拒绝已有路径抹掉了普通能力。
- **取舍：** [回归用例进入默认套件](../architecture/trade-offs.zh-CN.md#2026-11-09--回归用例进入默认测试集)；[后台重绘让位于正在输入的编辑器](../architecture/trade-offs.zh-CN.md#2026-11-09--后台重绘让位于正在输入的编辑器)；[write_file 模式按 Worker 区分](../architecture/trade-offs.zh-CN.md#2026-11-09--write_file-的覆盖模式按-worker-区分只有修复通道拒绝)。
- **变更：**（a）`package.json` 的 `test` 包含 `test/regression/*.test.ts`，使已合并的两个用例及后续所有用例进入 `npm test`，从而进入 CI；（b）记忆面板的轮询路径调用 `render({ background: true })`，当焦点位于 `#memory-root` 内的 `INPUT`/`TEXTAREA` 时跳过重绘——仅靠标记缓存无法覆盖“数据已变”的情形；（c）`fileTools()` 接受 `writeFileMode`，默认 `overwrite`，修复通道为自己的进程设置 `CLONE_AI_NATIVE_WRITE_FILE=refuse-existing`。
- **评估：** `npm test` 633 通过 / 3 跳过 / 0 失败（此前 626；两个回归文件与新增的覆盖用例现已包含）；`npx tsc --noEmit` 通过；`npm run gate` PASS，基准未变。改动前失败的探针（无关的 `updatedAt` 变化导致 textarea 被摘下）现已通过，并成为 `test/regression/memory-refresh-focus.test.ts` 的一部分。
- **基准运行：** 无——本条目改的是工具默认值与测试接线，不是模型行为；未调用任何 Provider。
- **执行链路：** 先对照父提交复核两个已合并补丁（均能复现红色），再写探针暴露“数据变化”情形，随后在主分支一次性完成三处改动、把探针固化为用例，并更新中英取舍条目。未运行修复通道：这是对通道本身的修正，不是应由通道产出的产品 bug。
- **优点：** 审查发现从“靠记忆”变成“有检查”；焦点残留缺陷无法悄悄回归；普通任务重新可以整文件生成。
- **缺点 / 下次：** 焦点守卫用“输入时内容不新鲜”换编辑安全；输入期间加载完成的详情会延迟出现。`write_file` 模式是修复进程读取的环境变量——若未来有别的入口构建 Registry，必须设置同一个变量。
- **推翻条件：** 见上方各取舍条目。

### 2026-11-07 — 共享 Agent 循环内核与绿色基线

- **目标 / 假设：** Main Agent 需要 Claude Code 已经证明重要的 harness 机制：带类型的终止
  原因、安全工具并行/非安全工具屏障、abort 传播、回合/工具/token/时长预算、有界重试与
  结构化工具结果。单一内核也能阻止 Main Agent 与执行 Worker 长出两套不同的循环。
- **取舍：** [共享 Agent 循环内核](../architecture/trade-offs.zh-CN.md#2026-11-06--main-agent-与原生-worker-共享一个-agent-循环内核)
  与 [执行 Worker 是通用的](../architecture/trade-offs.zh-CN.md#2026-11-06--执行-worker-是通用的编码只是其中一种工具配置)。
- **变更：** 新增 `src/agent/loop.ts` 与 `test/agent-loop.test.ts`，并把
  `src/main-agent/native-runtime.ts` 接上去。Kernel 工具表适配到循环；只读工具并行安全，
  提案保持串行。工具开始/完成事件仍写入回合审计；客户端断开时 companion 流会取消回合。
  阶段 0 同时移除了最后一个 `pi` 默认值
  （`evidence-reviewer` 改用 `claude-code`）、更新了过期 Pi 测试、把主 Agent 基准改为仅原生，
  并从基准配方与文档中移除 Pi。
- **Eval：** `node --experimental-strip-types --test test/agent-loop.test.ts` →
  **10/10 通过**；`test/native-main-agent.test.ts` → **6/6 通过**；客户端断开路径由
  `test/companion-main-agent.test.ts` 覆盖。`npm test` →
  **609 个测试、606 通过、0 失败、3 跳过**（变更前：
  585 个测试、578 通过、4 失败、3 跳过）。`npm run typecheck` → 退出 0。
  `npm run gate` → **PASS**，基线未变。本次没有实机模型调用；eval 是确定性的。
- **Benchmark run：** 无。本次变更由确定性循环契约与既有测试判定；实机 Main Agent 运行会
  增加成本，却不能区分内核的调度与预算逻辑。
- **执行链路：** 八路并行分析（采用七份报告；工具目录一路持续重复扫描后被停止），直接核对
  源码中的工具清单，阶段 0 修测试，实现内核，接适配器，最后跑全量测试。过程中的失败：strip-only
  模式不支持一个 TypeScript 参数属性、测试里两处类型错误、以及一个仍假设默认 Provider 是 CLI
  的基准安全测试；均已就地修复。耗时与成本未单独测量；没有调用 Provider。
- **优点：** Main Agent 现在拥有带类型的终止原因、并行安全工具调度、abort 传播、重试、预算与
  中间截断，且公共入口不变。基线重新变绿，循环可被原生 Worker 复用。
- **缺点 / 下次：** 第一版内核仍缺 token 感知的实时压缩、逐次权限检查与总 token 计费账本；
  这些属于阶段 2–4。部分流式响应之后的重试会把 delta 重放给 UI；阶段 2 应发出模型调用
  重试/重置事件。工具目录分析应从开始就设硬性的调用/时间预算。
- **推翻条件：** 如果 Main Agent 与 Worker 在传输或流式要求上分叉，保留不同的模型适配器，
  但共享调度、预算与工具结果层；如果内核增加的复杂度大于它消除的复杂度，就恢复单一用途的
  Main Agent 循环。

### 2026-11-06 — 重复运行并取中位数的对比

- **目标 / 假设：** 让 Pi 与原生对比能够给延迟排序——两次单跑结论相反，且原生 plan 一格
  曾出现 45.2s。
- **取舍：** [重复取中位数](../architecture/trade-offs.zh-CN.md#2026-11-06--主-agent-对比每格重复多次并报告中位数)。
- **变更：** `benchmark/main-agent.ts` 每格跑 `--repeat N` 次（默认 5），报告中位数与
  p90 耗时、中位 tokens 与通过率，并保留每个样本；`benchmark/stats.ts` 提供中位数与
  最近秩百分位；抛错的格子记录为失败样本，而不是中断整份报告。
- **Eval：** `test/benchmark-stats.test.ts` 覆盖奇/偶/空中位数与最近秩百分位。重复运行：
  `CLONE_AI_BENCH_MAIN_MODEL=360/deepseek/deepseek-v4.1-flash npm run bench:main -- --repeat 3`；
  模型 `360/deepseek/deepseek-v4.1-flash` 经 Magpie `http://127.0.0.1:3425`；每格 3 个
  样本；结果文件 `benchmark/results/main-agent-2026-11-06T01-41-51-266Z.json`。
- **结果（中位 / p90 / 中位 tokens）：** direct Pi 1.2s / 1.3s / 2,620 vs 原生 1.5s /
  1.7s / 2,560；authority Pi 4.5s / 6.2s / 5,721 vs 原生 4.4s / 5.6s / 5,449；
  plan Pi 11.5s / 15.8s / 14,145 vs 原生 12.2s / 19.9s / 12,994。两个运行时均 9/9。
- **说明：** 三个样本下结论已经稳定。延迟接近——原生在 authority 略快，Pi 在 direct 与
  plan 略快；原生总体少约 6.6% tokens（中位和 21,003 vs 22,486）。每个格子都满足预期。
- **模型说明：** 之前的 Sonnet 5.5 id 在此环境的 Pi 目录中已不存在；第一次重复运行在任何
  模型调用前就失败，已记录为发现。DeepSeek v4.1 Flash 同时存在于两个目录且支持工具调用。
- **下一步：** 默认 5 个样本；本次为了控制运行窗口用了 3。需要 p90 时用 `--repeat 5`。
- **推翻条件：** 见取舍条目。

### 2026-11-06 — 五次样本确认

- **目标 / 假设：** 用默认的 5 个样本替换三次样本的结论，让 p90 成为真实的尾部指标，
  而不是接近最大值。
- **取舍：** [重复取中位数](../architecture/trade-offs.zh-CN.md#2026-11-06--主-agent-对比每格重复多次并报告中位数)。
- **Benchmark 运行：** `CLONE_AI_BENCH_MAIN_MODEL=360/deepseek/deepseek-v4.1-flash npm run bench:main -- --repeat 5`；
  模型 `360/deepseek/deepseek-v4.1-flash` 经 Magpie `http://127.0.0.1:3425`；每格 5 个
  样本；结果 `benchmark/results/main-agent-2026-11-06T02-07-58-472Z.json`。
- **结果（中位 / p90 / 中位 tokens）：** direct Pi 1.4s / 1.9s / 2,621 vs 原生 1.1s /
  2.1s / 2,563；authority Pi 4.8s / 5.5s / 5,583 vs 原生 4.7s / 5.4s / 5,488；
  plan Pi 13.8s / 26.9s / 10,877 vs 原生 11.4s / 15.8s / 9,922。两个运行时均 15/15。
- **与三次样本相比的变化：** 原生在每个格的中位延迟上都更快（合计 17.2s vs 20.0s），
  plan 的尾部明显更好（p90 15.8s vs 26.9s）。原生少约 5.8% tokens。plan 格的工具调用
  次数仍有波动（Pi 1–3 次，原生 2–4 次），这是模型行为，不是运行时差异。
- **限制：** 一个模型、一台机器、一个小时内、共享网关。把结论当作稳定的本地对比，
  而不是普适排名。
- **推翻条件：** 见取舍条目。

### 2026-11-06 — 从主 Agent 移除 Pi SDK（两步中的第一步）

- **目标 / 假设：** 按移除取舍的決定，让主 Agent 的循环、上下文组装与工具面都属于我们，
  没有 SDK、没有回退。
- **取舍：** [只保留自己的 Agent](../architecture/trade-offs.zh-CN.md#2026-11-06--只保留自己的-agent去掉-pi-sdk-与黑盒-cli)。
- **变更：** 删除 `session.ts`（Pi 会话工厂）；把 `run-main-query`、`clone-main` 与 CLI
  对话路径改到原生运行时；把不依赖 SDK 的指针与旧会话列举移入 `conversation-store.ts`；
  把模型/强度偏好移入 `model-preferences.ts`；把自评审的 Pi 会话替换为对已配置端点的普通
  completion；把 Pi 模型目录替换为网关自己的列表；从 Kernel 工具宿主中移除 Pi 类型；
  回合台账现在同时供 `search_history` 与对话视图使用；移除
  `@earendil-works/pi-coding-agent` 依赖与仅 Pi 的 live 测试。
- **Eval：** 全量 578 个测试 / 578 通过；typecheck、gate 与双语文档通过。被删除的 live
  测试依赖 Pi，SDK 移除后无法运行；其确定性等价测试仍在。
- **执行链路：** 先写取舍；再改运行时；然后自评审与目录；最后测试。每一步由编译器引导。
  两个使用 Pi `SessionManager` 的测试种子改写为台账回合。
- **优点 / 缺点：** 主 Agent 不再依赖 SDK，每个输入、工具调用与用量记录都是我们自己的。
  端点现在是必需的；设置页的模型选择器列出网关模型，且只配置基础地址时使用所选 id。
- **未完成（第二步）：** 黑盒 CLI Worker（Claude Code、Codex、Pi CLI、opencode）、它们的
  Provider 目录、安装命令与 `install_agent` 工具仍在。移除它们是同一取舍的下一阶段；
  在有受治理的连接器之前，外部动作将没有 Provider。
- **推翻条件：** 见取舍条目。

### 2026-11-06 — 移除黑盒 CLI Worker（两步中的第二步）

- **目标 / 假设：** 完成移除：没有 CLI Worker、没有 Provider 配方、没有安装路径，与同一
  取舍一致。
- **取舍：** [只保留自己的 Agent](../architecture/trade-offs.zh-CN.md#2026-11-06--只保留自己的-agent去掉-pi-sdk-与黑盒-cli)。
- **变更：** 删除 `black-box-cli-worker`、`worker-registry`、Worker 侧的
  `executable-resolver` 用法、`worker-env`、`fresh-session-policy`、
  `provider-config-store` 与 `providers.json`；Provider 目录只剩原生定义；默认 Agent
  全部为原生，`external` 配置移除（没有受治理的连接器）；`install` 被拒绝，
  `install_agent` 工具移除，Provider 设置接口返回 409；记忆提炼改为调用原生端点并支持注入；
  Worker 基准只跑原生；路由把已配置的 Agent 视为可用；文档、本地化文案与失败文案更新。
- **Eval：** 全量 520 个测试 / 520 通过；typecheck、gate 与双语文档通过。删除的测试只覆盖
  已删除的 CLI 面（CLI 配方、安装器、seatbelt、Worker 环境、Provider 注册表）；路由、
  记忆提炼与评审的确定性等价测试仍在。
- **执行链路：** 先删除，再让编译器驱动每处引用修正：run-query、CLI、companion、自评审、
  记忆 Worker、benchmark、测试。两次批量测试编辑产生了无效文件，已回滚并改为逐项删除。
- **优点 / 缺点：** 唯一的执行路径现在逐次受闸门约束且可审计，没有 CLI 能带着隐藏的工具或
  凭据运行。代价是明确的：外部动作没有 Provider，CLI 独有能力消失，安装命令也帮不上忙。
- **推翻条件：** 见取舍条目。

### 2026-11-06 — Worker 并发跟随实测机器容量

- **目标 / 假设：** 让派发按机器实际能力并行，而不是按计划形状；硬上限留在 Kernel，而不是
  一次采样出的模型 token。
- **取舍：** [容量](../architecture/trade-offs.zh-CN.md#2026-11-06--worker-并发跟随实测机器容量硬上限由-kernel-掌握)。
- **变更：** `src/core/capacity.ts` 采样核数、1 分钟负载与空闲内存，计算上限（自动：核数、
  负载感知的 CPU 预算与内存预算取最小，上限 16），并提供计数式 `CapacityGate`。运行时在
  每次单 Agent 执行与每次子 Agent 派发前后获取/释放槽位；组装层共用一个闸门，使队列与每个
  波次共享预算。`config.json` 的 `maxConcurrentWorkers` 固定上限（0 = 自动），每次获取时
  重新读取，并通过 `PATCH /api/config` 暴露。只读的 `get_capacity` 工具让主 Agent 决定
  计划规模；charter 要求它先调用。
- **Eval：** `test/capacity.test.ts`——CPU 受限、内存受限、负载敏感、所有者固定值受核数
  约束、闸门不超限且按序唤醒、取消等待会释放槽位。工具溯源包含 `get_capacity`。全量
  525 个测试 / 525 通过；typecheck、gate 与双语文档通过。
- **执行链路：** 先写取舍；纯函数与闸门；在两个执行入口获取/释放；工厂持有闸门与实时固定值；
  设置接口；工具与 charter；测试；文档。
- **优点 / 缺点：** 16 核空闲主机与 2 核忙碌笔记本现在表现不同，这正是目的。同 Workspace
  的写步骤仍被 Workspace 锁串行化，因此容量是天花板，不保证依赖或冲突工作一定并行。公式是
  启发式，不是对模型端点自身并发限制的测量。
- **未验证：** 没有在大主机上做负载测试；端点自身的并发/限流未知，宽计划可能在 Provider 侧
  排队，而不是在 Kernel 侧。
- **推翻条件：** 见取舍条目。

### 2026-11-06 — 第二轮：通道重跑五条桌面端轨迹

- **目标 / 假设：** 堵住三个漏洞后，同一批五条轨迹能产出的补丁，其用例在修复后应为绿色；任何不满足的都应被通道拒绝。
- **取舍：** [修复后用例检查](../architecture/trade-offs.zh-CN.md#2026-11-06--修复通道在修复后重跑已哈希的回归用例)；[有界暂存](../architecture/trade-offs.zh-CN.md#2026-11-06--修复暂存只移除已知的运行期临时物不丢任意文件)；[定向编辑（现在包含 write_file 拒绝已有路径）](../architecture/trade-offs.zh-CN.md#2026-11-06--原生-worker-获得定向编辑工具)。
- **变更：** 本轮发现的第四个漏洞——`write_file` 现在拒绝已存在的路径，因此已有文件只能通过 `edit_file` 修改。随后对三条被拒轨迹的重试暴露了第五个：`edit_file` 仍可替换文件的大部分（`memory.js` 删 127 行、`audit.js` 删 315 行）而窄用例变绿，因此通道现在统计暂存删除行数，超过 40 行生产代码即拒绝（`fix-too-large`）。测试：`write_file` 创建新文件并拒绝替换；100 行重写被拒绝且用例行不计入；第二阶段措辞已更新。
- **eval：** `node --experimental-strip-types --test test/native-client.test.ts test/repair.test.ts` —— 32 个用例通过。两个修复合入后完整套件 626 pass / 3 skipped / 0 fail；`npx tsc --noEmit` 通过；`npm run gate` PASS。通道运行即行为层 eval，逐条如下。
- **Benchmark run：** 五次修复运行，原生 Worker 指向 Magpie `360/deepseek/deepseek-v4.1-flash`，`CLONE_AI_NATIVE_MAX_ROUNDS=32`、`CLONE_AI_NATIVE_MAX_TOKENS=50000`、`CLONE_AI_NATIVE_TIMEOUT_MS=900000`，隔离 clone home `~/.clone-repair-r1`…`r5`，报告在各 home 的 `rsi/last-run.json`。结果：记忆刷新（r1）——第一阶段红（2 个失败断言），修复后用例绿，但因生成的用例有两处 TS2554 而停在 `typecheck`；侧栏（r4）——第一阶段红，修复后用例绿，但因生成用例的英文注释未通过双语文档测试、以及 `never[]` 推断而停在 `suite`/`typecheck`；归档（r2）——只因桩的问题而红，修复后仍红，被 `regression-still-red` 拒绝；审计（r3）——第二阶段用 `write_file` 替换了 `audit.js` 的 127 行，用例仍失败，被 `regression-still-red` 拒绝；审计第二次运行（r6）在任何断言前崩溃，被 `not-red` 拒绝；推理强度（r5）产出了有效红色用例，但修复阶段调用了一个从未定义的辅助函数，用例仍红，被 `regression-still-red` 拒绝。两个因仓库检查被拒的修复，由工作 Agent 对生成的用例做机械调整（一个可选参数；双语注释与 `any[]` 标注）后重跑用例、tsc 与套件，才合入。
- **执行链路：** 先并行跑记忆与归档，再跑审计与侧栏；接受前逐个检查修复差异；保留通道产出的生产补丁与用例逻辑，只改仓库类型检查与双语规则要求的部分；没有提前停止任何通道（均由它自己的闸门停止）。除五次运行外无额外模型 token。
- **优点：** 修复后检查把此前的 false-fixed 变成拒绝；抓住了一个只因桩崩溃而红的用例；抓住了一次破坏性的整文件重写；两个真实修复通过通道产出。
- **缺点 / 下次：** 模型写用例时看不到 `tsc` 与双语规则，因此正确的修复仍可能被仓库检查拒绝；用例需要第一阶段预检，或工作 Agent 的机械修整。`write_file` 拒绝已有路径可能挡住合法的整文件重写；那种情况必须通过 `edit_file` 携带完整旧内容。对三条被拒轨迹的第二次重试同样没有产可合并的补丁：归档与审计把各自 UI 文件的大部分重写掉（分别删除 127 与 315 行）而用例变绿，在提交前被停止——新的删除闸门现在会拒绝两者；推理强度在任何断言前崩溃（`not-red`）。推理强度与审计轨迹仍没有补丁；下一次尝试应先要求模型定义它调用的任何辅助函数。
- **推翻条件：** 见编辑工具取舍；若拒绝已有路径挡住合法修复，应对小于阈值的文件放行 `write_file`，而不是对大型 UI 脚本放行。

### 2026-11-06 — 关闭桌面端尝试暴露的三个修复通道漏洞

- **目标 / 假设：** 桌面端修复尝试暴露了通道把"未验证的东西"报成或提交成修复的三条路径：修复后从不重跑回归用例、暂存会带上运行期临时物、整文件 `write_file` 会让模型用片段替换大型 UI 脚本。堵住这三条，使 `fixed` 真正意味着记录的失败已消失、提交只携带修复与用例。
- **取舍：** [修复后重跑已哈希用例](../architecture/trade-offs.zh-CN.md#2026-11-06--修复通道在修复后重跑已哈希的回归用例)；[只移除已知运行期临时物](../architecture/trade-offs.zh-CN.md#2026-11-06--修复暂存只移除已知的运行期临时物不丢任意文件)；[定向编辑工具](../architecture/trade-offs.zh-CN.md#2026-11-06--原生-worker-获得定向编辑工具)。
- **变更：** `src/repair/gates.ts`（`verifyRegressionGreen`、`stageRepair`、`isRuntimeScratch`）；`src/repair/repair-lane.ts`（修复后运行用例并以 `regression-still-red` 停止、记录 `regressionAfter`、改用 `stageRepair`、第二阶段优先 `edit_file`）；`src/workers/native-worker-factory.ts`（`edit_file`：唯一一次精确替换，拒绝缺失/歧义，拒绝缩到不足十分之一）；`src/cli/clone-ai.ts` 输出修复后的回归结果；`test/repair.test.ts`、`test/native-client.test.ts`、`test/mcp.test.ts`。
- **eval：** `node --experimental-strip-types --test test/repair.test.ts test/native-client.test.ts` —— 31 个用例通过。变更前，空操作修复用例在套件不含 `test/regression/` 的仓库里会走到套件并被报成 fixed；新用例期望 `regression-still-red`。暂存用例在 `git add -A` 上失败（会暂存 `node_modules` 与 `.probe/junk.txt`）；而"只暂存已跟踪文件 + 回归文件"的第一版实现因悄悄丢掉新的受保护文件而使既有的保护路径测试失败。`edit_file` 用例在工具表没有该工具时失败，也在无保护的替换（接受 8 KB 片段）时失败。`test/mcp.test.ts` 的内建工具清单现在包含 `edit_file`。完整套件：624 pass / 3 skipped / 0 fail（首次运行有一个无关的 WhatsApp 测试偶发失败，单独与重跑均通过）；`npx tsc --noEmit` 通过；`npm run gate` PASS（baseline unchanged）。
- **Benchmark run：** 无——确定性、离线；不涉及 Provider、模型或数据集。
- **执行链路：** 阅读 false-fixed 报告（`d8c54037` / `4accee4b`）与被停止的预览尝试中的 8 KB `app.js`；先实现绿色重跑；暂存先实现为"已跟踪 + `test/regression/`"，既有保护路径测试当场指出漏洞（新的受保护文件会被悄悄丢弃），随后改为 `git add -A` 加显式临时物拒绝清单；加入 `edit_file` 及唯一出现与 10 倍缩水保护；接入第二阶段措辞与 CLI 报告；运行定向测试（两个失败：空操作修复在 fake 阶段写无关文件前停在 `kernel`，以及暂存修复自身），再跑完整套件（一个无关偶发失败，重跑绿）、类型检查与 gate。成本：无模型 token；约 40 分钟本地工作。
- **优点：** `fixed` 现在要求修复后已哈希用例通过；提交无法携带 `node_modules` 或已知临时物；大文件的小修复有了不会把它变成片段的工具。
- **缺点 / 下次：** 清单外的临时文件名仍可能进入差异（在 `changed` 中可见）；拒绝清单是仓库形态的，若临时物名字增多应移到 manifest；`edit_file` 需要精确片段，没读过文件的模型用不了；通道仍只在 worktree 而非**服务中的检出**上重跑用例（cherry-pick 是工作 Agent 的步骤）。
- **推翻条件：** 见三条取舍条目。

### 2026-11-06 — 把桌面端缺陷交给 Magpie Worker 的修复通道

- **目标 / 假设：** 桌面应用运行逻辑中的五个可观察缺陷，可以由 `clone-ai repair` 使用指向 Magpie `360/deepseek/deepseek-v4.1-flash` 的原生 Worker 修好，每个都带失败的回归用例与经过验证的补丁。
- **取舍：** 每个 bug 的条目见 [trade-offs.zh-CN.md](../architecture/trade-offs.zh-CN.md)（记忆面板刷新、归档/恢复 TypeError、审计派发块、侧栏恢复入口、预览下划线、推理强度下拉）。
- **变更 / 尝试：** Worker 配置为 `CLONE_AI_NATIVE_MODEL=360/deepseek/deepseek-v4.1-flash`、`CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425`、`CLONE_AI_NATIVE_MAX_ROUNDS=32`、`CLONE_AI_NATIVE_MAX_TOKENS=50000`、`CLONE_AI_NATIVE_TIMEOUT_MS=900000`，使用隔离 clone home（`~/.clone-repair{,-2,-3}`），`draft-maker` 绑定 `native`；每次尝试是一条手工轨迹。结果（通道报告的闸门 + 工作 Agent 自己的检查）：记忆刷新轨迹产出了有效的红色用例（382 行 vm 测试，2 个失败断言），但修复阶段（32 轮、971k 输入 token）什么都没写；通道仍报 fixed，因为它在修复后不重跑回归用例，事后用例仍红——未合并。归档/恢复轨迹的第一个用例因 vm 缺少 `Element` 全局而红错了原因；补上该事实后，下一个用例的 DOM 桩仍没命中 PATCH；没有补丁。审计派发轨迹产出了两个有效红色用例（“步骤 —”与“阻断运行说没有记录”），但修复阶段让一次 Provider 调用超过步骤预算，重跑时用例又在没有断言错误的情况下崩溃（通道的 `not-red` 闸门拒绝）。预览下划线轨迹产出了红色用例，随后修复阶段把 118 KB 的 `apps/desktop/ui/app.js` 替换成只含被切片函数的 8 KB 片段；套件与类型检查都不加载该文件，通道本来会报 fixed——该尝试在提交前被停止。推理强度与侧栏恢复两条轨迹都产出了有效的红色用例（前者指出实际提供的通用档位列表，后者显示空状态标记里没有恢复控件），但到报告截止时它们的修复阶段仍停在一次 Provider 调用中，被停止且没有生产写入。
- **eval：** 每次尝试由通道的红色检查与工作 Agent 自己在修复 worktree 中运行用例；工作树另跑完整套件与 `npm run typecheck`。没有 benchmark：不涉及数据集或评分参数。
- **执行链路：** 先把修复通道所在的实现分支合并进 `main`（它并不在 `main` 上）；原生 Worker 先后需要轮次预算、单次补全上限、“写入成功后才能总结”的 System Prompt、以及分阶段的尽早写入规则；在 `write_file` 被证明无法重写大型 UI 文件后，补全上限从 16k 提高到 50k。两小时窗口里约一小时花在这些 harness 变更上。各次尝试合计约 4M 输入 / 300k 输出 token；精确用量在各 clone home 的运行审计里。
- **优点：** 通道现在能为 UI 代码产出真正的红色复现（在 `node:vm` 中运行真实脚本的 `test/regression/` 用例），失败报告能指名具体闸门。
- **缺点 / 下次：** 三个漏洞使它还不能被信任用于桌面代码：（1）修复后只重跑 `npm test`（不含 `test/regression/`）与类型检查，从不重跑回归用例——空操作或只写临时文件的改动会被报成 fixed；（2）`git add -A` 会暂存 `node_modules`（忽略规则写成 `node_modules/`，匹配不到符号链接）与任何临时文件；（3）`write_file` 只能整文件写，修复 118 KB 脚本中一行时模型可能用片段替换整个文件，而套件与类型检查都发现不了。再次用于 UI 文件之前先修这三处：修复后重跑已哈希的用例、只暂存已跟踪路径与 `test/regression/`、给 Worker 一个带大小保护的查找替换编辑工具。
- **推翻条件：** 见各 bug 的取舍条目；通道自身的闸门/写入修复记录在上面两条条目中。

### 2026-11-06 — 原生 Worker 接受显式的轮次预算

- **目标 / 假设：** 修复阶段必须能先读失败代码、再在同一个步骤里写出回归用例与补丁。原生客户端硬编码的 12 轮上限让第一次真实修复运行在写出任何文件之前就停了。
- **取舍：** [2026-11-06 —— 原生 Worker 接受显式的轮次预算](../architecture/trade-offs.zh-CN.md#2026-11-06--原生-worker-接受显式的轮次预算)。
- **变更：** `readNativeWorkerEnvironment` 读取 `CLONE_AI_NATIVE_MAX_ROUNDS` 与 `CLONE_AI_NATIVE_MAX_TOKENS`（正整数；未设置或非法时保留客户端默认值），`createConfiguredNativeWorker` 把两者传给 `OpenAiCompatibleClient`（`maxRounds` 与请求体中的 `max_tokens`）。`test/native-client.test.ts` 增加了环境解析断言、一个在配置轮次处停止的客户端用例，以及一个断言 token 上限进入请求体的用例。
- **eval：** `node --experimental-strip-types --test test/native-client.test.ts` —— 11 个用例全部通过。变更前该选项不存在，客户端固定停在 12 轮；新用例在旧代码上会失败，因为环境变量没有被读取。
- **Benchmark run：** 未跑 benchmark；eval 是针对 Magpie `360/deepseek/deepseek-v4.1-flash` 的修复通道（无数据集与评分参数）。运行记录：第一阶段轨迹 `ui-memory-refresh-1`，通道报告 `~/.clone-repair/rsi/last-run.json`，Provider `native`，模型 `360/deepseek/deepseek-v4.1-flash`，强度未指定（网关默认），Worker 轮次预算先 24 后 32，`CLONE_AI_NATIVE_TIMEOUT_MS=900000`。
- **执行链路：** 阅读 `openai-compatible-client.ts` 与 `native-worker-factory.ts`；修改环境读取与客户端构造；运行定向测试与 `tsc --noEmit`；用 24 轮启动通道。该运行（`426f3d3a`，24 次调用，423,163 输入 token，150 秒）只写了一个会通过的探针测试，说明仅提高预算并不能产出补丁。下一次尝试把预算提高到 32；下面的措辞变更针对真正的失败模式。
- **优点：** 预算显式且由所有者控制；非法值不会造成零轮循环。
- **缺点 / 下次：** 更大的预算会让模型探索更多而不写文件，因此必须配合明确“交付物”的计划措辞。eval 只测客户端的停止行为，不测真实修复。
- **推翻条件：** 见取舍条目——若原生步骤普遍能在 12 轮内完成，应移除该开关，而不是保留一个可被误配的入口。

### 2026-11-06 — 修复计划告诉 Worker 它的步骤如何被判定

- **目标 / 假设：** 同一轨迹在 12 轮时没有产出复现，在 24 轮时产出了一个会通过的探针。Worker 把“读仓库”当成了目标，而不是把“复现文件”当成目标。
- **取舍：** [2026-11-06 —— 修复计划告诉 Worker 它的步骤如何被判定](../architecture/trade-offs.zh-CN.md#2026-11-06--修复计划告诉-worker-它的步骤如何被判定)。
- **变更：** `repairPlan` 的第一阶段指令现在要求先写复现再做广泛探索、只读复现需要的文件、不得在 `test/regression/` 留下诊断/探针文件；验收标准写明该目录下每个文件都必须是复现。`test/repair.test.ts` 断言这些措辞。
- **eval：** `node --experimental-strip-types --test test/repair.test.ts` —— 16 个用例全部通过。变更前新断言在旧指令文本上会失败；行为层面的 eval 是通道运行本身。
- **Benchmark run：** 同一轨迹、同一模型的修复通道运行；命令、模型、预算与报告路径记录在上一条。结果：见本次工作的最终报告。
- **执行链路：** 阅读两次失败的运行审计（`1dddd6b4`、`426f3d3a`），写取舍条目，修改计划文本与验收标准，增加结构断言，运行定向测试，提交并重跑通道。运行 `d8c54037` 终于产出了红色用例（`test/regression/ui-memory-refresh.test.ts`，2 个失败断言），用了 32 轮 / 688 秒。随后第二阶段（`4accee4b`）把全部 32 轮 / 375 秒用于阅读 README、`.work-orders`、`.verification-baseline`、`node_modules`，并把 `memory.js` 读了两次，没有产出任何 artifact，而通道仍报告 **fixed**：`git add -A` 只暂存了 `.probe/*`、`node_modules` 符号链接与测试文件，`evalAfter` 只重跑了 `npm test`（不含 `test/regression`）和类型检查。事后运行回归用例仍然失败。因此收紧了修复阶段：只读失败用例与它覆盖的生产文件、不留临时文件、不写取舍条目、不执行 shell 命令，并给第一阶段加了“用例尽量小”的指令。该运行未被 cherry-pick，worktree 与分支已删除。下一次运行（`f7e07553`，28 轮，574,129 输入 / 74,641 输出 token）读了 20 个文件，以 `completed` 结束却没有任何 artifact，因此原生 System Prompt 现在拒绝“声称做了但从未落盘”的总结，且第一阶段必须在三次工具调用内写入。
- **优点：** 指令现在明确交付物，并禁止已两次观察到的失败模式，且没有再次提高预算；验收标准的变化可被测试。
- **缺点 / 下次：** 措辞是软约束——模型仍可能忽略，通道只有在花完预算后才知道。这次运行暴露了一个**闸门漏洞**：修复后通道从不重跑回归用例，因此只要顶层套件恰好通过，一个空操作（或只写临时文件）的改动就会被报告为 fixed。必须先修复通道（在受保护路径检查之前重跑已哈希的用例并要求全绿），否则它的 fixed 状态不可信；在此之前由工作的 Agent 自己运行用例。第二个漏洞：`git add -A` 把 `node_modules` 符号链接与 `.probe/` 临时文件也暂存了，暂存步骤需要显式忽略清单。更强的设计是在红色检查之前就拒绝“会通过的探针”这类证据，但这需要通道能判定什么算“复现”。
- **推翻条件：** 见取舍条目。

### 2026-11-06 — 修复通道变成 clone-ai 自己的 Run（AGENTS.md 第 4 条终于可执行）

- **目标 / 假设：** AGENTS.md 第 4 条要求 clone-ai 的 Bug 通过它自己的修复通道来修。此前的通道是 `scripts/nightly-rsi.mjs`：自己拼 Prompt 并 spawn `claude -p`，clone-ai 从未真正执行修复，规则描述的是系统并未做到的事。目标是把修复做成由已配置 Worker 执行的 Kernel Run，同时保留全部既有闸门。
- **取舍：** [2026-11-06 —— 修复通道是 Clone AI 自己的 Run](../architecture/trade-offs.zh-CN.md#2026-11-06--修复通道是-clone-ai-自己的-run而不是脚本驱动另一个-cli)；[MCP 工具按服务器显式开启](../architecture/trade-offs.zh-CN.md#2026-11-06--mcp-工具按服务器显式开启并与内建工具过同一道闸门)。
- **变更：** `src/repair/repair-lane.ts`（轨迹筛选、两个 Kernel Run、闸门、报告）、`src/repair/worktree.ts`（隔离的链接 worktree、依赖链接、清理）、`src/repair/gates.ts`（红色验证、逐路径哈希、暂存路径检查、提交）、`clone-ai repair [--dry-run] [--keep] [--max-traces N] [--agent id] [--base ref]`；`selfcheck --repair` 改为调用通道而不再 spawn 脚本。`scripts/nightly-rsi-policy.mjs` 与 `scripts/nightly-rsi-state.mjs` 是导入而非复制，保护路径清单与已消费轨迹账本因此只有一份。既有代码新增两个接缝：`createRuntimeAssembly({ evidenceKinds, knownAgentIds })`（黑盒 Worker 无法报告 `test` 证据；显式 Registry 必须是 Kernel 认可的执行者清单）与 `NativeToolSpec.close`（MCP 子进程不得活过它的步骤）。
- **Eval：** `node --experimental-strip-types --test test/repair.test.ts` —— 16 个用例。单元：失败断言计数、崩溃不算复现、绿色套件被拒、按路径哈希（新增/删除/修改）、worktree 隔离（服务中检出的 `git status` 保持为空）、前置拒绝（路径已存在、非 git 根）、暂存中的保护路径检测、计划步骤顺序与验收措辞、worktree 保留策略（失败的保留、成功的不保留、`--keep` 覆盖两者）。用假 Adapter 的端到端：完整修复（两个 Run 按序派发、修复前验证为红、在分支上提交、轨迹不进提交、仅成功时消费轨迹）；已通过的用例在第二阶段前停下（只派发一次）；改写回归用例被哈希闸门拒绝；保护路径改动在提交前被拒；步骤失败则通道结束、无提交、轨迹保持可再修。变更前不存在进程内修复通道可测；`test/nightly-rsi.test.ts` 仍覆盖脚本的保护路径拒绝。完整套件：首次 `npm test` 617 个测试 / 613 通过 / 1 失败 / 3 跳过——失败是本切片在 `test/mcp.test.ts` 里的纯英文注释，已修复；最终运行 618 个测试 / 615 通过 / 3 跳过 / 0 失败。`npm run typecheck` 通过；`npm run gate` PASS 且 `baseline unchanged`。
- **Benchmark run：** 无——确定性离线评估，使用假 Adapter，不涉及 Provider、模型、数据集或评分参数。
- **执行链路：** 读脚本通道、Kernel 的计划/执行路径、验证器插件与 Worker Adapter；先写取舍条目；实现 worktree + 闸门 + 通道；在真实失败上迭代五次——（1）红色检查曾接受 import 期崩溃，因为 `node:test` 把它算作一个失败用例，现在要求输出中出现 `node:test` 断言错误；（2）最初设计把两阶段放进一个 Run，导致被禁用的假 Worker 也执行了"修复"分支、悄悄产出绿色用例，现在每个阶段各自一个 Run，红色检查夹在中间；（3）对 `~/.clone` 的冒烟运行按角色选中 `direct-responder`，随后被 Kernel 以缺少 `filesystem_write` 拒绝，现在按声明的能力选 Worker；（4）运行期临时物（`.clone/workspace-execution.sqlite3`）会被暂存，现在暂存前删除 `.rsi/` 与 `.clone/`；（5）`finally` 会删掉命令行刚刚承诺“保留供查看”的 worktree，现在保留策略跟随结果。最终状态：`npm test` 618 / 615 通过 / 3 跳过 / 0 失败，`npm run typecheck` 通过，`npm run gate` PASS 且 `baseline unchanged`。未产生任何模型调用。
- **优点：** 每道闸门都在被测进程内运行，因此由确定性测试证明，而不是靠一次真实模型运行；保护路径清单与已消费轨迹账本只有一个所有者；报告带有修复前后 eval 以及修复新增的取舍标题。
- **缺点 / 下次：** 通道尚未对真实模型端到端跑通——自动冒烟运行在第一阶段就因该 home 里配置的 Worker 不能写文件而停下，没有产出模型补丁。回退的套件命令（`package.json` 没有 `test` 脚本时）会跑所有 `test/**/*.test.ts`，仅在小夹具仓库上验证过。worktree 里的 `tsc --noEmit` 需要 `node_modules`，它从服务中检出符号链接而来——没有安装依赖的检出会走 `npx tsc` 回退路径并打印误导性横幅（在调试夹具中可见，本仓库中不可见）。
- **推翻条件：** 见取舍条目——若 Kernel 路径无法表达一次修复，就把两阶段退回脚本，但保留共享的策略与轨迹模块。

### 2026-11-06 — MCP 作为同一道闸门之后的第二个工具来源

- **目标 / 假设：** clone-ai 的工具面此前只来自 `kernel-tools.ts` 与 `native-worker-factory.ts`。所有者要求通过 MCP 补齐缺失能力，同时不得扩大步骤可做的事。
- **取舍：** [MCP 工具按服务器显式开启](../architecture/trade-offs.zh-CN.md#2026-11-06--mcp-工具按服务器显式开启并与内建工具过同一道闸门)。
- **变更：** `src/workers/mcp-client.ts`（配置解析、默认关闭、风险声明、为 CLI Provider 按步骤筛选服务器、观察包裹、无依赖的 stdio 与 streamable-HTTP JSON-RPC 客户端）、`native-worker-factory.ts` 中的 `workerTools()`（内建工具加上已开启服务器声明的工具）、`NativeToolSpec.close`（步骤结束时释放子进程）、`providers.json`/`provider-catalog.ts` 中供接受 `--mcp-config` 的 Provider（Claude Code）使用的 `mcpConfigArgs`，以及不支持的 Provider 回退到内建工具。
- **Eval：** `node --experimental-strip-types --test test/mcp.test.ts` —— 11 个用例：默认关闭（含 `"enabled": "yes"` 不算同意）、格式错误被报告而不是当作未配置、无已开启服务器时只有内建工具表、输出被包裹并清洗为观察、未声明风险按 external 拒绝、只读步骤得到只读工具而网络工具在无网络授权时不提供、带路径工具的逐次路径核对、客户端拒绝已关闭服务器、真实 stdio 子进程应答 `tools/list` 与 `tools/call`、CLI 服务器筛选（仅当每个已声明风险都被授权）、`workerTools` 从 `mcp.json` 接线。变更前完全没有 MCP 代码路径，因此"变更前"就是第三个用例断言的内建工具表。
- **Benchmark run：** 无——确定性离线；stdio 用本地子进程，不涉及 Provider。
- **执行链路：** 读 Worker Adapter 与 Connector 包裹模块；先写取舍条目；实现配置、闸门映射、包裹与客户端；跑测试并修正一处期望了不同错误前缀的断言。未新增依赖；取舍条目记录了原因以及改用 SDK 的条件。最终状态：`npm test` 618 / 615 通过 / 3 跳过 / 0 失败；`npm run typecheck` 通过；`npm run gate` PASS。
- **优点：** 零新依赖；风险的权威是所有者的配置，而不是服务器的自我描述；没有 `--mcp-config` 的 Provider 仍可用内建工具继续工作，而不是让整轮失败。
- **缺点 / 下次：** 只要服务器声明的全部工具都过闸门，CLI 路径就会把整个服务器交给 Provider——CLI 无法执行逐次路径核对，取舍条目已写明这一点。未使用真实第三方服务器；唯一用过的是本地夹具。
- **推翻条件：** 见取舍条目——当 resources、prompts、sampling 或 OAuth 进入范围时，改用维护中的 SDK。

### 2026-11-06 — 设置页以 Worker 为语言，并让派发可见

- **目标 / 假设：** 设置对话框生硬（切标签丢状态、没有键盘流、另有一份重复的 Provider 清单），且 UI 没有解释一步为什么给了某个 Worker。
- **取舍：** [2026-11-06 — 设置页以 Worker 为语言，并让派发可见](../architecture/trade-offs.zh-CN.md)。
- **变更：** 设置导航改为真正的 tablist（`role=tablist/tab/tabpanel`、`aria-selected`、方向键/Home/End、逐面板记忆滚动、160ms 淡入并尊重 `prefers-reduced-motion`）。移除历史 Provider 区块；每个 Worker 行携带其 Provider 的安装状态、命令、执行边界、强度选择、安装与 host-access 操作。审计 Run 详情新增「Worker 派发」：选中者、Provider、步骤、路由来源与理由，来自 `dispatch.decided`；计划行点名执行步骤的 Worker。
- **Eval：** `node --experimental-strip-types --test test/ui-structure.test.ts`（新增断言：不存在 `provider-registry`、七个带 tab 语义的标签、`state.settingsScroll`、派发区块与来源文案）。浏览器对演示 home 的检查：方向键移动选中（agents → mobile）、Home/End 跳到首/尾、Provider 区块消失、Worker 行显示状态与五个强度选择、派发块渲染两条种子决定并翻译来源。`npm test`：591 通过；`npm run gate`：PASS。
- **Benchmark run：** 无——纯确定性 UI/结构评估，不涉及 Provider 或数据集。
- **执行链路：** 阅读设置/审计 UI 与 `dispatch.decided` 载荷；修复通道无法运行（无头 `claude` 报 Not logged in，直接启动可写的 `pi` 被会话分类器拦截），按所有者指示由工作 Agent 手写。第一次 HTML 编辑漏掉每个设置 section 的 `>`，应用停在启动页；由启动提示 `Cannot set properties of null` 定位并修复后浏览器复验。成本：补丁无模型 token（本地编辑），约 25 分钟。
- **优点：** 一份清单取代两份；键盘与语义可用；无需读原始载荷即可回答派发；每个面板保留位置。
- **缺点 / 下次：** 手写路线缺少修复通道证据；过渡只能通过类切换验证；滚动记忆只做了结构断言，演示 home 的面板不够高，未在浏览器中实际触发。
- **推翻条件：** 见取舍条目。

## 模板

```markdown
### YYYY-MM-DD — <标题>

- **目标 / 假设：** 期望什么变好，以及为什么相信它会变好。
- **取舍：** 链接到 `docs/architecture/trade-offs.md` 中的条目。
- **变更：** 一段说明，加上主要文件或目录。
- **Eval：** 命令、数据集或用例 id、变更前后的结果。
- **Benchmark run：** 命令、Provider/模型、数据集或任务 id、评分参数与结果文件。只要跑了
  benchmark 就必须写；仅跑确定性测试的 eval 可以省略。
- **执行链路：** 走过的步骤、使用的 Worker 或工具、耗时与成本、失败与重试。
- **优点：** 这条链路做得好的地方。
- **缺点 / 下次：** 哪里慢、贵、脆或不完整。
- **推翻条件：** 从取舍条目复制。
```

### 2026-11-05 — 自检时重建 App

- **目标 / 假设：** 所有者启动的 App 必须包含刚刚通过测试、即将推送的源码版本。
- **取舍：** [自检后重建本地 App](../architecture/trade-offs.zh-CN.md#2026-11-05--自检后重建本地-macos-app)。
- **变更：** `scripts/selfcheck-push.mjs` 在测试、类型检查和 gate 通过后，用
  `--replace` 构建 macOS App。
- **Eval：** 下一次自检必须生成最新的 `dist/Clone AI.app`，启动验收必须看到新 UI；
  测试、类型检查和 gate 结果由脚本记录。
- **执行链路：** 陈旧 App 让已完成的源码修复看起来不存在，因此加入此步骤。
- **优点：** 启动的 App 不会再悄悄落后于已验证源码。
- **缺点 / 下次：** macOS 自检变慢。
- **推翻条件：** 当热更新运行时取代打包 App 时移除此步骤。

### 2026-11-05 — 所有 Agent 调用共享审计

- **目标 / 假设：** 即使接入 Agent 使用隔离 `CLONE_HOME`，每次 Main Agent 调用也要
  出现在所有者审计中。
- **取舍：** [在 CLONE_HOME 之外审计调用](../architecture/trade-offs.zh-CN.md#2026-11-05--所有-agent-调用在-clone_home-之外审计)。
- **变更：** `src/audit/invocation-ledger.ts` 将调用者、请求、可见回复、错误、模型、
  强度、Workspace、会话文件、Run id 与耗时写入
  `~/.clone/audit/invocations.jsonl`。CLI、桌面 companion、WhatsApp 与独立 Main
  Agent 入口共用同一账本。审计页新增 **Agent 调用** 页签，CLI 新增
  `clone-ai invocations`。
- **Eval：** `test/invocation-ledger.test.ts` 与 companion API 测试覆盖隔离主目录、
  脱敏、失败回合、中断开始和详情输出。使用临时 `CLONE_HOME` 的真实回合出现在默认
  账本中，调用者 `codex`、模型 `360/deepseek/deepseek-v4.1-flash`、强度 `high`、
  回复 `OK`（invocation `7cb576ee`）。完整套件 568 项、565 通过、3 跳过、0 失败；
  `npm run gate` 通过。
- **执行链路：** 自修复运行暴露临时主目录导致审计不可见后，在当前工作区实现并验证。
  同时保留验证器文件期望的回归覆盖。
- **优点：** 所有者现在能看到谁调用了 Clone AI、问什么、回复什么、产生哪个 Run，
  不再依赖调用方的数据目录。
- **缺点 / 下次：** 账本是第二个明文存储；保留期与加密策略尚未可配置。
- **推翻条件：** 如果明文 JSONL 不再满足威胁模型，迁移到加密的、所有者作用域审计存储。

### 2026-11-05 — 记住夜间修复已消费的轨迹

- **目标 / 假设：** 成功修复后不再重复处理未改变的轨迹；同一 runId 的文件内容
  改变后仍可修复。
- **取舍：** [runId 和文件指纹](../architecture/trade-offs.zh-CN.md#2026-11-05--按-runid-和文件指纹消费已修复轨迹)。
- **变更：** `scripts/nightly-rsi-state.mjs` 用原子替换保存指纹与结果信息；
  `scripts/nightly-rsi.mjs` 筛选批次并仅在成功结果后记录。配套声明、
  `test/nightly-rsi-state.test.ts`、`docs/nightly-rsi.md` 和双语 CHANGELOG
  说明并覆盖该契约。
- **Eval：** 变更前代码检查显示没有消费状态；运行 `node --experimental-strip-types
  --test test/nightly-rsi-state.test.ts` 因新模块不存在而失败，因此没有旧行为的实测
  基线。变更后同一命令的 6 个确定性测试通过；`node --check
  scripts/nightly-rsi-state.mjs`、`node --check scripts/nightly-rsi.mjs` 与
  `npm run typecheck` 均通过。
- **执行链路：** Main Agent 使用 DeepSeek V4.1 Flash、`high` 强度提出单步计划，
  `draft-maker`/`codex-cli` 实现状态模块、接线、测试和文档。Runtime 随后把该步骤
  判为失败，因为文件验证器把 `fs.rename`、`os.tmpdir`、`consumed-traces.json` 等
  引号内标识符误当成工作区必须存在的文件。监工独立运行目标测试和 typecheck，均通过；
  这个假失败作为独立验证器缺陷继续修复。耗时约 3.5 分钟；使用了实时模型调用，费用未测量。
- **优点：** 结果判定与脚本共用；离线覆盖损坏状态、替换失败清理和内容改变后的重试。
- **缺点 / 下次：** 本任务没有端到端运行修复或 dry run，完整的模型依赖行为仍属假设；
  `npm test` 和 `npm run gate` 明确不在允许的命令范围内。
- **推翻条件：** 需要跨机器持久共享账本，或文件字节变化但有效证据不变导致反复修复时，
  替换这一文件方案。

### 2026-11-05 — 保守恢复规划阶段孤儿

- **目标 / 假设：** 关闭已放弃的规划 Run，同时不回收新建、已领取或已有计划的工作。
  15 分钟宽限期未经测量，不能证明没有租约的规划者已经停止。
- **取舍：** [规划孤儿宽限期](../architecture/trade-offs.zh-CN.md#2026-11-05--规划孤儿只在保守宽限期后恢复)。
- **变更：** `src/core/runtime.ts` 检查时间与领取；Journal 契约及 SQLite 实现增加
  条件围栏写入，拒绝并发 Run 变化。`test/claim-fencing.test.ts` 覆盖生命周期、阈值、
  领取竞争、并发计划和不支持条件写入的存储。
- **Eval：** 实现前，针对性孤儿恢复用例为红。实现后 `node --experimental-strip-types
  --test test/claim-fencing.test.ts` 的 15 项全部通过，`npm run typecheck` 和
  `npm run gate` 通过。关闭实时模型测试后，完整套件通过 545 项、跳过 3 项、0 失败。
  第一次全量运行仅因一个遗留 WhatsApp 桥进程占用 4318 端口而失败；清理后套件干净。
- **执行链路：** Main Agent 使用用户授权的 Magpie DeepSeek V4.1 Flash、`high` 强度
  提出计划，`claude-code` 调研，`codex-cli` 实现并记录。自执行耗时约 17 分钟。它的
  验证步骤错误地启用了实时测试并运行全量套件而挂起；监工取消该 Run、保留已完成的修改，
  再独立运行针对性测试和完整确定性套件。模型费用未测量。
- **优点：** 修复前复现失败；事务保护快照之后到达的计划；测试无需真实模型。
- **缺点 / 下次：** 超时不能确认规划者是否存活，全量测试也未能在本环境通过。应使用
  规划者租约和时长测量，并在测试前隔离工作区和端口。
- **推翻条件：** 如果正常无领取规划超过 15 分钟，应在启用恢复前改用可靠的规划者租约，
  或根据实测时长调整阈值。

### 2026-11-05 — 提示词溯源与离线回归门禁

- **目标 / 假设：** 让主 Agent 的一轮回答可以归因到它真正读到的提示词，并让 harness
  的判断层在没有真实模型的情况下可做回归测试。
- **取舍：** [提示词溯源](../architecture/trade-offs.zh-CN.md#2026-11-05--提示词溯源--内容寻址文件--一条-journal-事件)、
  [回归门禁](../architecture/trade-offs.zh-CN.md#2026-11-05--回归门禁离线逐用例只衡量行为)。
- **变更：** 每轮追加 `main_agent.prompt_snapshot` 事件，携带 charter、简报、工具表哈希
  以及模型与强度；完整材料按内容寻址存于 `prompt-snapshots/`；新增列表接口；
  `npm run gate` 包含 11 个判定用例、14 个策略用例、5 条审计记录、逐用例基线与 CI 步骤。
- **Eval：** `npm run gate` —— PASS（一致率 100%，假通过 0）；`npm test` —— 451 个测试，
  448 通过，3 跳过；`npm run typecheck` —— 通过。门禁出现之前没有行为评估；本次生成的
  基线就是之后每次优化的“变更前”。
- **执行链路：** 在一个会话内实现，随后验证三次（功能提交、门禁提交、合并后）。创建 PR
  被权限分类器拦截两次，最终由所有者手动创建；合入 base 时只有一个 `CHANGELOG.md`
  冲突，按两边都保留解决。没有模型调用，也没有 Provider 耗时；CI 每个任务约 40 秒。
- **优点：** 门禁零成本、确定性、每次提交都跑；逐用例基线把之后任何判定变化变成可审查的
  diff。提示词溯源不需要新存储——Journal 加内容寻址文件本来就是正确的形状。
- **缺点 / 下次：** 第一条基线编码的是当前行为，只能检测变化，不能证明正确。提示词快照
  接入真实 Pi 会话这一点，由工具注册测试和类型检查覆盖，没有端到端会话测试（本会话中
  运行它被拦截）。分支与 PR 流程带来两次权限拦截和一次冲突；现在的长期规则是直接合入
  `main` 并说明合并内容。
- **推翻条件：** 见上面两条取舍条目。

### 2026-11-05 — 失败轨迹、带闸门的夜间修复与 Worker 凭据边界

- **目标 / 假设：** 给修复回路诚实的材料——脱敏的失败文档，包含隐性失败——以及一个不能合并、
  不能碰规则的流程，同时把工具凭据移出 Worker 环境。
- **取舍：** [草稿 PR 闸门](../architecture/trade-offs.zh-CN.md#2026-11-04--失败轨迹与修复只在有闸门的草稿-pr-通道运行)、
  [Worker 凭据](../architecture/trade-offs.zh-CN.md#2026-11-05--worker-只继承模型凭据不继承工具凭据)。
- **变更：** `src/audit/failed-traces.ts`、`src/workers/worker-env.ts`、`scripts/nightly-rsi.mjs`、
  launchd 示例，以及 `traces` CLI 命令。
- **Eval：** 四个测试文件共 16 个用例：失败轨迹 3、夜间闸门 7、自我评审 4、Worker 环境 2。
  集成验证：`npm test` 540 个测试 / 537 通过 / 3 跳过；`npm run typecheck` 与
  `npm run gate` 通过。
- **执行链路：** 在 `dreamy-ritchie-b0f526` worktree 中实现；本条目记录交付状态与集成验证。
  夜间任务本身在集成期间没有端到端运行——它需要真实失败轨迹与无头模型——因此那条路径标记为
  **假设**。
- **优点：** 五道闸门各自对应一种已知失效模式；轨迹在模型读到之前已脱敏；凭据拒绝发生在
  进程启动之前。
- **缺点 / 下次：** 端到端修复没有在 CI 中执行（成本与模型依赖），且它产出草稿 PR，这是对
  日常直接合 main 规则的有意例外。原执行链路未被记录。
- **推翻条件：** 见上面两条取舍条目。

### 2026-11-05 — 所有主 Agent 入口的回合级审计

- **目标 / 假设：** 无论从 CLI、`npm run main`、companion/server 还是 WhatsApp 发起，
  主 Agent 回合都应从 Journal 可审计——包括输入、回复、工具调用、模型/强度、用量与状态。
- **取舍：** [每个回合都是一条 Journal 记录](../architecture/trade-offs.zh-CN.md#2026-11-05--每个主-agent-回合都是一条-journal-记录而不是旁路文件)。
- **变更：** 新增 `src/main-agent/turn-audit.ts`（共享 begin/observe/finish 与台账）、
  `src/audit/turn-audit.ts`（投影）、两种 Journal 事件类型、`clone-ai audit turns`、
  `GET /api/audit/turns`、审计页标签、用量记录的 `turnId`、CLI 用量记录，以及自评审用量。
- **Eval：** `test/main-agent-turn-audit.test.ts` 4 个用例，覆盖脱敏、工具事件、失败回合、
  中断幂等与新的在前加载。全量：544 个测试 / 541 通过 / 3 跳过；`npm run typecheck` 与
  `npm run gate` 通过；审计 UI 通过 `node --check`。
- **执行链路：** 通过阅读每个入口与审计投影定位缺口；先写取舍；用一个共享模块接入四个
  入口；随后补测试与全量验证。直接落在 `main`，没有分支或 PR。本次触及
  `src/core/contracts.ts` 与多个模块，而夜间修复通道的受保护路径闸门禁止这些路径，
  因此在所有者直接指示下于本会话实现——该通道仍是可复现 bug 的默认路径。
- **优点：** 同一段代码在所有入口写回合，台账与 Journal 不会漂移；工具调用与用量终于可
  归因到回合；脱敏与截断限制了 Journal 体积。
- **缺点 / 下次：** 黑盒 CLI Worker 的内部工具调用仍不可见（结构性边界）；原生 Worker 的
  模型用量当时未被记录（由下面的原生 Provider 条目取代）；`scripts/run-pi-task.mjs` 与
  `nightly-rsi` 仍在 Journal 之外；回合事件尚未并入单 Run 轨迹视图。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 原生 Worker 成为一等 Provider，并记录精确用量

- **目标 / 假设：** 让所有者像选择任何 CLI 一样按 Agent 选择进程内 Worker，并让它的模型用量
  精确、可归因，使 CLI 与原生 Worker 的对比有数据而不是印象。
- **取舍：** [原生 Provider](../architecture/trade-offs.zh-CN.md#2026-11-05--原生-worker-成为可选-provider并记录精确用量)。
- **变更：** `native` 注册进 Provider 目录，带 Agent 身份与角色能力；原生 Adapter 报告用量；
  OpenAI 兼容客户端解析两种 usage 形状；Runtime 以带 runId/stepId 的 `usage.recorded` 记入
  Journal；审计为每次执行展示精确用量；审计 UI 在网关估算旁显示它。
- **Eval：** `test/native-client.test.ts`（两种 usage 形状、没有 usage 时只计数不定价、
  Provider 身份与角色）、`test/native-agent-worker.test.ts`（completed 事件携带用量）、
  `test/audit.test.ts`（Runtime 记录用量且审计投影出来）。全量：549 个测试 / 546 通过 /
  3 跳过；`npm run typecheck` 与 `npm run gate` 通过。
- **执行链路：** 先写取舍；按 Provider、客户端、Worker、Runtime、审计、UI 的顺序实现；
  每层补测试；最后跑全量与门禁。该项真实对比后来已运行——见下面的 benchmark 条目。
- **优点：** 原生 Worker 可按 Agent 选择与识别；精确 token 可归因到单个步骤；不返回 usage 的
  Provider 只被计数、不被定价，而不是看起来免费。
- **缺点 / 下次：** 没有真实端点测试；原生 Worker 仍只有文件工具；默认 Agent 仍指向 CLI；
  未配置两个环境变量时选择 `native` 会在构建 Registry 时以清晰错误失败。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 原生 vs Claude：可靠性任务集 benchmark

- **目标 / 假设：** 测量进程内 Worker 是否能在同一组固定任务上完成得像 Claude Code CLI
  一样，并拿到精确用量、找出差异。
- **取舍：** [原生 Provider](../architecture/trade-offs.zh-CN.md#2026-11-05--原生-worker-成为可选-provider并记录精确用量)。
- **变更：** `benchmark/run.ts` 接受 `--provider native`（无需 `--unsafe-host`），记录
  验证结果、失败原因与精确用量，并把基准工作区交给验证器。缺少工作区是一个真实的 harness
  bug：所有相对产物都被当成不存在，第一次运行连 summarize 都失败
  （`native-2026-11-05T07-23-30-609Z.json` 保留了证据）。
- **Benchmark 运行 — 原生：** 命令
  `CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 npm run bench -- --provider native --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`；
  Provider/模型：`native`，经本地 Magpie，模型 `360/moonshotai/kimi-k3.1-pro`；数据集：
  `benchmark/tasks.ts` 的 5 个任务；参数：原生 `maxRounds` 12、WorkOrder 预算 12 次模型
  调用 / 20 次工具调用、每任务时长取自 `tasks.ts`；环境：macOS、Magpie
  `127.0.0.1:3425`、无 API Key；结果文件
  `benchmark/results/native-2026-11-05T07-36-54-051Z.json`。**4/5**：
  summarize 15.9s / 2,112 tokens；two-step-chain 55.1s / 5,022；
  three-step-pipeline 131.1s / 10,973；code-tool 45.6s / 4,891；
  missing-input 20.5s / 2,002——**完成并伪造了 `out/summary.md`**，预期失败没有发生。
  合计 25,000 tokens。
- **Benchmark 运行 — Claude：** 命令
  `npm run bench -- --unsafe-host --provider claude --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`；
  Provider/模型：`claude` 及其配置的默认模型；同一数据集与参数；结果文件
  `benchmark/results/claude-2026-11-05T07-48-06-889Z.json`。**4/5**：
  summarize 15.7s；two-step-chain 30.6s；three-step-pipeline 82.2s；code-tool 60.8s；
  missing-input 58.6s——**在验证阶段失败**（`out/summary.md` 不存在），但 benchmark 的
  预期失败要求执行阶段的 `no_artifact`，因此被计为意外失败。CLI 不向运行器报告 token。
- **Benchmark 运行 — Pi：** 命令
  `npm run bench -- --unsafe-host --provider pi --tasks summarize`；结果文件
  `benchmark/results/pi-2026-11-05T07-41-52-338Z.json`；最简单的任务在 180s WorkOrder
  超时。是真实的可靠性数据点，不是模型对比。
- **数字说明：** 四个可解任务两边都通过。原生在 code-tool 更快（45.6s vs 60.8s），在两个
  链式任务更慢（55.1s vs 30.6s；131.1s vs 82.2s）。原生报告精确用量（合计约 25k tokens）；
  CLI 不报告。missing-input 两边都不符合预期，原因相反：原生伪造产物，Claude 在验证阶段
  干净失败。
- **发现 / 下一步：** 加固原生 Prompt，使必需输入缺失时停止而不是编造；决定验证阶段缺失
  产物是否应计入 `no_artifact`（本质上是同一件事）。在两者决定前，原生 Worker 在可解任务上
  与 Claude 持平，但在 missing-input 的诚实性上更弱。（已在下面的条目中修复。）
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 命名输入缺失时原生 Worker 失败

- **目标 / 假设：** 当 WorkOrder 或步骤指令点名的文件缺失时，阻止原生 Worker 编造内容；
  benchmark 显示它会完成并伪造产物。
- **取舍：** [缺失输入](../architecture/trade-offs.zh-CN.md#2026-11-05--命名输入缺失时原生-worker-失败而不是允许编造)。
- **变更：** 读取 WorkOrder 目标或步骤指令点名的路径失败时，回合以 `no_artifact` /
  `native-missing-input` 结束；Prompt 要求模型不要编造缺失输入；失败 Adapter 的用量也会
  记入 Journal。
- **Eval：** `test/native-agent-worker.test.ts`——命名输入缺失以正确类别与签名失败、未被
  指令点名的失败读取仍可恢复、失败用量被携带。Benchmark：原生套件 5/5
  （`native-2026-11-05T08-07-23-864Z.json`）；最终代码重跑 `missing-input` 为预期失败，
  携带 1,397 tokens（`native-2026-11-05T08-10-22-910Z.json`）。全量：552 个测试 / 549 通过
  / 3 跳过；typecheck、gate 与双语文档通过。
- **执行链路：** 由 benchmark 发现；先写取舍；加守卫与 Prompt；补测试；重跑 benchmark；
  最后补失败用量，避免失败运行静默。
- **优点：** 声明为必需的输入缺失后不再接受编造；失败运行也会报告 token。
- **缺点 / 下次：** 指令中点名的合法可选路径缺失也会失败；benchmark 中 Claude 的
  `missing-input` 仍被计为意外失败，因为它在验证阶段而非执行阶段失败。`no_artifact` 的
  口径需要另行决定。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 开关后的原生主 Agent 循环

- **目标 / 假设：** 在不改变行为的前提下，把 Pi 从主 Agent 的关键路径上移除：用进程内
  OpenAI 兼容循环运行相同的 Prompt、工具与审计。
- **取舍：** [原生主 Agent](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-循环放在开关后而不是一次性切换)。
- **变更：** `src/main-agent/prompt.ts`（不依赖 SDK 的 Prompt 编译）、
  `src/main-agent/native-runtime.ts`（chat 循环、工具执行、台账对话记录、台账版
  `search_history`）、kernel-tools 的 `kernelToolDefinitions`，以及
  `run-main-query`、CLI、`npm run main` 的开关分支。Pi 仍是默认。
- **Eval：** `test/native-main-agent.test.ts` 3 个用例：脚本化工具调用 + 最终回答
  （回复、工具消息，以及 turn/tool/usage/snapshot Journal 事件）、从台账加载历史轮次、
  显式开关与端点处理。全量：576 个测试 / 573 通过 / 3 跳过；typecheck、gate 与双语
  文档通过。
- **实机冒烟：** `CLONE_AI_MAIN_RUNTIME=native
  CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro
  CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 clone-ai "请只回复：native 主 Agent 已就绪"`
  返回了该回复；`clone-ai audit turns` 显示完成的回合与 3,393 tokens；
  `clone-ai invocations` 显示 caller `claude-code:<session>`、surface `cli`。
- **优点：** 原生路径写入相同的审计与用量记录；工具表从 Pi 扩展捕获，两个运行时不会
  各自漂移；共享调用账本能识别调用者。
- **缺点 / 下次：** 当时非流式、无压缩；两者接下来已补齐（见下）。当时也拒绝图片，现已支持；
  `search_history` 检索回合台账而非 Pi 会话文件；原生回合不能作为 Pi 会话续跑。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 原生 vs Pi 主 Agent 对比

- **目标 / 假设：** 在改变任何默认之前，检查原生循环能否在相同的 Main Agent 任务上匹敌
  Pi——直接回答、读取权限、提案计划。
- **取舍：** [原生主 Agent](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-循环放在开关后而不是一次性切换)。
- **变更：** 新增 `benchmark/main-agent.ts` 与 `npm run bench:main`：三条固定 Prompt、
  每个任务独立的 clone home、两个运行时相同的模型与端点，报告耗时、tokens、工具调用、
  产生的 Run、回合状态与预期是否成立。
- **Benchmark 运行 — 失败尝试：** 命令
  `CLONE_AI_BENCH_MAIN_MODEL=360/google/gemini-4-argon npm run bench:main`；两个运行时
  的所有任务都因 Magpie 上游返回 400（could not connect to stream）而失败。问题在端点，
  不在 harness（`main-agent-2026-11-05T09-01-57-162Z.json`）。
- **Benchmark 运行 — 有效：** 命令
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`；
  模型：`360/anthropic/claude-sonnet-5-5`，经 Magpie `http://127.0.0.1:3425`；任务：
  direct-answer、authority-read、plan-proposal；每个运行时每任务一次；隔离 clone home；
  结果文件 `benchmark/results/main-agent-2026-11-05T09-06-13-005Z.json`。**两边均 3/3**：
  - direct-answer：Pi 3.3s / 3,865 tokens，原生 5.9s / 3,795；无工具、无 Run。
  - authority-read：Pi 7.6s / 8,197，原生 9.5s / 7,958；两边各调用一次
    `get_authority`；无 Run。
  - plan-proposal：Pi 12.1s / 9,452，原生 9.5s / 9,407；两边各调用一次
    `propose_work_plan`，各产生一个 Run。
- **数字说明：** 任务结果、工具选择与 Run 创建都相同。tokens 几乎一致（Pi 21,514；原生
  21,160，约少 1.6%）。总耗时 Pi 略快（23.0s vs 24.9s），但 plan-proposal 上原生更快
  （9.5s vs 12.1s）。每格只跑一次；把它当作一致性检查，而不是统计基准。
- **发现 / 下一步：** 在这些任务上原生循环行为可比。它仍缺流式与压缩，下一次对比应加入
  长对话与多轮工具任务——那才是最可能出现差异的地方。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 原生主 Agent 流式输出并压缩

- **目标 / 假设：** 在改变默认之前补齐两个缺口：token 到达即输出，以及长对话不再悄悄
  丢失早期细节。
- **取舍：** [流式与压缩](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-流式输出并做确定性压缩)。
- **变更：** 原生运行时使用 SSE（`stream: true`、`stream_options.include_usage`），转发
  内容增量、按 index 组装工具调用增量并解析最后的 usage 块。`buildHistory` 在
  `historyChars`（默认 12,000）的三分之二内保留最新轮次原文，其余替换为一段有界的
  确定性摘要；全文仍在回合台账中。
- **Eval：** `test/native-main-agent.test.ts` 直接驱动 SSE：增量逐个到达、工具调用片段
  正确组装、流式下 usage 不丢、20 轮对话压缩成摘要加最新一轮。全量：579 个测试 /
  576 通过 / 3 跳过；typecheck、gate 与双语文档通过。
- **Benchmark：** `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`
  → 两边 3/3；direct 2.5s / 3,795 vs 2.5s / 3,864；authority 7.8s / 8,013 vs
  9.2s / 8,141；plan 14.2s / 9,138 vs 11.2s / 8,929；工具选择与 Run 创建相同；
  结果文件 `benchmark/results/main-agent-2026-11-05T09-26-57-563Z.json`。与流式之前的
  运行相比，行为无变化，usage 没有丢失。
- **实机验证：** 摘要已在下面的长对话运行中发给真实端点，五项检查全部通过。先前的假设
  已解决。
- **优点 / 缺点：** 流式消除了界面冻结感；确定性压缩便宜、可审计，但不如模型撰写的摘要
  保真；长对话质量已在下面的种子对话上验证。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 原生压缩的长对话验证

- **目标 / 假设：** 对真实端点验证确定性摘要被接受、最新轮次保持原文，以及最早轮次里的
  事实能在压缩后保留到足以让模型回答。
- **取舍：** [流式与压缩](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-流式输出并做确定性压缩)。
- **Benchmark 运行：** 命令
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:long`；
  模型 `360/anthropic/claude-sonnet-5-5`，经 Magpie `http://127.0.0.1:3425`；
  24 条已完成的种子轮次（针在最老一轮）、`historyChars` 4,000、一次真实回合；结果文件
  `benchmark/results/native-main-long-context-2026-11-05T09-43-52-438Z.json`。
- **结果：** 9 条消息（4 条 user）、2,121 字符的确定性摘要；端点接受；最新轮次保持原文；
  回复恰好是 `BLUE-FALCON`；7,842 tokens、1 次模型调用；五项检查全为真。
- **证明了什么 / 没证明什么：** 多个 system 消息在实践中被接受，放在旧轮次开头的事实能
  在摘要中保留。它没有证明埋在旧轮次后部的事实能保留：摘要把每条旧轮次截到 160 字符、
  整体截到 2,000 字符。这仍是确定性压缩的已知弱点。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 原生主 Agent 接受图片

- **目标 / 假设：** 补齐 Pi 与原生主 Agent 之间最后一项能力差距：图片附件。
- **取舍：** [图片附件](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-接受图片附件)。
- **变更：** 有图片时，原生 user 消息改为 OpenAI 风格 content parts（`text` 加
  `image_url` data URL）；`run-main-query` 不再拒绝附件，而是传给原生运行时。图片是
  逐回合的，不写入回合台账。
- **Eval：** `test/native-main-agent.test.ts` 断言捕获请求中的图片部分与 data URL。
  实机验证：发送 64×64 纯红 PNG，回复 `Red.`；图片部分存在、无错误、3,806 tokens、
  1 次模型调用；结果 `benchmark/results/native-main-images-2026-11-05T10-01-47-161Z.json`。
- **优点 / 缺点：** 原生开关不再移除一项能力；base64 会放大请求，本版本不做缩放，之后
  无法从台账恢复图片。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 配置了端点的原生主 Agent 成为默认

- **目标 / 假设：** 让已验证的原生循环成为默认，同时不破坏没有 OpenAI 兼容端点的安装。
- **取舍：** [默认运行时](../architecture/trade-offs.zh-CN.md#2026-11-05--配置了端点的原生主-agent-成为默认)。
- **变更：** 用 `readMainAgentRuntime` 取代布尔开关。未设置 → 存在
  `CLONE_AI_NATIVE_MODEL` 与 `CLONE_AI_NATIVE_BASE_URL` 时用原生，否则用 Pi；
  `pi`/`legacy` 强制 Pi；`native` 强制原生，端点缺失时清晰失败；未知值抛错。对比
  benchmark 的 Pi 列显式固定 `CLONE_AI_MAIN_RUNTIME=pi`。
- **Eval：** `test/native-main-agent.test.ts` 的运行时选择矩阵（未设置且有/无端点、
  显式 pi、显式 native、未知值）；全量 580 个测试 / 577 通过 / 3 跳过；typecheck、
  gate 与双语文档通过。不设开关的实机冒烟：
  `CLONE_AI_NATIVE_MODEL=360/anthropic/claude-sonnet-5-5 CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 clone-ai "请只回复：默认运行时已生效"`
  → 精确回复；`clone-ai audit turns --json --limit 1` 显示 `provider: "native"`。
- **优点 / 缺点：** 配置了端点的部署现在默认使用已验证的原生循环；没有端点的安装继续
  使用 Pi。未设置的情况依赖环境，因此当前运行时在回合记录（`provider`）里可见，而不是
  靠一个隐含的开关。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — direct / research / draft / review 默认使用原生 Worker

- **目标 / 假设：** 默认使用已验证的进程内 Worker，但不强加给 external 角色，也不覆盖
  所有者已保存的选择。
- **取舍：** [Worker 默认](../architecture/trade-offs.zh-CN.md#2026-11-05--配置了端点的原生-worker-成为可承担角色的默认)。
- **变更：** 设置 `CLONE_AI_NATIVE_MODEL` 与 `CLONE_AI_NATIVE_BASE_URL` 时，
  `defaultWorkerProfiles(environment)` 与 `WorkerSettingsStore` 的 `normalize` 让除
  `external` 外的角色默认使用 `native`；已保存的 Provider id 仍然优先，未知或与角色不
  兼容的保存值仍回退到默认。
- **Eval：** `test/worker-defaults.test.ts`——有/无端点时的角色矩阵、缺失设置文件、已保存
  的 `pi` 选择被保留。全量：582 个测试 / 579 通过 / 3 跳过；typecheck、gate 与双语文档
  通过。设置端点后手工检查输出：direct/research/draft/review 为 `native`，external 为
  `codex-cli`。
- **优点 / 缺点：** 配置了端点的部署不再取决于恰好装了哪个 CLI；`external` 仍走受治理的
  CLI 路径。原生 Worker 只有文件工具，因此日后需要网络或外部动作的角色必须更换 Provider。
- **推翻条件：** 见取舍条目。

### 2026-11-05 — 默认切换后的重跑

- **目标 / 假设：** 确认默认切换没有破坏真实链路（路由、工具、审计），并用新默认重新测量。
- **取舍：** [Worker 默认](../architecture/trade-offs.zh-CN.md#2026-11-05--配置了端点的原生-worker-成为可承担角色的默认)
  与[主 Agent 默认](../architecture/trade-offs.zh-CN.md#2026-11-05--配置了端点的原生主-agent-成为默认)。
- **Benchmark 运行 — Worker 套件：** 命令
  `CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 npm run bench -- --provider native --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`；
  模型 `360/moonshotai/kimi-k3.1-pro` 经 Magpie；结果
  `benchmark/results/native-2026-11-05T11-09-55-300Z.json`。**5/5**：summarize
  12.4s / 2,252 tok / 3 次调用；two-step-chain 38.7s / 5,146 / 6；three-step
  pipeline 111.2s / 12,420 / 11；code-tool 46.5s / 4,922 / 5；missing-input
  19.1s / 1,673 / 2，为预期失败。
- **Benchmark 运行 — 主 Agent，两轮：** 命令
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`；
  结果文件 `main-agent-2026-11-05T11-05-57-652Z.json` 与
  `main-agent-2026-11-05T11-12-52-700Z.json`。**两轮中两个运行时都是 3/3。**
- **是波动，不是回退：** 两轮对"谁更快"给出了相反结论，这才是关键发现。第一轮：direct
  Pi 3.0s vs 原生 2.2s；authority 15.9s vs 11.7s；plan 6.6s vs 45.2s（原生一次离群）。
  第二轮：direct 2.9s vs 1.2s；authority 5.9s vs 8.4s；plan 10.4s vs 11.1s（这一轮 Pi
  在提案前先调用了 `get_authority`，其 plan tokens 升到 13,174）。tokens 保持接近
  （direct 上原生 3,795–3,796 vs Pi 3,864）。
- **这次运行改变了什么：** 代码没有变化。它确认默认值端到端可用——工具被调用、每个计划
  任务恰好创建一个 Run、每个回合都完成——并说明每格只跑一次无法对延迟排序。
- **下一步：** 要比较延迟，每格跑 N 次并报告中位数；当前脚本刻意只跑一次，并已说明。
- **推翻条件：** 见两条取舍条目。

### 2026-11-05 — 自检回路：对抗探针、门禁、记录每一轮

- **目标 / 假设：** Agent 应定时攻击自己的边界、记录每一轮，并把红色的一轮交给修复通道，而不是等所有者发现回归。
- **取舍：** [2026-11-05 — Agent 自己运行对抗性测试与修复回路](../architecture/trade-offs.zh-CN.md)。
- **变更：** `src/eval/adversarial-probes.ts`（15 个确定性探针：非授信包裹、转发审批拒绝、审批重放/过期/重发、限流、受保护路径、符号链接逃逸、Worker 环境凭据、轨迹脱敏、摘要篡改、轨迹组装、路径包含、探针隔离）；`src/eval/self-check.ts`（跑探针 + `npm run gate` + 可选 `npm test`，写 `selfcheck.completed`、轮次报告，红色时导出轨迹）；`clone-ai selfcheck [--full] [--repair] [list]`；`GET/POST /api/audit/selfcheck`；审计→评估页显示本轮、失败项、门禁尾巴与历史。
- **Eval：** `node --experimental-strip-types --test test/self-check.test.ts`（三个用例：全部探针绿、绿色轮次写入 Journal 与磁盘、门禁红使本轮变红并尝试导出）。对 `/tmp/audit-demo3` 运行 `clone-ai selfcheck`：`绿色 · 探针 15/15 · gate ok`，轮次 `round-20261105T081911`。
- **Benchmark run：** 无——这是确定性离线评估，不涉及 Provider、模型、数据集或评分参数。
- **执行链路：** 读现有门禁与测试骨架；针对已发布模块写探针；加轮次运行器、CLI、API 与界面；套件跑了两次（一次因中文注释缺失变红并修复）；跑 `npm test`（568 通过）与 `npm run typecheck`；用 CLI 对演示 home 跑了一轮真实自检（约 2 秒，纯 CPU，0 token）。
- **优点：** 便宜到可以每轮跑；每个探针都写明边界与攻击方式；回路产出是一等审计对象，修复交接复用既有带闸门通道。
- **缺点 / 下次：** 探针确定性、可复现，但不具创造性——下一层是受 schema 约束、有预算上限的模型红队；真实事故暴露新类别时，应扩展套件。
- **推翻条件：** 见取舍条目——扩展套件，而不是放宽。

### 2026-11-04 — 带可撤销配置动作的 AI 自我评审

- **目标 / 假设：** 把审计摘要变成一个小而安全的改进回路——发现项加上所有者可应用、可撤销的
  配置动作——而不把代码、提示词或策略的权限交给模型。
- **取舍：** [自我评审只改配置](../architecture/trade-offs.zh-CN.md#2026-11-04--自我评审只改配置不改规则)。
- **变更：** `src/audit/self-review.ts`、`src/audit/apply-review.ts`、审计页的评审界面，以及
  `recommendation.applied` Journal 事件。
- **Eval：** `test/self-review.test.ts` 4 个用例，覆盖动作校验、模型不可用时的"只给事实"降级，
  以及 worker 强度与主 Agent 强度的应用/撤销。集成验证：`npm test` 540 个测试 / 537 通过 /
  3 跳过，`npm run typecheck` 通过。
- **执行链路：** 在 `dreamy-ritchie-b0f526` worktree 中实现。本条目记录的是交付状态与集成验证；
  原会话的内部步骤在这里不可得。集成期间没有模型调用。
- **优点：** 接口刻意很窄；每次应用先写旧值，因此所有者总能撤销，Journal 也能回答谁在哪次
  评审下改了什么。
- **缺点 / 下次：** 评审修不了代码或提示词缺陷，只能调模型与强度。原执行链路当时没有被记录
  ——这正是本日志要补上的缺口。
- **推翻条件：** 见取舍条目。
