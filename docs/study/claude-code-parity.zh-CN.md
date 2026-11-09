# 从 Claude Code 到 Clone AI：逆向分析与 95% 对齐路线

[English](claude-code-parity.md) · **简体中文**

这份文档回答一个问题：**clone-ai 的 Agent 框架要做到什么程度，才算达到 Claude Code 的 95%？**
它基于对本机安装的 Claude Code 2.1.317 与 Claude Desktop 4.16336.0 的只读逆向，以及对
clone-ai 工作区（2026-11-06）的审计。

结论先说：Claude Code 的优势主要在 **harness 机制**，不是某个秘密模型。clone-ai 在权限边界、
验证、记忆和审计上已经比 Claude Code 更强；落后的是循环控制、逐次工具面、上下文工程、
扩展点和桌面反馈。这些都可以实现，本文给出顺序与 eval。

> 本文是分析与计划，不表示 95% 已经达成。逆向得到的源码只留在仓库之外，没有把专有源码或
> Prompt 原文复制进 clone-ai。

---

## 1. 方法与“95%”的定义

### 1.1 分析对象

| 对象 | 提取内容 | 证据 |
| --- | --- | --- |
| Claude Code 2.1.317 | 从 Bun 单文件可执行文件的 `__BUN` 模块图提取 2,942 个 JS 模块 | `cli` 模块头 `// Version: 2.1.317`；模块表与 Offsets |
| Claude Desktop 4.16336.0 | Electron 主包（`app.asar`）、渲染层（`ion-dist.asar`）、内置技能、MCP、VM 镜像 | `package.json`、SDK wrapper `0.3.317` |
| clone-ai 工作区 | 分支 `codex/net-new`，22 个改动文件、2 个未跟踪文件；`npm run gate` 通过，`typecheck` 通过，`npm test` 578/585 | 审计报告、`test.log` |

提取方法见附录。文中每条结论都锚定到源码里的字符串、对象键或控制流；没有直接证据的推理
标为“推测”。

### 1.2 95% 的定义

**95% 是加权的 harness 对齐分数，不是模型输出完全一致。**

- 12 个维度，权重合计 100（第 4 节）。
- 每个维度按 0–100 打分，每一级都必须有可执行的证据；没有证据的能力不算分。
- 总分要求 **加权分 ≥ 95，且每个维度 ≥ 80**。
- 模型质量单独测量：用同一个后端模型跑同一组任务，绝不混进 harness 分数。弱模型不能
  被误判成 harness 失败，强模型也不能掩盖 harness 缺陷。
- 没有第 6 节的 eval 套件，分数只是意见。

这样定义的理由：clone-ai 支持任意 OpenAI 兼容端点，模型可能比 Claude Code 默认模型弱或强；
harness 才是 clone-ai 能控制的部分。把两者混在一起，数字既不可比，也容易被操纵。

---

## 2. Claude Code 到底是什么

### 2.1 循环是一个带类型的状态机

查询循环是一个 async generator：每轮要么返回哨兵 `"next_round"`，要么返回带类型的终止对象。
它是否继续，取决于 assistant 是否产生了 `tool_use` 块，而不是 `stop_reason === "tool_use"`。
观察到的终止原因包括 `completed`、`api_error`、`aborted_streaming`、`aborted_tools`、
`max_turns`、`stop_hook_prevented`、`hook_stopped`、`blocking_limit`、`prompt_too_long`、
`image_error`、`rapid_refill_breaker`、`malformed_tool_use_exhausted`。

这很重要：重试、回退、遥测、预算报告、UI 都需要一个“为什么结束”的答案。clone-ai 目前只有
一个通用错误字符串。

### 2.2 工具在流式输出期间就开始执行，危险工具是屏障

每个工具声明 `isConcurrencySafe(input)`。安全工具可以在模型还在流式输出时启动；非安全工具
是屏障：它等待所有在途工具结束，后续调用再等它。结果按模型调用顺序返回，而不是完成顺序。
schema 解析失败会把工具降级为串行。这条路径没有数字并发上限。

内建工具共 22 个：

```text
Bash Read Write Edit Glob Grep NotebookEdit WebFetch WebSearch Task TodoWrite
TaskCreate TaskUpdate TaskGet TaskList TaskStop Skill REPL JavaScript
AskUserQuestion ToolSearch SendUserMessage
```

另有延迟/专用工具：`EnterPlanMode`、`ExitPlanMode`、`Monitor`、`Workflow`、
`CronCreate/List/Delete`、`ScheduleWakeup`、`TaskOutput`、`EnterWorktree/ExitWorktree`、
MCP 资源工具等。

工具定义携带运行期元数据：`isConcurrencySafe`、`isReadOnly`、`maxResultSizeChars`、
`backgrounding`、`shouldDefer`、`persistenceThresholdCeiling`、`strict`、`coerceInput`。
结果阶梯也是契约的一部分：Bash 溢出到文件，Read 默认 2,000 行，Grep 上限 20,000 字符，
MCP 输出上限 25,000 tokens。

### 2.3 权限是逐次调用决定的，不是计划时决定的

六种模式构成阶梯：

```text
plan < default = dontAsk < acceptEdits < auto < bypassPermissions
```

