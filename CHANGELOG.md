# Changelog

All notable changes to clone-ai are listed here. Dates are UTC+8.

clone-ai 的可见变化记在这里。日期为北京时间。

## Unreleased

### Every Kernel denial is an AI appeal; the owner is the last authority

A plan step the deterministic policy engine refuses no longer ends the run. The Runtime asks a bounded model judge (1,024 output tokens, minimal effort, 20 s) for one word: `ALLOW` records a `model_judge` approval and executes the step with a per-step override of the protected-path, `.git` and `.rsi` gates; `ASK`, an unparsable answer, an unreachable endpoint or no judge records an `approval.requested` with the judge's reason, waits for you, notifies the computer, and turns the sidebar row red; `DENY` fails with the judge's reason. Your approval of an appealed step executes with the same override. The approval card now lists the step's scopes and the Kernel/judge reason. This includes protected locations and credentials, as you chose. The agent-exec MCP server keeps its own command allowlist and Seatbelt profile. `test/policy-judge.test.ts` 3/3; `npm test` 1108/1108, typecheck 0, gate PASS.

### Kernel 的每次拒绝都成为 AI 上诉；所有者是最后权威

被确定性 Policy 引擎拒绝的计划步骤不再直接结束 Run。Runtime 询问一个有界模型裁判（输出上限 1024 token、最低推理强度、20 秒），只要求一个词：`ALLOW` 记录 `model_judge` 审批，并带仅限该步骤的受保护路径/`.git`/`.rsi` 覆盖执行；`ASK`、无法解析的回答、端点不可达或没有裁判时记录带裁判理由的 `approval.requested`，等待你决定，发电脑通知，并把侧栏行变红；`DENY` 以裁判理由失败。你批准被上诉的步骤后，也带同一覆盖执行。审批卡现在列出步骤的 Scope 与 Kernel/裁判理由。按你的选择，这包括受保护位置与凭据。agent-exec MCP 服务器仍保留自己的命令白名单与 Seatbelt profile。`test/policy-judge.test.ts` 3/3；`npm test` 1108/1108，typecheck 0，gate PASS。

### The UI uses the macOS system typeface

The app's body and display text now use the macOS system face (SF Pro, with PingFang SC for Chinese) instead of Avenir Next/Inter, and monospace uses SF Mono. Font weights are normalized to 400/500/600/700, heading tracking is relaxed to at most -.025em, and the 14px/1.5 body size is unchanged — removing the synthesized weights and the cramped Chinese display type. `npm test` 1104/1104, typecheck 0, gate PASS.

### 界面改用 macOS 系统字体

应用的正文与展示文字现在使用 macOS 系统字体（SF Pro，中文回退 PingFang SC），不再用 Avenir Next/Inter；等宽使用 SF Mono。字重归一化为 400/500/600/700，标题字距放宽到不紧于 -.025em，正文保持 14px/1.5——去掉了合成字重与被挤紧的中文展示文字。`npm test` 1104/1104，typecheck 0，gate PASS。

### A read-only request stays read-only

A request that explicitly says 只读/仅读取/不要修改任何文件 is no longer sent through the LLM planner, whose contract requires a required artifact for every subagent. `runQuery` now uses the deterministic read-only plan — also when the Main Agent's brief is read-only — so the worker reads the file and answers instead of failing with "Subagent draft did not satisfy its artifact contract." The LLM planner remains for delivery requests; two planner-failure tests now use delivery queries to keep their intent. `npm test` 1103/1103, typecheck 0, gate PASS.

明确写着 只读/仅读取/不要修改任何文件 的请求不再交给 LLM Planner——它的合同要求每个子代理都有必需产物。`runQuery` 现在改用确定性的只读计划（Main Agent 简报为只读时也一样），Worker 读取文件并回答，而不是以 "Subagent draft did not satisfy its artifact contract." 失败。LLM Planner 仍负责交付类请求；两个 Planner 失败测试改用交付类查询以保留原意。`npm test` 1103/1103，typecheck 0，gate PASS。

### Child agents run automatically; the desktop notifies you when a decision is truly needed

The 子 Agent 边界 card no longer says 默认禁止. The only child executor is the in-process native worker, which already ran automatically; the label was left over from the removed black-box CLI path. The card now says it runs at the step's risk and stops only when a decision is genuinely yours. When the Kernel does stop — `waiting_approval` or `waiting_review` — the daemon posts one macOS notification with the task title and the step/reason. The text is passed as `argv` to `osascript`, never interpolated into AppleScript; the Runtime notifies at most once per run/step/kind, a failing notifier cannot change the run, and the approval or review still happens in the app. macOS may require allowing notifications for Script Editor/osascript, and a notification has no click action. `test/owner-notifier.test.ts` 3/3; `npm test` 1103/1103, typecheck 0, gate PASS.

### 子 Agent 自动执行；真正需要决定时桌面通知

「子 Agent 边界」卡片不再显示"默认禁止"。唯一的子执行器是进程内的原生 Worker，它本来就自动执行；该标签是被移除的黑盒 CLI 路径的遗留。卡片现在写着按步骤风险自动执行，只有决定确实属于所有者时才停下。当 Kernel 真的停下——`waiting_approval` 或 `waiting_review`——守护进程发一条 macOS 通知，带任务标题与步骤/原因。文本以 `argv` 传给 `osascript`，绝不拼进 AppleScript；Runtime 每个 Run/步骤/类型最多通知一次，失败的通知器不能改变 Run，审批/复核仍在 App 内完成。macOS 可能要求允许 Script Editor/osascript 的通知，通知没有点击动作。`test/owner-notifier.test.ts` 3/3；`npm test` 1103/1103，typecheck 0，gate PASS。

### Owner-confirmed MCP install from the tools settings page

The tools tab can now install a stdio MCP server from an npm package. "探测工具" spawns `npx --yes <package> <args>`, performs the MCP handshake and lists the tools the package exposes; each tool starts at `external` (always refused) and the owner assigns read/write/network, with one-click presets. "安装" asks for confirmation, re-probes, refuses when the package exposes a tool the request did not declare, and writes one enabled entry into `mcp.json` atomically (mode 0600) without disturbing other servers or unknown fields. A per-server "移除" button deletes one entry. Every failure happens before the write, and the agent still cannot install: `~/.clone` stays a protected root and the exec sandbox re-denies it. Routes: `POST /api/tools/probe`, `POST /api/tools/install`, `DELETE /api/tools/mcp/:id`. Focused tests: `test/mcp-installer.test.ts` 8/8, `test/tools-install-api.test.ts` 6/6. `npm test` 1103/1103, gate PASS.

### 工具与技能页支持所有者确认的 MCP 安装

工具页现在可以从 npm 包安装一个 stdio MCP 服务器。「探测工具」用 `npx --yes <package> <args>` 启动包，完成 MCP 握手并列出它暴露的工具；每个工具从 `external`（拒绝）开始，所有者为它指定读取/写入/网络，也可一键预设。「安装」会先确认、重新探测，在包暴露了请求未声明的工具时拒绝，并把一条启用条目原子写入 `mcp.json`（权限 0600），不影响其他服务器与未知字段。每个服务器有「移除」按钮，删除一条条目。所有失败都发生在写入之前，Agent 仍然装不了：`~/.clone` 仍是受保护根，exec 沙箱也会重新拒绝它。路由：`POST /api/tools/probe`、`POST /api/tools/install`、`DELETE /api/tools/mcp/:id`。定向测试：`test/mcp-installer.test.ts` 8/8、`test/tools-install-api.test.ts` 6/6。`npm test` 1103/1103，gate PASS。

### 全部放行 is the default; scopes and external confirmations stop

The permissions ladder is now 批准 / 自动执行 / 全部放行, and 全部放行 (`allow_all`) is the default for files, shell and network. At that level a reversible write no longer needs a declared scope, reads are machine-wide, and an external or irreversible step whose declared scopes are all at 全部放行 no longer asks; the Runtime records a standing-policy approval before dispatch, so `approval-before-external-execution` still holds and the audit names the authority. Protected locations (the whole clone home), unenforced domains, `.git`/`.rsi` writes and the agent-exec command allowlist remain hard boundaries. A covering policy with a lower ceiling still narrows a scope, and any narrowing write policy withdraws the whole-domain grant so an unscoped step fails instead of walking around it. `observe`/`prepare` stay valid only for legacy configs and the corrupt-file fail-closed value; the UI does not offer them. The gate policy suite is 30 cases at 100% agreement with 0 unsafe allows. `npm test` 1083/1083, typecheck 0, gate PASS.

### 全部放行成为默认；免 Scope、免外部确认

权限档位现在是批准 / 自动执行 / 全部放行，且「全部放行」（`allow_all`）是文件、Shell 与网络的默认值。该档位下可逆写入不再需要声明的 Scope，读取覆盖整机，声明的 Scope 全在全部放行的外部/不可逆步骤不再询问；Runtime 在派发前记录一条策略审批，因此 `approval-before-external-execution` 仍成立，审计能指名授权来源。受保护位置（整个 clone home）、未实现强制的域、`.git`/`.rsi` 写入与 agent-exec 命令白名单仍是硬边界。覆盖策略的低上限仍会收紧 Scope；只要存在收紧写策略，全域授权就被撤回，未声明目标的步骤会失败，而不是绕过限制。`observe`/`prepare` 只对旧配置和损坏文件的 fail-closed 值有效，UI 不再提供。门禁策略套件 30 个用例，一致率 100%，0 个不安全放行。`npm test` 1083/1083，typecheck 0，gate PASS。

### The audit reads tool calls in words, with JSON behind a toggle

The audit's Main Agent turn log and worker tool list now render each tool input as a sentence, labeled fields and lists, with the raw JSON behind a "原始参数" toggle. Known tools get a headline (`dispatch_task` shows its objective; `daily_workspace_digest` shows path, date, diff switch and limit); unknown tools get a labeled generic view. A record cut at the old 2,000-character cap is repaired by closing the open string and brackets and is marked as truncated; the cap is now 8,000. Focused tests: `test/tool-format.test.ts` 6/6, `test/ui-structure.test.ts` 42/42. The full suite currently has 3 failures from a concurrent policy-default change, not from this UI change.

### 审计把工具调用读成人话，JSON 留在一键之后

审计的主 Agent 回合日志与 Worker 工具列表现在把每条工具输入渲染成一句话、带标签字段与列表，原始 JSON 放在"原始参数"开关之后。已知工具有专属标题（`dispatch_task` 显示目标，`daily_workspace_digest` 显示路径、日期、是否含 diff 与上限）；未知工具得到带标签的通用视图。被旧 2,000 字符上限截断的记录会补全未闭合的字符串与括号，并标注已截断；上限现在是 8,000。定向测试：`test/tool-format.test.ts` 6/6、`test/ui-structure.test.ts` 42/42。全量套件当前有 3 个失败，来自并发的策略默认值变更，不是这次 UI 变更。

### A read-only review of uncommitted files is not an external action

The fallback planner no longer treats `提交` as an external-action cue when it is part of a state phrase ("未提交/已提交的文件") or a quoted error; under an explicit read-only marker only a named submission target (`提交 PR`, 表单, 申请, 报告) counts. A read-only review of 9 uncommitted files therefore plans as one read-only step instead of being rejected with "外部执行 Agent 已关闭". A genuine external request with no connector now says the governed connector is not implemented and suggests a local alternative. The Agent settings page computes its "all enabled" badge from the four worker profiles and states that external actions are not among them and have no switch. `npm test` 1073/1073, typecheck 0, gate PASS.

### 只读审查"未提交的文件"不再被当成外部动作

回退规划器不再把状态短语（"未提交/已提交的文件"）或引用报错里的 `提交` 当作外部动作线索；在显式只读标记下，只有点名了提交目标（`提交 PR`、表单、申请、报告）才算数。因此"只读审查 9 个未提交文件"会规划成一步只读，而不是被"外部执行 Agent 已关闭"拒绝。没有连接器时，真实的外部请求会说明受治理的连接器尚未实现，并给出本地替代。Agent 设置页的"全部启用"徽章由四个 Worker profile 计算，并说明外部动作不在其中、没有开关。`npm test` 1073/1073，typecheck 0，gate PASS。

### Automatic execution is the default and the model judges its scope

Files, shell and network now default to 自动执行 (`act_auto`) when `policies.json` does not name them, and `act_auto` no longer requires a covering standing policy: the step's declared scope is the judgment, so the owner no longer authors a policy per resource. The hard boundaries are unchanged — protected locations, unscoped writes, unenforced domains, and external/irreversible steps still stop; an absent `policies.json` uses the default, and a corrupt one (invalid JSON, an invalid level, or a non-array `policies`) fails closed to `observe` instead of silently arming every domain. The whole clone home is now one protected location (endpoint key, provider keys, `mcp.json` credentials, memory, conversations, journal, traces), with the Kernel's isolated sandbox as the only exception. Standing policies stay in Settings under 高级：常设策略（可选） as an optional narrowing; when several cover one scope, the lowest ceiling wins, so an explicit restriction is never defeated by a broader grant. The gate policy suite is 24 cases at 100% agreement with 0 unsafe allows (before: 78% agreement, 5 over-blocks). `npm test` 1073/1073, typecheck 0, gate PASS.

### 自动执行成为默认，由模型判断 Scope

`policies.json` 没有点名某个域时，文件、Shell 与网络现在默认「自动执行」（`act_auto`），且 `act_auto` 不再要求有覆盖的常设策略：步骤声明的 Scope 就是判断，所有者不必再逐资源写策略。硬边界不变——受保护位置、无 Scope 写入、未实现强制的域、外部与不可逆步骤仍会停下；`policies.json` 不存在时使用默认值，损坏时（非法 JSON、非法档位，或 `policies` 不是数组）fail closed 到只观察，而不是悄悄把每个域都设成自动。整个 clone home 现在是一个受保护位置（端点密钥、Provider 密钥、`mcp.json` 凭据、记忆、对话、Journal、轨迹），唯一例外是 Kernel 的隔离沙箱。常设策略保留在设置的「高级：常设策略（可选）」里，作为进一步收紧的手段；同一 Scope 被多条策略覆盖时，最低上限生效，显式限制不会被更宽的授权推翻。门禁策略套件 24 个用例，一致率 100%，0 个不安全放行（变更前 78%、5 个误拦截）。`npm test` 1073/1073，typecheck 0，gate PASS。

### A missing deliverable asks a judge, then the owner

A completed subagent that supplies observation evidence but not every promised artifact no longer ends as a dead failure. A bounded artifact judge — one short prompt to the configured Main Agent endpoint, 1,024 output tokens with minimal reasoning, a 20 s timeout — decides whether the evidence or the completion summary answers the work order; ACCEPT records the missing artifact and continues, while REVIEW, an unparsable answer or an unreachable endpoint settles the run as waiting for the owner. The main conversation's subagent row then shows the summary, the missing criterion, "继续（接受观察证据）" and "判为失败"; the task record keeps the same review. A worker with no evidence at all still fails, and protected or unscoped writes remain the policy engine's decision. `npm test` 1062/1062, typecheck 0, gate PASS.

### 缺失的交付物先问裁判，再问所有者

完成的子 Agent 给出了观察证据、但没有满足每一项承诺产物时，不再以死掉的失败结束。一个有界的产物裁判——向已配置的主 Agent 端点发送一段短提示，输出上限 1024 token（最低推理强度）、超时 20 秒——判断证据或完成摘要是否回答了工作单；ACCEPT 记录缺失产物并继续，REVIEW、无法解析的回答或端点不可达则把 Run 结算为等待所有者。主对话的子 Agent 行随即显示摘要、缺失标准、"继续（接受观察证据）"与"判为失败"；任务记录保留同一份复核。完全没有证据的 Worker 仍然失败；受保护路径与无 Scope 写入仍由权限引擎决定。`npm test` 1062/1062，typecheck 0，gate PASS。

### The memory page is a flat, search-first list

The Memory page now opens on one flat list ordered by last use, with the search box and a row of type chips; the five collapsible type groups are gone. The stored type is unchanged and still drives the context budget, the preference recall boost, same-type conflict comparison and the procedure evidence gate — it now appears as an inline chip and a filter instead of a browsing tree. A new memory defaults to 事实 instead of 偏好. `npm test` 1055/1055, typecheck 0, gate PASS.

### 记忆页是搜索优先的平铺列表

记忆页现在以一份按最近使用排序的平铺列表开场，配搜索框与一行类型 chip；五个可折叠的类型分组被移除。存储的类型不变，仍驱动上下文预算、偏好召回加分、同类冲突比较与流程证据闸门——它现在以行内 chip 和筛选器的形式出现，而不是浏览树。新建记忆默认"事实"而不是"偏好"。`npm test` 1055/1055，typecheck 0，gate PASS。

### A memory the owner wrote is always standing context

Active, non-secret memories the owner authored are now pushed into every Main Agent turn as a bounded "Owner-authored standing memories" section, independent of whether the request shares a word with them. Previously the push only recalled by token overlap, so a note like "我是jiaoxiangyu,我的工作内容以此为展开" was silently absent from a summary request such as "继续总结". The section carries at most five summaries (300 characters each), never includes `secret` entries, joins the turn's `memoryIds`, and is journaled in `memory.recalled` with `standing: true` and `standingCount`. The relevance-budgeted list and synthesized recall are unchanged. `npm test` 1053/1053, typecheck 0, gate PASS.

### 所有者手写的记忆是常驻上下文

所有者手写的、活跃且非机密的记忆，现在会以有界的“Owner-authored standing memories”段进入每个主 Agent 回合，不依赖请求是否与它共享词。此前推送只按词重叠召回，因此像“我是jiaoxiangyu,我的工作内容以此为展开”这样的便签，在“继续总结”这类请求里会悄悄缺席。该段最多五条摘要（每条 300 字），绝不包含 `secret` 条目，其 id 加入本回合的 `memoryIds`，并以 `standing: true` 与 `standingCount` 记入 `memory.recalled`。按相关性预算的列表与合成召回不变。`npm test` 1053/1053，typecheck 0，gate PASS。

### A failed subagent explains itself instead of jumping to a task record

A subagent row in the main conversation now expands in place. The panel shows the worker's recorded summary, up to five evidence rows for that work order, and a deterministic "要修改什么" hint: an unsatisfied artifact contract says to make the request read-only or name the exact file, an interrupted run says to inspect possible side effects, and a generic failure points at the evidence and the task record. Clicking the row no longer navigates away; the full execution trace stays behind an explicit 「打开任务记录查看完整轨迹」 link, and the agent-list header counts failed subagents as 需要处理. `npm test` 1052/1052, typecheck 0, gate PASS.

### 失败的子 Agent 原地解释自己，而不是跳转到任务记录

主对话里的子 Agent 行现在原地展开。面板显示 Worker 记录的摘要、该工作单最多五条证据，以及确定性的「要修改什么」提示：artifact 契约未满足时提示改成只读或点名文件；执行被中断时提示先检查可能的副作用；一般失败指向证据与任务记录。点击整行不再导航离开；完整执行轨迹留在显式的「打开任务记录查看完整轨迹」链接后面，Agent 列表标题把失败项计为"需要处理"。`npm test` 1052/1052，typecheck 0，gate PASS。

### The composer's model and effort are saved with the conversation

The model and effort a conversation keeps are now stored in `<clone home>/turn-choices.json` (one entry per conversation id) and restored when the conversation is opened, instead of living only in the window's local storage. The window loads the daemon at an ephemeral `127.0.0.1:<port>` origin; local storage is scoped to that origin, so every daemon restart silently reset the pickers to the defaults. `GET`/`PUT /api/main-agent/turn-choice` read and write the record; the dashboard carries each conversation's choice; a stream or query turn also saves the choice it ran with. Empty model and effort remove the entry, so "follow Settings" stays an absence. Local storage remains only as a cache for a new request that has no conversation id yet. The file is owner-only (0600), atomic, capped at 500 entries. `npm test` 1052/1052, typecheck 0, gate PASS.

### 输入框的模型与强度按对话保存

一个对话保留的模型与强度现在存放在 `<clone home>/turn-choices.json`（每个对话 id 一条），打开该对话时恢复，而不是只存在窗口的 local storage 里。窗口从 Daemon 的临时 `127.0.0.1:<port>` origin 加载，而 local storage 按 origin 隔离，因此每次 Daemon 重启都会把选择器悄悄重置为默认值。`GET`/`PUT /api/main-agent/turn-choice` 读写这条记录；Dashboard 携带每个对话的选择；stream 或 query 回合也会保存它实际使用的选择。模型与强度都为空时删除条目，因此"跟随设置"保持为缺失。local storage 只作为尚无对话 id 的新请求的缓存。文件仅所有者可读（0600）、原子写、上限 500 条。`npm test` 1052/1052，typecheck 0，gate PASS。

### A scoped write under observe asks the owner once; auto stays automatic

A `reversible_write` step that declares a `files` write scope no longer fails outright while the files domain is observe-only. The policy returns `approval_required`, the run enters `waiting_approval`, and the existing approval card lets the owner allow this exact step once or deny it; the approval is keyed to the run and step and leaves the domain observe-only for everything else. The automatic path is unchanged: set the files domain to `自动执行` (act_auto) with a covering standing policy and the worker's scoped writes proceed without a per-step confirmation. Protected locations, unscoped writes, shell/network domains and irreversible steps keep their hard gates. The regression-gate policy baseline changes one intended case (`files-write-observe-denied` becomes `files-write-observe-asks-approval` plus `files-write-observe-approved`). `npm test` 1047/1047, typecheck 0, gate PASS.

### observe 下带 Scope 的写入向所有者请求一次确认，自动模式不变

声明了 `files` 写 Scope 的 `reversible_write` 步骤，在 files 域为只观察时不再直接失败。Policy 返回 `approval_required`，Run 进入 `waiting_approval`，现有审批卡让所有者允许这一步一次或拒绝；批准绑定 Run 与 Step，之后该域仍是只观察。自动路径不变：把 files 域设为“自动执行”（act_auto）并有覆盖的常设策略，Worker 在 Scope 内的写入无需逐步骤确认。受保护位置、无 Scope 写入、shell/network 域与不可逆步骤保持硬闸门。回归门禁的策略基线有一个有意的变更（`files-write-observe-denied` 变为 `files-write-observe-asks-approval`，并新增 `files-write-observe-approved`）。`npm test` 1047/1047，typecheck 0，gate PASS。

### The daemon records file operations, and generated files are filtered out

While the resident daemon runs, each learned folder is watched through recursive `fs.watch` (FSEvents on macOS). A created, modified or removed file becomes one dated operation record in `<clone home>/workspace-history/days/<key>/<day>.events.jsonl`, deduplicated per path for 30 seconds and capped at 5,000 records / 2 MB per day; the digest merges these operations with content diffs and marks paths that changed with no net content difference. The same noise filter now runs in the watcher, the content capture and the digest's mtime fallback: generated directory names (build, dist, target, caches, `node_modules`, …), generated file patterns (`.DS_Store`, `*.log`, `*.tmp`, swap/backup files, `*.tsbuildinfo`, source maps, …) and the repository's own `.gitignore` (untracked ignored paths, read with `--no-optional-locks`/`--no-fsmonitor`). The skipped count is reported per folder instead of silently dropping files. A new folder is watched as soon as the turn ledger learns it. Mac sleep/off still loses events; the next capture's mtime backfill remains. The window being closed does not stop the daemon — it is already a launchd LaunchAgent. `npm test` 1046/1046, typecheck 0, gate PASS.

### 常驻 Daemon 记录文件操作，生成文件被过滤

常驻 Daemon 运行期间，每个已学会文件夹通过递归 `fs.watch`（macOS 上即 FSEvents）监听。创建、修改或删除的文件在 `<clone home>/workspace-history/days/<key>/<day>.events.jsonl` 中变成一条带时间戳的操作记录；按路径 30 秒去重，每天上限 5,000 条 / 2 MB；摘要把这些操作与内容 diff 合并，并标出"改过但没有净内容差异"的路径。同一套噪声过滤器现在运行在监听器、内容采集和摘要的 mtime 回退中：生成目录名（build、dist、target、各类缓存、`node_modules` 等）、生成文件模式（`.DS_Store`、`*.log`、`*.tmp`、交换/备份文件、`*.tsbuildinfo`、source map 等）以及仓库自己的 `.gitignore`（未跟踪且被忽略的路径，用 `--no-optional-locks`/`--no-fsmonitor` 读取）。每个文件夹会报告被跳过的数量，而不是静默丢弃。新文件夹在回合台账学到它之后立即开始监听。Mac 休眠/关机仍会丢事件；下一次采集的 mtime 回填继续兜底。窗口关闭不会停掉 Daemon——它本来就是 launchd LaunchAgent。`npm test` 1046/1046，typecheck 0，gate PASS。

### The settings page lists MCP tools and skills, and each server can be loaded

The desktop settings gain a **工具与技能** tab: every MCP server in the clone home's `mcp.json` is listed with its declared tools and risks, every skill under `<clone home>/skills` and `<workspace>/.clone/skills` is listed read-only, and each server has a 加载/停用 button that rewrites only its `enabled` field for the next worker run. The catalog never returns `env`, `command`, `args` or `url`; the toggle is atomic and 0600, and preserves every other field. `GET /api/tools` and `POST /api/tools/mcp/:id/enabled` back the tab. `npm test` 1038/1038, typecheck 0, gate PASS.

桌面设置新增 **工具与技能** 分区：列出 clone home 的 `mcp.json` 中每个 MCP 服务器及其已声明工具与风险；只读列出 `<clone home>/skills` 与 `<workspace>/.clone/skills` 下的技能；每个服务器都有 加载/停用 按钮，只改写它的 `enabled` 字段，供下一次 Worker 运行使用。目录从不返回 `env`、`command`、`args` 或 `url`；切换是原子的、权限 0600，并保留其他所有字段。`GET /api/tools` 与 `POST /api/tools/mcp/:id/enabled` 支撑该分区。`npm test` 1038/1038，typecheck 0，gate PASS。

### A day of work reads as a content-level diff, and the twin's own records join it

