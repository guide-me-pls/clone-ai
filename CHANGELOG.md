# Changelog

All notable changes to clone-ai are listed here. Dates are UTC+8.

clone-ai 的可见变化记在这里。日期为北京时间。

## Unreleased

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
Fixes: built-in providers now default to the OS sandbox on macOS (`sandbox: "seatbelt"`, network on, CLI state dirs writable; Codex's own sandbox is turned off via `{{sandboxArgs}}` because ours enforces); a provider can pin a model (`clone-ai model pi magpie/360/deepseek/deepseek-v4.1-flash`) through `{{modelArgs}}`; owner provider overrides now merge field-wise over the built-in recipe. A failed single-agent step now journals `execution.failed` with the message and structured failure report.
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

## 0.1.0

Shipped on `origin/main` before this slice:

- Companion loopback bearer token plus Host/Origin checks; HTTP and CLI cancel/reject; Main Agent single-flight lock; advisory model/tool call caps; ToolAuthority not wired into the black-box CLI; SMTP From/To, TLS verify, daily report hour; `GET /api/health`; SIGTERM; esbuild; planner 429/5xx retry.
- JSON stderr logs; health run metrics; `mainAgentModel` in `config.json`; journal `usage.recorded` for the Main Agent; GitHub Actions `npm test` + typecheck; verifier plugins (test command + diff); restorable checkpoints for reversible work.
- External/irreversible steps in a git worktree or copied tree; `workspaceIsolation` journaled; planner `usage.recorded`; `config.locale` drives desktop chrome; `.env.example` names only.

此前已在 `origin/main` 上线：

- Companion loopback bearer 与 Host/Origin 校验；HTTP 与 CLI 的 cancel/reject；Main Agent 单飞锁；模型/工具次数上限为声明而非假执行；ToolAuthority 未接入黑盒 CLI；SMTP From/To、TLS 校验、日报小时；`GET /api/health`；SIGTERM；esbuild；Planner 对 429/5xx 重试。
- JSON stderr 日志；健康检查中的 Run 计数；`config.json` 的 `mainAgentModel`；Main Agent 的 `usage.recorded`；GitHub Actions 跑 `npm test` 与 typecheck；测试命令与 diff 的 Verifier 插件；可逆工作的可还原检查点。
- 外部/不可逆步骤进入 git worktree 或目录副本；Journal 记录 `workspaceIsolation`；Planner 记 `usage.recorded`；`config.locale` 驱动桌面文案；`.env.example` 只写变量名。