规则使用 `Tool(pattern)` 语法（`Bash(git *)`、`Read(./src/**)`、`Edit(...)`、
`mcp__server__tool`）。deny 优先，然后 ask/allow。`auto` 模式下分类器逐次决定
allow/deny/ask。`bypassPermissions` 除显式 deny 外全部放行。被拒绝的调用作为工具结果返回
给模型，回合继续。

Harness 用 `canUseTool`（或 `--permission-prompt-tool=stdio`）强制执行。桌面端走同一条路：
CLI 通过 stream-json 控制通道发送 `can_use_tool`，App 的权限 broker 渲染卡片，再返回带
`request_id` 的 `control_response`。

值得照抄的实现细节（朴素规则引擎容易在这里出错）：

- 规则按来源排序：`userSettings`、`projectSettings`、`localSettings`、`flagSettings`、
  `policySettings`，然后 `cliArg`、`session`、`command`、`toolsNarrowing`、`mcpMount`、
  `mcpServerPolicy`、`hostCredential`。deny 先于 ask/allow 评估，弱来源的 deny 仍能压过
  强来源的 allow。
- Hook 的 `allow` 不能解除 deny（`Hook returned 'allow' … but deny rule overrides`）；
  多个 hook 取最严格者。
- `acceptEdits` 是窄允许清单——`mkdir`、`touch`、`rm`、`rmdir`、`mv`、`cp`、`sed`——
  并做参数形状检查，不是“编辑都可以”。
- `plan` 模式有写入地板：非只读、非豁免的调用变成 ask，理由是 `plan mode holds the call`。
- 沙箱自动放行是 ask→allow 的条件降级：只有沙箱确实在运行、profile 允许、命令不是已知危险
  形状时才成立。
- 审批卡有完整性校验：答案改了卡片展示过的字段会被拒绝；审批只能增加限制，不能放宽。
- 无人值守调用有明确的“无人应答，不要重试”策略，避免重试风暴。

### 2.4 Hook 是 33 个事件的扩展面

事件包括 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、
`PermissionRequest`、`PermissionDenied`、`UserPromptSubmit`、`UserPromptExpansion`、
`SessionStart`、`SessionEnd`、`Stop`、`StopFailure`、`SubagentStart`、`SubagentStop`、
`PreCompact`、`PostCompact`、`PreModelSwitch`、`PostModelSwitch`、`TaskCreated`、
`TaskCompleted`、`Elicitation`、`ElicitationResult`、`ConfigChange`、`WorktreeCreate`、
`WorktreeRemove`、`InstructionsLoaded`、`CwdChanged`、`FileChanged`、`DirectoryAdded`、
`MessageDisplay` 等。

契约是 shell 友好的：stdin 收 JSON；exit 0 继续，exit 2 阻断并把 stderr 喂给模型，其他
退出码把 stderr 展示给用户后继续；`hookSpecificOutput` 可以注入上下文。每个事件有超时
（工具 hook 15s、提示 hook 30s、Stop/SubagentStop 120s）；超时的 hook 被跳过并提示，
不会挂住整个回合。Hook 类型有 `command`（shell 或 argv）、`http`、`prompt` 与
`callback`/SDK；选项包括 `if`（规则匹配器）、`onFailure`（`continue`/`block`）、
`async`、`asyncRewake`、`once` 与超时。项目 hook 本身在沙箱中运行，并按脚本 SHA-256
钉住；工作区信任被接受前不会加载。

### 2.5 上下文工程分三层

1. **Prompt 组装。** 静态段（`intro`、`system`、`doing_tasks`、`actions`、`tools`、
   `tone`）与会话动态段由 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 分隔。缓存范围由边界推导：
   静态段 global、身份段 org、动态段 org 或 null。`__SYSTEM_PROMPT_STATIC_BREAKPOINT__`
   可以把一个静态块再拆成多个缓存段。每个会话的段落答案会被记忆，并由显式事件失效，
   因此 Prompt 的差异是可解释的。
2. **记忆加载。** 托管 `CLAUDE.md`、用户 `CLAUDE.md`、项目逐级查找
   （`CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`、`CLAUDE.local.md`）、
   额外工作目录、auto-memory（`MEMORY.md`，索引 200 行 / 25 KB）。`@import` 深度 5，
   跳过代码块，只允许文本扩展名，单文件读取上限 4 MiB。注入时按信任类别标注
   （managed/user/project/local/auto-memory），不静默合并。
3. **窗口管理。** 先估算 token，然后：
   `effective = contextWindow - min(maxOutputTokens, 20000)`；
   `threshold = min(floor(effective * (1 - 0.2)), effective - 13000)`；
   警告线 `threshold - 20000`；阻断线 `effective - 3000`。
   压缩时写入 `compact_boundary`，带 `preservedMessages.uuids`、九段摘要、保留的尾部、
   恢复的附件。微压缩清理旧工具结果（保留最近 12 次工具调用，且至少节省 20,000 tokens 才做）。
   工具结果有阶梯：内联 → 落盘 → 中间截断 → 清理旧结果，每个工具有自己的上限。

### 2.6 扩展点是产品的入口