The Main Agent gains `daily_workspace_digest`: it reads one local day as the files that changed in the learned folders (with unified diffs for text files that have a stored baseline), each repository's commits and current status, and the day's turns, runs, verifications and memory-document writes. The daemon keeps a bounded daily ledger in `<clone home>/workspace-history`: a per-folder state map, a per-day change file, and content-addressed text blobs, captured incrementally at most every 30 minutes and never inside a turn. Caps: 5 folders, 20,000 files per folder, 512 KB per text blob, 512 MB of blobs, 5,000 change rows per folder per day, 90-day retention. A day without ledger coverage falls back to the existing mtime read and is labelled as having no content baseline; binaries and larger files are listed without a diff. Credential-shaped files are tracked by identity but never read; a protected root inside a learned folder is skipped. The ledger directory is itself protected from workers. `MAIN_AGENT_CHARTER_VERSION` moves to 9. `npm test` 1038/1038, typecheck 0, gate PASS.

主 Agent 新增 `daily_workspace_digest`：把一个本地日历日读成已学会文件夹中的文件变更（有存储基线的文本文件给出 unified diff）、每个仓库的提交与当前状态，以及当天的回合、Run、验证与记忆文档写入。守护进程在 `<clone home>/workspace-history` 维护有界每日台账：每文件夹状态表、每天一份变更文件、内容寻址的文本块；最多每 30 分钟增量采集一次，绝不在回合内采集。上限：5 个文件夹、每文件夹 2 万文件、每个文本块 512 KB、块总量 512 MB、每文件夹每天 5,000 条变更、保留 90 天。没有台账覆盖的一天回退到现有 mtime 读取，并明确标注没有内容基线；二进制与更大的文件只列出、不给 diff。凭据形态的文件只跟踪身份、绝不读取；已学会文件夹内部的受保护根会被跳过。台账目录本身也受保护，Worker 无法读取。`MAIN_AGENT_CHARTER_VERSION` 升到 9。`npm test` 1038/1038，typecheck 0，gate PASS。

### The Main Agent writes the worker brief

The Main Agent now writes each worker's complete task brief (`workerBrief`) on a plan step or subagent work order; the runtime appends only the execution contract (tool names, the gate, the stop condition) and the facts it resolves after planning (workspace, objective, required inputs, evidence contract, memory packet, refused scopes, acceptance criteria). `dispatch_task` and `propose_work_plan` expose the field, the runtime places it on the primary execution order for both planner paths, and a write target named only in the brief is scoped. Without a brief the previous template is unchanged. The Main Agent charter is reorganised around the reply / `dispatch_task` / `propose_work_plan` choice and the brief contract (version 8; the daily-digest guidance added in parallel takes the current tree to 9). `npm test` 1025/1025, typecheck 0, gate PASS.

主 Agent 现在为计划步骤或子 Agent 工作单编写每个 Worker 的完整任务简报（`workerBrief`）；运行时只追加执行契约（工具名、闸门、停止条件）与规划之后才解析出的事实（工作区、目标、必需输入、证据合同、记忆包、被拒绝的 Scope、验收标准）。`dispatch_task` 与 `propose_work_plan` 暴露该字段，两条 planner 路径都会把它放到主执行工作单，只写在简报里的写入目标也会被纳入 Scope。没有简报时沿用原模板。主 Agent charter 围绕“直接回答 / `dispatch_task` / `propose_work_plan`”的选择与简报契约重新组织（版本 8；并行加入的每日摘要指引使当前树为 9）。`npm test` 1025/1025，typecheck 0，gate PASS。

### The worker can run allowlisted tests inside a sandbox

The native worker gains `agent-exec`: `list_commands` and `run_command` run only the commands the owner lists in `agent-exec.json` — the installer seeds `test`, `typecheck`, `lint`, `check`, `gate` and `build` scripts, or pytest/go/cargo/mvn/gradle when detected — without a shell or model-supplied argv. On macOS every command runs under a Seatbelt profile: writes stay in the workspace, temp and package caches; network is off; protected locations and the workspace `.git` are read-only. The default timeout is 240 s (600 max), output keeps a 50 KB tail per stream, and the runner refuses unsandboxed execution unless the owner explicitly opts out. `run_command` is a write-risk tool for reversible-write steps. New docs: `docs/usage/agent-exec-mcp.md` and its Chinese pair. `npm test` 991/991, typecheck 0, gate PASS.

原生 Worker 新增 `agent-exec`：`list_commands` 与 `run_command` 只运行所有者在 `agent-exec.json` 里列出的命令——安装器播种 `test`、`typecheck`、`lint`、`check`、`gate` 与 `build` 脚本，或检测到的 pytest/go/cargo/mvn/gradle——不经过 shell，也不接收模型提供的 argv。在 macOS 上，每条命令都在 Seatbelt profile 下运行：写入留在工作区、临时目录与包缓存；网络关闭；受保护位置与工作区 `.git` 只读。默认超时 240 秒（最多 600 秒），每个流保留 50KB 尾部；除非所有者显式放弃，执行器拒绝无沙箱运行。`run_command` 是提供给可逆写入步骤的 write 风险工具。新文档：`docs/usage/agent-exec-mcp.md` 及其中文版。`npm test` 991/991，typecheck 0，gate PASS。

### Workers gain a read-only agent-tools MCP server

The native worker can now search a repository (`search_text`, `find_files`), inspect `git_status`/`git_diff`/`git_log`, read `current_time`, and fetch one HTTP(S) URL (`fetch_url`) through a bundled `agent-tools` MCP server installed with `scripts/install-agent-tools.mjs`. Every tool is opt-in through `mcp.json` and carries a declared risk: `fetch_url` is `network` and is offered only to a step with a network scope; no write or shell tool is declared. The server resolves paths before walking, skips protected roots and symlinked directories, disables repository-configured git diff helpers and fsmonitor, refuses private/loopback fetch targets and caps results. `browser-mcp.ts` now shares its `mcp.json` merge helpers with the new installer. New docs: `docs/usage/agent-tools-mcp.md` and its Chinese pair. `npm test` 974/974, typecheck 0, gate PASS.

原生 Worker 现在可以通过随 clone-ai 发布的 `agent-tools` MCP 服务器检索仓库（`search_text`、`find_files`）、查看 `git_status`/`git_diff`/`git_log`、读取 `current_time`，并抓取一个 HTTP(S) URL（`fetch_url`）；用 `scripts/install-agent-tools.mjs` 安装。每个工具都通过 `mcp.json` 选择启用并声明风险：`fetch_url` 是 `network`，只提供给带网络 Scope 的步骤；没有声明写工具或 shell 工具。服务器在遍历前解析路径、跳过受保护根与符号链接目录、关闭仓库配置的 Git diff 助手与 fsmonitor、拒绝私有/回环抓取目标并限制结果。`browser-mcp.ts` 现在与新安装器共用 `mcp.json` 合并函数。新文档：`docs/usage/agent-tools-mcp.md` 及其中文版。`npm test` 974/974，typecheck 0，gate PASS。

### The conversation starts sooner, and the effort picker offers more levels

Three or more failed follow-ups collapse into one 40 px summary row above the conversation (count + newest failure, expandable in place); a single failure keeps its card, and non-failure opportunities stay visible. The conversation now begins 155 px earlier at 1468×1080. The reply prose is capped at a 620 px measure shared with the request bubble, the request bubble loses its "你" overline and sits at 14 px / 1.7, the turn's author, status and time become one left-side byline instead of a status stranded at the right edge, and the composer's model and effort pickers become 25 px pills. The effort picker offers the known gateway vocabulary in two groups — levels the model declares, then other known levels the provider may map — with Chinese labels plus the exact provider spelling and a "Provider 可能映射" note when a mapped level is selected. An undeclared level is saved as chosen instead of silently cleared; failed cards drop their repeated source prefix, turn a raw ISO stamp into local time, and drop a trailing sentence only when it exactly repeats the title. No server, ledger or provider contract changed.

三条及以上的失败跟进收成对话上方 40px 的摘要行（条数 + 最新失败，原地展开）；单条失败保留卡片，非失败机会始终可见。1468×1080 下对话因此提前 155px 开始。正文行宽限制在 620px，与请求气泡共用同一把尺；请求气泡去掉“你”的眉线并排到 14px / 1.7；回合的作者、状态与时间在左侧排成一条署名，而不是把状态孤零零挂在右缘；输入框的模型与强度选择器变成 25px 药丸。强度选择器按两组提供网关已知词汇——模型声明的档位在前，其余 Provider 可能映射的已知档位在后——中文含义加真实 Provider 写法，选中映射档位时显示“Provider 可能映射”。未声明档位按选择原样保存，不再被悄悄清空；失败卡去掉重复的来源前缀，把原始 ISO 时间换成本地时间，并且只有在结尾句与标题完全相同时才删除复述。服务端、台账与 Provider 契约均未改动。

### A verification failure names its cause once

A failed verification now says whether a promised path is missing, a directory, unreadable, or outside the roots this step may verify; the summary carries a single "Verification failed." prefix. The existing unscoped-write expectation was updated to the outside-roots message.

验证失败现在说明被承诺的路径是缺失、目录、不可读，还是在步骤可验证的根之外；摘要只带一个 "Verification failed." 前缀。原有的“无 Scope 写入”断言已更新为根外文案。

### A provider's blocked or abnormal stop is a failure

A response that ends with `content_filter`, a safety stop or another defined finish reason outside the normal completion set is no longer stored as a completed answer. The turn fails with the finish reason, and the owner sees a Chinese summary ("提供方拦截或中止了这次回答") and next step. `length`/`max_tokens` keep the truncation failure, and a normal `stop` still completes.

以 `content_filter`、安全停止或其它已定义、但不在正常完成集合里的 finish reason 结束的回答，不再被记成完成。回合以该 finish reason 失败，所有者看到中文摘要（“提供方拦截或中止了这次回答”）与下一步。`length`/`max_tokens` 保留截断失败，正常 `stop` 仍然完成。

### A failed trace carries the step's instructions

Failed traces now include each step's instructions, acceptance criteria, required capabilities, scopes and subagent count, redacted and capped, so the repair lane can reproduce a plan or verification failure from the trace. The verifier repair's first lane run had failed because the trace held only the step id, title and risk.

失败轨迹现在包含每个步骤的 instructions、验收标准、所需能力、scopes 与子代理数量（已脱敏并截断），修复通道可以只凭轨迹复现计划或验证失败。验证器修复的第一次通道运行正是因为轨迹只有步骤 id、标题与风险而失败。

### A first-send failure shows the reason and next step

A failed turn already said why in the conversation ledger, but a first send with no streamed reply kept its transient error card and skipped the ledger refresh — so the owner saw only the raw loop error ("The agent called get_run_status 5 times…"). The failed SSE event now carries the same owner-facing summary and next step, and the transient card renders them with the raw error in a collapsed 原始错误 detail. It falls back to the old interrupted card when no summary is present.

失败的回合在台账里本来就说原因，但首次发送没有流式正文，会保留临时错误卡并跳过台账刷新——所有者只看到原始循环错误（“The agent called get_run_status 5 times…”）。failed SSE 事件现在携带同样的所有者可读摘要与下一步，临时卡渲染它们，并把原始错误放进折叠的“原始错误”详情。没有摘要时退回旧的中断卡片。

### A turn's answer starts at the section's left edge

The reply in a conversation turn is no longer indented into the 52 px label gutter: the 结果 label is hidden, the answer is set at 14.5 px in the full reading width, and the 依据 line closes the section behind a hairline with 查看审计 pushed to the right end. Failed turns, legacy history entries and the live streaming card use the same rules, since they share the step container; narrow widths keep the same shape. No data, server or behaviour change.

对话回合的回复不再缩进到 52px 的标签栏里："结果"标签隐藏，回答以 14.5px 铺满阅读栏，"依据"以一条细线收束章节，"查看审计"推到行尾。失败回合、旧历史条目与实时流式卡片共用同一套规则，因为它们共享步骤容器；窄宽度保持同一形状。没有数据、服务端或行为变更。

### The sidebar lists conversations only; run detail is in the audit

A turn's dispatched runs no longer nest under their conversation. The sidebar shows conversations — the main conversation pinned first, then today and earlier — with no `N 个任务` line and no child rows; a run with no conversation (scheduled, repair, opportunity) no longer appears there either. The only task that still earns a row is one waiting for you: it stays in 需要你处理, because a decision that is invisible is a decision missed. The conversation pane drops the 产物 list of spawned runs; each turn keeps its reply and the one-line 依据 with 查看审计, and every run remains reachable in 设置 → 审计与轨迹.

派发的 Run 不再嵌套在所属对话下。侧栏只显示对话——主对话固定在前，然后是今天与更早——没有 `N 个任务` 那行，也没有子行；没有对话的 Run（定时、修复、机会）也不再出现在那里。唯一仍占一行的任务是在等你决定的那个：它留在 需要你处理，因为看不见的决定等于漏掉的决定。对话区去掉列出派发 Run 的 产物 列表；每个回合保留回复与一行"依据 / 查看审计"，所有 Run 仍可在 设置 → 审计与轨迹 打开。

### Dev mode and the resident daemon no longer run two sidecars on one clone home

`npm run desktop:dev` used to kill the launchd-supervised daemon; `KeepAlive` restarted it immediately, so the dev app's own sidecar and the resident daemon wrote the same journal, turn ledger and endpoint. When the dev sidecar exited it deleted the endpoint the other process still served, and a window opened at that moment showed "launchd 没有在 60 秒内发布端点" until the daemon republished. The dev driver now boots `ai.clone.companion` out for its session and restores it on exit, and a companion takes a per-home lock (`companion-runtime.lock`) before hydrating the journal: a second sidecar exits with the owner's pid instead of starting. `test/companion-singleton.test.ts` covers the refusal and stale-lock reclamation; the driver's bootout/bootstrap contract is pinned in `test/desktop-shell.test.ts`.

`npm run desktop:dev` 过去会杀掉 launchd 托管的守护；`KeepAlive` 立刻把它重启，于是开发 App 自己的 sidecar 与常驻守护同写一本 Journal、同一份回合台账与端点。开发 sidecar 退出时会删除另一个进程仍在服务的端点，此时打开的窗口会一直显示"launchd 没有在 60 秒内发布端点"，直到守护重新发布。开发驱动现在在会话期间把 `ai.clone.companion` bootout，退出时恢复；companion 在重放 Journal 之前取得按 home 的锁（`companion-runtime.lock`）：第二个 sidecar 会带着属主 pid 退出而不是启动。`test/companion-singleton.test.ts` 覆盖拒绝与陈旧锁回收；驱动的 bootout/bootstrap 契约钉在 `test/desktop-shell.test.ts`。

### A failed turn stays visible in the sidebar while its task runs

The conversation row now gives a failed or interrupted latest turn precedence over a running child: the row reads 需要处理 and its preview shows the failure plus "N 个任务仍在执行". A waiting decision still wins, and a completed turn with an active child still reads 运行中. The child row keeps its own status.

对话行现在让失败或被中断的最新回合优先于运行中的子任务：行显示需要处理，预览显示失败并追加“N 个任务仍在执行”。等待中的决定仍然优先；完成回合带活跃子任务仍显示运行中。子行保留自己的状态。

### A failed run says why it failed

The Kernel now records a policy denial's reason, or the verification summary (capped at 500 characters) on a failed verification or rejected review, in the run's status. `run.failureReason` therefore covers every failure; `get_run_status` prints `Failure:`, `dispatch_task` returns `failureReason`, and the work update and opportunity card read it instead of "没有记录到具体原因". Worker failures keep their existing message.

Kernel 现在把 policy 拒绝的理由，或验证失败/复核拒绝的验证摘要（截 500 字符）写进 Run 的状态。因此 `run.failureReason` 覆盖每一次失败；`get_run_status` 打印 `Failure:`，`dispatch_task` 返回 `failureReason`，工作更新与机会卡读取它，而不是“没有记录到具体原因”。Worker 失败沿用原有消息。

### A model's declared effort levels are accepted, not only the built-in seven

The composer and Settings pickers list the gateway's per-model reasoning levels, and some models declare levels outside clone-ai's built-in set — `openai/gpt-6.1-terra` offers `none` and `ultra`. Those appeared in the picker and were then refused with HTTP 400 by the stream/query endpoints and `PATCH /api/config`. The endpoints now accept any non-empty level name (trimmed, at most 64 characters), forward it as `reasoning_effort`, and leave the provider as the authority for what a model accepts. The built-in seven remain the picker's fallback when the gateway declares nothing, and the set a self-review proposal may choose from.

输入框与设置页的选择器列出网关按模型声明的推理档位，而有些模型声明的档位不在 clone-ai 的内置集合里——`openai/gpt-6.1-terra` 提供 `none` 与 `ultra`。这些档位出现在选择器里，随后却被流式/查询接口与 `PATCH /api/config` 以 HTTP 400 拒绝。现在这些接口接受任何非空档位名称（去空白、最多 64 字符），以 `reasoning_effort` 转发，并把"模型接受什么"的权威交给 Provider。内置七档仍是网关没有声明时选择器的兜底，也是自审提案可以选择的集合。

### A failed run's lesson must cite the failure

A memory mined from a failed run is now accepted only when it cites evidence that records the failure: the mining prompt marks failing evidence `[failure]`, and a procedure that cites none is refused and journaled with its reason. The recorded memory "下次应先直接读取…README.md…" is the case this closes. Completed-run mining and a durable preference stated inside the task are unchanged. Memory files also stop repeating the summary as the first line of their content.

从失败 Run 提炼的记忆，现在只有在引用记录失败的 Evidence 时才被接受：提炼 Prompt 把失败 Evidence 标成 `[failure]`，没有引用它的 procedure 会被拒绝并把理由记入 Journal。记录中的“下次应先直接读取…README.md……”正是这次修复的用例。已完成 Run 的提炼、以及任务里声明的持久偏好都不变。记忆文件也不再在正文首行重复摘要。

### One sidebar entry starts a request; the main conversation is a pinned row

The 对话 button beside 新请求 is gone: 新请求 is the only way to start a request and keeps the router that decides between continuing a conversation and starting a Main Agent. The main conversation is now the pinned first row of 最近, named 主对话, with the tasks its turns dispatched nested under it like every other thread, and it has no hide control. It appears once the main thread has a turn, a dispatched task, or older on-disk history — an empty install still has only 新请求 — and a hidden main conversation stays hidden with its restore control.

新请求 旁边的 对话 按钮已移除：新请求 是发起请求的唯一入口，并保留"继续相关对话还是新开 Main Agent"的路由器。主对话现在是 最近 里固定的第一行，名为主对话；它各回合派发的任务像其他线程一样嵌套在下面，且没有隐藏控件。它在主线程有回合、派发过任务或磁盘上有旧历史时出现——空数据仍然只有 新请求 一个入口；被隐藏的主对话保持隐藏，并保留恢复控件。

### The composer chooses the model and reasoning effort for a conversation

The composer now has model and effort pickers beside the send box, saved with the conversation. The Settings model/effort rows are gone: the composer is the only picker, and a turn without one uses the configured default model and the provider's default effort — the same defaults WhatsApp and scheduled turns use, with the default model still bound through the Agent page's gateway card. The choice travels with the turn: the stream and query endpoints accept `model` and `effort`, and an effort that is not a name at all is refused with HTTP 400 before any model call. Wiring this exposed that the Main Agent recorded `mainAgentEffort` but never sent `reasoning_effort` to the provider — the request now carries it, so the setting and the new picker actually change the reasoning budget. The effort list now uses the gateway's declared levels for the selected model; the previous code read a field that was never assigned and always fell back to the full list. The observation-sources panel now explains that a source only reads `.md`/`.txt` files from the folder you chose and has no write or execute authority.

输入框旁现在有模型与推理强度选择器，选择随对话保存。设置里的模型/强度两行已移除：输入框是唯一入口，没有选择时使用配置的默认模型与 Provider 默认强度——WhatsApp 与定时回合也使用这些默认值，默认模型仍通过 Agent 页的网关卡片绑定。选择随回合发送：流式与查询接口接受 `model` 与 `effort`，根本不像名称的强度在任何模型调用前以 HTTP 400 拒绝。接上这条线时发现主 Agent 只记录了 `mainAgentEffort`，从未把 `reasoning_effort` 发给 Provider——现在请求会携带它，设置与新选择器真正改变推理预算。强度列表现在使用网关为所选模型声明的档位；此前的代码读取从未赋值的字段，永远退回完整列表。观察来源面板现在说明：来源只读取所选目录中的 `.md`/`.txt` 文件，没有写入或执行权限。

### The internal base is the machine root

A task's internal base is now `/` — the whole machine — when no explicit `CLONE_AI_WORKSPACE` is set; the companion server no longer falls back to the clone home. The execution lock now actually lives at `~/.clone/workspace-runtime/workspace-execution.sqlite3`, so a root workspace never tries to create `/.clone`. The verifier's default root is the machine, and `verifiedWorkspacePath` still refuses the locations no policy may open. Relative paths in plans should be absolute; the clone home remains the data directory.

任务的内部基准现在默认是 `/`——整台机器——除非显式设置 `CLONE_AI_WORKSPACE`；companion server 不再回退到 clone home。执行锁现在确实位于 `~/.clone/workspace-runtime/workspace-execution.sqlite3`，根工作区不会再尝试创建 `/.clone`。验证器的默认根是整台机器，`verifiedWorkspacePath` 仍拒绝任何策略都无法打开的位置。计划中的相对路径应改为绝对路径；clone home 仍是数据目录。

### The no-progress guard counts a repeated call across the turn

The shared agent loop now counts each executed call's identity — tool name, arguments (ignoring JSON key order) and result text — across the whole turn, not only against the previous batch. Two identical polls alternated with each other, or a poll sharing a batch with a read whose result changes, now get the same warning at three and the `no_progress` stop at five. A call whose result changes is still progress, and a changed argument is a different call. The exact 2026-11-19 eight-poll shape still stops at five, and no round cap is reintroduced.

共享 Agent 循环现在按整回合统计每个已执行调用的身份——工具名、参数（忽略 JSON 键顺序）与结果文本——不再只与上一批比较。两个相同轮询彼此交替，或一个轮询与结果变化的读取同批，现在同样在第三次提示、第五次以 `no_progress` 停止。结果变化的调用仍算进展，参数变化是不同调用。2026-11-19 的八次轮询形状仍在第五次停止，且没有重新引入轮次上限。

### A read-only dispatch task is no longer planned as a write

`dispatch_task` with an objective that says 只读 / 不修改 no longer becomes a `reversible_write` plan just because it mentions 保存 / 写 in the code it describes. The fallback planner now lets the explicit read-only marker outrank a bare delivery verb; only a named write target (写到 / 保存到 / 输出到 plus a path) still turns a read-only request into a delivery plan. Both recorded 2026-11-19 objectives now plan as one read-only lookup instead of a write step that the files policy denied 3–4 ms after queuing. The repair lane produced the patch and the regression case; the regression is red before and green after.

带“只读 / 不修改”的 `dispatch_task` 目标，不再因为描述了带“保存 / 写”字样的代码就变成 `reversible_write` 计划。fallback planner 现在让显式只读标记压过裸交付动词；只有点名的写入目标（写到 / 保存到 / 输出到 加路径）才会把只读请求变成交付计划。2026-11-19 的两条被记录目标现在规划为一次只读查找，而不是被 files 策略在入队 3–4ms 后拒绝的写入步骤。补丁与回归用例由修复通道产出；回归用例修复前红、修复后绿。

### A video attachment's frame comes from AVFoundation

A video chosen through the attachment picker now gets its preview frame from macOS AVFoundation instead of the WebView's `<video>` media pipeline: one 1280 px JPEG at 1 s, measured at 160 ms on the first run and 13 ms thereafter, versus 1,065–1,277 ms for the same 8 MB/30 s/1080p file in WKWebView. Drag/drop and pasted videos, or a failed extraction, still use the HTML path. The model receives the same single JPEG frame and the attachment payload is unchanged.

通过附件选择器选中的视频，预览帧现在来自 macOS AVFoundation，而不是 WebView 的 `<video>` 媒体管线：1 秒处的一张 1280px JPEG，实测第一次 160ms、之后 13ms；同一个 8MB/30 秒/1080p 文件在 WKWebView 中要 1,065–1,277ms。拖放/粘贴的视频或抽取失败仍走 HTML 路径。模型收到同样的单张 JPEG 帧，附件载荷不变。

### There is no working-directory setting

The 工作目录 setting is gone: the app no longer asks for or stores a folder, and the config API no longer exposes one. Reads still reach any readable location except protected ones; a write must name its exact target as a files write scope, and no folder is writable by default — a write that names no target is denied instead of falling back to the workspace. Runtime locks and the execution database live under `~/.clone/workspace-runtime`, not in a project folder. The Main Agent's prompt says the computer is the workspace and no longer names a current folder. A write outside the internal base can be verified when the step declares the scope that contains it. The repair lane's isolated worktree remains writable without a per-step scope.

工作目录设置已移除：App 不再询问或保存文件夹，配置接口也不再暴露它。读取仍可到达受保护位置之外的任何可读位置；写入必须把确切目标声明为 files 写 Scope，默认没有文件夹可写——没有点名目标的写入会被拒绝，而不是回退到工作区。运行时锁与执行数据库位于 `~/.clone/workspace-runtime`，不再放在项目文件夹里。主 Agent 的 Prompt 说明整台电脑就是工作空间，不再点名当前文件夹。基准之外、但位于步骤声明 Scope 内的写入可以被验证。修复通道的隔离 worktree 仍无需每步 Scope 即可写。

### The sidebar's top level is the conversation, and tasks nest inside it

The sidebar now has one top-level kind: a conversation. The tasks its turns dispatched are collapsible children, with a count and a running/waiting/failed summary. Tasks dispatched by the main conversation sit under a non-row 主对话 header; scheduled, repair and opportunity runs sit under 定时/自动. A waiting child is still promoted into 需要你的确认, so a decision is never hidden inside a collapsed group. The owner-facing words are now 新请求 (the action), 对话 (the thread), 任务 (one bounded Run) and 定时 (the schedule); 最近任务, the peer 任务记录 kind, 任务对话 and 个人对话 are gone, and a task record's top bar is a breadcrumb back to its conversation. A task with no conversation no longer sends a follow-up into the main conversation: sending from its record starts a new request. The dashboard row is the thread, named by its first request, and its status aggregates waiting > running > recent failure > completed.

