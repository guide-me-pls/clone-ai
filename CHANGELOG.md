# Changelog

All notable changes to clone-ai are listed here. Dates are UTC+8.

clone-ai 的可见变化记在这里。日期为北京时间。

## Unreleased

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