- **MCP**：stdio、HTTP、streamable HTTP、SSE、WebSocket、SDK、IDE、proxy 等传输；工具名
  `mcp__<server>__<tool>`；资源；OAuth；每服务器超时；输出上限 25,000 tokens。
- **Skills**：`skills/<name>/SKILL.md` + frontmatter（`name`、`description`、
  `allowed-tools`、`disable-model-invocation`、`user-invocable`、`paths`、`context`、
  `agent`、`hooks` 等）；先发列表，调用时再注入正文。
- **插件/市场**：`plugin.json`、`commands/`、`agents/`、`hooks/hooks.json`、`.mcp.json`；
  只有技能树的目录可以没有 manifest。
- **子 Agent**：`Task`/`Agent`，支持 `subagent_type`、模型/强度覆盖、
  `isolation: "worktree"`、`run_in_background: true`、通过 `SendMessage` 续聊，
  结果以 user 角色 `<task-notification>` 消息返回。
- **延迟工具**：`shouldDefer` + `ToolSearch`，工具表只在需要时展开。

### 2.7 Claude Desktop 是同一个 CLI 的 GUI

Code 标签页不嵌入第二个 Agent。它用
`--output-format stream-json --input-format stream-json` 启动固定版本的 `claude` CLI，
并通过控制协议通信：`initialize`、`can_use_tool`、`hook_callback`、`request_user_dialog`、
`oauth_token_refresh`、`interrupt`、`session_state_changed`、`transcript_mirror`、
`keep_alive`、`compact_boundary`。App 拥有权限 broker、会话存储、文件 checkpoint、rewind、
resume/fork，以及 Cowork 的 VM。渲染层启用 `contextIsolation`、禁用 Node、使用带类型的
service registry 和严格的 scheme 策略。

这是给 clone-ai 的关键架构教训：**桌面是 Agent runtime 的控制面，不是第二个 Agent。**
clone-ai 已经是 Swift/WKWebView + Node sidecar 的同一结构；缺的是控制协议里的权限、会话、
checkpoint 和反馈面。

---

## 3. clone-ai 现在的位置

审计看的是工作区，不是文档。审计时 `npm run gate` 通过，`npm run typecheck` 退出 0，
`npm test` 为 585 个测试、578 通过、4 失败、3 跳过。4 个失败是移除 Pi 之后的迁移遗留，
可复现；它们不是停工理由，但说明当时的树不能直接发布。阶段 0 已修复它们。阶段 0/1 之后
（2026-11-07），套件为 **609 个测试、606 通过、0 失败、3 跳过**，共享循环内核已接入 Main Agent 与原生 Worker。下面的矩阵仍是实现前的审计基线；其余阶段完成后再重新评分。

### 3.1 应保留的强项

- **权限边界。** Main Agent 只提案；Kernel 校验、批准、验证、判定完成。比“Agent 自证完成”
  更安全。
- **Journal 优先的持久化。** SQLite WAL、append-only 事件、claim lease、孤儿恢复、
  kill-restart 测试。
- **基于证据的验证。** 文件/测试/diff 验证器，离线 gate 有逐用例基线。
- **受治理的记忆。** 来源、候选、冲突、敏感度、过期、PII 脱敏、混合词面召回；对个人 Agent
  比朴素向量库更合适。
- **Scope 与沙箱原语。** Path gateway、受保护路径、自主性阶梯、macOS Seatbelt。
- **Loopback 加固。** 每次启动的 bearer、Host/Origin 校验、0600 文件。
- **Provider 抽象。** 黑盒配方 + 进程内原生 Worker。

### 3.2 缺口的白话版

| # | 缺口 | 为什么重要 |
| --- | --- | --- |
| 1 | Main Agent 不能碰工作区 | 它能提案但不能读/改/跑；Claude Code 的循环正是这些 |
| 2 | 权限只在计划时决定，没有逐次闸门和 hook | 无法“拒绝一次并继续”；没有可审计的扩展面 |
| 3 | 压缩按字符、且不落记录 | 长会话丢细节；桌面上下文面板读的是遗留 Pi JSONL |
| 4 | 没有 MCP host | 第三方集成几乎都从 MCP 进来 |
| 5 | 没有 Skills | 可复用流程只能硬编码 |
| 6 | 没有模型可调用的子 Agent / 后台任务 | WorkOrder 由 Kernel 从计划派发，不是运行时选择 |
| 7 | 回合中没有取消 | 失控回合停不下来；UI 只中止自己的 fetch |
| 8 | 没有重试/退避/回退 | 一次 429/5xx 就变成用户可见失败 |
| 9 | 会话状态分裂；没有 resume/fork/rewind | 跨重启连续性是 Agent 的核心属性 |
| 10 | 桌面反馈与可观测性不达标 | 纯文本流、无工具时间线、无停止按钮、无 OTel span |

### 3.3 需要修正的过期说法

9 月的 `harness-gap-analysis.html` 已经两个方向都过期：它仍说 Main Agent 跑在 Pi 上；
又说没有 `/health`、没有 bearer/Origin、没有 reject/cancel，而代码三者都有。
`benchmark/main-agent.ts` 仍设置 `CLONE_AI_MAIN_RUNTIME=pi`，现在会直接抛错。
`native-runtime.ts` 的头注释说“no compaction”，文件却在压缩。下一位 Agent 会被这些说法
误导；应在改动相关区域时一并修正。