侧栏现在只有一种顶层行：对话。回合派发的任务是可折叠的子行，摘要显示数量与运行中/待确认/失败的分布。主对话派发的任务放在不可点击的"主对话"标题下；定时、修复与机会卡 Run 放在"定时/自动"下。等待中的子任务仍被提升到"需要你的确认"，决定不会被折叠组藏起来。所有者词表现在是"新请求（动作）、对话（线程）、任务（一次有界 Run）、定时（计划规则）"；"最近任务"、作为并列种类的"任务记录"、"任务对话"与"个人对话"已移除，任务记录顶栏改为回到所属对话的面包屑。没有对话的任务不再把追问送进主对话：从它的记录发送会作为新请求开始。Dashboard 的行是线程，以第一个请求命名，状态聚合为等待 > 运行中 > 最近失败 > 已完成。

### A directory introduced in a plan is not a promised file, and a spaced path stays whole

Verification no longer fails a run because a plan mentioned a directory as context — 数据目录 /path, 项目运行目录 /path, "the data directory /path" — or because an absolute file path contains a space. A path that is genuinely a file promise is still checked, including one with spaces (`/Users/user/Documents/Clone AI/out.md` is now extracted whole instead of `AI/out.md`). The verifier's workspace read boundary, symlink refusal and write authorization are unchanged. The two named forms are handled; this did **not** clear the recorded investigation's real plan, which still yielded two false promises and failed verification. The follow-up patch, with the real plan as its fixture, then landed as `763dcd8` after the owner approved it; that step now yields no file promises. The repair lane produced both patches.

验证不再因为计划把目录作为上下文提及（数据目录 /path、项目运行目录 /path、"the data directory /path"）或因为绝对文件路径含空格而判失败。真正的文件承诺仍会被检查，包括带空格的路径（`/Users/user/Documents/Clone AI/out.md` 现在作为完整路径提取，而不是 `AI/out.md`）。验证器的工作区读取边界、符号链接拒绝与写入授权不变。两条被点名的形式已处理；但这**没有**清掉记录中只读排查的真实计划——它仍然产出两个假承诺并验证失败。后续补丁以真实计划为 fixture，在所有者批准后以 `763dcd8` 落地；该步骤不再产出文件承诺。两个补丁都由修复通道产出。

### The audit view renders without waiting for gateway usage

The audit list now caches the Magpie gateway's usage rows for 15 seconds and waits at most 1 second for that optional enrichment, down from 2 seconds. A slow or missing gateway therefore cannot make every open of 设置 → 审计与轨迹 wait; the journal-backed run records, verdicts, errors and traces render without it. On this machine, the live `/api/audit` first call was 2,290 ms and the gateway's 499 KB usage response took 429 ms; the cached fetch now measures 438 ms first and 0 ms second, and the audit projection itself is about 60 ms. Usage can be up to 15 seconds stale.

审计列表现在缓存 Magpie 网关的用量行 15 秒，并把这项可选补充的等待限制在 1 秒（原先 2 秒）。因此慢或缺失的网关不会让每次打开 设置 → 审计与轨迹 都等待；由 Journal 支撑的 Run 记录、判定、错误与轨迹无需它即可渲染。在本机，线上 `/api/audit` 第一次为 2,290ms，网关 499KB 用量响应耗时 429ms；缓存后的拉取测得第一次 438ms、第二次 0ms，审计投影本身约 60ms。用量可能陈旧最多 15 秒。

### A table in the conversation renders as a table and exports to CSV

A reply can contain a Markdown table, and the conversation used to show the pipes and `---` rows literally. A GFM table now renders as a real table — header row, alignment, inline code and bold inside cells, escaped pipes — with horizontal scrolling on narrow windows. Every rendered table carries a 导出 CSV control: it asks for a folder and writes a timestamped `.csv` there (Excel opens it directly), then reveals it in Finder; a browser preview downloads the file instead. The export is an owner action: it needs no Worker, write scope or approval, refuses the clone data directory, and caps the file at 5 MB. Existing conversations re-render with tables when reopened.

clone-ai 的回复里可以包含 Markdown 表格，而对话此前会把竖线和 `---` 行原样显示。GFM 表格现在会渲染成真正的表格——表头、对齐、单元格内的行内代码与粗体、转义的竖线——窄窗口下可横向滚动。每张渲染出的表格都带一个"导出 CSV"控件：选择一个文件夹后，把带时间戳的 `.csv` 写进去（Excel 可直接打开），并在 Finder 中定位；浏览器预览则改为下载文件。导出是所有者动作：不需要 Worker、写作用域或批准，拒绝 clone 数据目录，并把文件限制在 5 MB。重新打开既有对话时，表格也会以表格形态重新渲染。

### Agent settings show the model choice, not the wiring

Settings → Agent no longer prints the Magpie loopback address (`http://127.0.0.1:3425/v1`) under 本机 Magpie 已连接, and its overview no longer repeats a 当前模型 card with the raw provider/model id. The connection state, the explanation, the model picker and the 使用此模型 action remain; the endpoint and id stay in the config file, the audit and the logs.

设置 → Agent 不再在"本机 Magpie 已连接"下打印 Magpie 回环地址（`http://127.0.0.1:3425/v1`），概览也不再重复显示原始 provider/model id 的"当前模型"卡。连接状态、说明、模型下拉与"使用此模型"动作保留；端点与 id 仍留在配置文件、审计与日志里。

### A repeated tool call stops the turn instead of looping until the provider stops it

The shared agent loop now warns once when the same call returns the same result three times in a row, and ends the turn at five with a new `no_progress` failure. It compares the tool name, the arguments regardless of JSON key order, and the result text, so a call whose result changes is still progress. The Main Agent is also told that a run proposed by `propose_work_plan` advances on its own: it reports the runId, ends the turn, and never polls `get_run_status`; a live run's status now ends with "Snapshot only — calling this again does not change it." This closes the 2026-11-19 failure where eight identical `get_run_status` calls were stopped by the external model gateway, whose notice was recorded as a completed reply.

共享 Agent 循环现在在同一个调用连续三次返回同样结果时提示一次，并在第五次以新的 `no_progress` 失败结束回合。它比较工具名、参数（忽略 JSON 键顺序）与结果文本，因此结果变化的调用仍算进展。主 Agent 也被告知：`propose_work_plan` 提出的 Run 会自行推进——报出 runId、结束回合，绝不轮询 `get_run_status`；运行中的 Run 状态末尾现在写"仅快照——再次调用不会改变它"。这关闭了 2026-11-19 的失败：八次相同的 `get_run_status` 调用被外部模型网关拦下，而它的提示被记成了一条完成的回复。

### A turn shows its result and evidence; the process moves to the audit

A conversation no longer renders the 上下文 block (model, system prompt, tool table, history window, compactions) or the 派发 block (every tool call with its JSON input and duration) for a turn. A turn now shows your request, the result, the runs it produced as 产物 rows, and one muted 依据 line — how many tools it called, how many failed, how many tasks it spawned — with a 查看审计 control that opens 设置 → 审计与轨迹 → 主 Agent 回合 filtered to that turn by its id. The audit keeps the full assembly, tool list and history searches, and now shows compaction summaries in a 上下文压缩 block; a turn with no journal record gets no link instead of a dead one. The live running card keeps its transient tool timeline while the turn streams.

对话不再为每个回合渲染"上下文"块（模型、系统提示、工具表、历史窗口、压缩）与"派发"块（每次工具调用及其 JSON 输入与耗时）。一个回合只显示你的请求、结果、本回合派生的 Run（"产物"行），以及一行低调的"依据"——调用了多少次工具、多少次失败、派生了多少个任务——并带一个"查看审计"控件，打开 设置 → 审计与轨迹 → 主 Agent 回合 并按回合 id 精确筛到本回合。审计页保留完整的任务组装、工具清单与历史检索，并新增"上下文压缩"块显示压缩摘要；没有 Journal 记录的回合不再给出失效链接，而是不显示控件。运行中的实时卡片在流式进行时保留临时的工具时间线。

### A request that dispatched no task stays in the sidebar

The sidebar now lists every request you started, not only task Runs. A request the Main Agent answered directly — or one whose turn failed or was interrupted — becomes its own 对话 row with the latest request as its title and the reply as its preview, so it no longer disappears when the answer arrives. A conversation that did dispatch tasks still appears as those task rows only, never twice; the main conversation is still opened from 对话 and hidden conversations stay hidden with a restore action. The audit's execution list remains tasks-only because a conversation is not a Run.

侧栏现在列出你发起的每一次请求，而不只是任务 Run。主 Agent 直接作答的请求——或回合失败、中断的请求——会成为一条"对话"行，标题是最近一次请求，预览是回复，因此回答到达后它不再消失。派发过任务的对话仍只由那些任务行表示，绝不重复；主对话仍从"对话"打开，隐藏的对话仍可从"已隐藏"恢复。审计的执行记录列表仍只列任务，因为对话不是 Run。

### A turn reads as an exchange: your request on the right, the answer on the left

The conversation log and 设置 → 审计与轨迹 → 主 Agent 回合 now render a turn as two sides. Your request is a right-aligned bubble; the reply is the left-hand section with its author, status, time and evidence below. In the audit, the duplicated 140-character input preview in the card head and the two identical grey blocks under 输入 and 回复 are gone; the assembly and tool evidence stay in the card below the exchange.

对话日志与 设置 → 审计与轨迹 → 主 Agent 回合 现在把回合渲染成两侧。你的请求是靠右的气泡；回复是左侧章节，作者、状态、时间与证据在它下面。审计卡片头部重复的 140 字输入预览、以及"输入""回复"下两个相同的灰块都已移除；任务组装与工具证据仍在卡片内、交流下方。

### Today's work comes from learned folders, not a setting

The twin now learns the folders you work in from your own requests and from the tasks it dispatched — `~/work/knowledge_base/README.md` teaches `~/work`, a project under `~/Documents` teaches that project — and remembers them in the persisted turn ledger. Every turn's situation briefing carries the list. A new read-only `recent_file_changes` tool lists the files whose content changed since local midnight (Spotlight on macOS, with a bounded directory walk fallback) plus each Git repository's branch, uncommitted changes and commits; it reads the learned folders by default and only a folder you name otherwise. The Main Agent is told to call it before saying it has no material. No folder has to be configured one by one.

分身现在从你自己的请求与它派发过的任务中学习你工作的文件夹——`~/work/knowledge_base/README.md` 学到 `~/work`，`~/Documents` 下的项目学到该项目本身——并把它们记在持久化的回合台账里。每回合的情境简报都会带上这份列表。新增只读工具 `recent_file_changes`：列出本地午夜以来内容发生变化的文件（macOS 用 Spotlight，其他情况回退到有界目录遍历），以及每个 Git 仓库的分支、未提交改动与提交；默认读取学到的文件夹，只有你点名时才读取别处。主 Agent 被告知在说"没有素材"之前先调用它。不需要逐个配置文件夹。

### The attachment picker skips the sheet animation

The native attachment picker now opens as an app-modal panel instead of a window sheet, removing about 270 ms of sheet animation from every click; its first cold construction is warmed once after the page is ready, so the first click builds in about 100 ms instead of 300–660 ms. Measured with the same content types and an offscreen window: cold sheet 984 ms to become visible, warm sheet 389 ms, warm app-modal panel 106 ms. File types, drag/drop and the selected URLs are unchanged; the directory picker keeps its sheet. The running app must be rebuilt and relaunched to get the native change.

原生附件选择器现在以应用级模态面板打开，而不是窗口 sheet，每次点击少掉约 270ms 的 sheet 动画；页面就绪后会预热一次冷构造，因此第一次点击的构造约 100ms，而不是 300–660ms。用相同内容类型与离屏窗口测得：冷 sheet 可见 984ms，热 sheet 389ms，热应用级模态面板 106ms。文件类型、拖放与选中的 URL 不变；目录选择器仍用 sheet。运行中的 App 需要重新构建并重启才能获得这项原生变更。

### Attachments answer the click before they are read

Choosing a file now paints a "读取中…" chip immediately, then prepares independent files through one global ordered three-way pool. Images are shown through a 240 px thumbnail shared by the composer chip and the live card instead of a full-resolution data URL, and image/PDF bytes are encoded in the background after the chip exists; a send waits only for reads still in flight, overlapping the route decision. The four-attachment cap and the 100,000-character document budget are unchanged, a failed send restores the chosen files, and a transient read failure can be retried. Enter with only a reading chip waits for the batch; if every file is rejected, the composer keeps the message unsent. Measured in Chromium, four 5 MB images went from 94 ms of serial data-URL work to 3 ms of ordered blob previews, and four 12 MP photos now cost 69 ms for four 4.9 KB thumbnails. The server's PDF/.docx/OCR extraction stays sequential and in-process: parallel extraction measured slower on the single Node thread, concurrent PDF pages throw `DataCloneError`, and parallel OCR gained about 10% on a 20-page scan.

选择文件后现在会立刻画出"读取中…"chip，然后由同一个全局的、按输入顺序的 3 路池准备独立文件。图片通过 chip 与实时卡片共用的 240px 缩略图显示，而不是全分辨率 data URL；图片与 PDF 的字节在 chip 出现后于后台编码，发送只等待仍在进行的读取，并与路由决定重叠。四附件上限与 100,000 字符文档预算不变；发送失败会恢复已选文件；瞬时读取失败可以重试。只有"读取中…"chip 时按回车会等待批次；如果所有文件都被拒绝，输入框保留消息、不发送。Chromium 实测：四张 5MB 图片从 94ms 的串行 data URL 处理降到 3ms 的按序 blob 预览；四张 12MP 照片现在 69ms 生成四张 4.9KB 缩略图。服务端的 PDF/.docx/OCR 提取保持串行、进程内：单 Node 线程上的并行提取实测更慢，并发 PDF 页面会抛 `DataCloneError`，并行 OCR 在 20 页扫描件上仅提升约 10%。

### The installed window is the only UI

The browser preview entry is gone: `.claude/launch.json` (its only configuration started the preview on port 4317), `scripts/companion-dev.mjs` and the `companion:dev` npm script are deleted. The installed window's supervised loopback server is unchanged, and the two archived eval harnesses now start `src/companion-server.ts` on `CLONE_AI_PORT` with their own home, so replay still works. UI work uses `npm run desktop:dev`, which opens the real app against the live source. The preview home under `.automation/preview` is not part of the app; a task created there (such as 发送周报) never appears in `~/.clone`, and this change removes the page that made that look like a missing app task.

浏览器预览入口已移除：`.claude/launch.json`（它唯一的配置在 4317 端口启动预览）、`scripts/companion-dev.mjs` 与 `companion:dev` npm 脚本均已删除。已安装窗口的受监督 loopback 服务不变；两个归档评测 harness 改为以 `CLONE_AI_PORT` 和各自的 home 直接启动 `src/companion-server.ts`，重放仍然可用。UI 工作改用 `npm run desktop:dev`，它以活源码打开真实的 App。`.automation/preview` 下的预览 home 不属于 App；在那里创建的任务（例如 发送周报）永远不会出现在 `~/.clone`，这次变更移除了那个让它看起来像"App 丢任务"的页面。

### An Agent 协作 row opens the task record that owns it

Subagent rows in the Agent 协作 card are now buttons when they belong to another task record. Clicking one opens that run's task record, expands its Agent 协作 card and scrolls the matching row into view once; the title underlines on hover, the cursor turns into a pointer, and keyboard focus draws a ring. Rows inside a task record stay plain text because they are already at their destination. The conversation payload now carries each subagent's `runId`, so the row can address its record even when several runs contribute to the same card. `test/ui-structure.test.ts` and `test/agent-collaboration-link.test.ts` pin the markup, the click wiring and both views' payload.

Agent 协作 卡片里的子 Agent 行，当它属于另一条任务记录时现在是按钮。点击会打开该 Run 的任务记录、展开它的 Agent 协作 卡片，并把对应的行滚动到视野内一次；悬停时标题显示下划线，光标变成指针，键盘聚焦时画出焦点环。任务记录内部的行保持纯文本，因为它们已经在目的地。对话载荷现在为每个子 Agent 携带 `runId`，即使同一张卡片聚合了多个 Run，行也能寻址到自己的记录。`test/ui-structure.test.ts` 与 `test/agent-collaboration-link.test.ts` 固定了标记、点击接线以及两种视图的载荷。

### A transcript says which block is which

The conversation log now separates its four levels by structure instead of giving every block the same white card. A Main Agent turn is an exchange: the owner's request sits above as a right-aligned bubble, and the twin's answer below it is a ruled section with an author overline (`clone-ai` / `历史记录`), a status dot plus word and time, and its 上下文 / 派发 / 结果 steps on one label gutter; the author strip pins within its own answer, so a tail whose head scrolled out of view still says whose answer it is, and an answer that hands over to an update closes with a rule. Failed and interrupted answers carry a 2-px state rule, and the error stays the only tinted callout inside 结果. A 任务更新 is an indented margin note beside a tone-coloured rule — small label, status, time, then text — so it no longer reads as an answer. A dispatched child run is a hairline row on a rail inside 派发, with its id, title and tone-coloured status word; the whole row still opens the task. Records after the log (Agent 协作, 执行计划, 证据与产物, 本地执行轨迹, 核验结果) are top-rule disclosures with a drawn chevron, not more cards; the flattening is scoped to the conversation, so task-record views keep their card grouping. `test/ui-structure.test.ts` pins the four levels' markup and CSS grammar.

对话日志现在用结构区分四个层级，而不是给每个块都套同一只白卡片。主 Agent 回合是一次交换：所有者的请求在上方，是靠右的气泡；分身的回答在下方，是带分隔线的章节——作者眉线（`clone-ai` / `历史记录`）、状态圆点加文字与时间，以及共用一条标签栏的 上下文 / 派发 / 结果 步骤；作者条只在所属回答内吸附，头部滚出视口后尾部仍能说明这是谁的回答；交接给更新的回答以底线收尾。失败与中断的回答带 2px 状态线，"结果"里的错误也是唯一带底色的提示块。任务更新是带状态色竖线旁的缩进页边注——小标签、状态、时间，然后是正文——不再读成一个回答。派发的子任务 Run 是"派发"里竖线上的细线行，带 id、标题与按状态着色的状态词，整行仍可打开该任务。日志之后的记录（Agent 协作、执行计划、证据与产物、本地执行轨迹、核验结果）是带自绘箭头的顶线披露行，而不是更多卡片；这种变平只作用于对话转录，任务记录视图保留卡片分组。`test/ui-structure.test.ts` 固定了这四个层级的标记与 CSS 语法。

### The machine is the workspace: reads are open, every write carries a scope

Workers can read any readable location on the local computer, and the live folder is no longer an implicit write root. Every write step must carry a `files` write scope; when a step names no target, the Kernel proposes the workspace as an explicit scope, and the policy engine still decides — `observe` denies writes, `prepare` and `act_with_approval` ask the owner, and only an `act_auto` standing policy allows them without a prompt. External work runs in an isolated copy and the repair lane in its own worktree; those sandboxes stay writable. Protected locations — credentials, browser profiles, Clone AI's own journal and token — remain refused before any policy can open them. The audit now lists each step's scopes. With files still at 只观察, writes are denied until you raise 设置 → 权限与安全 → 文件 to 需批准后执行 (or add a standing policy).

Worker 现在可以读取本机任何可读位置，活文件夹也不再是隐式写入根。每个写入步骤必须携带 `files` 写 Scope；步骤没有点名目标时，Kernel 把工作区作为显式 Scope 提出，仍由权限引擎判定——`observe` 拒绝写入，`prepare` 与 `act_with_approval` 询问所有者，只有 `act_auto` 常设策略才无需询问。外部工作运行在隔离副本里，修复通道运行在自己的 worktree 里；这些沙箱保持可写。受保护位置——凭据、浏览器档案、Clone AI 自己的 Journal 与令牌——仍在任何策略之前被拒绝。审计现在列出每个步骤的 Scope。在 files 仍为"只观察"时，写入会被拒绝，直到你在 设置 → 权限与安全 → 文件 调到"需批准后执行"（或加入常设策略）。

### A Main Agent can search every task conversation

`search_history` now searches all of the owner's task conversations by default, tags each result with its conversation and time, and can be narrowed to the current conversation. Every search is recorded and shown in the audit — the query, its scope, and the conversations it recovered — so a task can use context established elsewhere without merging all histories. The prompt now tells every Main Agent it is the same twin as in the owner's other tasks, with its own conversation here.

`search_history` 现在默认检索所有者的全部任务对话，每条结果带所属对话与时间，并可收窄到当前对话。每次检索都会记录并显示在审计里——查询、范围以及召回了哪些对话——因此任务可以使用在别处建立的上下文，而不必合并所有历史。Prompt 现在告诉每个 Main Agent：它和所有者的其他任务是同一个分身，但在这里有自己的对话。

### One "new request"; Clone AI picks the Main Agent

The desktop no longer asks you to choose between a new conversation and a new task. "新请求" sends your message through a router: an explicit continuation ("继续", "刚才", "上次") reuses the related conversation, a new-goal cue or no context starts a new Main Agent, and an ambiguous request asks the model once (falling back to a new agent). Each task record shows "派发者" with the Main Agent that dispatched it and a button to open that conversation; the audit's turn assembly shows the routing decision and why.

桌面端不再让你在"新建对话"与"新建任务"之间选择。"新请求"会先经过路由器：明确的续接（"继续""刚才""上次"）沿用相关对话；明确的新目标或没有上下文时新开一个 Main Agent；语义含糊时问模型一次（失败则新开）。每个任务记录显示"派发者"与派发它的 Main Agent，并可一键打开该对话；审计的任务组装显示路由决定与理由。

### Agent settings show workers, not wiring

Settings → Agent now shows the detected Magpie gateway with its model picker and a read-only list of the four workers — title, role and what each one is for. The manual endpoint/API-key form, the redundant local-provider list, the per-worker provider selects and enable switches, and the gateway card's model-count, version and API-path badges are gone. Magpie's loopback endpoint is still discovered and pinned when a model is applied, and every worker stays enabled. `test/ui-locale.test.ts` asserts the removed controls stay out of the page.

设置 → Agent 现在展示检测到的 Magpie 网关及其模型选择，以及一份只读的四个 Worker 列表——名称、角色与用途。手填端点/API Key 表单、重复的本机 Provider 列表、每个 Worker 的 Provider 下拉与启用开关，以及网关卡片上的模型数量、版本与 API 路径徽章都已移除。应用模型时仍会自动发现并固定 Magpie 的回环端点，所有 Worker 保持启用。`test/ui-locale.test.ts` 会断言这些被移除的控件不再出现在页面里。

### Readiness is published before the first maintenance pass

The desktop window now connects as soon as the companion server binds its loopback port and publishes `companion-endpoint.json`. The first background maintenance pass — memory extraction, commitment reconciliation, opportunity scanning and the one-time legacy-candidate cleanup — starts right after that instead of running before the server listens. A held memory-extraction lock or a miner waiting on a model could previously leave the daemon alive but invisible, with the window stuck on 正在连接; with eight pending extractions and the lock held, the sidecar now reaches ready in about 170 ms instead of never becoming ready while the lock was held. The opportunity and attention strips are scanned before the extraction drain, so their cards stay current while another process holds the lock. Shutdown aborts every background lock wait — the maintenance pass, its governance operations, the in-process lock queue and a scheduled run's post-run extraction — while a run that is already executing is left to finish. `test/companion-startup-readiness.test.ts` pins readiness, card freshness and close under a held extraction or governance lock; `test/workspace-lock-abort.test.ts` pins each abortable wait.

桌面窗口现在在伴随服务器绑定回环端口并发布 `companion-endpoint.json` 后立即连接。首轮后台维护——记忆提炼、承诺收敛、机会扫描以及一次性旧候选清理——改为在端点发布之后立即开始，而不是挡在服务器监听之前。此前，被持有的记忆提炼锁或等待模型的提炼器会让 Daemon 活着却不可见，窗口停在"正在连接"；在八条待提炼请求且锁被持有时，sidecar 现在约 170 毫秒就绪，而不是锁被持有时始终无法就绪。机会条与注意力条在提炼排空之前扫描，因此别的进程持锁时卡片仍然最新。关停会中止所有后台锁等待——维护轮、其治理操作、进程内锁队列与定时任务运行后的提炼——已经执行的 Run 则允许完成。`test/companion-startup-readiness.test.ts` 钉住就绪、卡片新鲜度与持有提炼锁或治理锁时的 close；`test/workspace-lock-abort.test.ts` 钉住每一种可中止等待。

### Task records own the decision; the audit shows the assembly

The sidebar now lists only dispatched tasks. A waiting task is promoted into its own "需要你的确认" section with an explicit flag, and its approval/review card — with the step and the accept/reject buttons — is decided on the task record itself; the main conversation no longer aggregates decisions, and the 对话 control opens the main thread. Every Main Agent turn in 审计 now has a collapsed "任务组装" block: the conversation, the history window, the model, the prompt materials (charter version, briefing, instruction files, tool table) and the runs the turn dispatched with their steps and status.

侧栏现在只列出已派发的任务。等待中的任务被提升到独立的"需要你的确认"分区并带明确标签；它的确认/复核卡——含步骤与接受/拒绝按钮——直接在任务记录上决定，主对话不再汇集决定，"对话"控件负责打开主线索。审计中的每个主 Agent 回合新增折叠的"任务组装"块：对话、历史窗口、模型、提示词材料（charter 版本、简报、指令文件、工具表）以及本回合派发的 Run 及其步骤与状态。

### A finished task is not a memory

Task-run memory mining no longer turns every completed task's objective into a candidate. Without a configured miner a completed task proposes nothing and its extraction marker records `count: 0`; with `CLONE_AI_MEMORY_MINING=all` the model miner still runs. Any miner's untyped or `procedure` candidate that only restates its task objective is dropped at the pipeline boundary (`droppedRestatements`, with the PII-redacted dropped text journaled for audit); a typed preference, fact, decision or commitment equal to the objective stays for review, because the owner may have stated exactly that. A one-time governed pass rejected the six pending legacy copies in the live home, leaving zero. The review list, attention list and dashboard show only undecided candidates. The live journal had 8 proposals and all 8 were `候选流程：` plus the exact objective. Conversation mining now has its own worker instead of borrowing the task pipeline's; the native loop still does not feed it (a repair-lane task).

