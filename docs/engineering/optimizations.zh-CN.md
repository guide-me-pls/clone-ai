# 优化日志

[English](optimizations.md) · **简体中文**

每个优化在这里占一条，新的在前。取舍条目在变更之前写；本条目在变更落地后补全。
它的目的是让**工作本身**可审计：不仅改了什么，还包括怎么做的、花了多少、链路哪里弱。
规则见 [`AGENTS.md`](../../AGENTS.md)。

### 2026-11-06 — 第二轮：通道重跑五条桌面端轨迹

- **目标 / 假设：** 堵住三个漏洞后，同一批五条轨迹能产出的补丁，其用例在修复后应为绿色；任何不满足的都应被通道拒绝。
- **取舍：** [修复后用例检查](../architecture/trade-offs.zh-CN.md#2026-11-06--修复通道在修复后重跑已哈希的回归用例)；[有界暂存](../architecture/trade-offs.zh-CN.md#2026-11-06--修复暂存只移除已知的运行期临时物不丢任意文件)；[定向编辑（现在包含 write_file 拒绝已有路径）](../architecture/trade-offs.zh-CN.md#2026-11-06--原生-worker-获得定向编辑工具)。
- **变更：** 本轮发现的第四个漏洞——`write_file` 现在拒绝已存在的路径，因此已有文件只能通过 `edit_file` 修改。测试：`write_file` 创建新文件并拒绝替换；第二阶段措辞已更新。
- **eval：** `node --experimental-strip-types --test test/native-client.test.ts test/repair.test.ts` —— 32 个用例通过。两个修复合入后完整套件 626 pass / 3 skipped / 0 fail；`npx tsc --noEmit` 通过；`npm run gate` PASS。通道运行即行为层 eval，逐条如下。
- **Benchmark run：** 五次修复运行，原生 Worker 指向 Magpie `360/deepseek/deepseek-v4.1-flash`，`CLONE_AI_NATIVE_MAX_ROUNDS=32`、`CLONE_AI_NATIVE_MAX_TOKENS=50000`、`CLONE_AI_NATIVE_TIMEOUT_MS=900000`，隔离 clone home `~/.clone-repair-r1`…`r5`，报告在各 home 的 `rsi/last-run.json`。结果：记忆刷新（r1）——第一阶段红（2 个失败断言），修复后用例绿，但因生成的用例有两处 TS2554 而停在 `typecheck`；侧栏（r4）——第一阶段红，修复后用例绿，但因生成用例的英文注释未通过双语文档测试、以及 `never[]` 推断而停在 `suite`/`typecheck`；归档（r2）——只因桩的问题而红，修复后仍红，被 `regression-still-red` 拒绝；审计（r3）——第二阶段用 `write_file` 替换了 `audit.js` 的 127 行，用例仍失败，被 `regression-still-red` 拒绝；推理强度本轮未跑。两个因仓库检查被拒的修复，由工作 Agent 对生成的用例做机械调整（一个可选参数；双语注释与 `any[]` 标注）后重跑用例、tsc 与套件，才合入。
- **执行链路：** 先并行跑记忆与归档，再跑审计与侧栏；接受前逐个检查修复差异；保留通道产出的生产补丁与用例逻辑，只改仓库类型检查与双语规则要求的部分；没有提前停止任何通道（均由它自己的闸门停止）。除五次运行外无额外模型 token。
- **优点：** 修复后检查把此前的 false-fixed 变成拒绝；抓住了一个只因桩崩溃而红的用例；抓住了一次破坏性的整文件重写；两个真实修复通过通道产出。
- **缺点 / 下次：** 模型写用例时看不到 `tsc` 与双语规则，因此正确的修复仍可能被仓库检查拒绝；用例需要第一阶段预检，或工作 Agent 的机械修整。`write_file` 拒绝已有路径可能挡住合法的整文件重写；那种情况必须通过 `edit_file` 携带完整旧内容。推理强度轨迹仍待运行。
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

## 2026-11-05 — 所有 Agent 调用共享审计

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

## 2026-11-05 — 记住夜间修复已消费的轨迹

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

## 2026-11-05 — 保守恢复规划阶段孤儿

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

## 2026-11-05 — 提示词溯源与离线回归门禁

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

## 2026-11-04 — 带可撤销配置动作的 AI 自我评审

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

## 2026-11-05 — 失败轨迹、带闸门的夜间修复与 Worker 凭据边界

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