---

## 4. 对齐矩阵

权重按“离 Claude Code 的行为有多远”分配，而不是按实现难易。分数来自审计中有证据的成熟度，
换算到 0–100。

| # | 维度 | 权重 | 基线 | 缺口 | 决定 |
| --- | --- | ---: | ---: | --- | --- |
| 1 | Agent 循环控制（有界、预算、取消、单飞） | 12 | 55 | 缺带类型的终止原因、turn/token 预算、abort 传播、重试/回退、并行安全调度 | **采纳**状态机与调度器 |
| 2 | 工具层与闸门（受治理工具、截断、延迟加载） | 10 | 55 | 执行工作的 Agent 没有 Edit/Glob/Grep/Bash；无结果阶梯；无 ToolSearch | **采纳**元数据与结果阶梯；**适配**为按角色/能力的工具配置（编码只是其中一种） |
| 3 | 权限与授权（模式、规则范围、逐次 ask） | 12 | 65 | 只有计划时；无模式；无 hook | **采纳**六模式、规则语法、ask 路径；**适配**到 Kernel policy |
| 4 | 验证与证据 | 10 | 85 | 外部动作 receipt 结构性困难；连接器证据薄 | **保留**，再补 receipt/连接器 |
| 5 | 记忆与上下文管理（压缩、简报、召回） | 10 | 55 | 字符压缩；无 token 阈值、边界记录、微压缩、压缩后恢复 | **采纳**阈值数学与边界记录；**适配**摘要 Prompt |
| 6 | 子 Agent 编排（隔离、后台、回传） | 8 | 65 | WorkOrder 有依赖/续跑/验证，但模型不能调用 | **适配**成 `Task` 工具 |
| 7 | 扩展点（hook、skill、MCP、插件） | 8 | 10 | 都没有 | **采纳** hook/skill/MCP；**延后**插件市场 |
| 8 | 可观测性与遥测 | 6 | 65 | 有 journal/usage/audit/health；无 span、指标、工具决策事件 | **采纳**稳定事件 schema 与 OTel |
| 9 | 可靠性与运维（崩溃恢复、队列、健康） | 6 | 75 | Journal/恢复强；无重试/watchdog；4 个红测试 | **保留**，加重试/watchdog，修基线 |
| 10 | 安全（loopback、密钥、沙箱） | 8 | 65 | Bearer/Host/Origin 与 Seatbelt 有；进程内工具无 OS 沙箱、无 keychain、CSP null | **保留**，补进程内沙箱/keychain/CSP |
| 11 | 模型层（路由、回退、用量账本） | 5 | 55 | 无重试/回退、无按模型成本账本、无 prompt-cache 账 | **采纳**重试/回退与 cache 感知用量 |
| 12 | 产品/UX 与分发 | 5 | 45 | 纯文本流、无工具时间线/停止按钮、无 resume/rewind、ad-hoc 签名 | **采纳**桌面控制面模式 |

**基线加权分（估计）：58.5 / 100。** 最低维度是扩展点（10），其次是产品/UX（45）、Agent 循环（55）、
工具（55）、上下文（55）。分数刻意从严：只有可执行检查证明过的等级才算数。

### 4.1 采纳、适配、跳过、延后

**采纳（机制，不抄代码）：**

- 带类型的循环终止原因与有界恢复阶梯——*理由：重试、回退、预算报告和 UI 都需要“为什么
  结束”的答案；clone-ai 目前只有一个通用错误字符串。*
- 流式工具执行，逐工具 `isConcurrencySafe` / `isReadOnly`，危险工具做屏障——*理由：读多的
  回合现在要逐个等工具；调度器能在不改工具 API 的前提下缩短墙钟时间。*
- 逐次权限决定：allow/deny/ask、规则范围、`updatedInput`——*理由：计划时审批无法“拒绝一次
  坏调用并继续”；这是每个新工具都需要补的安全层。*
- Hook 面：退出码契约 + 每事件超时——*理由：它以很低成本换来可审计的扩展性，且不授予权威。*
- Token 感知的压缩：持久化边界 + 保留消息 id——*理由：字符预算不跟踪模型窗口；没有记录，
  桌面上下文面板也无法说明发生了什么。*
- 工具结果阶梯：内联 → 落盘 → 中间截断 → 清理旧结果——*理由：8,000 字符硬切会丢掉大输出
  的尾部，也不告诉模型数据被移除。*
- MCP host：`mcp__server__tool` 命名、输出上限、延迟工具——*理由：它是生态入口；没有它，
  每个集成都得手写连接器。*
- `SKILL.md` 渐进披露与按技能的工具授权——*理由：它增加可复用的流程知识，又不膨胀每个
  Prompt。*
- `Task` 工具：后台、隔离、回传——*理由：Kernel 能派发 WorkOrder，但模型不能在运行时选择
  并行或委派。*
- 会话记录/转录分离、resume/fork、文件 checkpoint——*理由：跨重启连续性与撤销是 Agent 的
  核心属性；只有回合台账无法恢复会话或文件。*