任务提炼不再把每个已完成任务的目标变成候选。未配置提炼器时，已完成任务不提出候选，提取标记记录 `count: 0`；设置 `CLONE_AI_MEMORY_MINING=all` 时模型提炼器仍会运行。任何提炼器提出的、只是复述任务目标的无类型或 `procedure` 候选现在会在流水线边界被丢弃（`droppedRestatements`，被丢弃文本经 PII 脱敏后写入 Journal 供审计）；等于目标的有类型偏好、事实、决定或承诺留给审核，因为所有者可能原样说出了这件事。一次性治理扫描已拒绝线上 home 中 6 条待确认的遗留复制，剩下零条。审核列表、注意力列表与 Dashboard 只显示未决定的候选。线上 Journal 有 8 条提案，8 条都是 `候选流程：` 加完全一致的目标。对话提炼现在拥有自己的 Worker，不再借用任务流水线；原生循环仍未喂给它（属于修复通道任务）。

### A direct answer is recorded as evidence

A one-step direct response no longer fails after the worker has answered. When a single-agent `direct_response` step produced no tool evidence and the reply is non-empty, the native worker records one observation row for the answer (bounded summary, locator `answer:<stepId>`) immediately before completing; real tool evidence is preserved, and every other step still requires evidence. The fix came from the gated repair lane (commit `76aec5d`) and ships with `test/regression/direct-response-evidence.test.ts`, which is red without the change and green with it.

单步直接回答不再在 Worker 已作答之后失败。单 Agent 的 `direct_response` 步骤没有产出工具证据且回答非空时，原生 Worker 会在完成之前为回答记录一条观察证据（有界摘要，locator 为 `answer:<stepId>`）；真实工具证据保持不变，其他步骤仍然要求证据。该修复由带闸门的修复通道产出（提交 `76aec5d`），并带有 `test/regression/direct-response-evidence.test.ts`：变更前为红，变更后为绿。

### A read-only request is answered, not failed for a missing artifact

A request that only reads — "只读取 README 并说明", "只读审查这个项目的代码", or "看一下这个项目有什么优化空间" — is now planned as one read-only executor step instead of a draft work order whose required artifact the objective forbids. Research and review work orders inside a mixed plan require observation evidence, never a file. The Kernel rejects a `read_only` work order that requires `artifact`, `receipt` or `test` when the plan is attached, and a rejected plan closes its Run instead of leaving it in `planning`. The worker is told the contract it must satisfy; a read records observation evidence with its path, a write records artifact evidence even when the path was read first, and artifact rows survive the 20-row evidence cap. A read-only order no longer inherits write tools from a writable preparation step. The missing-input regression test is now collected by `npm test`.

只读请求——"只读取 README 并说明"、"只读审查这个项目的代码"，或"看一下这个项目有什么优化空间"——现在被规划为一个只读执行步骤，而不是一份目标明确禁止的草稿工单。混合计划中的研究与复核工单要求观察证据，绝不要文件。Kernel 在挂载计划时拒绝要求 `artifact`、`receipt` 或 `test` 的 `read_only` 工单；被拒绝的计划会关闭它的 Run，而不是留在 `planning`。Worker 会被告知必须满足的合同；读取记录带路径的观察证据，写入记录产物证据（即使该路径先被读过），产物行也能活过 20 条证据上限。只读工单不再从可写准备步骤继承写工具。缺失输入的回归测试现在由 `npm test` 收集。

### Concurrent tasks share one worker budget

Worker capacity is now measured once per clone home instead of once per dispatch path. The daemon, every query, and each Main Agent tool call or turn draw from the same limit, so two tasks running at once can no longer each start up to the machine's full number of workers. The owner's `maxConcurrentWorkers` setting still applies and still takes effect without a restart; the limit is released when the last user of that home closes.

Worker 容量现在按 clone home 测量一次，而不是每条派发路径各测一次。守护进程、每次查询，以及主 Agent 的每次工具调用或回合都从同一上限取用，因此两个同时运行的任务不再能各自拉起机器允许的全部 Worker。所有者的 `maxConcurrentWorkers` 设置仍然生效，且无需重启即可应用；该 home 的最后一个使用者关闭后，上限随之释放。

### The main pane is a dispatch log

A conversation's main pane now shows one log entry per Main Agent turn instead of chat bubbles: the query, the context the model was given (provider/model/effort, prompt-material hashes, the tool table, deterministic compactions, how many completed turns the history carried), the work the turn dispatched (every tool call with its input summary and duration, and the runs it spawned with titles and statuses), and the result. Approval and review cards and the task-record view are unchanged; the searchable global log stays in Settings → Audit. A turn the journal never recorded says so instead of rendering as a clean run, and legacy Pi history appears as compact history rows.

对话的主界面现在按 Main Agent 回合显示日志条目，而不是聊天气泡：query、模型拿到的上下文（Provider/模型/强度、提示词材料哈希、工具表、确定性压缩、历史携带的已完成回合数）、本回合派发的工作（每次工具调用及其输入摘要与耗时，以及派生的 Run 及标题与状态）与结果。确认与复核卡片、任务记录视图不变；可搜索的全局日志仍在 设置 → 审计。Journal 没有记录的回合会如实说明，而不是显示成一次干净的运行；旧 Pi 历史以紧凑的历史行呈现。

### A read-only request runs once, in the right workspace

An explicit read-only request now becomes one read-only step instead of a draft work order: the fallback planner no longer treats generic containers such as 项目, 代码 or 文件 as delivery terms, and it removes a no-write clause before matching delivery verbs. `dispatch_task`'s run now executes in the workspace the prompt named instead of the daemon's checkout, and the execution trace records that workspace.

显式只读请求现在变成一个只读步骤，而不是 draft 工作单：fallback planner 不再把项目、代码、文件这类泛化容器词当成交付词，并在匹配交付动词前去掉禁止写入的分句。`dispatch_task` 的 Run 现在在 Prompt 点名的工作区里执行，而不是守护进程所在的检出；执行轨迹会记录该工作区。

### Worker file tools read the paths the plan names

A worker's `read_file`, `list_directory`, `write_file` and `edit_file` now resolve a path against the workspace with `resolve` instead of `join`, so an absolute path inside the workspace or a granted read root reaches the file the gate approved. A plan that named `/workspace/README.md` used to pass the gate and then read `/workspace/workspace/README.md`, failing the step with "outside the workspace".

Worker 的 `read_file`、`list_directory`、`write_file` 与 `edit_file` 现在用 `resolve` 而不是 `join` 解析路径，因此工作区内或已授权读取根内的绝对路径能读到闸门批准的文件。计划里写 `/workspace/README.md` 时，闸门此前判定允许，工具却去读 `/workspace/workspace/README.md`，步骤因此以“位于工作区之外”失败。

### A review shows what the worker actually concluded

A single-agent step's final answer is now stored in the journal (`execution.completed`) and rendered in the task record and the review card, instead of leaving the owner with only acceptance criteria and an evidence count. The review card is docked at the top of the pane, so a pending decision stays visible while a long conversation scrolls.

单 Agent 步骤的最终回答现在写入 Journal（`execution.completed`），并显示在任务记录与复核卡里，不再让所有者只看到验收标准与证据计数。复核卡固定在面板顶部，长对话滚动时待决定的事项仍然可见。

### The Main Agent reads the configured workspace

The Main Agent's project instructions, situation briefing and invocation ledger now come from the workspace configured in Settings, not from the folder the daemon was started in. The prompt names that workspace and says workers see only inside it: a project outside it must be reported, not replaced by the workspace's files. Saving a different workspace says the app must be restarted instead of implying the switch already took effect.

主 Agent 的项目指令、情境简报与调用台账现在都来自设置里配置的工作区，而不是守护进程启动时所在的目录。Prompt 写明该工作区，并说明 Worker 只能看到其中内容：工作区之外的项目必须如实报告，不能用工作区里的文件顶替。保存不同的工作区时会明确提示需要重启 App，而不再暗示切换已经生效。

### A path mentioned only in prose no longer fails a worker step

The native worker now fails a step for a missing required input only when the work order declares that input with `required: true`. A path in the objective, instructions or acceptance criteria is context, not a requirement, and a path that is later read or written during the run no longer counts as missing. Declared required inputs that stay missing still fail. The fix came from the repair lane (commit `fb496e5b`) and ships with a two-direction regression test.

Native Worker 现在只有在工作单以 `required: true` 声明某输入时，才因该输入缺失而判步骤失败。目标、指令或验收标准里的路径只是上下文，不是要求；运行期间后来被读取或写入的路径也不再算缺失。已声明且仍然缺失的必需输入仍会失败。该修复由修复通道产出（提交 `fb496e5b`），并带有覆盖两个方向的回归测试。

### A plan step says what kind of risk it carries

The execution plan no longer labels every non-read step `需确认`, which read as a pending approval even when the policy had already allowed the step. Steps now say `直接处理` (read), `本地写入` (reversible write), `外部动作` (external side effect) or `不可逆` (irreversible). When a confirmation really is pending, the run is `waiting_approval` and the approval card in the main conversation is the place to decide.

执行计划不再把所有非只读步骤标成「需确认」——即使策略已经放行，它也会被读成待审批。现在按风险显示「直接处理」（只读）、「本地写入」（可回滚写入）、「外部动作」（外部副作用）或「不可逆」。真正需要确认时，Run 会进入 `waiting_approval`，在主对话的审批卡里决定。

### Each task runs its own Main Agent

A new task in the desktop is now its own Main Agent conversation: it carries its own history, and a task whose subtasks are still executing no longer blocks another task from starting. Concurrent Main Agent turns are capped by a cross-process pool measured from the machine's CPU and load — half the CPU cores (two when the machine has room), reduced under load, ceiling eight; `maxConcurrentMainAgents` pins the limit. Two prompts for the same task still return 409. Older ledger rows and runs, which carry no conversation id, stay under the main conversation. WhatsApp now keeps one conversation per chat.

桌面端新建任务现在是一个独立的 Main Agent 对话：拥有自己的历史；一个任务的子任务仍在执行，也不会阻止另一个任务开始。并发 Main Agent 回合由跨进程槽位池按机器 CPU 与负载实测限制——CPU 核数的一半（机器有余量时给两个），负载紧张时下调，上限八个；`maxConcurrentMainAgents` 可固定上限。同一任务的两个提示仍返回 409。没有对话 id 的旧台账行与 Run 仍归在主对话下。WhatsApp 现在按聊天各保留一个对话。

### The verification record stops repeating itself

A finished task's review card printed the step title on every criterion, pasted all criteria again into the summary paragraph, and said the owner's decision twice. The pill now is the decision (`已接受结果` / `已驳回结果`), the criteria are numbered rows with the repeated title on its own muted line, and the summary counts them; new records keep the criteria only in their structured field. Records already stored get the same reading — the UI shortens their legacy summary sentence.

已结束任务的核验卡把步骤标题印在每一条标准上，又在摘要段里把所有标准重复一遍，还把所有者的决定说了两遍。现在标签就是决定（`已接受结果` / `已驳回结果`），标准变成带编号的行、重复的标题单独弱化显示，摘要只给计数；新记录只在结构化字段里保存标准。已存储的记录也按同样方式呈现——界面会把它们的旧摘要句子缩短。

### Approvals live in the main conversation

Waiting approvals and reviews are now decided from the Main Agent conversation, each card posting to the run id it belongs to; a child task record shows a pointer back instead of a second set of buttons. Derived tasks collapse into a group under the conversation that spawned them, its summary showing the count and the running/waiting/failed split, with the open state remembered per conversation.

等待中的确认与复核现在在 Main Agent 主对话里决定，每张卡片提交到所属的 Run id；子任务记录只给出回到主对话的入口，不再有第二套按钮。派生任务折叠在所属对话之下，摘要显示数量与进行中/待确认/需处理分布，展开状态按对话记忆。

### A finished run keeps its verification and evidence

A task record no longer loses the verification card when the owner accepts or rejects a result: it keeps the system verdict, the owner's decision, the unverified criteria and a count of checked evidence. The evidence list now names the artifacts and observations the run produced instead of only counting them, and the execution trace opens by default for every run, finished or not (the scroll container bounds a long one; a collapse the owner makes is remembered).

所有者接受或拒绝结果后，任务记录不再丢失核验卡：它保留系统结论、所有者的决定、未自动验证的标准与被检查证据的数量。证据清单现在列出 Run 产出的产物与观察记录，而不只是计数；每个 Run（无论是否已结束）的执行轨迹都默认展开（长轨迹由滚动容器约束；所有者自己做过的折叠仍会记住）。

### UI edits reach the running window

The resident daemon serves a checkout but read `app.js`, the stylesheets and the view scripts once at startup, so an edit made while it ran could arrive in the window as a script that calls a function the served copy no longer defines — `Can't find variable` on the first click. The daemon now re-reads the asset it is about to serve when `CLONE_AI_DEV_MODE=1` (set by the LaunchAgent installer), and a new UI test fails when `app.js` calls a function it never defines.

常驻守护服务的是源码检出，但此前只在启动时读取一次 `app.js`、样式表与视图脚本，因此运行期间的编辑可能以"脚本调用了被提供副本里已不存在的函数"的形式到达窗口——第一次点击就 `Can't find variable`。现在守护在 `CLONE_AI_DEV_MODE=1`（由 LaunchAgent 安装器设置）时按请求重读即将提供的资源；新增的界面测试会在 `app.js` 调用自己从未定义的函数时失败。

### Workers stop when the model stops, not at a round number

The per-step model-round cap is gone unless the plan or owner sets one explicitly. The shared loop now continues until the model answers, the turn is aborted, or a duration/tool/token budget stops it; the planners no longer write `maxModelCalls`. The final-answer reserve only applies when a limit is set, so an unbounded run is expected to end with the model's own answer.

单步模型轮次上限已移除，除非计划或所有者显式设置。共享循环现在持续到模型给出回答、回合被中止，或时长/工具/token 预算把它停下；规划器不再写入 `maxModelCalls`。轮次尾部提示只在设置了上限时适用，因此无上限的运行应以模型自己的回答结束。

### The Forbidden City benchmark passes end to end in the App

A one-paragraph request submitted through the App's own daemon now produces a
model that grades 28/28: ten named halls, the shared three-tier terrace, 太和殿
at 64×37×35 m, detailed roofs, brackets, lattices and door studs, shadows, orbit
and zoom, a hero framing at 34.5% of the frame height, and mirrored
体仁阁/弘义阁. Reaching it fixed the worker's round default (12 → 40), the
LaunchAgent's workspace, and three grader blind spots: video-only checks in
interactive mode, a 9% hero framing that read as a floor plan, and paired halls
kept under `props.sideHalls`.

故宫基准现在能在 App 内端到端通过

经 App 自己的守护进程提交的一段话请求，现在产出的模型评为 28/28：十座具名殿、共用三层
三台、太和殿 64×37×35 米、精确的屋面/斗拱/棂格/门钉、阴影、orbit 与 zoom、主殿占画面
高度 34.5%、体仁阁/弘义阁左右对称。达成它的过程中修好了 Worker 默认轮次（12 → 40）、
LaunchAgent 的工作区，以及评分器的三处盲点：交互模式仍在评视频字段、主殿只占 9% 却读作
平面图、配楼放在 `props.sideHalls` 时被判缺失。

### The load-time view is graded on composition

A Forbidden City model can pass every data and interaction check and still look
like a floor plan: run `4ce0db3d` graded 26/27 while 太和殿 covered 9.0% of the
frame height from the default camera. The interactive checker now projects the
hall's corners through the camera the page reports and requires at least 25% of
the frame height with the hall inside the frame; the eval prompt states the
same rule.

默认视角现在按构图评分

故宫模型可以通过全部数据与交互检查，却仍然像平面图：运行 `4ce0db3d` 评为 26/27，而默认
相机下太和殿只占画面高度的 9.0%。交互检查器现在按页面报告的相机投影主殿角点，要求占画面
高度至少 25% 且完整落在画面内；评测提示词写明同一条规则。

### The owner's messages render Markdown

A pasted task brief used to arrive as literal `#`, `**` and backtick text. Owner messages now go through the same renderer as the agent's replies — headings, lists, inline code, fenced code and bold — while staying HTML-escaped first. The optimistic echo uses the same path, so the bubble does not change appearance when the server confirms it.

粘贴的任务说明过去会原样显示 `#`、`**` 与反引号。所有者消息现在和 Agent 回复走同一个渲染器——标题、列表、行内代码、围栏代码与粗体——并且仍然先做 HTML 转义。本地乐观回显也走同一路径，服务端确认后外观不会跳变。

### Automation runs in its own clone home

Repair, nightly RSI and eval companions no longer share the owner's `~/.clone`. They resolve `<repo>/.automation/<purpose>` (or `CLONE_AI_AUTOMATION_HOME`), seed only `config.json`/`settings.json`/`providers.json`/`mcp.json`/`policies.json`, and refuse the live home unless `CLONE_AI_ALLOW_OWNER_HOME=1`. The repair lane still reads failed traces from the owner's home, read-only; reports, consumed-trace state and locks live in the isolated home. `scripts/companion-dev.mjs` uses `.automation/preview` when no home is set, and refuses the live home.

修复通道、夜间 RSI 与评测 companion 不再共享所有者的 `~/.clone`。它们改用 `<repo>/.automation/<用途>`（或 `CLONE_AI_AUTOMATION_HOME`），只播种 `config.json`/`settings.json`/`providers.json`/`mcp.json`/`policies.json`，并拒绝使用在线 home，除非 `CLONE_AI_ALLOW_OWNER_HOME=1`。修复通道仍从所有者 home 只读地读取失败轨迹；报告、已消费轨迹状态与锁放在隔离 home。`scripts/companion-dev.mjs` 在没有提供 home 时使用 `.automation/preview`，并拒绝在线 home。

### One Agent invocation can be deleted from its row

The Agent-invocation list now shows a compact 删除 control on each row, beside the selectable record, and 恢复 on a deleted row; the bulk "删除这 N 条" still acts on the filtered list. Delete remains soft — a tombstone, restorable from 含已删除.

Agent 调用列表的每一行现在在可选择的记录旁有一个紧凑的「删除」控件，已删除的行显示「恢复」；批量「删除这 N 条」仍然只作用于当前筛选列表。删除仍是软删除——追加墓碑，可从「含已删除」恢复。

### The packaged app attaches to the resident daemon

A build launched from Finder carries no environment, so the window used to spawn its own runtime even while the `ai.clone.companion` LaunchAgent was running — two writers on one journal. The window now asks launchd whether the job is loaded and attaches when it is; a checkout without the job still runs its own runtime. Developer builds keep theirs unless `CLONE_AI_RESIDENT_DAEMON=1` is explicit.

从 Finder 打开的构建没有环境变量，因此即使 `ai.clone.companion` 守护已在运行，窗口也会再拉起一个运行时——两个写者共享一本 Journal。现在窗口会向 launchd 询问任务是否已加载，已加载就附着；没有该任务的检出仍运行自己的运行时。开发构建除非显式设置 `CLONE_AI_RESIDENT_DAEMON=1`，否则保留私有运行时。

### A build-and-verify step gets 40 rounds, and interactive grading is honest

The native worker's default model-call budget rises from 12 to 40: App run
`91a50a87` wrote a working Forbidden City scene, used the browser tools, and was
then cut off at its 12th round with "reached its 12-round limit". The
Forbidden City checker in `--interactive` mode no longer grades video-only
fields (`browser.timeline-differs`, `setVideoTime`-based throughput,
`camera.keys`), so an interactive model is graded by orbit/zoom and its own
contract; the same workspace went from 23/28 to 26/27, the only miss being the
side pavilions the eval prompt never asked for.

构建并自证的步骤现在有 40 轮，交互评分不再考核视频字段

Native Worker 的默认模型调用预算从 12 提高到 40：App 运行 `91a50a87` 已经写出可用的
故宫场景并使用浏览器工具，却在第 12 轮被"reached its 12-round limit"切断。故宫检查器在
`--interactive` 模式下不再评视频专属字段（`browser.timeline-differs`、基于
`setVideoTime` 的吞吐、`camera.keys`），交互模型改由 orbit/zoom 与自身契约评分；同一
工作区从 23/28 变为 26/27，唯一未过的是评测提示词从未要求的左右配楼。

### Scanned PDFs and legacy .doc join through a native helper

A PDF with no text layer now falls back to Vision OCR, and a legacy `.doc` is
read with AppKit, through `CloneAIDocumentTool` — a Swift helper compiled into
the app that reads bytes on stdin and writes text on stdout. Nothing goes to a
cloud OCR service and no temp file is written. OCR renders pages at 2000 px,
tiles them into bands with row grouping (20 pages, 50k characters), and the
usual truncation notice applies; dense pages are usable but not perfect. The
helper is resolved from `CLONE_AI_DOCUMENT_TOOL` or beside the bundled Node; a
daemon without it refuses OCR/`.doc` with a reason. 742 tests, typecheck and the
regression gate pass; the compiled helper read a `textutil`-generated `.doc` and
OCR'd a scanned fixture into the expected sentences.

扫描件 PDF 现在会回退到 Vision OCR，旧式 `.doc` 由 AppKit 读取，二者都通过
`CloneAIDocumentTool`——编译进 App 的 Swift 助手从 stdin 读字节、向 stdout 写文本。不会
把文档送到云端 OCR，也不写临时文件。OCR 把每页渲染到 2000px、按条带识别并按行重组
（20 页、50k 字符），沿用现有截断提示；密集页面可用但不完美。助手从
`CLONE_AI_DOCUMENT_TOOL` 或打包 Node 的同级目录解析；没有它的守护进程会带原因拒绝
OCR/`.doc`。742 个测试、typecheck 与回归门均通过；编译后的助手读取了 `textutil` 生成的
`.doc`，并把扫描夹具识别成预期句子。

### The window restarts a stopped runtime and shows why

The desktop shell no longer ends at "本地运行时已停止" with an instruction to reopen the app. In the mode where the app spawns its own sidecar, an exit relaunches it with exponential backoff (1 s doubling to a 30 s cap) and the startup view shows the attempt and the last four stderr lines; a start that passes 30 s without `CLONE_AI_READY` is terminated and restarted. Both modes probe `/api/health` every 5 seconds — two misses restart the runtime, or make the window re-read the launchd endpoint — and a resident attach that finds no endpoint retries every 30 s instead of stopping after 60 s. A failed WebView load on a stale endpoint recovers immediately instead of showing a blank page.

桌面外壳不再停在「本地运行时已停止」并让用户重开应用。在 App 自己拉起 sidecar 的模式下，退出后会按指数退避重启（1 秒起翻倍、上限 30 秒），启动页显示重启次数与 stderr 最后四行；30 秒仍未打印 `CLONE_AI_READY` 的启动会被终止并重启。两种模式每 5 秒探测一次 `/api/health`——连续两次失败会重启运行时，或让窗口重读 launchd 发布的端点；常驻附着读不到端点时每 30 秒重试，而不是 60 秒后停下。陈旧端点导致 WebView 加载失败时立即恢复，而不是显示空白页。

### The app starts again after a raced journal event

A shared journal can contain a status transition one writer recorded and every later reader would refuse. The projection now reflects the recorded status instead of crashing, while live writers are still checked before they append. The desktop sidecar that had crashed in `hydrate()` on every launch starts and serves normally again; the illegal event stays in the journal as evidence.

共享 Journal 里可能有一条被某个写入者记录、而后来每个读者都会拒绝的状态转换。投影现在如实反映记录的状态，而不是崩溃；实时写入方在追加之前仍会被校验。此前每次启动都在 `hydrate()` 崩溃的桌面 sidecar 恢复正常启动与服务；非法事件留在 Journal 里作为证据。

### An isolated worktree carries untracked inputs

External steps run in a git worktree of the owner's project; `git worktree add`
materialised HEAD only, so a file the owner seeded but never committed
(`vendor/three.module.js`) was missing inside `~/.clone/isolated-workspaces/...`
and the worker aborted with "Required input missing". Untracked, non-ignored
regular files are now copied into the sandbox; tracked files stay at HEAD, and
ignored output and symlinks stay out. Tests:
`test/isolated-workspace.test.ts` 8/8, full suite 740/740, typecheck and gate
pass.

隔离 worktree 现在带上未被跟踪的输入

外部步骤运行在所有者项目的 git worktree 里；`git worktree add` 只物化 HEAD，所有者种下却
从未提交的文件（`vendor/three.module.js`）在 `~/.clone/isolated-workspaces/...` 中缺失，
Worker 以“Required input missing”中止。现在会把未被跟踪、未被忽略的普通文件复制进沙箱；
已跟踪文件停在 HEAD，被忽略的产物与符号链接不进入。测试：
`test/isolated-workspace.test.ts` 8/8，全套 740/740，typecheck 与 gate 通过。

### A one-query FPS capability benchmark, imported audit, and a rebuilt app

Added `benchmark/capability/shadowport-fps/`: a one-paragraph prompt, a
`setup.mjs` that generates a clean classic-script workspace, and an independent
17-check checker that drives the page's public `window.__game` hook (files,
runtime, hook, start, movement, shot damage, three relays, extraction, debrief,
console errors, external requests). Two clean from-scratch runs: the first
produced a playable game but its worker checked a stale preview port; the second
used the matching port, passed 17/17, and its worker used the browser tools with
zero tool errors (33 model calls, 744k tokens, 312.8 s, 8 enemies, three relays,
extraction, debrief). `scripts/import-audit.mjs` imports an isolated benchmark
Run into the owner's `~/.clone` journal, conversation history and invocation
ledger, so 审计与评估 shows it and `npm run audit:export` exports it. The macOS
app was rebuilt with the runtime changes (queued long builds, the last-two-round
budget notice, browser MCP, the 40-call fallback budget):
`dist/Clone AI-macOS-arm64.dmg` / `.zip`.

新增 `benchmark/capability/shadowport-fps/`：一段话提示词、生成干净 classic-script 工作区的
`setup.mjs`，以及驱动页面公开 `window.__game` 钩子的独立 17 项检查器（文件、运行时、钩子、
开始、移动、射击扣血、三处中继、撤离、结算、控制台错误、外部请求）。两轮干净从零运行：第一轮
产出了可玩游戏，但 Worker 查了过期的预览端口；第二轮用匹配端口，17/17 通过，Worker 使用浏览器
工具零错误（33 次模型调用、744k tokens、312.8 秒、8 个敌人、三处中继、撤离、结算）。
`scripts/import-audit.mjs` 把隔离评测 Run 导入所有者的 `~/.clone` Journal、对话历史与调用账本，
因此「审计与评估」能看到它，`npm run audit:export` 也能导出。macOS App 已用新的运行时改动
（长构建排队、最后两轮预算提示、浏览器 MCP、fallback 40 次预算）重建：
`dist/Clone AI-macOS-arm64.dmg` / `.zip`。