- 桌面权限卡片、工具时间线、diff、上下文表、停止按钮——*理由：用户通过“看得见、停得下”
  判断对齐；当前 UI 只渲染流式文本，没有工具活动。*

**适配：**

- `CLAUDE.md` 层级 → clone-ai 的受治理记忆 + 项目上下文文件，按信任标签注入——*理由：
  不受治理的自动发现是 clone-ai 刻意关闭的注入通道。*
- 权限规则 → Kernel policy + ToolAuthority；deny 优先，hook 不能扩大权限——*理由：Kernel
  必须是唯一权威；第二套规则引擎会让两套说法漂移。*
- 子 Agent → 现有 WorkOrder 子 Agent；`Task` 工具创建受治理 WorkOrder，而不是第二权威——
  *理由：clone-ai 已经有依赖、续跑与证据验证；复制它会造出两条完成判定路径。*
- 压缩摘要 Prompt → clone-ai 自己的九段摘要；先确定性，模型摘要可选——*理由：确定性摘要
  私密、便宜、可测试；模型摘要是优化，不是前提。*
- Hook → 所有者配置的命令，沙箱化、可审计，带信任位——*理由：hook 执行所有者代码；没有
  信任位与沙箱，它就是一个不受治理的执行面。*

**跳过（附理由）：**

- **Claude Code 的 Prompt 原文与源码。** 专有；为编码 CLI 调优；会替换 clone-ai 的个人分身
  charter。只抄契约，不抄文本。
- **Anthropic auth/OAuth/keychain、模型目录、GrowthBook flag、遥测、A/B 实验。**
  Provider 专属，不属于 harness 契约；clone-ai 支持任意 OpenAI 兼容端点。
- **云会话、远程控制、SSH、IDE、Chrome、computer-use。** 有基础设施成本的产品面，
  不影响 harness 分数。
- **插件市场与插件供应链。** 等 MCP/Skills 稳定、且有真实工作流需要时再做。
- **Windows/Linux VM（`smol-bin`、各 hypervisor 后端）。** macOS 上 Seatbelt 已经隔离 CLI
  Worker；VM 是 26 MB 镜像 + 平台相关 hypervisor 代码。等红队测试证明 Seatbelt 不够再做。
- **UI 的具体配色、排版、营销文案。** 不是功能缺口。

**延后（附触发条件）：**

- MCP resources/prompts：stdio 工具路径稳定后。
- 插件市场：Skills + MCP 有权限模型后。
- 云/远程会话：所有者需要第二台机器时。
- VM 沙箱：红队测试证明 Seatbelt 不足，或必须运行外部不可信代码时。
- computer-use/Chrome：真实个人工作流需要时。

---

## 5. 到 95% 的路线

顺序由依赖决定：先循环内核，因为其他能力都要挂上去；再逐次权限，因为新工具没有闸门就不安全；
然后工具与上下文；再扩展点；最后桌面与运维。每个阶段都有确定性 eval；实机基准单独标注。

### 阶段 0 — 修基线（半天）

- 修 4 个红测试：让它们与“只保留 native provider”的现状一致，或有意恢复 Pi。
  更新 `bench:main`，不要再强制已移除的 runtime。
- 修正过期文档（`harness-gap-analysis`、`native-runtime` 头注释、README 的 Pi 引用、
  `benchmark/README`）。
- 在 `benchmark/README` 增加 parity 小节，记录指标与证据层级。

**验收：** `npm test`、`npm run typecheck`、`npm run gate` 全绿；没有文档声称一个启动不了的
runtime。

### 阶段 1 — Agent 循环内核（P0）

- `src/agent/loop.ts`：一个 async 状态机，带类型终止原因（`completed`、`max_turns`、
  `budget_exhausted`、`aborted_streaming`、`aborted_tools`、`api_error`、`prompt_too_long`、
  `malformed_tool_use`、`hook_stopped`）。
- 流式工具调度：安全工具并发，非安全工具屏障，结果按模型调用顺序返回。
- 每回合 token/工具/时长预算与可见用量账本。
- Abort 传播到模型流与每个在途工具；Main Agent 流增加 `cancel` 端点。
- 重试/退避：`Retry-After`、首字节/空闲 watchdog、有界恢复阶梯（输出上限、截断流、
  非法工具调用、空完成）。
- 结构化 `tool_result` 信封（`tool_use_id`、`is_error`、`denialKind`、`truncated`）。

**Eval：** `test/agent-loop.test.ts` + 假模型：max-turns 终止原因、只读并行时序、串行屏障、
abort、429 重试、预算耗尽、非法工具恢复、结果顺序确定。

**预计：** 循环 55→90，模型层 55→75，可靠性 75→85。

**状态（2026-11-09）：** 阶段 6 已开始：Main Agent 可以通过 Kernel 派发有界任务
（`dispatch_task`）；阶段 7 已开始：对话从同一 SSE 流渲染实时工具时间线。阶段 1 与 2 已实现。`src/agent/loop.ts` 拥有带类型的终止原因、
逐次 `authorize`、前置/后置 hook、预算与 abort；Main Agent 与原生 Worker 都运行在它上面。
阶段 3 部分完成：Worker 的工具集是配置（编码只是其中一种），但额外的编码工具尚未编写。
阶段 4 已实现为 `src/main-agent/context-window.ts` 加 `main_agent.context_compacted`。
阶段 5 已实现为 `src/mcp/mcp-host.ts` 与 `src/skills/skill-loader.ts`；两者都按主 Agent
回合显式开启。

### 阶段 2 — 逐次权限与 Hook（P0）

- `ToolAuthority` 成为唯一进程内闸门：`allow / deny / ask`、原因、`updatedInput`、
  operation id、超时、reconcile。
- 六模式阶梯（`plan`、`default`、`dontAsk`、`acceptEdits`、`auto`、`bypassPermissions`），
  禁止未授权升级。
- 规则语法（`Bash(git *)`、`Read(./src/**)`、`Edit(...)`、`mcp__server__tool`）；
  deny 优先；受保护路径任何批准都打不开。
- 核心 hook 子集：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit`、
  `SessionStart`、`Stop`、`PreCompact`、`PostCompact`；退出码契约与每事件超时。
- 桌面/CLI 的 `ask` 路径与审批卡；拒绝返回结构化工具结果，回合继续。

**Eval：** 在 `benchmark/gate/policy-cases.json` 增加模式/规则优先级用例；
`test/tool-authority.test.ts` 覆盖 allow/deny/ask、updatedInput、超时、abort、hook 阻断；
桌面测试断言被拒绝的调用不会杀死回合。

**预计：** 权限 65→95，扩展点 10→50，安全 65→75。

### 阶段 3 — 执行 Worker 的工具配置与隔离（P1）

- 定义按角色/能力的工具配置。Worker 已经接受 `NativeToolSpec[]`；编码配置可以加入
  `edit_file`、`multi_edit`、`glob`、`grep`、`bash`、`todo_write`、`task`，而 research、
  review、draft 与 external 各有自己的配置。编码只是其中一种配置，不是 Worker 的身份。
- 每个配置都经 `decideTool` 逐次检查：配置不会扩大 risk、路径或网络权威；未知工具被拒绝，
  回合继续。
- Bash 在每步沙箱中运行：macOS Seatbelt，先 worktree/临时副本；只有拿到 scope 才开网络。
  不把 shell 字符串交给 shell，用 argv。
- 危险步骤用 worktree 隔离；checkpoint 可恢复（不只是 hash）。
- 工具结果阶梯与大输出落盘。

**Eval：** 确定性工具契约套件（路径逃逸、符号链接、命令分类、截断、落盘、worktree 清理）；
一个真实编码任务（读 → 改 → 测试）必须留下 artifact 并通过测试。

**预计：** 工具 55→95，安全 75→85。

### 阶段 4 — 上下文工程（P1）

- Token 估算与窗口配置；实现 Claude Code 推导的阈值（effective、threshold、warning、blocked）。
- 循环顶部自动压缩 + `prompt_too_long` 反应式压缩。
- `compaction` 记录：保留消息 id、九段摘要、保留尾部、恢复文件
  （最近 5 个，每个 ≤5,000 tokens，总计 ≤50,000 字符）。
- 微压缩：保留最近 12 次工具调用；只有至少节省 20,000 tokens 才清理。
- 工具结果阶梯 + 由新记录驱动的上下文视图。
- 稳定段落 id 与静态/动态边界；cache 感知的用量账。

**Eval：** `test/compaction.test.ts` 用种子轮次 + 假模型；
扩展 `benchmark/native-main-long-context.ts`，断言边界元数据与事实召回；
token 预算测试在 blocked 线失败回合。

**预计：** 上下文 55→95，可观测性 65→80。

### 阶段 5 — MCP 与 Skills（P2）

- 进程内 MCP host：先 stdio，再 HTTP/SSE；工具名 `mcp__server__tool`；输出上限；
  每服务器超时；需要时 OAuth。
- 延迟工具加载与 `ToolSearch` 式加载器。
- 项目/用户/插件目录的 `SKILL.md` 发现；frontmatter（`name`、`description`、
  `allowed-tools`、`disable-model-invocation`、`user-invocable`）；正文渐进注入。
- 权限集成：MCP 工具与 Skill 继承逐次闸门；服务器策略可强制 `ask`。

**Eval：** 假 stdio MCP 服务器 + 两个工具；带 `allowed-tools` 的 skill 夹具；
命名、schema、输出上限、延迟加载、未授权技能激活、服务器故障隔离。

**预计：** 扩展点 50→95，工具 95→100。

### 阶段 6 — 子 Agent、后台与会话（P2）

- `Task` 工具创建受治理 WorkOrder（角色、能力、预算、工作区、期望证据），返回
  `<task-notification>` 式结果。后台任务可见、可取消。
- Worktree 隔离与每会话并发上限。
- 会话转录 + 记录分离：append-only JSONL 存消息/工具事件，小记录存 cwd、模型、权限模式、
  checkpoint。
- Resume/fork/rewind：文件 checkpoint 可撤销；`resume`/`fork` 语义不写父转录。

**Eval：** 假子 Agent 的回传/配对/上限测试；会话 resume/fork/rewind 测试；
两个子 Agent 的依赖顺序实机任务。

**预计：** 子 Agent 65→95，循环 90→100，上下文 95→100。

### 阶段 7 — 桌面控制面与可观测性（P2）

- 工具时间线：工具卡、diff、计划/待办卡、上下文表、真正中止服务端回合的停止按钮。
- 权限卡：带范围的“始终允许”、危险操作的滚动确认、可见的拒绝原因。
- 侧栏会话 resume/fork/rewind；记录与转录分离。
- WebView 与 sidecar 的类型化 RPC；CSP 与渲染层沙箱；渲染层不加载 Node。
- JSON 事件 schema + OTel span/指标；脱敏与有界尾。

**Eval：** cancel/approve/deny/resume 的 UI e2e；工具时间线与上下文表的截图/DOM 检查；
工具决策与压缩事件的 trace 导出测试。

**预计：** 产品/UX 45→90，可观测性 80→95。

### 阶段 8 — 可靠性、安全与模型层（P3）

- 重试/回退已在阶段 1；补按模型成本账、prompt-cache 账、给模型的预算提醒。
- 流式 watchdog（首字节、空闲、总时长）与 run-end ceiling。
- Keychain/密钥存储、CSP、进程内工具沙箱、限流、hook/MCP 配置审计。
- 记忆：可选 embedding 作为 rerank（不替换可测试的词面路径）；项目上下文文件带信任标签。

**Eval：** 故障注入（429、500、流卡住、进程被杀、转录损坏）；CSP/keychain 安全测试；
resume 后仍正确的成本账测试。

**预计：** 安全 85→95，可靠性 85→95，模型层 75→95。

### 阶段 9 — 验证与总对齐运行（P3）

- 用受治理连接器补齐外部动作 receipt。
- 把指标报告中的确定性用例（D1–D13）加入 gate。
- 用与 Claude Code 相同的后端模型跑实机套件作为参照；记录命令、模型、任务、种子、样本量、
  结果路径。
- 公布加权分、最低维度、以及任何低于 80 的维度。

**预计：** 验证 85→100，产品/UX 90→95；加权分约 95。

> 预计分数只是估计；阶段验收标准，而不是预计数字，决定阶段是否完成。

---

## 6. Eval 套件

### 6.1 确定性（免费，CI）

在 `benchmark/gate/` 增加：

| ID | 用例 | 维度 |
| --- | --- | --- |
| D1 | 承诺的文件存在且有内容 → pass | 验证 |
| D2 | 缺失/空文件 → fail，零误通过 | 验证 |
| D3 | 本地可逆写入 → allowed | 权限 |
| D4 | 外部动作 → approval_required | 权限 |
| D5 | 受保护路径/穿越/符号链接 → denied | 权限、安全 |
| D6 | 审计校准 vs 所有者标签 → agreement 1、falsePass 0 | 可观测性 |
| D7 | max turns 发出 `max_turns` 与计数 | 循环 |
| D8 | 阈值压缩写入边界 + 保留 id | 上下文 |
| D9 | hook exit 2 阻断；exit 0 放行；其他继续 | Hook |
| D10 | 子 Agent 回传配对 + 并发上限 | 子 Agent |
| D11 | 并发 Main Agent 请求 → 409/排队 | 循环 |
| D12 | MCP 输出按上限截断 | 工具 |
| D13 | 无 bearer → 401；非 loopback Host 拒绝 | 安全 |

这些全部离线，每次变更都要跑。gate 的逐用例基线意味着任何行为变化都会被审查，包括改进。

### 6.2 实机（Provider，记录）

沿用现有 `benchmark/main-agent.ts`、`native-main-long-context.ts`、
`native-main-images.ts`、`benchmark/run.ts` 的模式：

| ID | 任务 | 通过标准 |
| --- | --- | --- |
| L1 | 总结只读文件 | artifact 存在且内容符合预期 |
| L2 | 两步链（笔记 → 简报） | 两个 artifact，依赖被遵守 |
| L3 | 三步管道；review 不得修改简报 | 简报 hash 不变 |
| L4 | 编码任务：编辑 + 跑测试 | 测试退出 0 |
| L5 | 缺失输入 → `no_artifact`，不挂起 | failure category 已记录 |
| L6 | 直接回答 → 零 Run | 预期 `direct` |
| L7 | 权限查询 → 调用 `get_authority` | 工具调用存在 |
| L8 | 计划提案 → 创建 Run，不执行 | runs > 0，无 artifact |
| L9 | 长记忆召回（LongMemEval 切片） | recall@k ≥ 下限 |
| L10 | 长上下文压缩保留种子事实 | 回答包含该事实 |
| L11 | 图片理解 | 预期答案 |
| L12 | 429/500/拒绝被分类，不崩溃 | 分类已记录 |

每次运行都按 AGENTS.md 规则 5 记录：完整命令、Provider、模型/强度、任务 id、数据集/版本、
切分/种子、评分参数、机器备注、结果文件、前后对比。没有这些块的数字只是轶事。

### 6.3 手工/UX

- GUI 与 CLI 的 cancel/deny/approve 都能关闭 `waiting_approval`。
- `/health` 报告 journal、队列、sidecar。
- 工具时间线、diff、上下文表、resume/rewind 可见。
- Onboarding、托盘、通知、签名构建。

### 6.4 防止自欺

- 对抗用例：文件里的提示注入；路径穿越；符号链接逃逸；非法 hook JSON；分类器不可用；
  工具执行中上下文溢出；MCP 输出被截断后重跑。
- 留出任务：约 20% 私有并轮换；不要针对头条集合调 Prompt。
- 同模型参照：同一组 Prompt 同时跑 Claude Code 与 clone-ai，两个结果都报告。
- 任何维度不得低于 80；加权分旁边必须报告最低维度。
- SDK 拥有的行为标为缺口，不要算成功能。

---

## 7. 风险与诚实

| 风险 | 为什么真实 | 如何发现 |
| --- | --- | --- |
| 把模型质量误当 harness 质量 | clone-ai 的端点可能更弱/更强 | 同模型参照；模型分单独报告 |
| 靠权重或清单等级刷分 | 清单可以没有行为就被满足 | 每级要可执行证据；gate 用例；留出任务 |
| 基线一直红 | 已有 4 个失败；迁移还会带来更多 | 阶段 0 验收；CI 必须跑 `npm test` |
| Hook/MCP 扩大攻击面 | 它们执行所有者代码与远程服务器 | 沙箱、信任位、逐次闸门、审计 |
| 压缩丢掉任务关键事实 | 摘要是有损的 | 种子针长上下文 eval；先确定性 |
| 桌面落后于 harness | 用户看到的是 UI | 阶段 7 e2e；截图；cancel/approve/resume 测试 |
| 两个循环漂移 | Main Agent 与 Worker 分叉 | 共享内核；行为漂移测试 |
| 专有内容污染 | 提取的源码有版权 | 只留在 `/tmp`；重写，不复制 |

---

## 8. 附录

### 8.1 提取方法

Claude Code 可执行文件是 Bun 单文件二进制。它的 `__BUN` Mach-O 段以 8 字节图长度开头，
后面是模块图：源码内容、名称、固定 52 字节记录的模块表、源哈希、可选记录、`Offsets` 结构、
以及尾部 `\n---- Bun! ----\n`。提取器读取
`Offsets { byte_count, modules_ptr, entry_point_id, compile_exec_argv_ptr, flags }`，
遍历模块表，把每个模块的 `contents`（Latin-1 或 UTF-16）写成文件。Claude Desktop 用
`@electron/asar` 解包。命令不在仓库内运行；提取树留在仓库外，不提交。

### 8.2 证据索引

| 结论 | 证据 |
| --- | --- |
| 22 个内建工具 | `chunk-eat7r0am.js` 的 `BUILTIN_TOOL_NAMES=[...]` |
| 六种权限模式 | `chunk-3z9szvkj.js` 的 `["default","acceptEdits","plan","auto","bypassPermissions","dontAsk"]` |
| 流式工具调度 | `chunk-8ntpzya9.js` 的 `isConcurrencySafe` / `canExecuteTool` |
| 重试/退避 | `Kbr=10`、`Vbr=300`、`FZe=15`、`HF(base=500, cap=32000, jitter=0.25)` |
| 压缩数学 | `chunk-vrwkjdrd.js` 的 `effectiveWindow`、`13000`、`0.2`、`3000` |
| 压缩边界 | `compact_boundary`、`preservedMessages.uuids` |
| 微压缩 | 保留 12 次工具调用、`clear_tool_uses_20250919` |
| CLAUDE.md 导入深度 | `d4r=5`、4 MiB 上限 |
| Hook 事件 | `chunk-83mgbqxd.js` / `chunk-djayrv3w.js` 的 33 个事件名 |
| MCP 命名 | `mcp__<server>__<tool>` |
| 桌面控制协议 | `--output-format stream-json`、`can_use_tool`、`control_response` |
| 桌面权限阶梯 | `{plan:0,default:1,dontAsk:1,acceptEdits:2,auto:3,bypassPermissions:4}` |
| 桌面会话/rewind | `claude-code-sessions`、`enableFileCheckpointing`、`rewindMarks` |
| clone-ai 缺口 | 审计报告、`src/main-agent/native-runtime.ts`、`src/workers/*`、`src/companion-server.ts` |

### 8.3 基线测试记录

```text
command: npm test
result: 585 tests, 578 pass, 4 fail, 3 skipped
failures:
  - test/companion-control-plane.test.ts:213 (unknown run reject/cancel expects 404, got 500)
  - test/local-preferences.test.ts:29 (unknown execution provider "pi")
  - test/provider-registry.test.ts:46 (unknown execution provider "pi")
  - test/worker-defaults.test.ts:27 (default provider expected "pi", got "native")
command: npm run gate -> PASS
command: npm run typecheck -> exit 0
```

4 个失败曾是工作区迁移遗留，不是绿色基线。阶段 0 已修复它们；阶段 0/1 之后的记录是：

```text
command: npm test
result: 609 tests, 606 pass, 0 fail, 3 skipped
command: npm run gate -> PASS
command: npm run typecheck -> exit 0
```