### Archived memories can be opened with one click and deleted for good

The memory panel's 已归档 count is now a control: clicking it filters the list to the archived set, and the selected card stays visibly pressed. Until now the archived set was only reachable through a status dropdown, and an archived memory could not be removed at all — the panel counted one while the `.md` file sat in `memory/archived/` with no control that could reach it. An archived memory now has a 删除 action: after a confirmation it unlinks both possible `.md` files and deletes the index row, search terms, version history and staged mutations in one transaction; the journal records `memory.deleted` with the summary before the files go. An active memory must be archived first, so the one irreversible action stays one deliberate step from the default view. The `.md` file remains the owner's; the audit of what was there remains in the journal.

记忆库的「已归档」计数现在是一个控件：点一下就把列表筛到归档集，被选中的卡片保持按下状态。此前归档集只能通过状态下拉框看到，而且归档记忆根本无法移除——面板数出一条，`.md` 文件却躺在 `memory/archived/` 里，没有任何控件能碰到它。归档记忆现在有「删除」动作：确认之后，在一个事务里删除两个可能位置的 `.md` 文件、索引行、检索词、版本历史与暂存变更；Journal 在删除文件之前记下 `memory.deleted` 与摘要。使用中的记忆必须先归档，使唯一不可逆的动作离默认视图保持一步。`.md` 文件仍然归所有者；对"那里曾有什么"的审计仍留在 Journal。

### The Agent-call audit can be searched and cleared

The **设置 → 审计与轨迹 → Agent 调用** list now searches the whole shared
invocation ledger on the server — request, reply, error, caller, workspace,
model and Run ids — and shows `显示 N / 共 M 条`. Delete appends a tombstone to
the append-only `~/.clone/audit/invocations.jsonl`: the original lines stay,
**含已删除** reveals hidden records, and one click restores them. **删除这 N 条**
applies only to the loaded filtered list and names the count. The **主 Agent
回合** tab also gained a search box. The focused suites, typecheck and the gate
pass; the full suite is 735/735 (one earlier run hit a WhatsApp-bridge
`EADDRINUSE` while another local preview server held its fixed port 4318;
unrelated to this change, and it passed once the port was free). Search, hide,
restore and the resulting ledger lines were exercised in the browser against
real records.

「设置 → 审计与轨迹 → Agent 调用」列表现在在服务端搜索整个共享调用账本——请求、回复、
错误、调用者、工作区、模型与 Run id——并显示「显示 N / 共 M 条」。删除只是向追加式的
`~/.clone/audit/invocations.jsonl` 追加墓碑：原始行保留，勾选「含已删除」即可看到隐藏记录并
一键恢复。「删除这 N 条」只作用于已加载的筛选结果并写明数量。「主 Agent 回合」标签页也增加了
搜索框。定向测试、typecheck 与 gate 全部通过；全量测试 735/735 通过（期间有一次运行在
另一个本地预览服务器占用其固定端口 4318 时触发 WhatsApp 桥 `EADDRINUSE`，与本次变更无关，
端口释放后通过）。搜索、隐藏、恢复与账本行已在浏览器里用真实记录验证。

### Long builds return at once, and the last two rounds are for the answer

A one-sentence game build no longer holds the chat turn. The Main Agent charter
and the `dispatch_task` description now send work expected to exceed a minute to
`propose_work_plan`, so the plan is queued and the owner gets control back. The
same one-paragraph FPS brief that previously spent ~50 minutes inside
`dispatch_task` (a 12-minute worker timeout, then planning, then an orphaned run
at the one-hour boundary) now reaches `waiting_review` in 211.9 s queued, and
487.9 s with the preview server running. The shared agent loop also reserves the
last two model rounds: it injects a budget notice to stop polishing, run only the
essential final check, and answer. A 60-round run that produced a complete,
browser-checked game but never answered now stops at 57 calls and returns a
summary. The final artifact is a 10-enemy, headshot-capable, three-relay
extraction FPS that passes the working agent's start/move/shoot/relay/extract
checks and loads from `file://` with zero external requests.

一句话游戏构建不再占住对话回合。主 Agent 章程与 `dispatch_task` 描述现在把预计超过一分钟的
工作交给 `propose_work_plan` 排队，所有者立即拿回控制权。同一段 FPS 简报原先在
`dispatch_task` 里耗约 50 分钟（12 分钟 Worker 超时、继续规划、一小时边界成为孤儿 Run），
现在排队后 211.9 秒到达 `waiting_review`，预览服务器启动时 487.9 秒到达。共享 Agent 循环还会
预留最后两轮模型调用：注入预算提示，要求停止打磨、只做最后的必要检查并回答。一次用满 60 轮、
产出了完整且经浏览器检查的游戏却没有回答的 Run，现在在 57 次调用时停下并返回总结。最终工件是
一个有 10 个敌人、支持爆头、三处中继撤离的 FPS，通过工作 Agent 的开始/移动/射击/中继/撤离检查，
并以 `file://` 打开、零外部请求。


### PDF and .docx join the attachments

The composer now accepts PDF and `.docx` files up to 10 MB each. The backend
extracts their text inside the turn — PDF through `unpdf` (MIT, about 3.1 MB,
lazy-loaded), `.docx` through a small built-in OOXML reader over `node:zlib` —
and treats the result like a text document: the model sees a delimited data
block, while the turn ledger keeps only a name/size manifest. Extracted text
shares the 50,000/100,000-character caps; a longer file keeps its first part
with an explicit truncation marker, and the completion notice tells the owner.
Image-only (scanned) PDFs now fall back to Vision OCR, and legacy `.doc` is read
through the same native helper (see above). No file is written to disk. The
picker, drag-and-drop and the native panel now accept `.pdf`, `.docx` and `.doc`.
The focused attachment and extraction tests, typecheck and the regression gate
pass; fixtures cover a text PDF, a `.docx` with XML entities, a scanned PDF,
truncation and a broken `.docx`.

### Text documents drop into a turn, and stay out of the ledger

The composer now takes text documents beside images and videos: `.md`, `.txt`,
`.csv`, `.json`, source and config files, and anything typed `text/*`, up to 4
attachments, 50,000 characters per document and 100,000 across documents. A file
can be picked from the panel or dropped anywhere in the window; the native
selector now allows `.text`, `.json` and `.csv`. The UI reads the file as text
and sends it; the Main Agent turns it into a delimited data block for that turn,
while the turn ledger and history keep only `[attached documents: …]` names and
sizes. PDF, Word and binary files are refused with a reason. 715 tests,
typecheck and the regression gate pass; the rebuilt app was exercised with a
picked document, a dropped document and a dropped image, and the intercepted
request carried both bodies without a model call.

### The packaged app is built from the code that was pushed

The window was running a 9 November bundle while the workspace had moved to 17 November:
`dist/Clone AI.app` carried an old `src/` and UI, and its Swift binary had no
`WKUIDelegate.runOpenPanelWith…` implementation, so the composer's paperclip did nothing.
The bundle is rebuilt from the working tree, and `npm run hooks:install` points Git at the
tracked `.githooks/` so every push to `main` that changes `src/`, `apps/desktop/`, the
package manifest or the macOS build script rebuilds the app first
(`CLONE_AI_SKIP_APP_BUILD=1` skips one). Verification: bundled `src/` and
`apps/desktop/ui/` are byte-identical to the workspace, the binary contains
`runOpenPanelWithParameters`, the rebuilt app served the composer, and uploading a PNG
through the file input produced a preview chip.

### Local browser verification, and a one-sentence FPS that clone-ai could check itself

A worker can now open the page it just wrote. `scripts/install-browser-mcp.mjs`
writes an enabled Playwright MCP server (`@playwright/mcp@0.0.85`) and a narrow
`127.0.0.1` read policy into the clone home; `scripts/serve-workspace.mjs`
serves the project read-only on loopback. Only the observation subset is
declared — navigate, console, snapshot, evaluate, screenshot, keyboard, resize,
wait, back, close — so `browser_run_code_unsafe`, file upload and drag/drop stay
invisible to the worker. The worker finally has eyes and hands for web work:
it can see console errors, assert page state, and leave the owner a screenshot.
`browser-mcp.ts` carries the declaration and merge logic, with 8 tests; a
provider-boundary bug found by the eval (assistant messages echoed dotted tool
names and the next request was rejected with a 400) is fixed and covered by 3
more tests.

The fallback work-order budget is now 40 model calls / 200 tool calls instead of
20 / 100. The same one-paragraph FPS brief produced a playable seven-enemy game
at 20 calls but stopped mid-verification; at 40 it produced ten enemies, headshot
damage, a reinforcement wave, cover state, crouch/slide/lean, grenades and
browser checks. The 40-call run outlived its execution claim before its final
report, so the artifact was functionally checked by the working agent, not
accepted on the worker's word. The single-file build
`eval-runs/2026-11-17-fps-cloneai/dist/shadowport.html` loads from `file://` with
zero external requests and no console errors; start, move, shoot, three relays,
extraction and debrief all work.

输入框现在接受 PDF 与 `.docx`，每个最大 10MB。后端在回合内提取正文——PDF 用 `unpdf`
（MIT，约 3.1MB，懒加载），`.docx` 用基于 `node:zlib` 的小型 OOXML 读取器——并像文本文档
一样处理：模型看到有边界的数据块，回合台账只保留文件名/大小清单。提取文本沿用
50,000/100,000 字符上限；更长文件保留前一部分并写入显式截断标记，完成后提示所有者。
纯图片（扫描件）PDF 现在会回退到 Vision OCR，旧式 `.doc` 也由同一原生助手读取（见上）。
不向磁盘写任何文件。选择器、拖拽与原生面板现在接受 `.pdf`、`.docx` 与 `.doc`。附件与
提取的聚焦测试、typecheck 与回归门均通过；夹具覆盖文本 PDF、带 XML 实体的 `.docx`、
扫描 PDF、截断与损坏的 `.docx`。

输入框现在在图片与视频之外接受文本文档：`.md`、`.txt`、`.csv`、`.json`、源码与配置
文件，以及任何 `text/*`，最多 4 个附件、每个文档 50,000 字符、合计 100,000 字符。文件
可从面板选择，也可拖入窗口任意处；原生选择器允许 `.text`、`.json` 与 `.csv`。UI 把文件
读成文本发送；Main Agent 在当前回合把它拼成有边界的数据块，而回合台账与历史只保留
`[attached documents: …]` 的名称与大小。PDF、Word 与二进制文件会带原因拒绝。715 个测试、
typecheck 与回归门均通过；重建后的应用用选择文档、拖入文档与拖入图片实测，被截获的请求
带着两份正文，且没有发起模型调用。

窗口里跑的是 11 月 9 日的包，而工作区已到 11 月 17 日：`dist/Clone AI.app` 里的 `src/`
与 UI 都是旧的，Swift 二进制也没有实现 `WKUIDelegate.runOpenPanelWith…`，因此输入框的
回形针点了没反应。现在安装包改从工作区重新构建；`npm run hooks:install` 让 Git 使用
纳入版本管理的 `.githooks/`，每次推送 `main` 且改动涉及 `src/`、`apps/desktop/`、包清单
或 macOS 打包脚本时先重打包（`CLONE_AI_SKIP_APP_BUILD=1` 可跳过单次）。验证：包内
`src/` 与 `apps/desktop/ui/` 与工作区逐字节一致，二进制含
`runOpenPanelWithParameters`，重建后的应用加载了输入框，经文件输入上传 PNG 后出现预览
缩略图。

一个 Worker 现在能打开它刚写好的页面。`scripts/install-browser-mcp.mjs` 会把启用的
Playwright MCP 服务器（`@playwright/mcp@0.0.85`）与一条很窄的 `127.0.0.1` 只读策略写进
clone home；`scripts/serve-workspace.mjs` 在环回上只读地服务项目。只声明观察子集——
导航、控制台、快照、求值、截图、键盘、缩放、等待、后退、关闭——因此
`browser_run_code_unsafe`、文件上传与拖放对 Worker 不可见。Worker 终于有了做 Web 工作的
眼睛和手：能看控制台错误、断言页面状态，并给所有者留下截图。`browser-mcp.ts` 承载声明与
合并逻辑，配 8 个测试；评测发现的一个 Provider 边界缺陷（assistant 消息回显带点号的工具名，
下一次请求被 400 拒绝）已修复，并新增 3 个测试覆盖。

fallback 工作单预算从 20 次模型调用 / 100 次工具调用提高到 40 / 200。同一段一句话 FPS 简报
在 20 次调用时产出了可玩的七敌人游戏，却在验收中途停下；40 次调用时产出了十个敌人、爆头伤害、
一波增援、掩体状态、蹲/滑铲/探头、手雷与浏览器自检。40 次调用那一轮在给出最终报告前丢了执行
领取，因此工件由工作 Agent 做功能检查，而不是凭 Worker 自述验收。单文件
`eval-runs/2026-11-17-fps-cloneai/dist/shadowport.html` 可从 `file://` 打开，零外部请求、
无控制台错误；开始、移动、射击、三处中继、撤离与结算均可用。


### The verifier reads negation, and naming `tests/` no longer demands a test run

A complete delivery was being failed for saying what it did *not* do. The
Forbidden City benchmark's plan wrote `不要声称 out/video.mp4 已生成` — do not claim
the MP4 exists — and `extractFileExpectations` read the negated path as a
promised file, failing a run whose 20 files, 6/6 tests and 21/21 external
checks had all passed. `mentionsTests` matched the bare word `tests`, so listing
`tests/` as a deliverable (or honestly recording that tests were not run)
triggered the test-evidence gate a file-only worker cannot satisfy.
`extractFileExpectations` now skips a path the clause before it says not to
claim, and `mentionsTests` requires a test *run* signal — `npm test passes`, a
run request in either language, or a shell command in a command context. Both
defects were reproduced as one-line calls before the fix and are now gate cases
(`negated-path-is-not-a-deliverable`,
`tests-named-as-deliverable-needs-no-test-evidence`) plus unit cases. Both files
are on the repair lane's protected list, so the owner authorized a hand fix,
recorded as an explicit exception in the trade-off entry. `npm test` is 688
tests, 688 pass; typecheck and `npm run gate` pass.

一次完整的交付因为写出了自己*没有*做什么而被判失败。故宫基准的计划里写着
`不要声称 out/video.mp4 已生成`，而 `extractFileExpectations` 把这个被否定的路径读成承诺文件，
于是一次 20 个文件、6/6 测试、21/21 外部检查全部通过的运行被判失败。`mentionsTests` 匹配裸词
`tests`，因此把 `tests/` 列为交付物（或诚实记录测试未运行）就触发了只有文件工具的 Worker 无法
满足的测试证据闸门。现在 `extractFileExpectations` 会跳过其前方分句明确说"不要声称"的路径；
`mentionsTests` 要求测试**运行**信号——`npm test 通过`、中英文运行请求、或命令语境中的 shell
命令。两个缺陷在修复前都用单行调用复现，现已成为门禁用例
（`negated-path-is-not-a-deliverable`、`tests-named-as-deliverable-needs-no-test-evidence`）
与单元用例。两个文件都在修复通道的保护清单里，因此由所有者授权人工修复，并在取舍条目中记为显式
例外。`npm test` 为 688 个测试、688 通过；typecheck 与 `npm run gate` 通过。

### The desktop app is the only product surface

The `clone-ai` command line, the headless server entry, the Docker/deployment
files and the developer query entry are removed. The macOS app — a native shell
over the loopback companion runtime — is now the only way to use the twin. Owner
actions that used to exist only in the CLI moved into the app: an authority
editor in **设置 → 权限与安全** (per-domain autonomy plus standing policies), an
unencrypted owner-data export in **设置 → 记忆与数据**, a bad-case tab and
improvement approvals in **设置 → 审计与评估**, and a cancel action on active
runs. The self-improvement loop keeps non-product entry points as npm scripts:
`npm run traces`, `npm run selfcheck`, `npm run repair` and
`npm run audit:export`; the launchd example and `AGENTS.md` rule 4 now use them.
The standalone WhatsApp bridge remains because the desktop 手机通道 panel
depends on it. The desktop's Agent page also no longer reads undefined
`providers`, `providerById`, `installed` or `missing` bindings, which blocked
the first refresh after the merge that introduced them. Trade-off:
[`docs/architecture/trade-offs.md`](docs/architecture/trade-offs.md).

移除 `clone-ai` 命令行、无界面服务器入口、Docker/部署文件与开发查询入口。macOS App——
原生外壳加环回 companion 运行时——是使用分身的唯一方式。原先只在 CLI 中存在的能力搬进
App：**设置 → 权限与安全** 的权限编辑器（按域自主档位与常设策略）、**设置 → 记忆与数据**
的未加密所有者数据导出、**设置 → 审计与评估** 的坏案例标签页与改进审批，以及取消正在运行
的 Run。自我改进环路保留非产品入口，改为 npm scripts：`npm run traces`、
`npm run selfcheck`、`npm run repair` 与 `npm run audit:export`；launchd 示例与
`AGENTS.md` 第 4 条已改用它们。独立 WhatsApp 网桥保留，因为桌面「手机通道」面板依赖它。
桌面的 Agent 页面也不再读取未定义的 `providers`、`providerById`、`installed` 与 `missing`
绑定——它们在引入该绑定的合并后阻塞了首次刷新。
取舍见 [`docs/architecture/trade-offs.zh-CN.md`](docs/architecture/trade-offs.zh-CN.md)。

### A Forbidden City 3D benchmark that grades the model against the world

`benchmark/capability/forbidden-city/` asks clone-ai to model the Forbidden
City's central axis with file tools only and grades it against an external
architectural contract: ten named halls with their historically correct roof
forms, the shared 三台, an axis within ±1 m, 961 m overall (±10 %), 64×37×35 m
太和殿 (±10 %), mirrored 体仁阁/弘义阁. The task exposes
`window.getForbiddenCityModel()` built from the same data as the geometry, and
`verify/check-forbidden-city.mjs` reads it from headless Chrome alongside
`node --test`, timeline screenshots, frame throughput and an optional 900-frame
render. It runs in two variants — a natural prompt and one that requires a
self-contained `propose_work_plan` step — so the report separates "the
specification reached the worker" from "the worker could model it". First
baseline: the natural variant produced **0 artifacts** (`dispatch_task` replaces
the task with a generic work order, and `buildInstructions` passes that
objective to the worker); the steered variant produced 20 files and passed
**21/21** checker checks plus a supervisor-rendered 900-frame video, yet its Run
was still marked `failed` because the file verifier read `不要声称
out/video.mp4 已生成` as a required file and `tests/` in prose triggered the
test-evidence gate. Analysis:
[`benchmark/capability/forbidden-city/ANALYSIS.md`](benchmark/capability/forbidden-city/ANALYSIS.md).

以上新增一个故宫 3D 基准：只给文件工具的 Worker 需按外部建筑契约建模紫禁城中轴线——十座
具名宫殿及历史上正确的屋顶形制、共用三台、轴线 ±1 m、总长 961 m（±10%）、太和殿
64×37×35 m（±10%）、体仁阁/弘义阁镜像对称。任务用与几何同源的
`window.getForbiddenCityModel()` 暴露模型，`verify/check-forbidden-city.mjs` 在无头 Chrome
里读取它，并运行 `node --test`、时间轴截图、帧吞吐与可选的 900 帧渲染。它跑两个变体——自然
提示，以及要求单个自包含 `propose_work_plan` step 的提示——以便报告把「规格是否到达 Worker」
与「Worker 能否建模」分开。首次基线：自然变体产出 **0 个工件**（`dispatch_task` 用通用工作
单元替换了任务，而 `buildInstructions` 把那个目标传给 Worker）；steered 变体产出 20 个文件、
通过 **21/21** 项检查并附主管渲染的 900 帧视频，但 Run 仍被判 `failed`，因为文件验证器把
`不要声称 out/video.mp4 已生成` 读成必需文件，且散文里的 `tests/` 触发了测试证据闸门。分析见
[`benchmark/capability/forbidden-city/ANALYSIS.zh-CN.md`](benchmark/capability/forbidden-city/ANALYSIS.zh-CN.md)。

### The Main Agent reads project instructions, memory edits are undoable, recall can synthesize, and consolidation proposes merges

Four gaps against Claude Code 2.1.319's memory architecture are closed, each through clone-ai's own governance rather than by copying the other product's model.

- **Project instructions.** The Main Agent now reads `AGENTS.md` / `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/*.md` from the workspace (`src/main-agent/project-instructions.ts`) and appends them to its system prompt under a labeled heading. Nothing in `src/` read either file before this — this repository's own `AGENTS.md` was invisible to clone-main. `@path` imports expand to depth 3 but only inside the workspace (a symlinked escape is refused), the total is capped at 64 KiB with a stated truncation, and `CLONE_AI_PROJECT_INSTRUCTIONS=0` turns the layer off. The prompt snapshot now records which files contributed.
- **Versioned memory and undo.** Every owner-visible change records the state before it in a `memory_versions` table (newest 20 per memory, written in the same transaction), and `MemoryGovernance.undo` restores the previous version as an ordinary `memory.updated` event with `source: "undo"`. A second undo walks one change further back. Exposed as `clone-ai memory versions <id>` / `clone-ai memory undo <id>`, `PATCH /api/memory/governed/:id` with `{ "undo": true }`, and a change list plus an undo button in the memory library.
- **Synthesized recall (opt-in).** `CLONE_AI_MEMORY_SYNTHESIS=1` lets the memory push ask the configured endpoint for one paragraph grounded in the top matches (`src/memory/synthesized-recall.ts`). The paragraph is discarded whole unless every cited id was among the memories it was given and every sentence carries a citation; it is never stored, never counted as a memory, never includes a `secret` memory, and the journal records `mode: "synthesize"`. Failures fall back to the plain list.
- **Consolidation proposals.** The improvement sweep now also proposes `merge` suggestions for same-type active memories at or above the measured 0.55 overlap threshold (`src/memory/consolidation.ts`), which finally gives `findConflicts` a production caller. A merge that would combine a statement with the one it explicitly replaced is never proposed; approving one authors the merged memory and archives the sources as `retired`, so it is undoable. The consolidator never writes memory itself.

`npm test` is 677 tests, 677 pass, 0 fail; `npm run typecheck` and `npm run gate` pass.

以上四项补齐了与 Claude Code 2.1.319 记忆架构之间的差距，每一项都走 clone-ai 自己的治理路径，而不是照搬对方的产品模型。

- **项目指令。** 主 Agent 现在读取工作区的 `AGENTS.md` / `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 与 `.claude/rules/*.md`（`src/main-agent/project-instructions.ts`），按带标注的标题追加到系统提示词。此前 `src/` 里没有任何代码读取这两个文件——本仓库自己的 `AGENTS.md` 对 clone-main 不可见。`@path` 导入展开深度 3，且只能在工区内（符号链接逃逸会被拒绝），总量上限 64 KiB 且截断会写明，`CLONE_AI_PROJECT_INSTRUCTIONS=0` 关闭整层。提示词快照现在记录哪些文件参与了。
- **记忆版本与撤销。** 每次所有者可见的变更都会把变更前的状态记入 `memory_versions` 表（每条最多 20 版，与变更同事务写入），`MemoryGovernance.undo` 以一条普通的 `memory.updated` 事件恢复上一版本并注明 `source: "undo"`。第二次撤销会再往前回退一次变更。入口是 `clone-ai memory versions <id>` / `clone-ai memory undo <id>`、`PATCH /api/memory/governed/:id`（`{ "undo": true }`），以及记忆库里的变更列表与撤销按钮。
- **合成召回（显式开启）。** `CLONE_AI_MEMORY_SYNTHESIS=1` 让记忆推送请已配置的端点依据靠前命中写一段话（`src/memory/synthesized-recall.ts`）。只有当它引用的每个 id 都在给过它的记忆内、且每句都带引用时，整段才被接受；它从不入库、从不计为记忆、绝不包含 `secret` 记忆，Journal 记录 `mode: "synthesize"`。失败退回普通列表。
- **巩固建议。** 改进扫描现在还会为同类型、重叠系数达到实测 0.55 阈值的活跃记忆提出 `merge` 建议（`src/memory/consolidation.ts`），终于让 `findConflicts` 有了生产调用方。会与它明确取代的那条陈述合并的组合绝不会被提出；批准后手写合并记忆并把来源以 `retired` 归档，因此可撤销。巩固器自己从不写记忆。

`npm test` 为 677 个测试、677 通过、0 失败；`npm run typecheck` 与 `npm run gate` 通过。

### The model endpoint is saved, so a Finder-launched app works

`config.json` now persists the OpenAI-compatible base URL and its key alongside the model, because a macOS app started from Finder has an empty environment and every turn used to fail. The environment still wins for one-off runs, and a missing endpoint fails with a message naming the variables. The settings API never returns the key — it reports `hasMainAgentApiKey` — `PATCH /api/config` validates the URL scheme, and applying a Magpie model pins the endpoint too. Owner JSON files are written 0600 and the desktop sidecar sets `umask 0o077`. Settings gains a manual endpoint + key form. `npm test` is 687 tests, 687 pass, 0 fail; typecheck and `gate` pass.

`config.json` 现在在模型之外持久化 OpenAI 兼容的基础地址与密钥，因为从 Finder 启动的 macOS App 环境为空，此前每个回合都会失败。一次性运行仍以环境变量为准，缺失端点会以点名变量的错误失败。设置接口绝不返回密钥——只报告 `hasMainAgentApiKey`——`PATCH /api/config` 校验 URL 协议，应用 Magpie 模型时也会固定端点。所有者 JSON 文件以 0600 写入，桌面 sidecar 设置 `umask 0o077`。设置页新增手填端点与密钥表单。`npm test` 为 687 个测试、687 通过、0 失败；typecheck 与 `gate` 通过。

### The runtime is a launchd job; the app is only a window

Quitting the desktop app no longer stops the twin. A per-user LaunchAgent (`ai.clone.companion`) now owns the companion process: `RunAtLoad` starts it at login, `KeepAlive` restarts it after a crash, and a 30-second throttle stops a crash loop. The app attaches to the endpoint the daemon publishes (`~/.clone/companion-endpoint.json`, honouring `CLONE_HOME` / `CLONE_AI_HOME` / `CLONE_AI_DATA_DIR`) and re-attaches when launchd restarts the job. `node scripts/install-daemon.mjs` installs, reloads or removes it (`--uninstall`); development mode keeps its in-process supervision behind `CLONE_AI_RESIDENT_DAEMON`. `npm test` is 684 tests, 684 pass, 0 fail; typecheck and `gate` pass.

退出桌面 App 不再停掉分身。按用户的 LaunchAgent（`ai.clone.companion`）现在拥有 companion 进程：`RunAtLoad` 登录即启动，`KeepAlive` 崩溃后重启，30 秒节流防止崩溃循环。App 附着到 Daemon 发布的端点（`~/.clone/companion-endpoint.json`，遵循 `CLONE_HOME` / `CLONE_AI_HOME` / `CLONE_AI_DATA_DIR`），并在 launchd 重启任务后重新附着。`node scripts/install-daemon.mjs` 负责安装、重载或卸载（`--uninstall`）；开发模式在 `CLONE_AI_RESIDENT_DAEMON` 之后保留进程内托管。`npm test` 为 684 个测试、684 通过、0 失败；typecheck 与 `gate` 通过。

### MCP config accepts both `env` shapes, a per-server timeout, and refuses duplicate ids

`mcp.json` now accepts `env` as either the MCP spec's variable-name list (`["GITHUB_TOKEN"]`) or the programmatic host's explicit values (`{"API_URL": "http://x"}`); the object form used to be silently dropped, so a server that needed a value started without it. A server may set `timeoutMs` instead of inheriting the client-wide timeout, because a slow tool and a quick one are different requests. Two servers with one id are refused with a clear error rather than shadowing each other. `npm test` is 650 tests, 650 pass, 0 fail; typecheck passes.

`mcp.json` 现在同时接受 `env` 的两种形态：MCP 规范里的变量名列表（`["GITHUB_TOKEN"]`）与程序化宿主的显式值（`{"API_URL": "http://x"}`）；对象形式此前被静默丢弃，需要值的服务器因此不带该值启动。服务器可以设置 `timeoutMs`，而不是继承客户端级超时，因为慢工具与快工具是不同的请求。同 id 的两个服务器会被明确拒绝，而不是互相遮蔽。`npm test` 为 650 个测试、650 通过、0 失败；typecheck 通过。

### Tokens are calibrated from the provider, not guessed

The token estimate was a character ratio, and a ratio is a property of the tokenizer: measured against this machine's gateway, the same Chinese sentence costs 265 tokens on `kimi-k3.1-pro` and 346 on `gpt-6.1-terra` (30% apart), and a code sample costs 2.0–2.6 characters per token where Latin prose costs 3.2–4.4. `src/agent/token-estimate.ts` now learns the real ratio from `usage.prompt_tokens`, starting at the lowest measured value (3.15) and smoothing each sample; every estimate reports whether it is `bootstrap` or `calibrated`. The loop feeds each response into the calibrator before the next compaction check, so the threshold reflects what the model actually charges. `npm test` is 649 tests, 649 pass, 0 fail; typecheck and `gate` pass.

token 估算此前是字符比例，而比例是 tokenizer 的属性：在本机网关上实测，同一句中文在
`kimi-k3.1-pro` 上是 265 token，在 `gpt-6.1-terra` 上是 346（相差 30%）；一段代码每 token
2.0–2.6 字符，而拉丁散文是 3.2–4.4。`src/agent/token-estimate.ts` 现在从
`usage.prompt_tokens` 学习真实比例，以实测最低值（3.15）起步并对每个样本平滑；每次估算都会报告
它是 `bootstrap` 还是 `calibrated`。循环在每次压缩检查前把响应喂给标定器，使阈值反映模型实际
收取的量。`npm test` 为 649 个测试、649 通过、0 失败；typecheck 与 `gate` 通过。

### Honest token accounting and a real MCP client

The loop now estimates tokens by character class — CJK and full-width punctuation one token each, Latin four characters per token — charges a fixed 1,568 tokens per image, and includes the tool schemas it re-sends every round. The native runtime no longer pre-truncates history: `buildHistory` had capped each record at 4,000 characters and the whole history at 12,000, so the transcript the loop measured never crossed the token threshold and compaction had never run in production. A compaction that removes nothing now ends the turn with `budget_exhausted` instead of being journalled again. The HTTP MCP transport performs the `initialize` / `notifications/initialized` handshake and reads a streamed SSE body event by event until the response id arrives; `mcpToolSpecs` can defer the whole declared table behind one `ToolSearch`-style loader. `npm test` is 648 tests, 648 pass, 0 fail; typecheck and `gate` pass.

循环现在按字符类别估算 token——中日韩文字与全角标点各一个 token，拉丁文每四个字符一个——每张
图片固定 1,568 个 token，并计入每轮重发的工具 Schema。原生运行时不再预截断历史：`buildHistory`
曾把每条记录截到 4,000 字符、整段历史截到 12,000，使循环测量到的转录永远越不过 token 阈值，
压缩在生产路径上从未执行。没有减少 token 的压缩现在以 `budget_exhausted` 结束回合，而不是再记
一条。HTTP MCP 传输执行 `initialize` / `notifications/initialized` 握手，逐事件读取流式 SSE 体
直到响应 id 到达；`mcpToolSpecs` 可以把整张已声明工具表延迟到一个 `ToolSearch` 式加载器之后。
`npm test` 为 648 个测试、648 通过、0 失败；typecheck 与 `gate` 通过。

### The remaining high and medium defects from the audit

Eleven confirmed findings closed, each with a reproduction that failed first. A standing-policy write could resurrect a revoked policy (two instances each computed the next config from their own copy); approvals now name the step they were issued for and a mismatch is a 409; `runQuery` and `dispatch_task` accept a cancellation signal, so a stopped turn stops the work it started; the loop retries `TimeoutError` but not `AbortError`, refuses malformed tool arguments instead of running the tool with `{}`, and treats `finish_reason: length` as a failed turn; MCP servers receive only the environment they declared, duplicate server and tool names are refused, framed output keeps its formatting, and a server's process group is killed; memory context caps each item at 400 characters and keeps the `type`/`status`/`createdAt` the builder classifies by. `npm test` is 646 tests, 646 pass, 0 fail; typecheck and `gate` pass.

审计中已确认的 11 条高危与中危缺陷已关闭，每条都有先失败的复现。策略写入可能复活已撤销的策略
（两个实例各自基于自己的副本算出下一份配置）；审批现在点名它签发时对应的步骤，不匹配返回 409；
`runQuery` 与 `dispatch_task` 接受取消信号，停止的回合会停掉它启动的工作；循环重试
`TimeoutError` 但不重试 `AbortError`，拒绝格式错误的工具参数而不是以 `{}` 运行工具，并把
`finish_reason: length` 当作失败回合；MCP 服务器只收到它声明的环境变量，重复的服务器名与工具名
被拒绝，包裹输出保留格式，服务器的进程组会被终止；记忆上下文每条上限 400 字符，并保留构建器用于
分类的 `type`/`status`/`createdAt`。`npm test` 为 646 个测试、646 通过、0 失败；typecheck 与
`gate` 通过。

### The repair lane repairs: token compaction now runs in production

clone-ai's own repair lane, driven by DeepSeek V4.1 Flash at `reasoning_effort=max`, produced the fix for the audit's most-referenced defect: token-aware compaction was unreachable because no caller passed `contextWindow`. The patch makes compaction always on, with a 128,000-token default, so no product surface can fall back to the character budget or truncate without an audit record. The working agent verified it functionally only: the regression case is red on the previous revision and green with the patch, and the full suite (634 tests), typecheck and `gate` pass. Getting there required fixing the lane itself — the worker now streams `model_call` / `tool_started` / `tool_completed` to the Kernel, the prompts name the files a trace names and say when to stop, the fix phase reads only the case this repair created, `read_file` returns windowed views with the total line count, and `write_file` refuses fragments that would discard most of an existing file. Those five fixes came from reviewing five live runs; the first of them destroyed `native-runtime.ts` by writing an 8,000-character prefix back over the file.

clone-ai 自己的修复通道，用 DeepSeek V4.1 Flash、`reasoning_effort=max` 驱动，产出了审计中引用最多的缺陷的修复：按 token 的压缩不可达，因为没有调用方传 `contextWindow`。补丁让压缩始终启用，默认 128,000 token 窗口，因此任何产品入口都不会退回字符预算、也不会在没有审计记录的情况下截断。工作 Agent 只做功能验证：回归用例在上一版为红、打补丁后为绿，全量套件（634 个测试）、typecheck 与 `gate` 通过。为此先修了通道本身——Worker 现在向 Kernel 流式上报 `model_call` / `tool_started` / `tool_completed`，提示词点名轨迹里的文件并说明何时停止，修复阶段只读本次修复产出的用例，`read_file` 返回带总行数的窗口视图，`write_file` 拒绝会丢弃文件大部分内容的片段。这五项修复来自对五次实机运行的审查；其中第一次把 8,000 字符的前缀写回，摧毁了 `native-runtime.ts`。

### Audit fixes: the boundary now matches the claim

A six-dimension audit against Claude Code 2.1.319 found 78 confirmed defects; the high-severity set is fixed. The per-call path gate now resolves both sides with `realpath`, so a symlink inside the workspace that points outside it is refused for reads and writes; read and write roots are checked separately (write implies read, never the reverse); a grant on a directory that contains a protected root is refused; case is folded on case-insensitive volumes; writes into a repository's `.git` are refused; and a path tool that yields no readable path is denied instead of skipping the check. A step's declared risk now caps which tools it is offered, so a `read_only` step no longer holds `write_file`. The repair lane's `refuse-existing` guard reaches `fileTools`, its worktree copies `node_modules` instead of symlinking the served checkout, and a round limit is a budget failure whether it came from the plan or the worker's default. Provider tool names are mapped to `[a-zA-Z0-9_-]` at both client boundaries, compaction keeps tool calls paired with their results, the request-body cap clears the attachment cap (a 300 KB image used to return 500), and `close()` destroys live connections so an open stream cannot block shutdown. The capacity gate transfers a released slot to its waiter synchronously, the native worker implements `cancel()`, and both MCP clients treat a half-closed stdin as a failed server rather than an uncaught EPIPE. The docs that claimed more than the code does were corrected: the Seatbelt profile is recorded as unused (the CLI workers it was written for are gone), the parity report marks Phase 2 partial, Phase 4 unreachable in production and Phase 5 without an entry point, the 58.5 baseline is labelled an estimate rather than a measurement, the README's "unrestricted host execution" claim (whose API returns 409) is replaced with what the native worker actually enforces, and `.env.example` names the real endpoint variables. `npm test` is 626 tests, 626 pass, 0 fail; typecheck and `gate` pass.

对照 Claude Code 2.1.319 的六维审计发现 78 条已确认缺陷；高危组已修复。逐次路径闸门现在用
`realpath` 解析两侧，工作区内指向外部的符号链接对读和写都被拒绝；读、写根分开检查（写蕴含读，
绝不反过来）；覆盖受保护根的授权被拒绝；在不区分大小写的卷上折叠大小写；拒绝写入仓库的
`.git`；路径工具解析不出路径时拒绝而不是跳过检查。步骤声明的风险等级限制可提供的工具，
`read_only` 步骤不再持有 `write_file`。修复通道的 `refuse-existing` 闸门到达 `fileTools`，
其 worktree 复制 `node_modules` 而不是链接服务检出，轮次上限无论来自计划还是 Worker 默认值
都报为预算失败。工具名在两个客户端边界映射为 `[a-zA-Z0-9_-]`，压缩保持工具调用与结果成对，
请求体上限高于附件上限（300 KB 的图片此前会得到 500），`close()` 销毁活动连接，打开的流不会
阻塞关停。容量闸门同步把释放的槽位转移给等待者，原生 Worker 实现 `cancel()`，两个 MCP 客户端
把半关的 stdin 当作失败的服务器而不是未捕获的 EPIPE。声称多于代码的文档已修正：Seatbelt profile 记为未使用（它为之编写的 CLI Worker 已不存在），
对齐报告标明阶段 2 部分实现、阶段 4 在生产路径不可达、阶段 5 没有入口，58.5 基线标为估计而非
测量，README 的"不受限主机执行"（其 API 返回 409）换成原生 Worker 实际执行的边界，
`.env.example` 写出真实的端点变量。`npm test` 为 626 个测试、626 通过、0 失败；
typecheck 与 `gate` 通过。

### The two lines merged: repair lane plus the shared loop

Local `main` (repair lane, self-check loop, settings surface, WhatsApp approvals) and `origin/main` (shared agent loop, native-only workers, capacity gate, MCP host, skills) were developed from the same base and had diverged. The merge keeps both: the repair lane now reports an unknown worker before provider construction, the owner-configured round budget reaches the shared loop, the credential-name policy and the write-before-answer rule are restored, and the local MCP client (explicit `mcp.json` enablement, per-tool risk, undeclared tools refused) is the one that remains. The black-box CLI workers are gone as agreed. `npm test` is 616 tests, 616 pass, 0 fail.

本地 `main`（修复通道、自检回路、设置页、WhatsApp 审批）与 `origin/main`（共享 Agent 循环、
仅原生 Worker、容量闸门、MCP 宿主、技能）从同一基座出发后分叉。合并保留了两者：修复通道现在
在构建 Provider 之前报告未知 Worker；所有者配置的轮次预算接入共享循环；凭据名策略与"先写再答"
规则已恢复；保留本地 MCP 客户端（`mcp.json` 显式开启、逐工具声明风险、未声明工具拒绝）。
黑盒 CLI Worker 按约定移除。`npm test` 为 616 个测试、616 通过、0 失败。

### Regression cases run in the default checks

`npm test` now includes `test/regression/*.test.ts`, so the cases produced by the repair lane run in CI instead of only inside a repair run. The memory panel also stops repainting while the owner is typing, even when the poll carries changed data (an unrelated memory's timestamp, or a recall count); previously only an unchanged payload was skipped. `write_file` once again replaces existing files for ordinary tasks — the refusal that protects the repair lane is now a per-worker mode (`CLONE_AI_NATIVE_WRITE_FILE=refuse-existing`), because create-only had removed the ability to regenerate a file.

`npm test` 现在包含 `test/regression/*.test.ts`，修复通道产出的用例因此进入 CI，而不再只在修复运行时执行。记忆面板在所有者输入期间也不再重绘，即使轮询带来了变化的数据（另一条记忆的时间戳或召回计数）；此前只有数据完全未变时才会跳过。`write_file` 对普通任务重新可以替换已有文件——保护修复通道的拒绝逻辑改为按 Worker 的模式（`CLONE_AI_NATIVE_WRITE_FILE=refuse-existing`），因为只允许新建曾使重新生成文件变得不可能。

### Two desktop defects fixed through the repair lane

The 3-second background refresh no longer rebuilds `#memory-root`: the memory library paints only when its markup actually changes, so a focused search box keeps focus and an unsaved editor keeps its text. The sidebar now renders the "已隐藏" group (with its restore control) even when no session is visible, so hiding the only conversation no longer leaves it unreachable. Both patches were produced by `clone-ai repair` with the native worker on Magpie DeepSeek V4.1 Flash; the working agent made mechanical adjustments so the generated cases satisfy the repository's typecheck and bilingual-comment rules. The native worker's `write_file` also refuses an existing path now — changes go through `edit_file` — because a whole-file rewrite turned `app.js` into an 8 KB fragment in one attempt and removed 127 lines of `audit.js` in another. A repair may also not delete more than 40 production lines: `fix-too-large` refuses a rewrite that keeps a narrow case green while deleting the rest of the file, which is exactly what two retry runs did to `memory.js` (127 lines) and `audit.js` (315 lines).

每 3 秒的后台刷新不再重建 `#memory-root`：记忆库只在标记真的变化时才重绘，因此聚焦的搜索框保持焦点，未保存的编辑器保留正文。侧栏在没有可见会话时也会渲染“已隐藏”分组及其恢复入口，隐藏唯一的对话不再让它无法恢复。两个补丁都由 `clone-ai repair` 使用 Magpie DeepSeek V4.1 Flash 的原生 Worker 产出；工作 Agent 做了机械调整，使生成的用例满足仓库的类型检查与双语注释规则。原生 Worker 的 `write_file` 现在拒绝已有路径——修改必须通过 `edit_file`——因为一次尝试把 `app.js` 整文件重写成了 8 KB 片段，另一次删掉了 `audit.js` 的 127 行。一次修复也不得删除超过 40 行生产代码：`fix-too-large` 会拒绝“窄用例变绿、文件其余部分被删掉”的重写，这正是两次重试对 `memory.js`（127 行）与 `audit.js`（315 行）做的事。

### A repair is only fixed when its case passes after the fix

`clone-ai repair` now re-runs the hashed regression cases after the fix phase and stops with `regression-still-red` if any of them still fails, recording the result as `regressionAfter` in the report. Previously it ran only the top-level suite and the typecheck, and in this repository the suite does not include `test/regression/`, so a fix that changed nothing could be reported as fixed. Staging now removes the runtime scratch the lane and a worker create (`node_modules`, `.probe/`, `.rsi/`, `.clone/`, `.work-orders/`, `.verification-baseline*`, `*.log`, `*.tmp`) while still showing every other change, including a new protected file, to the protected-path gate. The native worker also gains `edit_file`, which replaces exactly one excerpt and refuses an edit that would shrink a file below a tenth of its size, so a one-line fix to a large UI script cannot replace it with a fragment.

修复只有在修复后用例通过时才算 fixed。`clone-ai repair` 现在在修复阶段之后重跑已哈希的回归用例，任一仍失败就以 `regression-still-red` 停止，并在报告中记录 `regressionAfter`。此前它只跑顶层套件与类型检查，而本仓库的套件不包含 `test/regression/`，因此一个什么都没改的修复也可能被报成 fixed。暂存现在会移除通道与 Worker 创建的运行期临时物（`node_modules`、`.probe/`、`.rsi/`、`.clone/`、`.work-orders/`、`.verification-baseline*`、`*.log`、`*.tmp`），同时仍把其他所有改动——包括新的受保护文件——呈现给保护路径闸门。原生 Worker 还新增 `edit_file`：只替换一处精确片段，并拒绝把文件缩到不足十分之一的编辑，使大型 UI 脚本的一行修复不会把它替换成片段。

### Repair-lane workers get explicit budgets and a focused brief

The native worker now reads `CLONE_AI_NATIVE_MAX_ROUNDS` and `CLONE_AI_NATIVE_MAX_TOKENS` (unset keeps the previous defaults), so a repair step can be given enough rounds to read the failing code and write a patch without letting one runaway completion hold the step for minutes. The phase-1 plan asks for a small failing reproduction before broad exploration and forbids probe files under `test/regression/`; phase 2 reads only the failing case and the production file it exercises, leaves no scratch files, skips the trade-off entry (the working agent wrote it) and is told it has no shell tool. The changes were measured against a real Magpie worker: a first run wrote no file at 12 rounds, a 24-round run wrote only a passing probe, and a 32-round phase 1 finally produced a red case; that run also exposed a lane gate hole (recorded in `docs/engineering/optimizations.md`).

原生 Worker 现在读取 `CLONE_AI_NATIVE_MAX_ROUNDS` 与 `CLONE_AI_NATIVE_MAX_TOKENS`（未设置时保留原默认值），使修复步骤既能有足够轮次读失败代码并写补丁，又不会让一次失控的补全把步骤拖住数分钟。第一阶段计划要求先写一个小的失败复现再做广泛探索，并禁止在 `test/regression/` 留下探针文件；第二阶段只读失败用例与它覆盖的生产文件、不留临时文件、不写取舍条目（工作的 Agent 已写好），并被告知没有 shell 工具。这些改动用真实的 Magpie Worker 实测：第一次 12 轮没有写出文件，24 轮的运行只写了一个会通过的探针，32 轮的第一阶段终于产出了红色用例；该运行同时暴露了通道的一个闸门漏洞（记录在 `docs/engineering/optimizations.md`）。

### Settings feel like one surface, and dispatch is visible

The settings navigation is now a real tab list — arrow/Home/End keys, `aria-selected`, per-panel scroll memory, a 160 ms panel entrance that respects `prefers-reduced-motion`. The historical "local providers" registry is gone; each worker row carries its provider's installed state, command, execution boundary, effort select, install action and host-access action. A run's audit detail now includes "Worker 派发": which worker each step went to, its provider, the routing source (explicit / rule / memory / description) and the reason; plan rows name the worker that runs the step.

设置导航现在是真正的 tab 列表——方向键与 Home/End、`aria-selected`、逐面板记忆滚动、160ms 面板入场并尊重 `prefers-reduced-motion`。历史的「本地 Provider」清单已移除；每个 Worker 行携带其 Provider 的安装状态、命令、执行边界、强度选择、安装与 host-access 操作。Run 审计详情新增「Worker 派发」：每步去了哪个 Worker、Provider、路由来源（显式/规则/记忆/描述）与理由；计划行点名执行该步骤的 Worker。
### Repair is a clone-ai Run, and tools can come from MCP

`clone-ai repair` now performs the fix as a real Kernel Run instead of a script driving another CLI: it accepts a trigger from the failed traces, attaches a two-phase plan (write the regression case, then fix the code), and dispatches both phases to a configured worker, so approvals, budgets, evidence, verification and the journal apply to the repair itself. The lane keeps the nightly rules by importing `scripts/nightly-rsi-policy.mjs` and `scripts/nightly-rsi-state.mjs` — the regression case must be observed red before the fix, the case files are hashed at that moment and compared after it (a deletion counts), and the staged diff may not touch a protected path — and it creates an isolated git worktree, commits a branch, and never merges or pushes. A failed repair keeps its worktree and leaves the trace eligible.

MCP servers are a second tool source, off by default: `<clone home>/mcp.json` enables a server explicitly and must declare a risk for each tool. Declared tools reach the native worker through the same `decideTool` gate as built-in tools, path-taking tools are checked per call, and output is framed as untrusted observation. CLI providers receive `--mcp-config` only when their recipe declares the flag (Claude Code does); every other provider falls back to built-in tools.

`clone-ai repair` 现在把修复做成真实的 Kernel Run，而不是脚本驱动另一个 CLI：从失败轨迹接受 Trigger，挂上两阶段计划（先写回归用例，再修代码），两阶段都派发给已配置的 Worker，因此审批、预算、证据、验证与 Journal 都适用于这次修复。通道通过导入 `scripts/nightly-rsi-policy.mjs` 与 `scripts/nightly-rsi-state.mjs` 保留夜间规则——回归用例必须在修复前被观察到为红，此刻对用例文件取哈希并在修复后比较（删除也算变更），暂存差异不得触碰保护路径——同时创建隔离 git worktree、提交分支，绝不合并或推送。失败的修复会保留 worktree，并让轨迹保持可再修状态。

MCP 服务器是第二个工具来源，默认关闭：`<clone home>/mcp.json` 必须显式启用服务器，并为每个工具声明风险。已声明的工具与内建工具一样经过 `decideTool` 闸门到达原生 Worker，带路径的工具逐次核对，输出按不可信观察包裹。CLI Provider 只有在其配方声明了该开关时才会收到 `--mcp-config`（Claude Code 已声明）；其余 Provider 回退到内建工具。

### The agent attacks its own boundaries and records every round

`clone-ai selfcheck` runs 15 deterministic adversarial probes (untrusted WhatsApp wrapping, forwarded approval refusal, approval replay/expiry/re-issue, sender rate limit, protected paths, symlink escape, worker-env credentials, trace redaction, digest tampering, trace assembly), the deterministic gate, and optionally the full suite. Each round is journaled as `selfcheck.completed` and saved under `~/.clone/selfcheck/`; the evaluation tab shows the latest round, the red probes with the attack, the gate tail, and recent history. A red round exports its failures as traces; `--repair` hands them to the repair lane, which now commits a branch through a real Kernel Run and still never merges.

`clone-ai selfcheck` 运行 15 个确定性对抗探针（WhatsApp 非授信包裹、转发审批拒绝、审批重放/过期/重发、发送者限流、受保护路径、符号链接逃逸、Worker 环境凭据、轨迹脱敏、摘要篡改、轨迹组装）、确定性门禁，以及可选的完整测试。每一轮以 `selfcheck.completed` 写入 Journal 并保存在 `~/.clone/selfcheck/`；评估页显示最近一轮、失败探针及其攻击方式、门禁尾巴与历史。红色的一轮会导出失败轨迹；`--repair` 把它们交给修复通道，后者通过真实的 Kernel Run 提交一个分支，仍然绝不合并。

### Self-check and push command

`npm run selfcheck:push` refuses a dirty worktree, runs the full deterministic
suite, typecheck and regression gate, fetches `origin/main`, refuses to push
when the branch is behind, and otherwise pushes the current `main`. It never
commits or force-pushes.

`npm run selfcheck:push` 会拒绝脏工作区，依次运行完整确定性测试、类型检查与回归门禁，
拉取 `origin/main`，落后时拒绝推送，否则推送当前 `main`。它不会自动提交，也不会强推。

### Shared audit for every Agent invocation

Every call into the Main Agent now writes a shared invocation record under
`~/.clone/audit/invocations.jsonl`, independent of `CLONE_HOME`. The audit view
has an **Agent invocations** tab showing caller, request, visible reply, error,
model, effort, Run ids and duration. CLI, desktop and WhatsApp callers are
labelled; secrets are redacted and private reasoning is never stored.

每次 Main Agent 调用现在都会写入 `~/.clone/audit/invocations.jsonl` 下的共享调用记录，
不受 `CLONE_HOME` 影响。审计页新增 **Agent 调用** 页签，显示调用者、请求、可见回复、
错误、模型、强度、Run id 与耗时。CLI、桌面与 WhatsApp 调用都会标明来源；密钥会脱敏，
模型私有推理不会保存。

### Avoid false file expectations

The verifier excludes code identifiers, URLs and constant-directory paths from
file expectations. Root-level filenames now require an explicit file-intent
word in the same sentence and an allowed extension.

验证器不再把代码标识符、URL 和常量目录路径当作必需文件。根级文件名现在要求同一句
中有明确文件意图词，且扩展名在允许列表中。

### Avoid repeating successfully repaired traces

Nightly RSI records each successfully handled trace's runId and exact-file SHA-256 in
`rsi/consumed-traces.json`. Unchanged traces are skipped; changed content and failed
repairs remain eligible. Corrupt state is treated as empty and write failures only warn.

夜间 RSI 在 `rsi/consumed-traces.json` 中记录成功处理的轨迹 runId 与文件 SHA-256；
内容未变的轨迹会跳过，内容改变或修复失败的轨迹仍可处理。状态损坏时按空状态处理，写入失败只警告。


### Conservative recovery for orphaned planning

An unplanned Run left in planning for more than 15 minutes is marked failed
only when it has no live claim. A conditional fenced write protects concurrent
plans and cancellations; stores without that capability leave the Run alone.

没有计划的 Run 若在规划阶段超过 15 分钟未更新，只有在没有存活领取时才会被标记为失败。
带条件的围栏写入保护并发生成的计划和取消操作；不支持该能力的存储不会处理这类 Run。

### Approve external actions from WhatsApp

A run paused on `external_side_effect` or `irreversible` can now be answered from the phone. The bridge polls paused runs, issues an eight-character code bound to one run and step, sends it to the allowlisted number, and handles `APPROVE <code>` / `REJECT <code>` itself — never as a Main Agent turn. Codes expire in ten minutes, are stored only as a salted hash, are replaced when a new one is issued, and a forwarded message can never approve anything. The request is journaled as `approval.requested`; the decision stays `approval.granted`.

停在 `external_side_effect` 或 `irreversible` 上的 Run 现在可以在手机上作答。桥会轮询暂停的 Run，签发绑定唯一 Run 与步骤的八位编号并发到白名单号码，并自己处理 `APPROVE <编号>` / `REJECT <编号>`——不会变成 Main Agent 的一轮。编号十分钟过期、只保存加盐哈希、签发新编号使旧编号失效，转发消息永远不能批准任何事。请求记为 `approval.requested`，决定仍是 `approval.granted`。


### An offline regression gate

`npm run gate` now runs on every CI commit and costs nothing. It re-runs evidence verification and authority policy over held-out fixtures under `benchmark/gate/`, and calibrates the audit projection against owner labels (agreement, falsePass, falseFail) using the fixture dataset or a real `clone-ai audit export` file with `--audit`. Per-case behavior is recorded in `benchmark/gate/baseline.json`; any verdict change fails until the baseline is regenerated in the same change, so a shift is reviewed rather than discovered later. The audit dataset is hashed so held-out records cannot change silently.

`npm run gate` 现在随每次 CI 提交运行且零成本。它针对 `benchmark/gate/` 下的 held-out 夹具重新运行证据验证与权限策略，并用所有者标注校准审计投影（一致率、假通过、假失败）——数据集可以用内置夹具，也可以用 `--audit` 传入真实的 `clone-ai audit export` 文件。逐用例行为记录在 `benchmark/gate/baseline.json`；任何判定变化都会失败，直到在同一次变更中重新生成基线，因此变化会被审查而不是日后才发现。审计数据集带哈希，held-out 记录无法悄悄变化。

### Prompt provenance for every Main Agent turn

Every Main Agent turn now records what it was told before it answered: the charter version and hash, the compiled situation briefing hash, the exact tool table hash, and the model id plus reasoning effort. Identical material is stored once in `<clone home>/prompt-snapshots/<hash>.json`; each turn appends a `main_agent.prompt_snapshot` journal event that points at it and, for desktop turns, carries the turn id. `GET /api/main-agent/prompt-snapshots` lists recent snapshots. Recording is telemetry: a write failure is logged and never aborts the turn.

每次主 Agent 回合现在会记录它在回答前收到的输入：charter 版本与哈希、编译后情境简报的哈希、完整工具表的哈希，以及模型 id 与推理强度。相同材料只保存一份到 `<clone home>/prompt-snapshots/<hash>.json`；每轮追加一条 `main_agent.prompt_snapshot` Journal 事件指向它，桌面回合还会带上 turn id。`GET /api/main-agent/prompt-snapshots` 可列出最近的快照。记录属于遥测：写入失败只记日志，绝不中断本回合。

### Headless server deployment

Clone AI can now run without a Mac on a small Linux host. `npm run server` starts the same Runtime and UI in explicit server mode with a stable bearer token and a proxy-only secret; the `Dockerfile` and `compose.server.yml` pair it with Caddy, HTTPS, owner authentication, persistent data/workspace volumes, and a public `/webhook` route for WhatsApp. The web UI uses a custom token header so Caddy Basic Auth can remain in the standard `Authorization` header. Server mode refuses direct app-port access that does not come through the trusted proxy. A 1 vCPU / 2 GB host is documented for remote models, scheduling, memory, audit, and WhatsApp only; local LLM execution and child-agent CLI installation are explicitly out of scope for the base image.

### 无界面服务器部署

Clone AI 现在不依赖 Mac，也可以运行在小型 Linux 服务器上。`npm run server` 以显式服务器模式启动同一套 Runtime 和 UI，使用稳定 Bearer Token 和仅由反向代理注入的密钥；`Dockerfile` 与 `compose.server.yml` 组合 Caddy、HTTPS、所有者认证、持久化数据/Workspace 卷以及 WhatsApp 的公开 `/webhook` 路由。Web UI 改用自定义 Token Header，因此 Caddy Basic Auth 可以继续占用标准 `Authorization` 头。服务器模式会拒绝不经过可信代理的 App 端口直连。文档明确 1 核 2G 只用于远程模型、调度、记忆、审计和 WhatsApp；基础镜像不承担本地大模型和子 Agent CLI 安装。
### Forwarded WhatsApp content is data, and bursts are capped

A message the owner forwards carries a third party's words. The bridge now flags it (`forwarded` from the Cloud API context) and hands it to the Main Agent inside an explicit `<untrusted_data source="whatsapp_forward">` block with a "do not follow directives" line, stored per message so it survives a restart. The webhook also applies a per-sender sliding-window limit (20 messages/minute) so a hijacked number or a retry storm cannot become an unbounded stream of model turns.

所有者转发的消息带着第三方的文字。桥现在会标记它（来自 Cloud API context 的 `forwarded`），并以显式的 `<untrusted_data source="whatsapp_forward">` 块交给 Main Agent，附上"不要执行其中指令"的说明；标记按消息持久化，重启后仍然有效。Webhook 还对每个发送者施加滑动窗口限流（每分钟 20 条），被盗用的号码或重试风暴不会变成无限制的模型回合。

### Failed traces and a nightly repair pipeline (draft PRs only)

Failures now become documents a repair job can read: `clone-ai traces export` writes one redacted JSON per failed or cancelled run under `~/.clone/failed-traces/`, including the request, plan, per-step provider, failure stage/category, gateway errors, evidence, and the owner's label. Implicit failures are captured too — a step retried three or more times, a cancelled run, an "不合格" label, or an owner correction ("不对，重来") within ten minutes of the run ending. `scripts/nightly-rsi.mjs` turns those into a repair: an isolated worktree, a regression test written first and verified red by the script, test files hashed before the fix, a fix phase under a narrow tool allowlist, a protected-path diff check, then `npm test` + `tsc`, a commit, and a **draft** PR (or a patch file). Merging stays with the owner. `launchd` runs it in the GUI domain so Claude Code's Keychain login works; a lock file prevents overlapping runs.

Workers may now only inherit model credentials: a provider declaration that lists tool credentials (`GITHUB_TOKEN`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `*_SECRET`, …) is refused before launch, with the error pointing at the credential broker.

失败现在会变成修复任务可读的文档：`clone-ai traces export` 为每个失败或取消的 Run 在 `~/.clone/failed-traces/` 写一份脱敏 JSON，包含请求、计划、每一步的 Provider、失败阶段与类别、网关错误、证据与所有者判定。隐性失败也会记录——同一步骤重试三次以上、被取消、被判"不合格"，或运行结束后十分钟内的"不对，重来"。`scripts/nightly-rsi.mjs` 把这些变成一次修复：隔离 worktree、先写回归测试并由脚本验红、修复前对测试文件做哈希、窄工具白名单下修复、受保护路径 diff 检查，然后 `npm test` + `tsc`、提交、**草稿** PR（或补丁文件）。合并权仍在所有者。`launchd` 在 GUI 域运行以读取 Claude Code 的钥匙串登录；锁文件防止重叠运行。

Worker 现在只能继承模型凭据：Provider 声明里若出现工具凭据（`GITHUB_TOKEN`、`AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS`、`*_SECRET` 等），会在启动前被拒绝，错误信息指向凭据代管。

### AI self-review with one-click, reversible configuration changes

The evaluation tab can now have the system review its own audit: pass rate, failure stages and categories, gateway errors, durations, costs, and the owner's labels are compressed into one digest, and a review model returns findings plus a short list of configuration actions. Each action is validated against what this machine can actually do (a level the CLI declares, a model id that appears in the facts), applied only when the owner clicks, journaled as `recommendation.applied` with the previous and new value, and reversible from the same row. The surface is deliberately narrow — worker model/effort and Main Agent model/effort; code, prompts, policy and evidence rules are not reachable, and nothing runs on its own. When the model is unavailable the review degrades to measured facts rather than inventing advice.

评估页现在可以让系统评审自己的审计：通过率、失败阶段与类别、网关错误、耗时、费用，以及所有者的判定被压成一份摘要，评审模型返回发现项与一小串配置动作。每个动作都会对照这台机器实际能做的事校验（CLI 声明的档位、事实里出现过的模型 id），只在所有者点击时应用，以 `recommendation.applied` 记录前后值，并可在同一行撤销。范围刻意很窄——worker 的模型/强度与主 Agent 的模型/强度；代码、提示词、策略与证据规则不可触及，且不会自行运行。模型不可用时，评审判为只给实测事实，而不是编造建议。

### WhatsApp phone bridge

The owner can now text Clone AI from WhatsApp without SMS or a direct inbound port on the Mac. A separate loopback bridge verifies Meta's raw webhook signature, enforces an E.164 allowlist, stores messages in SQLite before returning `200`, deduplicates Meta retries by message id, and forwards visible replies through the Cloud API. Long replies are split below the 4096-character limit. If the desktop runtime is closed or busy, the message stays queued with backoff and the owner is told it was not executed; the same turn id prevents a completed request from running twice. `npm run mobile:install` creates an optional per-user LaunchAgent with its secrets in a `0600` env file. Apple provides no supported iMessage bot API, so WhatsApp is the implemented phone channel; Meta's current message pricing still applies.

The Mac app now exposes a **Connect phone** entry in the sidebar and a **Phone channel** settings wizard. It writes the Cloud API credentials to a `0600` env file, starts or stops the bridge, verifies Meta credentials, installs `cloudflared` through Homebrew only after confirmation, starts/stops the HTTPS tunnel, copies the Webhook URL and Verify Token, and shows the live binding checklist. Access Token and App Secret are never returned to the UI.

### WhatsApp 手机通道

所有者现在可以从 WhatsApp 给 Clone AI 发文字，不依赖短信，也不需要把 Mac 的端口直接暴露到公网。独立的回环桥会验证 Meta 原始 Webhook 签名、执行 E.164 白名单、先写入 SQLite 再返回 `200`、按 message id 去重，并通过 Cloud API 发送可见回复。长回复会按 4096 字符上限切分。桌面 Runtime 关闭或正忙时，消息会退避排队，并明确提示“尚未执行”；相同回合 id 保证已完成的请求不会再次调用模型。`npm run mobile:install` 可安装当前用户的 LaunchAgent，密钥保存在 `0600` 环境文件中。Apple 没有受支持的 iMessage 机器人 API，因此已实现的是 WhatsApp 通道；Meta 当前的商业消息计费规则仍然适用。

Mac App 现在在侧栏提供 **连接手机** 入口，并在设置中提供 **手机通道** 向导：保存 Cloud API 凭据到 `0600` 文件、启动或停止手机桥、验证 Meta 凭据、在明确确认后通过 Homebrew 安装 `cloudflared`、启动或停止 HTTPS 隧道、复制 Webhook 地址和 Verify Token，并实时显示绑定清单。Access Token 与 App Secret 永远不会返回到 UI。

### Tasks stay inside the conversation that spawned them

A run the Main Agent proposed during a chat is now a **child task of that conversation**, not a second conversation beside it. The sidebar shows the relation (the chat says how many tasks it owns, each task says 子任务 and is indented under its parent), hiding the conversation hides its children in the same step with a confirmation that names the count, and a "已隐藏" row lets the owner restore the conversation together with exactly the tasks that went with it. Deleting a task on its own leaves the conversation alone.

主 Agent 在对话中提案的 Run 现在是该对话的**子任务**，而不是旁边另一个对话。侧栏把这个关系画出来（对话显示自己有几个任务，任务标为"子任务"并缩进在父级之下），隐藏对话会在同一步连带隐藏子任务，确认框会说明数量；「已隐藏」一行可把对话连同当初一起隐藏的任务精确恢复。单独删除某个任务不影响对话。


### Effort, readable traces, and a daemon that reports back

A model's reasoning effort can now be chosen per worker and for the Main Agent. The gateway reports the levels each model actually offers (`reasoning_levels`), worker providers declare the levels their CLI accepts, and the settings page offers only those: Claude Code gets `--effort`, Codex `-c model_reasoning_effort=…`, Pi `--thinking`. `clone-ai effort <worker> <level>` pins it from the CLI; `config.json` `mainAgentEffort` (or `CLONE_AI_MAIN_EFFORT`) sets it for the Main Agent. Verified against the real CLIs: Claude Code with `--effort high` and Pi with `--thinking medium` both completed; Codex accepts the config override.

Every run can be read end to end: `GET /api/runs/:id/trace` returns the run's whole journal in order with a plain-language label and detail for each event, and the audit view renders it (完整轨迹, raw payload one level down). Events that used to read "Recorded in the local journal." now say what happened (status, plan steps, which provider ran, evidence, verification, memory used).

A guardian now reports background work back into the conversation: when a run settles, the daemon writes a one-line update that the chat shows as a message, and the Main Agent's briefing lists recently finished work with evidence counts — so the next turn starts from the result, not from a status colour.

Sidebar previews are plain text and strictly one line with an ellipsis; markdown from the model no longer leaks into the list. The empty conversation dropped its three starter cards.

### 强度、可读的轨迹，以及会回报的后台

每个 worker 和 Main Agent 现在都可以选择推理强度。网关会报告每个模型实际支持的档位，worker provider 声明各自 CLI 接受的档位，设置页只列出这些：Claude Code 用 `--effort`，Codex 用 `-c model_reasoning_effort=…`，Pi 用 `--thinking`。CLI 用 `clone-ai effort <worker> <level>` 固定；`config.json` 的 `mainAgentEffort`（或 `CLONE_AI_MAIN_EFFORT`）设置主 Agent。已对真实 CLI 验证：Claude Code `--effort high` 与 Pi `--thinking medium` 均完成；Codex 接受该配置覆盖。

每个 Run 都可端到端阅读：`GET /api/runs/:id/trace` 按顺序返回该 Run 的全部 Journal 事件，每条都有可读的标题与说明，审计页渲染成「完整轨迹」（原始数据在下一层）。过去显示 "Recorded in the local journal." 的事件，现在会说明发生了什么（状态、计划步骤、哪个 Provider 执行、证据、验证、用到的记忆）。

新增守护：后台 Run 落定时，守护进程写一条更新，对话把它显示为消息；Main Agent 的简报会列出最近完成的工作及证据数——下一轮从结果开始，而不是从一个状态颜色开始。

侧栏预览改为纯文本、严格单行省略号；模型输出的 Markdown 不再漏进列表。空对话去掉了三张起始卡片。

### Memory, classified and layered

The memory page now groups by kind — commitments and boundaries, preferences, decisions, procedures, facts — with each group's size and total recalls on its header. Rows stay collapsed inside the group; opening one shows its body, provenance, and the runs that actually recalled it (from `memory.recalled` in the journal, with a link to the run and the query). Reading a memory counts as a use, and the detail endpoint now returns that usage list.

记忆库改为分类分层：先按种类分组——承诺与边界、偏好、决定、流程、事实——组头显示条数与总召回次数；组内条目默认收起，展开后显示正文、来源，以及 Journal 里真正召回它的 Run（含跳转与当时的问题）。读取记忆计为一次使用，详情接口同时返回这份使用记录。

### A quieter empty state

The empty conversation dropped the three starter cards and now centres the welcome copy and the composer as one group, instead of pinning the input to the bottom.

空状态更安静：去掉了三张起始卡片，欢迎语与输入框作为一个整体居中，而不是把输入框钉在底部。

### One conversation, tasks beside it

The Kernel now refuses a proposal whose only step is `direct_response`: a greeting was creating a Run, a sidebar session and a real worker launch. Conversation is answered in the reply; a plan is for work that changes files or needs an executor.


Every message used to look like a brand-new conversation: the Main Agent answers a greeting with a one-step `direct_response` plan, that Run appeared as its own session, and the interface jumped into it. Conversational runs are no longer listed as sessions (they stay in the journal and the audit), and every turn now lands in the single Main Agent conversation thread, with tasks appearing in the sidebar beside it.

### Memory library: progressive disclosure

The memory page is an index — summary, type, status and recall count — and opening a row fetches its body, provenance, cited evidence and `.md` path on demand (fetched reads count as uses). Editing stays inside the opened row. The Main Agent gained `read_memory`, so recall can return summaries and a body is opened only when needed, journaled as `memory.recalled`.

### 对话只有一条，任务在旁边

Kernel 现在拒绝"唯一步骤是 `direct_response`"的提案：一句打招呼过去会创建 Run、侧栏会话，并真的启动一个 Worker。对话在回复里回答；计划只用于会改动文件或需要执行器的工作。


此前每条消息都像开了一个新对话：面对一句打招呼，Main Agent 会提案单步 `direct_response` 计划，那个 Run 被显示成一个独立会话，界面还会跳进去。现在对话类 Run 不再列为会话（仍保留在 Journal 与审计中），每一轮都落进唯一的 Main Agent 对话线程，任务则出现在侧栏。

### 记忆库：渐进式披露

记忆页现在是一份索引——摘要、类型、状态与召回次数——展开某一条时才读取它的正文、来源、引用证据与 `.md` 路径（读取计为一次使用）。编辑仍在展开行内。Main Agent 新增 `read_memory`：召回只返回摘要，需要正文时再按需打开，并记为 `memory.recalled`。

### Chat rendering fixes

The "Main Agent is thinking" card stayed on screen after the reply arrived: its CSS sets `display: grid`, which overrode the `hidden` attribute. A global `[hidden] { display: none !important }` now wins, which also fixes the hidden opportunity strip. Markdown list items were double-spaced (each item's trailing `<br>` rendered as an empty line, so the bullet looked detached from its text); line breaks adjacent to block-level list/heading elements are now dropped.

界面修复：「Main Agent 正在思考」在回复到达后仍然显示——它的样式设了 `display: grid`，压过了 `hidden` 属性。现在用全局 `[hidden] { display: none !important }` 压制，也顺带修好了被隐藏的机会条。Markdown 列表项被拉开双倍行距（每项尾部多余的 `<br>` 渲染成一整行空行，圆点看起来与正文分离）；现在会去掉紧邻列表/标题块级元素的换行。

### Audit & eval, visual

Settings → 审计与轨迹 is now a dashboard (`apps/desktop/ui/audit.js`): an overview (pass rate, runs per day, where failures happen, failure categories, per-tool comparison with cost and gateway errors), a filterable run list with a detail panel (stage strip, why it failed, execution timeline, policy verdicts per scope, evidence, verification, sha256 digest, raw record), and an evaluation tab. Evaluation uses owner ground truth instead of a model grader: mark a finished run 合格 / 不合格 (`POST /api/audit/:runId/label`, journaled as `audit.labeled`) and the system's own verdict is compared with yours, reporting agreement, false-pass (system completed, owner failed) and false-fail. A run in `waiting_review` has no system verdict, so your label there is the verdict and is not counted as agreement. `GET /api/audit/export` downloads JSONL. Labels are judgement, so they are not part of a record's digest.
Sessions can be deleted and restored from the audit view as well as the sidebar (`POST /api/sessions/:id/restore`). Deleting only hides the conversation; the audit record stays, marked deleted, so an eval never loses a run because someone tidied the sidebar.

审计与评估可视化：设置 → 审计与轨迹现在是一个面板：总览（通过率、每日运行数、失败发生在哪一步、失败类别、各工具对比含费用与网关错误）、可筛选的运行列表加详情面板（阶段条、失败原因、执行时间线、按 scope 的策略判定、证据、验证、sha256 摘要、原始记录），以及评估页。评估用所有者的真值而不是模型打分：把已结束的 Run 标为 合格 / 不合格（记为 `audit.labeled`），系统会把自己的判定与你的对照，给出一致率、误判通过（系统判完成、你判不合格）与误判失败。`waiting_review` 的 Run 系统尚无判定，你的标注就是判定，不计入一致率。`GET /api/audit/export` 下载 JSONL。标注是判断，不进记录的摘要。
会话可在审计页和侧边栏删除与恢复。删除只是隐藏对话；审计记录保留并标为已删除，评估不会因为有人整理侧边栏而丢掉某个 Run。

### Why workers "always failed", and the audit that now says so

Root causes found by running the real CLIs and reading the gateway's request log: (1) every built-in worker was blocked by default ("Unrestricted host execution is disabled"), so every run failed in under two seconds; (2) the reason was never journaled, only `status: failed`; (3) once unblocked, Codex failed inside our sandbox because macOS forbids nested sandboxes, and (4) Pi's inherited default model (`gemini-4-argon` through Magpie) returns HTTP 400 on the turn after a tool call, so Pi did the work and then exited non-zero.
Fixes: built-in providers now default to the OS sandbox on macOS (`sandbox: "seatbelt"`, network on, CLI state dirs writable; Codex's own sandbox is turned off via `{{sandboxArgs}}` because ours enforces); a provider can pin a model (`clone-ai model pi magpie/deepseek/deepseek-v4.1-flash`) through `{{modelArgs}}`; owner provider overrides now merge field-wise over the built-in recipe. A failed single-agent step now journals `execution.failed` with the message and structured failure report.
Audit: `clone-ai audit [runId|export]` and `GET /api/audit[/:runId]` project one record per run from the journal only: plan, policy verdicts, executions (provider, duration), evidence, verification, `failureStage`/`failureCategory`/`reason`, and a sha256 digest of the run's events. Executions are joined with Magpie's per-request log (tokens, cost, HTTP errors) by provider and time window, labelled `time_window` because the gateway cannot attribute a request to a run.

为什么 worker "总是失败"，以及现在能说清原因的审计：实际运行各 CLI 并读取网关请求日志，找到的根因是：(1) 所有内建 worker 默认被阻断，每个 Run 不到两秒就失败；(2) 失败原因从未写入 Journal，只有 `status: failed`；(3) 解除阻断后，Codex 在我们的沙箱里失败，因为 macOS 不允许嵌套沙箱；(4) Pi 继承的默认模型（经 Magpie 的 `gemini-4-argon`）在工具调用后的下一轮返回 HTTP 400，于是 Pi 干完活却以非零退出。
修复：内建 provider 在 macOS 上默认使用 OS 沙箱（`sandbox: "seatbelt"`，开网络，CLI 状态目录可写；Codex 自带沙箱通过 `{{sandboxArgs}}` 关闭，由我们的沙箱执行约束）；provider 可通过 `{{modelArgs}}` 固定模型；所有者的 provider 覆盖项改为在内建配方之上按字段合并。单 Agent 步骤失败现在会写入 `execution.failed`，带消息与结构化失败报告。
审计：`clone-ai audit [runId|export]` 与 `GET /api/audit[/:runId]` 只从 Journal 投影每个 Run 一条记录：计划、策略判定、执行（provider、耗时）、证据、验证、`failureStage`/`failureCategory`/原因，以及该 Run 事件的 sha256 摘要。执行记录按 provider 与时间窗口关联 Magpie 的逐请求日志（token、费用、HTTP 错误），标为 `time_window`，因为网关无法把请求归属到某个 Run。

### Machine-wide authority kernel (phase 1)

Authority is now expressed as scopes (`files` / `shell` / `network`) and judged by `AuthorityPolicyEngine`: a per-domain autonomy ladder (`observe` < `prepare` < `act_with_approval` < `act_auto`) plus owner-authored standing policies in `policies.json`. Defaults are `observe`, so nothing is writable until the owner raises a domain. Protected locations (SSH/GPG/cloud keys, Keychains, browser profiles, Clone AI's own journal, token and policies) can never be opened by any policy or approval, including through symlinks. Steps may declare `scopes`; each verdict is journaled inside `policy.decided`, and every owner edit as `authority.changed`. Only the owner can edit authority (`clone-ai authority ...`, `/api/authority/*`); the Main Agent can only read it (`get_authority`).

On macOS a provider can set `"sandbox": "seatbelt"` to run under an OS-enforced `sandbox-exec` profile built from the step's granted scopes: writes outside the granted roots, protected-location access, and (unless `sandboxNetwork` is set) network are blocked by the OS rather than by the prompt. Not yet done: desktop UI page for authority, per-policy usage budgets, strict read isolation by default, other platforms, calendar/mail/apps domains.

整机权限内核（第一阶段）：权限以 Scope（`files` / `shell` / `network`）表达，由 `AuthorityPolicyEngine` 判定：按域的自主阶梯（`observe` < `prepare` < `act_with_approval` < `act_auto`）加所有者撰写的常设策略（`policies.json`）。默认均为 `observe`，所有者抬高某个域之前什么都不可写。受保护位置（SSH/GPG/云密钥、钥匙串、浏览器档案、Clone AI 自己的 Journal、token 与策略文件）任何策略或审批都无法开放，符号链接也绕不过。步骤可声明 `scopes`；每个判定写入 `policy.decided`，所有者的每次编辑写入 `authority.changed`。只有所有者能修改权限（`clone-ai authority ...`、`/api/authority/*`），Main Agent 只能读取（`get_authority`）。

macOS 上 Provider 可设置 `"sandbox": "seatbelt"`，在由步骤已授权 Scope 生成的 OS 级 `sandbox-exec` profile 下运行：授权根之外的写入、受保护位置访问，以及（未设 `sandboxNetwork` 时）网络，都由操作系统而不是提示词拦截。尚未完成：权限桌面页面、策略用量额度、默认严格读隔离、其他平台、日历/邮件/应用域。

### Isolated work can return named files

External and irreversible steps still run in a git worktree or a copied tree under clone home. After a successful step, files the plan actually named (for example `` `receipt.md` ``) are copied into the owner's live project **only when that path does not already exist with different contents**. Other writes stay in the sandbox. The journal records `workspace.isolation.applied` with copied / leftover paths and whether the sandbox was kept, so the owner can open that directory instead of guessing.

外部与不可逆步骤仍在 clone home 下的 git worktree 或目录副本里运行。步骤成功后，计划真正点名的文件（例如 `` `receipt.md` ``）会拷进所有者的活项目——**仅当该路径尚未被不同内容占用**。其余写入留在沙箱。Journal 记下 `workspace.isolation.applied`（已拷贝 / 残留路径、沙箱是否保留），所有者可以直接打开那个目录，而不用猜。

### Memory promotion hygiene

Promoting a candidate now refuses an active memory with the same folded summary, redacts emails / tokens / keys / obvious phone and card patterns, and stores any PII-bearing memory as `secret` so default recall will not serve it. `GET /api/memory/candidates` includes `piiFindings`.

提升候选时，若已有折叠后摘要相同的活跃记忆则拒绝；对邮箱 / token / 密钥 / 明显电话与卡号做脱敏；含 PII 的记忆存为 `secret`，默认召回不会把它交给 Worker。`GET /api/memory/candidates` 带上 `piiFindings`。

### Stop a running answer from the composer

The send slot now becomes a stop control while a turn is running: clicking it, or pressing Escape, aborts the request and the server cancels the model call and every in-flight tool. A user stop reads differently from the three-minute stall timeout, and the typed text is still restored if no answer arrived. `npm test` is 566 tests, 566 pass, 0 fail.

回合运行时，发送槽位会变成停止控件：点击它或按 Escape 会中止请求，服务端随即取消模型调用与
所有在途工具。用户停止的提示与三分钟静默超时不同；若没有收到回答，已输入的文本仍会恢复。
`npm test` 为 566 个测试、566 通过、0 失败。

### A live tool timeline in the chat

While the Main Agent works, the desktop now shows each tool call as it happens: a row with the tool name, a running/done/failed/refused dot, and its duration, delivered over the same SSE stream as the answer. The events come from the turn's own tool lifecycle, so the timeline and the turn audit cannot disagree. Locale strings are bilingual and the running pulse respects `prefers-reduced-motion`. `npm test` is 565 tests, 565 pass, 0 fail; typecheck and gate pass.

主 Agent 工作时，桌面端现在会实时显示每次工具调用：一行包含工具名、运行中/完成/失败/拒绝的
状态点与耗时，通过与回答相同的 SSE 流送达。事件来自回合本身的工具生命周期，因此时间线与
回合审计不会互相矛盾。文案中英双语，运行中的脉冲遵循 `prefers-reduced-motion`。
`npm test` 为 565 个测试、565 通过、0 失败；typecheck 与 gate 通过。

### A model-invocable dispatch_task tool

The Main Agent can now start bounded work instead of only describing it: `dispatch_task` takes an objective and 1–12 acceptance criteria, validates them before any planning round, and calls the same `runQuery` path the companion uses. The Kernel still plans, applies authority and budgets, verifies evidence and decides completion, so this adds an entry point rather than a second authority. The charter tells the model to answer conversation directly and to use `propose_work_plan` when it already knows the steps. Three deterministic tests cover the validation rules. `npm test` is 563 tests, 563 pass, 0 fail; `npm run typecheck` and `npm run gate` pass.

主 Agent 现在可以启动有界工作，而不只是描述它：`dispatch_task` 接受目标与 1–12 条验收标准，在任何规划轮之前完成校验，并调用与 companion 相同的 `runQuery` 路径。规划、权威与预算、证据验证与完成判定仍归 Kernel，因此这只是增加入口，而不是第二个权威。charter 会告诉模型：对话直接回答，已知步骤时使用 `propose_work_plan`。三个确定性测试覆盖校验规则。`npm test` 为 563 个测试、563 通过、0 失败；`npm run typecheck` 与 `npm run gate` 通过。

### Desktop CSP and test isolation

The Tauri shell no longer sets `csp: null`; it now restricts scripts, styles, images, fonts, objects, frames and form targets to the app, with loopback connections allowed for the local daemon.

Tauri 外壳不再设置 `csp: null`；现在限制脚本、样式、图片、字体、object、frame 与表单目标为应用自身，并允许连接本机 daemon 的 loopback。

### MCP host and skills

`src/mcp/mcp-host.ts` is an MCP client over stdio: JSON-RPC 2.0, `initialize`, `tools/list`, `tools/call`, a per-request timeout, an output cap, and `mcp__<server>__<tool>` names. A server that cannot start is recorded in `failures` and contributes no tools; one broken server never blocks the others. `src/skills/skill-loader.ts` loads `<root>/<name>/SKILL.md` with frontmatter (`name`, `description`, `allowed-tools`, `disable-model-invocation`, `user-invocable`) and progressive disclosure: only a capped one-line listing enters the system prompt, and the body is injected when the model invokes `Skill(<name>)`. Both are opt-in per Main Agent turn (`skillRoots`, `mcpServers`); skill bodies and MCP output are treated as data, and the Kernel gate still decides what may run. Fifteen deterministic tests cover the host, the loader, and an end-to-end turn that exposes and invokes both.

`src/mcp/mcp-host.ts` 是基于 stdio 的 MCP 客户端：JSON-RPC 2.0、`initialize`、`tools/list`、`tools/call`、每请求超时、输出上限，以及 `mcp__<server>__<tool>` 命名。启动失败的服务器记入 `failures` 且不贡献工具；一个坏服务器绝不阻塞其他服务器。`src/skills/skill-loader.ts` 加载 `<root>/<name>/SKILL.md`，支持 frontmatter（`name`、`description`、`allowed-tools`、`disable-model-invocation`、`user-invocable`）与渐进披露：只有有上限的单行列表进入 System Prompt，正文在模型调用 `Skill(<name>)` 时注入。两者都按主 Agent 回合显式开启（`skillRoots`、`mcpServers`）；技能正文与 MCP 输出按数据处理，真正的闸门仍由 Kernel 决定。15 个确定性测试覆盖宿主、加载器，以及一个同时暴露并调用两者的端到端回合。

### Token-aware context compaction

`src/main-agent/context-window.ts` derives the compact/warn/blocked levels from a context window (`effective = window - min(maxOutputTokens, 20000)`, compact at `min(80%, effective - 13000)`, warn at `compact - 20000`, blocked at `effective - 3000`), estimates tokens, and compacts a transcript into a bounded summary plus a verbatim tail. The native Main Agent enables it when `contextWindow` is supplied; each compaction writes `main_agent.context_compacted` with the estimated size, threshold, dropped/kept counts and the summary, so the desktop context view can show what happened. A blocked level ends the turn as `budget_exhausted` instead of sending an over-window request. Eight deterministic tests cover the levels, pressure, preservation, bounded summaries, and the estimator.

`src/main-agent/context-window.ts` 从上下文窗口推导压缩/警告/阻断三档水位（`effective = window - min(maxOutputTokens, 20000)`，压缩线 `min(80%, effective - 13000)`，警告线 `compact - 20000`，阻断线 `effective - 3000`），估算 token，并把转录压成有界摘要加逐字尾部。原生主 Agent 在提供 `contextWindow` 时启用；每次压缩写入 `main_agent.context_compacted`，带估算大小、阈值、丢弃/保留数量与摘要，桌面上下文视图因此能显示发生了什么。达到阻断线会以 `budget_exhausted` 结束回合，而不是发出超窗口请求。8 个确定性测试覆盖水位、压力、保留、有界摘要与估算器。

### Shared agent loop kernel

The Main Agent now runs through `src/agent/loop.ts`: typed terminal reasons, safe tools scheduled together with unsafe tools as barriers, abort propagation, round/tool/token/duration budgets, bounded retries, middle-truncated tool results, and a compaction hook. `src/main-agent/native-runtime.ts` adapts its streaming chat client and Kernel tools to the kernel; read-only tools run in parallel and proposals stay serial, and tool start/completion events still reach the turn audit. Sixteen new deterministic tests cover completion, tool pairing, the concurrency barrier, max rounds, tool-call budgets, abort, retry, truncation, compaction, unknown tools, an interrupted-turn audit case, and a client-disconnect cancellation path. `npm test` is 622 tests, 619 pass, 0 fail, 3 skipped; `npm run typecheck` and `npm run gate` pass. The native worker now uses the same kernel: its OpenAI-compatible client is a single completion, and the worker owns the rounds and tool gate.

主 Agent 现在通过 `src/agent/loop.ts` 运行：带类型的终止原因、安全工具并行/非安全工具屏障、abort 传播、回合/工具/token/时长预算、有界重试、中间截断的工具结果，以及压缩钩子。`src/main-agent/native-runtime.ts` 把流式 chat 客户端与 Kernel 工具适配到内核；只读工具并行，提案保持串行，工具开始/完成事件仍写入回合审计。新增 16 个确定性测试，覆盖完成、工具配对、并发屏障、最大回合、工具调用预算、abort、重试、截断、压缩、未知工具、中断回合的审计记录，以及客户端断开时的取消路径。`npm test` 为 622 个测试、619 通过、0 失败、3 跳过；`npm run typecheck` 与 `npm run gate` 通过。原生 Worker 现在也使用同一内核：OpenAI 兼容客户端只做一次 completion，Worker 拥有回合与工具闸门。

### Claude Code parity analysis and 95% roadmap

Added a bilingual reverse-engineering analysis of Claude Code 2.1.317 and Claude Desktop 4.16336.0, a 12-dimension weighted parity scorecard, and a nine-phase roadmap to 95%. The analysis covers the typed loop state machine, streaming tool scheduler, six-mode permission ladder, 33 hook events, token-aware compaction, MCP/skills/subagents, and the Desktop Agent-SDK control protocol. clone-ai's audited baseline is 58.5/100; the roadmap starts by repairing the four red tests left by the Pi removal, then adds the shared loop kernel, per-call permissions, execution-worker tool profiles (coding is one profile), context engineering, MCP/skills, subagents/sessions, and desktop feedback. See [docs/study/claude-code-parity.md](docs/study/claude-code-parity.md).

新增双语版 Claude Code 2.1.317 / Claude Desktop 4.16336.0 逆向分析与 12 维加权对齐评分卡，以及到达 95% 的九阶段路线。分析覆盖带类型的循环状态机、流式工具调度、六模式权限阶梯、33 个 hook 事件、token 感知压缩、MCP/Skills/子 Agent，以及桌面端 Agent-SDK 控制协议。clone-ai 审计基线为 58.5/100；路线先修复移除 Pi 后留下的 4 个红测试，再加入共享循环内核、逐次权限、执行 Worker 的工具配置（编码只是其中一种）、上下文工程、MCP/Skills、子 Agent/会话与桌面反馈。见 [docs/study/claude-code-parity.zh-CN.md](docs/study/claude-code-parity.zh-CN.md)。

### Optimization results are a separate, curated file

`docs/engineering/optimization-results.md` (and its Chinese pair) now lists only optimizations whose eval showed a real gain: the claim, the evidence, and links to the trade-off and the execution chain. A negative optimization — no gain, a regression, or a revert — gets no entry there; its trade-off and execution-chain entries remain the record. `AGENTS.md` rule 6 and the optimization log's header point to the new file.

`docs/engineering/optimization-results.md`（及中文版）现在只列 eval 显示出真实收益的优化：主张、证据，以及取舍与执行链路的链接。负优化——没有收益、出现回退或被撤销——不写条目；它的取舍与执行链路条目仍是记录。`AGENTS.md` 第 6 条与优化日志的抬头都指向新文件。

### Worker concurrency follows the machine

The Kernel now samples CPU cores, the 1-minute load average and free memory, computes how many workers may run at once, and gates every execution through one shared limiter — so a 16-core idle host and a 2-core busy laptop no longer behave the same. The Main Agent can read the snapshot with a read-only `get_capacity` tool to size a plan, but cannot raise the limit. Owners can pin a ceiling with `maxConcurrentWorkers` (0 = auto), re-read on every dispatch.

Kernel 现在采样 CPU 核数、1 分钟负载与空闲内存，计算同时运行多少个 Worker，并通过共享限流器约束每次执行——16 核空闲主机与 2 核忙碌笔记本不再表现相同。主 Agent 可以用只读的 `get_capacity` 工具读取快照来决定计划规模，但不能提高上限。所有者可以用 `maxConcurrentWorkers` 固定上限（0 = 自动），每次派发时重新读取。

### The black-box CLI workers are gone

Claude Code, Codex, the Pi CLI and opencode were removed as execution providers, together with their launch recipes, install commands, the `install_agent` tool and the provider settings APIs. The in-process native worker is the only executor: every tool call is checked against the step's scopes at the moment it is made, and its usage is exact. The `external` role now has no provider until a governed action connector exists — it is never routed to a CLI. The worker benchmark runs native-only; memory mining calls the same endpoint with an injected completion.

Claude Code、Codex、Pi CLI 与 opencode 已被移除，连同它们的启动配方、安装命令、`install_agent` 工具与 Provider 设置接口。进程内的原生 Worker 是唯一的执行器：每次工具调用都在发起的瞬间按步骤 Scope 校验，用量精确。`external` 角色在有受治理的动作连接器之前没有 Provider，绝不会被路由到 CLI。Worker 基准只跑原生；记忆提炼用可注入的补全调用同一端点。

### The Main Agent no longer uses the Pi SDK

The Pi Agent SDK is gone from the Main Agent path. The native in-process loop is the only runtime: the prompt compiler, conversation pointer, transcript, self-review call and model picker are ours. `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` are required; without them a turn fails with a message naming the missing variables, and `CLONE_AI_MAIN_RUNTIME=pi` is refused instead of falling back. The turn ledger is the conversation record, and `search_history` reads it alongside any legacy session files. Removing the black-box CLI workers is the next step, recorded in the same trade-off.

主 Agent 路径中已移除 Pi Agent SDK。进程内的原生循环是唯一运行时：Prompt 编译器、对话指针、对话记录、自评审调用与模型选择器都是我们自己的。必须配置 `CLONE_AI_NATIVE_MODEL` 与 `CLONE_AI_NATIVE_BASE_URL`；缺少时回合会以指明缺失变量的错误失败，`CLONE_AI_MAIN_RUNTIME=pi` 会被拒绝而不是回退。回合台账成为对话记录，`search_history` 同时读取它与旧会话文件。移除黑盒 CLI Worker 是下一步，记在同一个取舍条目中。

### Main Agent comparison repeats and reports medians

`npm run bench:main` now runs each task/runtime cell `--repeat N` times (default 5) and reports median and p90 duration, median tokens and pass rate, keeping every sample in the JSON. `benchmark/stats.ts` provides the median and nearest-rank percentile, and a throwing cell is recorded as a failed sample instead of aborting the report. A three-sample run on DeepSeek v4.1 Flash: both runtimes 9/9, native about 6.6% fewer tokens, median latency within about one second.

`npm run bench:main` 现在对每个任务/运行时组合跑 `--repeat N` 次（默认 5），报告中位数与 p90 耗时、中位 tokens 与通过率，并在 JSON 中保留每个样本。`benchmark/stats.ts` 提供中位数与最近秩百分位；抛错的格子记为失败样本，而不是中断整份报告。DeepSeek v4.1 Flash 上的三次运行：两个运行时均 9/9，原生少约 6.6% tokens，中位延迟相差约一秒以内。

### Native worker defaults for eligible roles

With `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` set, the default agents for `direct`, `research`, `draft` and `review` now use the in-process native worker; `external` stays on the CLI path because the native worker has no governed action connector. A provider saved in settings still wins, and without the endpoint the previous CLI defaults apply.

设置 `CLONE_AI_NATIVE_MODEL` 与 `CLONE_AI_NATIVE_BASE_URL` 后，`direct`、`research`、`draft`、`review` 的默认 Agent 现在使用进程内的原生 Worker；`external` 仍走 CLI 路径，因为原生 Worker 没有受治理的动作连接器。设置中保存的 Provider 仍然优先，未配置端点时沿用之前的 CLI 默认。

### Native Main Agent is the default when configured

With `CLONE_AI_MAIN_RUNTIME` unset, the Main Agent now uses the native in-process loop when `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` are present; otherwise it stays on Pi. `CLONE_AI_MAIN_RUNTIME=pi` forces Pi, `=native` forces native, and an unknown value is refused. A live smoke without the flag recorded `provider: "native"`, and the full suite still passes.

`CLONE_AI_MAIN_RUNTIME` 未设置时，只要存在 `CLONE_AI_NATIVE_MODEL` 与 `CLONE_AI_NATIVE_BASE_URL`，主 Agent 现在默认使用进程内的原生循环；否则继续使用 Pi。`CLONE_AI_MAIN_RUNTIME=pi` 强制 Pi，`=native` 强制原生，未知值会被拒绝。不设开关的实机冒烟记录了 `provider: "native"`，全量测试仍通过。

### Native Main Agent accepts images

The native Main Agent now sends image attachments as OpenAI-style `image_url` data URLs in the current user message, so switching from Pi no longer removes the feature. Images are per-turn and not stored in the turn ledger. A live validation (64×64 red PNG) returned "Red." with 3,806 tokens.

原生主 Agent 现在把图片附件以 OpenAI 风格 `image_url` data URL 放进当前 user 消息，因此从 Pi 切换过来不再丢失该功能。图片是逐回合的，不写入回合台账。实机验证（64×64 红色 PNG）返回 "Red."，消耗 3,806 tokens。

### Native Main Agent streams and compacts

The flag-gated native Main Agent now streams SSE tokens to the interface, assembles streamed tool-call fragments, parses the final usage chunk, and compacts long transcripts deterministically: the newest turns stay verbatim within `historyChars` (12,000), older turns become a bounded summary, and the full text remains in the turn ledger for `search_history`. The Pi-versus-native comparison still passes 3/3 on both after the change. A live long-context validation (24 seeded turns, 4,000-char budget) confirmed the endpoint accepts the summary and a fact from the oldest turn survives it.

开关后的原生主 Agent 现在会向界面流式输出 SSE token、组装分片的工具调用、解析最后的 usage 块，并对长对话做确定性压缩：最新轮次在 `historyChars`（12,000）内保留原文，较早轮次变成有界摘要，全文仍留在回合台账中供 `search_history` 检索。改动后 Pi 与原生对比两边仍为 3/3。一次实机长对话验证（24 条种子轮次、4,000 字符预算）确认端点接受摘要，且最老一轮中的事实能够保留。

### Main Agent comparison benchmark

`npm run bench:main` runs three fixed prompts — direct answer, authority read, plan proposal — through the Pi runtime and the native loop with the same model and an isolated clone home per task, recording duration, tokens, tool calls, created runs and whether the expectation held. First working run on Sonnet 5.5 via Magpie: both 3/3, 21,514 vs 21,160 tokens, 23.0s vs 24.9s summed. A first attempt on the broken gemini endpoint failed for both runtimes and is kept as evidence.

`npm run bench:main` 用同一模型与每个任务独立的 clone home，把三条固定 Prompt——直接回答、读取权限、提案计划——分别跑过 Pi 运行时与原生循环，记录耗时、tokens、工具调用、产生的 Run 与预期是否成立。首次有效运行（Sonnet 5.5 经 Magpie）：两边均 3/3，21,514 vs 21,160 tokens，总耗时 23.0s vs 24.9s。第一次尝试因 gemini 端点故障对两个运行时都失败，保留为证据。

### Audit renders again, and the composer accepts media

The audit page no longer goes blank from a missing function brace, and the
composer has an attachment picker for PNG/JPEG/GIF/WebP images plus video files.
Videos are converted to a representative JPEG frame before being sent to the
model, so a video can participate in a text/image conversation.

审计页不再因为缺少函数括号而整体空白；输入区新增附件按钮，可选择
PNG/JPEG/GIF/WebP 图片和视频。视频会先提取一张代表画面为 JPEG 再发送给模型，
因此视频也能参与文字/图片对话。

### Self-check rebuilds the installed app

On macOS, `npm run selfcheck:push` now rebuilds and replaces `dist/Clone AI.app`
after the full test suite, typecheck and gate pass, before pushing. Source edits
no longer require a separate manual app build.

macOS 上 `npm run selfcheck:push` 现在会在完整测试、类型检查和 gate 通过后、
推送之前重新构建并替换 `dist/Clone AI.app`。修改源码后不再需要手动单独构建 App。

### A native Main Agent loop behind a flag

`CLONE_AI_MAIN_RUNTIME=native` runs the Main Agent in-process against an OpenAI-compatible endpoint (`CLONE_AI_NATIVE_*`): the same charter/briefing/memory-push prompt, the same Kernel tools captured from the Pi extension, the turn ledger as transcript, and the same prompt-snapshot/turn/tool/usage audit. Pi remains the default and fallback. The first native loop is non-streaming, keeps the last 12 turns without compaction, refuses image attachments, and answers `search_history` from the turn ledger.

`CLONE_AI_MAIN_RUNTIME=native` 让主 Agent 在进程内运行，对接 OpenAI 兼容端点（`CLONE_AI_NATIVE_*`）：相同的 charter/简报/记忆推送 Prompt、从 Pi 扩展捕获的同一组 Kernel 工具、以回合台账作为对话记录，以及相同的提示词快照/回合/工具/用量审计。Pi 仍是默认与回退。第一版原生循环非流式、保留最近 12 轮且不做压缩、拒绝图片附件，`search_history` 从回合台账检索。

### A missing named input fails the native worker

When a read fails on a path named in the work order or step instructions, the native worker now ends the turn as `no_artifact` (`native-missing-input`) instead of accepting an invented artifact. The prompt says not to invent missing inputs, usage from failed runs is journaled, and the missing-input benchmark now behaves as expected (native set: 5/5).

当读取 WorkOrder 或步骤指令点名的路径失败时，原生 Worker 现在以 `no_artifact`（`native-missing-input`）结束回合，而不是接受编造的产物。Prompt 要求不编造缺失输入，失败运行的用量也会写入 Journal，missing-input benchmark 现在按预期失败（原生套件 5/5）。

### Desktop conversation input and layout

Chinese IME candidate confirmation no longer sends the message, and multi-turn messages remain full-width in a vertical conversation.

中文输入法确认候选词时不再发送消息，多轮对话中的消息保持纵向排列并占满会话宽度。

### Benchmark runs the native provider

`npm run bench -- --provider native` runs the same fixed task set in-process without `--unsafe-host`, and the report records exact usage, verification and failure reason. The verifier now receives the benchmark workspace, fixing relative artifact checks that made even `summarize` fail. First comparison on 2026-11-05: native 4/5 and Claude 4/5 on the four solvable tasks; both miss the missing-input expectation for opposite reasons — native invents the artifact, Claude fails cleanly at verification.

`npm run bench -- --provider native` 现在不用 CLI、也不需要 `--unsafe-host`，跑同一组固定任务；报告记录精确用量、验证结果与失败原因。验证器现在会拿到基准工作区，修复了此前让 summarize 都失败的相对产物检查。2026-11-05 的首次对比：四个可解任务上原生 4/5、Claude 4/5；missing-input 两边都不符合预期，原因相反——原生伪造产物，Claude 在验证阶段干净失败。

### Native worker is a first-class provider with exact usage

### Every Main Agent turn is in the audit

CLI, `npm run main`, the desktop/server companion, and WhatsApp now write the same two journal events per turn — `main_agent.turn_started` and `main_agent.turn_completed` — plus `agent.tool_started` / `agent.tool_completed` for every Main Agent tool call. Each turn carries the input and reply (PII-redacted and capped), model, provider, reasoning effort, token usage, prompt material hash, spawned run ids, and tool calls with redacted argument summaries. The audit page gains a **Main Agent turns** tab, `clone-ai audit turns` prints the same, and `GET /api/audit/turns` serves it. The existing `main-agent-turns.jsonl` ledger is written by the same module, so the conversation view and the journal cannot disagree.

CLI、`npm run main`、桌面/服务器 companion 与 WhatsApp 现在为每个回合写同样两条 Journal 事件——`main_agent.turn_started` 与 `main_agent.turn_completed`——并为每次主 Agent 工具调用写 `agent.tool_started` / `agent.tool_completed`。每个回合携带输入与回复（PII 脱敏并截断）、模型、Provider、推理强度、token 用量、提示词材料哈希、产生的 Run id，以及带脱敏参数摘要的工具调用。审计页新增 **主 Agent 回合** 标签页，`clone-ai audit turns` 打印同样的内容，`GET /api/audit/turns` 提供数据。既有的 `main-agent-turns.jsonl` 台账由同一模块写入，因此对话视图与 Journal 不会互相矛盾。

## 0.1.0

Shipped on `origin/main` before this slice:

- Companion loopback bearer token plus Host/Origin checks; HTTP and CLI cancel/reject; Main Agent single-flight lock; advisory model/tool call caps; ToolAuthority not wired into the black-box CLI; SMTP From/To, TLS verify, daily report hour; `GET /api/health`; SIGTERM; esbuild; planner 429/5xx retry.
- JSON stderr logs; health run metrics; `mainAgentModel` in `config.json`; journal `usage.recorded` for the Main Agent; GitHub Actions `npm test` + typecheck; verifier plugins (test command + diff); restorable checkpoints for reversible work.
- External/irreversible steps in a git worktree or copied tree; `workspaceIsolation` journaled; planner `usage.recorded`; `config.locale` drives desktop chrome; `.env.example` names only.

此前已在 `origin/main` 上线：

- Companion loopback bearer 与 Host/Origin 校验；HTTP 与 CLI 的 cancel/reject；Main Agent 单飞锁；模型/工具次数上限为声明而非假执行；ToolAuthority 未接入黑盒 CLI；SMTP From/To、TLS 校验、日报小时；`GET /api/health`；SIGTERM；esbuild；Planner 对 429/5xx 重试。
- JSON stderr 日志；健康检查中的 Run 计数；`config.json` 的 `mainAgentModel`；Main Agent 的 `usage.recorded`；GitHub Actions 跑 `npm test` 与 typecheck；测试命令与 diff 的 Verifier 插件；可逆工作的可还原检查点。
- 外部/不可逆步骤进入 git worktree 或目录副本；Journal 记录 `workspaceIsolation`；Planner 记 `usage.recorded`；`config.locale` 驱动桌面文案；`.env.example` 只写变量名。
